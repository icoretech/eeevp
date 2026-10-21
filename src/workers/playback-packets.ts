// Ephemeral ciphertext only: shared LRU budgets and reader-leased, cancellable packet downloads.
const SESSION_BUDGET = 8 * 1024 * 1024;
const TOTAL_BUDGET = 32 * 1024 * 1024;
// A finite lease bounds reuse after server session expiry; explicit lock/401 clears immediately.
const CACHE_TTL = 30_000;
const DOWNLOADS = 3;
// Native players hand adjacent byte ranges off between responses before reattaching their readers.
const HANDOFF_GRACE = 50;

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
  orphanTimer?: ReturnType<typeof setTimeout>;
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
    clearTimeout(leased.orphanTimer);
    leased.orphanTimer = undefined;
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
          if (leased.running) {
            leased.orphanTimer = setTimeout(() => {
              this.discard(leased);
              this.pump();
            }, HANDOFF_GRACE);
          } else this.discard(leased);
        }
        this.pump();
      },
    };
  }

  private discard(download: Download) {
    clearTimeout(download.orphanTimer);
    download.orphanTimer = undefined;
    if (this.downloads.get(download.index) === download)
      this.downloads.delete(download.index);
    download.abort.abort(new Error("Playback packet no longer needed."));
    download.result.reject(download.abort.signal.reason);
  }

  private pump() {
    if (this.closed) return;
    // A genuinely different seek takes precedence over the short native handoff grace.
    if (
      this.active >= DOWNLOADS &&
      [...this.downloads.values()].some(
        (item) => !item.running && item.readers > 0,
      )
    ) {
      for (const item of this.downloads.values()) {
        if (item.running && item.readers === 0) this.discard(item);
      }
    }
    for (const download of this.downloads.values()) {
      if (this.active >= DOWNLOADS) break;
      if (download.running || download.readers === 0) continue;
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
          clearTimeout(download.orphanTimer);
          download.orphanTimer = undefined;
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
      clearTimeout(download.orphanTimer);
      download.orphanTimer = undefined;
      download.abort.abort(new Error("Playback is locked."));
      download.result.reject(download.abort.signal.reason);
    }
    this.downloads.clear();
  }
}
