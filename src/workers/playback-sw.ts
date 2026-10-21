// Serve owner-bound virtual video URLs, decrypting only requested chunks in service worker memory.
import { decryptChunk, decryptMetadata } from "../lib/crypto/video-crypto";
import { resolveRange } from "../lib/video/range";
import {
  credentialsSchema,
  manifestSchema,
  metadataSchema,
  type VideoCredentials,
  type VideoManifest,
  type VideoMetadata,
  videoIdSchema,
} from "../lib/video/schema";

const MEDIA_PREFIX = "/__eeevp_media__/";
const MAX_SESSIONS = 32;
const RESTORE_TIMEOUT = 5_000;
const SESSION_EXPIRED =
  "Your library session expired. Sign in and unlock the library again.";

type PlaybackSession = {
  ownerId: string;
  manifest: VideoManifest;
  credentials: VideoCredentials;
  metadata: VideoMetadata;
  requests: Set<AbortController>;
  locked: boolean;
  activityClient: BrowserClient;
};

type BrowserClient = {
  id: string;
  url: string;
  type: string;
  postMessage: (message: object, transfer?: Transferable[]) => void;
};
type PlaybackRuntime = {
  origin: string;
  fetch: typeof fetch;
  getClient: (id: string) => Promise<BrowserClient | undefined>;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function failure(message: string) {
  return { ok: false as const, error: message };
}

function requestSessionId(request: Request, origin: string) {
  const url = new URL(request.url);
  if (
    url.origin !== origin ||
    !url.pathname.startsWith(MEDIA_PREFIX) ||
    url.search
  )
    return null;
  const sessionId = videoIdSchema.safeParse(
    url.pathname.slice(MEDIA_PREFIX.length),
  );
  return sessionId.success ? sessionId.data : null;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", aborted));
  });
}

function requestRestore(
  client: BrowserClient,
  sessionId: string,
  signal: AbortSignal,
) {
  return new Promise<unknown>((resolve, reject) => {
    const channel = new MessageChannel();
    const cleanup = () => {
      signal.removeEventListener("abort", aborted);
      channel.port1.close();
      channel.port2.close();
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason);
    };
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      cleanup();
      resolve(event.data);
    };
    channel.port1.onmessageerror = () => {
      cleanup();
      reject(new Error("The browser could not restore secure playback."));
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) return aborted();
    try {
      client.postMessage({ type: "playback-resume", sessionId }, [
        channel.port2,
      ]);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

async function readPacket(response: Response, expectedSize: number) {
  if (!response.ok || !response.body) {
    throw new Error(
      "The encrypted video chunk is unavailable. Open the video again.",
    );
  }
  const length = response.headers.get("Content-Length");
  if (length !== null && Number(length) !== expectedSize) {
    await response.body.cancel();
    throw new Error("The encrypted video chunk has an invalid size.");
  }

  const packet = new Uint8Array(expectedSize);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > expectedSize - offset) {
        await reader.cancel();
        throw new Error("The encrypted video chunk has an invalid size.");
      }
      packet.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== expectedSize) {
    throw new Error("The encrypted video chunk is incomplete.");
  }
  return packet.buffer;
}

// The service is exported to exercise real encryption, streaming, cancellation, and client isolation in tests.
export class PlaybackService {
  private sessions = new Map<string, PlaybackSession>();
  private pending = new Map<string, { ownerId: string }>();
  private restoring = new Map<
    string,
    {
      ownerId: string;
      abort: AbortController;
      promise: Promise<boolean>;
      waiters: number;
    }
  >();

  constructor(private runtime: PlaybackRuntime) {}

  async unlock(ownerId: string, message: unknown) {
    if (!record(message)) return failure("Invalid playback request.");
    const sessionId = videoIdSchema.safeParse(message.sessionId);
    const manifest = manifestSchema.safeParse(message.manifest);
    const credentials = credentialsSchema.safeParse(message.credentials);
    const metadata = metadataSchema.safeParse(message.metadata);
    if (
      !sessionId.success ||
      !manifest.success ||
      !credentials.success ||
      !metadata.success ||
      manifest.data.id !== credentials.data.id
    ) {
      return failure("The video details or encryption key are invalid.");
    }
    if (this.sessions.has(sessionId.data) || this.pending.has(sessionId.data)) {
      return failure("This playback session already exists.");
    }
    if (this.sessions.size + this.pending.size >= MAX_SESSIONS) {
      return failure(
        "Close another video before opening a new playback session.",
      );
    }

    const pending = { ownerId };
    this.pending.set(sessionId.data, pending);
    try {
      const client = await this.runtime.getClient(ownerId);
      if (
        client?.type !== "window" ||
        client.id !== ownerId ||
        new URL(client.url).origin !== this.runtime.origin
      ) {
        return failure(
          "Secure playback requires a controlled page on this site.",
        );
      }
      const authenticated = await decryptMetadata(
        manifest.data,
        credentials.data.key,
      );
      if (
        authenticated.name !== metadata.data.name ||
        authenticated.type !== metadata.data.type
      ) {
        return failure(
          "The decrypted video details do not match the encrypted metadata.",
        );
      }
      if (this.pending.get(sessionId.data) !== pending) {
        return failure("Playback was closed before it started.");
      }
      this.sessions.set(sessionId.data, {
        ownerId,
        manifest: manifest.data,
        credentials: credentials.data,
        metadata: authenticated,
        requests: new Set(),
        locked: false,
        activityClient: client,
      });
      return { ok: true as const };
    } catch {
      return failure(
        "The video key could not unlock this video. Lock and unlock the library again.",
      );
    } finally {
      if (this.pending.get(sessionId.data) === pending)
        this.pending.delete(sessionId.data);
    }
  }

  lock(ownerId: string, sessionId: string) {
    const restoring = this.restoring.get(sessionId);
    if (restoring?.ownerId === ownerId)
      restoring.abort.abort(new Error("Playback is locked."));
    if (this.pending.get(sessionId)?.ownerId === ownerId)
      this.pending.delete(sessionId);
    const session = this.sessions.get(sessionId);
    if (session?.ownerId !== ownerId) return;
    session.locked = true;
    for (const request of session.requests)
      request.abort(new Error("Playback is locked."));
    session.requests.clear();
    this.sessions.delete(sessionId);
  }

  respond(ownerId: string, request: Request) {
    const sessionId = requestSessionId(request, this.runtime.origin);
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (
      !sessionId ||
      !ownerId ||
      !session ||
      session.ownerId !== ownerId ||
      session.locked
    ) {
      return new Response("Playback is locked. Open the video again.", {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    const { manifest, metadata } = session;
    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Type": metadata.type,
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
    // HTTP Range applies only to GET; HEAD describes the complete representation.
    const range = resolveRange(
      request.method === "GET" ? request.headers.get("Range") : null,
      manifest.size,
    );
    if (!range) {
      headers.set("Content-Range", `bytes */${manifest.size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Length", String(range.end - range.start + 1));
    if (range.status === 206) {
      headers.set(
        "Content-Range",
        `bytes ${range.start}-${range.end}/${manifest.size}`,
      );
    }
    if (request.method === "HEAD")
      return new Response(null, { status: range.status, headers });

    const abort = new AbortController();
    const onAbort = () => abort.abort(request.signal.reason);
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    session.requests.add(abort);
    let cursor = range.start;
    let cancelled = false;
    const cleanup = () => {
      request.signal.removeEventListener("abort", onAbort);
      session.requests.delete(abort);
    };
    const body = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            abort.signal.throwIfAborted();
            if (session.locked) throw new Error("Playback is locked.");
            const index = Math.floor(cursor / manifest.chunkSize);
            const chunkStart = index * manifest.chunkSize;
            const expectedSize = Math.min(
              manifest.chunkSize,
              manifest.size - chunkStart,
            );
            const response = await this.runtime.fetch(
              `${this.runtime.origin}/api/videos/${manifest.id}/chunks/${index}`,
              {
                cache: "no-store",
                credentials: "same-origin",
                redirect: "error",
                signal: abort.signal,
              },
            );
            if (response.status === 401) {
              this.lock(ownerId, sessionId);
              const client = await this.runtime.getClient(ownerId);
              client?.postMessage({
                type: "playback-error",
                sessionId,
                code: "session-expired",
                message: SESSION_EXPIRED,
              });
              throw new Error(SESSION_EXPIRED);
            }
            const packet = await readPacket(response, expectedSize + 28);
            abort.signal.throwIfAborted();
            const plaintext = new Uint8Array(
              await decryptChunk(
                packet,
                index,
                manifest,
                session.credentials.key,
              ),
            );
            abort.signal.throwIfAborted();
            if (session.locked) throw new Error("Playback is locked.");
            if (plaintext.byteLength !== expectedSize)
              throw new Error("Invalid decrypted chunk size.");
            try {
              session.activityClient.postMessage({
                type: "decryption-activity",
                sessionId,
                index,
                plaintextBytes: expectedSize,
                phase: "verified",
              });
            } catch {
              // A closed owner cannot receive telemetry; media streaming remains independent.
            }
            const offset = cursor - chunkStart;
            const length = Math.min(
              plaintext.byteLength - offset,
              range.end - cursor + 1,
            );
            controller.enqueue(plaintext.subarray(offset, offset + length));
            cursor += length;
            if (cursor > range.end) {
              controller.close();
              cleanup();
            }
          } catch (error) {
            cleanup();
            if (!cancelled) {
              controller.error(
                error instanceof Error && error.message === SESSION_EXPIRED
                  ? error
                  : new Error(
                      "Secure playback failed. Open the video again or unlock the library.",
                    ),
              );
            }
          }
        },
        cancel: () => {
          cancelled = true;
          abort.abort(new Error("Playback request cancelled."));
          cleanup();
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: range.status, headers });
  }

  private async restore(
    ownerId: string,
    sessionId: string,
    signal: AbortSignal,
  ) {
    const client = await abortable(this.runtime.getClient(ownerId), signal);
    signal.throwIfAborted();
    if (
      client?.type !== "window" ||
      new URL(client.url).origin !== this.runtime.origin
    )
      return false;
    const message = await requestRestore(client, sessionId, signal);
    signal.throwIfAborted();
    if (!record(message) || message.sessionId !== sessionId) return false;
    const result = await abortable(this.unlock(ownerId, message), signal);
    signal.throwIfAborted();
    return result.ok;
  }

  // A browser may stop an idle service worker at any time. The still-open owner window,
  // rather than the worker process, owns the ephemeral key and can restore its own session.
  async respondWithResume(ownerId: string, request: Request) {
    const sessionId = requestSessionId(request, this.runtime.origin);
    if (
      !ownerId ||
      !sessionId ||
      this.sessions.has(sessionId) ||
      !["GET", "HEAD"].includes(request.method)
    ) {
      return this.respond(ownerId, request);
    }
    let restoring = this.restoring.get(sessionId);
    if (
      restoring &&
      (restoring.ownerId !== ownerId || restoring.abort.signal.aborted)
    ) {
      return this.respond(ownerId, request);
    }
    if (!restoring) {
      if (
        this.restoring.size + this.pending.size + this.sessions.size >=
        MAX_SESSIONS
      ) {
        return this.respond(ownerId, request);
      }
      const abort = new AbortController();
      const timer = setTimeout(
        () => abort.abort(new Error("Secure playback restoration timed out.")),
        RESTORE_TIMEOUT,
      );
      const locked = () => this.lock(ownerId, sessionId);
      abort.signal.addEventListener("abort", locked, { once: true });
      const promise = this.restore(ownerId, sessionId, abort.signal)
        .catch(() => false)
        .finally(() => {
          clearTimeout(timer);
          abort.signal.removeEventListener("abort", locked);
          if (this.restoring.get(sessionId)?.abort === abort)
            this.restoring.delete(sessionId);
        });
      restoring = { ownerId, abort, promise, waiters: 0 };
      this.restoring.set(sessionId, restoring);
    }
    restoring.waiters += 1;
    try {
      await abortable(restoring.promise, request.signal);
      request.signal.throwIfAborted();
      return this.respond(ownerId, request);
    } catch {
      return new Response(null, {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      });
    } finally {
      restoring.waiters -= 1;
      if (
        restoring.waiters === 0 &&
        this.restoring.get(sessionId) === restoring
      ) {
        restoring.abort.abort(new Error("Playback requests cancelled."));
      }
    }
  }
}

type LifecycleEvent = { waitUntil: (promise: Promise<unknown>) => void };
type WorkerMessage = LifecycleEvent & {
  data: unknown;
  origin: string;
  source: { id?: string } | null;
  ports: readonly MessagePort[];
};
type WorkerFetch = {
  request: Request;
  clientId: string;
  respondWith: (response: Response | Promise<Response>) => void;
};
type WorkerEvents = {
  install: LifecycleEvent;
  activate: LifecycleEvent;
  message: WorkerMessage;
  fetch: WorkerFetch;
};
type WorkerScope = {
  location: { origin: string };
  clients: { claim: () => Promise<void>; get: PlaybackRuntime["getClient"] };
  skipWaiting: () => Promise<void>;
  fetch: typeof fetch;
  addEventListener: <K extends keyof WorkerEvents>(
    type: K,
    listener: (event: WorkerEvents[K]) => void,
  ) => void;
};

if ("clients" in globalThis && "skipWaiting" in globalThis) {
  const scope = globalThis as unknown as WorkerScope;
  const playback = new PlaybackService({
    origin: scope.location.origin,
    fetch: (input, init) => scope.fetch(input, init),
    getClient: (id) => scope.clients.get(id),
  });
  scope.addEventListener("install", (event) =>
    event.waitUntil(scope.skipWaiting()),
  );
  scope.addEventListener("activate", (event) =>
    event.waitUntil(scope.clients.claim()),
  );
  scope.addEventListener("message", (event) => {
    const ownerId = event.source?.id;
    if (
      event.origin !== scope.location.origin ||
      !ownerId ||
      !record(event.data)
    )
      return;
    if (
      event.data.type === "lock" &&
      typeof event.data.sessionId === "string"
    ) {
      playback.lock(ownerId, event.data.sessionId);
    } else if (event.data.type === "unlock") {
      const port = event.ports[0];
      if (!port) return;
      event.waitUntil(
        playback.unlock(ownerId, event.data).then((result) => {
          port.postMessage(result);
          port.close();
        }),
      );
    }
  });
  scope.addEventListener("fetch", (event) => {
    const url = new URL(event.request.url);
    if (
      url.origin === scope.location.origin &&
      url.pathname.startsWith(MEDIA_PREFIX)
    ) {
      event.respondWith(
        playback.respondWithResume(event.clientId, event.request),
      );
    }
  });
}
