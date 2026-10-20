// Verify the browser/worker handshake releases keys on cancellation and reports controller replacement.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVideo } from "@/lib/crypto/video-crypto";
import { openPlayback, PlaybackSessionExpired } from "@/lib/video/playback";

const origin = "https://example.com";

async function video() {
  return createVideo(new File(["sample"], "sample.mp4", { type: "video/mp4" }));
}

function browser({ acknowledge = true, secure = true } = {}) {
  const worker = {
    scriptURL: `${origin}/eeevp-sw.js`,
    postMessage: vi.fn(
      (message: { type: string }, transfer?: Transferable[]) => {
        if (!acknowledge || message.type !== "unlock") return;
        const port = transfer?.[0];
        if (!(port instanceof MessagePort))
          throw new Error("Expected a private handshake channel.");
        port.postMessage({ ok: true });
      },
    ),
  };
  const serviceWorker = Object.assign(new EventTarget(), {
    controller: worker,
    register: vi.fn(async () => ({})),
  });
  const window = Object.assign(new EventTarget(), {
    location: { origin },
    isSecureContext: secure,
    setTimeout,
    clearTimeout,
  });
  vi.stubGlobal("navigator", { serviceWorker });
  vi.stubGlobal("window", window);
  return { worker, serviceWorker, window };
}

function workerMessage(
  target: EventTarget,
  source: object,
  sessionId: string,
  messageOrigin = origin,
) {
  const event = new Event("message");
  Object.defineProperties(event, {
    source: { value: source },
    origin: { value: messageOrigin },
    data: {
      value: { type: "playback-error", code: "session-expired", sessionId },
    },
  });
  target.dispatchEvent(event);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("browser playback session lifecycle", () => {
  it("waits for private unlock acknowledgement and releases its key on normal close", async () => {
    const { worker, serviceWorker } = browser();
    const { manifest, credentials, metadata } = await video();
    const playback = await openPlayback(manifest, credentials, metadata);
    expect(serviceWorker.register).toHaveBeenCalledWith("/eeevp-sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
    expect(playback.url).toMatch(
      /^https:\/\/example\.com\/__eeevp_media__\/[a-f0-9-]{36}$/,
    );
    expect(playback.url).not.toContain(credentials.key);
    expect(new URL(playback.url).search).toBe("");
    expect(new URL(playback.url).hash).toBe("");
    expect(worker.postMessage.mock.calls[0]?.[0]).toMatchObject({
      type: "unlock",
      manifest,
      credentials,
      metadata,
    });
    playback.close();
    playback.close();
    expect(worker.postMessage).toHaveBeenCalledTimes(2);
    expect(worker.postMessage.mock.calls[1]?.[0]).toEqual({
      type: "lock",
      sessionId: new URL(playback.url).pathname.split("/").at(-1),
    });
    expect(playback.disconnected.aborted).toBe(false);
  });

  it("reports controller replacement with an actionable error and locks the former worker", async () => {
    const { worker, serviceWorker } = browser();
    const { manifest, credentials, metadata } = await video();
    const playback = await openPlayback(manifest, credentials, metadata);
    serviceWorker.controller = { ...worker, postMessage: vi.fn() };
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(playback.disconnected.aborted).toBe(true);
    expect(playback.disconnected.reason).not.toBeInstanceOf(
      PlaybackSessionExpired,
    );
    expect(playback.disconnected.reason).toEqual(
      new Error("Secure playback restarted. Open the video again."),
    );
    expect(worker.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "lock",
    });
  });

  it("closes normally when the user leaves the page", async () => {
    const { window, worker } = browser();
    const { manifest, credentials, metadata } = await video();
    const playback = await openPlayback(manifest, credentials, metadata);
    window.dispatchEvent(new Event("pagehide"));
    expect(worker.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "lock",
    });
    expect(playback.disconnected.aborted).toBe(false);
  });

  it("surfaces session expiry only from its owning worker for the matching playback session", async () => {
    const { worker, serviceWorker } = browser();
    const { manifest, credentials, metadata } = await video();
    const playback = await openPlayback(manifest, credentials, metadata);
    const sessionId = new URL(playback.url).pathname.split("/").at(-1);
    if (!sessionId) throw new Error("Expected a playback session id.");
    workerMessage(serviceWorker, {}, sessionId);
    workerMessage(serviceWorker, worker, crypto.randomUUID());
    workerMessage(
      serviceWorker,
      worker,
      sessionId,
      "https://untrusted.example.com",
    );
    expect(playback.disconnected.aborted).toBe(false);
    workerMessage(serviceWorker, worker, sessionId);
    expect(playback.disconnected.aborted).toBe(true);
    expect(playback.disconnected.reason).toBeInstanceOf(PlaybackSessionExpired);
    expect(playback.disconnected.reason).toMatchObject({
      name: "PlaybackSessionExpired",
      code: "session-expired",
    });
    expect(playback.disconnected.reason).toEqual(new PlaybackSessionExpired());
    expect(worker.postMessage.mock.calls.at(-1)?.[0]).toEqual({
      type: "lock",
      sessionId,
    });
  });

  it("cancels a pending unlock and sends a lock even before acknowledgement", async () => {
    const { worker } = browser({ acknowledge: false });
    const { manifest, credentials, metadata } = await video();
    const signal = new AbortController();
    const opening = openPlayback(
      manifest,
      credentials,
      metadata,
      signal.signal,
    );
    const rejected = expect(opening).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledTimes(1));
    signal.abort();
    await rejected;
    expect(worker.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "lock",
    });
  });

  it("bounds worker startup by a timeout", async () => {
    vi.useFakeTimers();
    const { serviceWorker } = browser();
    serviceWorker.register.mockImplementation(() => new Promise(() => {}));
    const { manifest, credentials, metadata } = await video();
    const opening = expect(
      openPlayback(manifest, credentials, metadata),
    ).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(20_001);
    await opening;
  });

  it("refuses to send keys through an unrelated controlling worker", async () => {
    const { serviceWorker, worker } = browser();
    serviceWorker.controller = {
      ...worker,
      scriptURL: `${origin}/unrelated-worker.js`,
    };
    const { manifest, credentials, metadata } = await video();
    const cancellation = new AbortController();
    const opening = openPlayback(
      manifest,
      credentials,
      metadata,
      cancellation.signal,
    );
    const rejected = expect(opening).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() =>
      expect(serviceWorker.register).toHaveBeenCalledTimes(1),
    );
    expect(worker.postMessage).not.toHaveBeenCalled();
    cancellation.abort();
    await rejected;
  });

  it("rejects unsupported insecure contexts before registration", async () => {
    const { serviceWorker } = browser({ secure: false });
    const { manifest, credentials, metadata } = await video();
    await expect(openPlayback(manifest, credentials, metadata)).rejects.toThrow(
      "HTTPS or localhost",
    );
    expect(serviceWorker.register).not.toHaveBeenCalled();
  });
});
