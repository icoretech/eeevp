// Open a browser-owned streaming session and release its worker-held key when playback closes.
import type { VideoCredentials, VideoManifest, VideoMetadata } from "./schema";

const STARTUP_TIMEOUT = 20_000;
const WORKER_PATH = "/eeevp-sw.js";

export class PlaybackSessionExpired extends Error {
  readonly code = "session-expired";

  constructor() {
    super(
      "Your library session expired. Sign in and unlock the library again.",
    );
    this.name = "PlaybackSessionExpired";
  }
}

function abortError() {
  return new DOMException("Playback opening was cancelled.", "AbortError");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? abortError());
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function isPlaybackWorker(
  worker: ServiceWorker | null,
): worker is ServiceWorker {
  return (
    worker !== null &&
    worker.scriptURL === new URL(WORKER_PATH, window.location.origin).href
  );
}

function waitForController(signal: AbortSignal) {
  return new Promise<ServiceWorker>((resolve, reject) => {
    const cleanup = () => {
      navigator.serviceWorker.removeEventListener("controllerchange", changed);
      signal.removeEventListener("abort", aborted);
    };
    const changed = () => {
      const controller = navigator.serviceWorker.controller;
      if (!isPlaybackWorker(controller)) return;
      cleanup();
      resolve(controller);
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason ?? abortError());
    };
    navigator.serviceWorker.addEventListener("controllerchange", changed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else changed();
  });
}

function unlock(
  worker: ServiceWorker,
  message: {
    type: "unlock";
    sessionId: string;
    manifest: VideoManifest;
    credentials: VideoCredentials;
    metadata: VideoMetadata;
  },
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const channel = new MessageChannel();
    const cleanup = () => {
      signal.removeEventListener("abort", aborted);
      channel.port1.close();
      channel.port2.close();
    };
    const aborted = () => {
      cleanup();
      reject(signal.reason ?? abortError());
    };
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      cleanup();
      if (
        typeof data === "object" &&
        data !== null &&
        "ok" in data &&
        data.ok === true
      ) {
        resolve();
      } else {
        const error =
          typeof data === "object" &&
          data !== null &&
          "error" in data &&
          typeof data.error === "string"
            ? data.error
            : "The secure playback worker returned an invalid response. Reload this page.";
        reject(new Error(error));
      }
    };
    channel.port1.onmessageerror = () => {
      cleanup();
      reject(
        new Error(
          "The secure playback worker could not start. Reload this page.",
        ),
      );
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) {
      aborted();
      return;
    }
    try {
      worker.postMessage(message, [channel.port2]);
    } catch {
      cleanup();
      reject(
        new Error(
          "The secure playback worker stopped. Reload this page and open the video again.",
        ),
      );
    }
  });
}

export async function openPlayback(
  manifest: VideoManifest,
  credentials: VideoCredentials,
  metadata: VideoMetadata,
  signal?: AbortSignal,
) {
  if (
    typeof window === "undefined" ||
    !("serviceWorker" in navigator) ||
    !window.isSecureContext
  ) {
    throw new Error(
      "Secure video playback requires a browser with service workers over HTTPS or localhost.",
    );
  }
  signal?.throwIfAborted();
  const sessionId = crypto.randomUUID();
  const startup = new AbortController();
  const disconnected = new AbortController();
  let worker: ServiceWorker | undefined;
  let closed = false;
  const timeout = window.setTimeout(() => {
    startup.abort(
      new Error(
        "The secure playback worker timed out. Reload this page and open the video again.",
      ),
    );
  }, STARTUP_TIMEOUT);
  const changed = () => {
    if (worker && navigator.serviceWorker.controller !== worker) {
      const reason = new Error(
        "Secure playback restarted. Open the video again.",
      );
      disconnected.abort(reason);
      startup.abort(reason);
      close();
    }
  };
  const failed = (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (
      event.source !== worker ||
      event.origin !== window.location.origin ||
      typeof data !== "object" ||
      data === null ||
      !("type" in data) ||
      data.type !== "playback-error" ||
      !("sessionId" in data) ||
      data.sessionId !== sessionId ||
      !("code" in data) ||
      data.code !== "session-expired"
    )
      return;
    const reason = new PlaybackSessionExpired();
    disconnected.abort(reason);
    startup.abort(reason);
    close();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    window.clearTimeout(timeout);
    startup.abort(abortError());
    signal?.removeEventListener("abort", close);
    window.removeEventListener("pagehide", close);
    navigator.serviceWorker.removeEventListener("controllerchange", changed);
    navigator.serviceWorker.removeEventListener("message", failed);
    try {
      worker?.postMessage({ type: "lock", sessionId });
    } catch {
      // A stopped worker already discarded its in-memory sessions.
    }
  };
  signal?.addEventListener("abort", close, { once: true });
  window.addEventListener("pagehide", close, { once: true });
  try {
    await abortable(
      navigator.serviceWorker.register(WORKER_PATH, {
        scope: "/",
        updateViaCache: "none",
      }),
      startup.signal,
    );
    worker = await waitForController(startup.signal);
    navigator.serviceWorker.addEventListener("controllerchange", changed);
    navigator.serviceWorker.addEventListener("message", failed);
    changed();
    await unlock(
      worker,
      { type: "unlock", sessionId, manifest, credentials, metadata },
      startup.signal,
    );
    startup.signal.throwIfAborted();
    window.clearTimeout(timeout);
    return {
      url: new URL(`/__eeevp_media__/${sessionId}`, window.location.origin)
        .href,
      close,
      disconnected: disconnected.signal,
    };
  } catch (error) {
    close();
    throw error;
  }
}
