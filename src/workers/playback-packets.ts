// Ephemeral ciphertext only: shared LRU budgets and reader-leased, cancellable packet downloads.
const SESSION_BUDGET = 8 * 1024 * 1024;
const TOTAL_BUDGET = 32 * 1024 * 1024;
// A finite lease bounds reuse after server session expiry; explicit lock/401 clears immediately.
const CACHE_TTL = 30_000;
const DOWNLOADS = 3;

type CachedPacket = {
  session: string;
  index: number;
  bytes: ArrayBuffer;
  expires: number;
};

export class CiphertextCache {
  private entries = new Map<string, CachedPacket>();
  private key(session: string, index: number) {
    return `${session}:${index}`;
  }
  get(session: string, index: number) {
    const key = this.key(session, index);
    const item = this.entries.get(key);
    if (!item) return;
    this.entries.delete(key);
    if (item.expires <= Date.now()) return;
    this.entries.set(key, item);
    return item.bytes;
  }
  put(session: string, index: number, bytes: ArrayBuffer) {
    this.delete(session, index);
    if (bytes.byteLength > SESSION_BUDGET) return;
    this.entries.set(this.key(session, index), {
      session,
      index,
      bytes,
      expires: Date.now() + CACHE_TTL,
    });
    let total = 0;
    let own = 0;
    for (const [key, item] of this.entries) {
      if (item.expires <= Date.now()) {
        this.entries.delete(key);
        continue;
      }
      total += item.bytes.byteLength;
      if (item.session === session) own += item.bytes.byteLength;
    }
    for (const [key, item] of this.entries) {
      if (total <= TOTAL_BUDGET && own <= SESSION_BUDGET) break;
      if (total <= TOTAL_BUDGET && item.session !== session) continue;
      this.entries.delete(key);
      total -= item.bytes.byteLength;
      if (item.session === session) own -= item.bytes.byteLength;
    }
  }
  delete(session: string, index: number) {
    this.entries.delete(this.key(session, index));
  }
  clear(session: string) {
    for (const [key, item] of this.entries)
      if (item.session === session) this.entries.delete(key);
  }
}

type Download = {
  index: number;
  abort: AbortController;
  readers: number;
  running: boolean;
  result: ReturnType<typeof Promise.withResolvers<ArrayBuffer>>;
};

export class PlaybackPackets {
  private downloads = new Map<number, Download>();
  private active = 0;
  private closed = false;
  constructor(
    private session: string,
    private cache: CiphertextCache,
    private load: (index: number, signal: AbortSignal) => Promise<ArrayBuffer>,
  ) {}

  acquire(index: number) {
    if (this.closed) throw new Error("Playback is locked.");
    const cached = this.cache.get(this.session, index);
    if (cached) return { promise: Promise.resolve(cached), release: () => {} };
    let download = this.downloads.get(index);
    if (!download) {
      download = {
        index,
        abort: new AbortController(),
        readers: 0,
        running: false,
        result: Promise.withResolvers<ArrayBuffer>(),
      };
      // Lookahead failures remain observed even when a seek releases their reader before consumption.
      void download.result.promise.catch(() => {});
      this.downloads.set(index, download);
    }
    const leased = download;
    leased.readers += 1;
    this.pump();
    let released = false;
    return {
      promise: leased.result.promise,
      release: () => {
        if (released) return;
        released = true;
        leased.readers -= 1;
        if (leased.readers === 0 && this.downloads.get(index) === leased) {
          this.downloads.delete(index);
          leased.abort.abort(new Error("Playback packet no longer needed."));
          leased.result.reject(leased.abort.signal.reason);
        }
        this.pump();
      },
    };
  }

  private pump() {
    if (this.closed) return;
    for (const download of this.downloads.values()) {
      if (this.active >= DOWNLOADS) break;
      if (download.running) continue;
      download.running = true;
      this.active += 1;
      void this.load(download.index, download.abort.signal)
        .then((packet) => {
          download.abort.signal.throwIfAborted();
          if (!this.closed)
            this.cache.put(this.session, download.index, packet);
          download.result.resolve(packet);
        })
        .catch((error: unknown) => download.result.reject(error))
        .finally(() => {
          this.active -= 1;
          if (this.downloads.get(download.index) === download)
            this.downloads.delete(download.index);
          this.pump();
        });
    }
  }

  invalidate(index: number) {
    this.cache.delete(this.session, index);
  }
  close() {
    this.closed = true;
    this.cache.clear(this.session);
    for (const download of this.downloads.values()) {
      download.abort.abort(new Error("Playback is locked."));
      download.result.reject(download.abort.signal.reason);
    }
    this.downloads.clear();
  }
}
