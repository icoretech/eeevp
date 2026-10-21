// Exercise the actual AES-GCM chunk boundary behind progressive, cancellable browser playback.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVideo, encryptChunk } from "@/lib/crypto/video-crypto";
import { CHUNK_SIZE } from "@/lib/video/schema";
import { PlaybackService } from "@/workers/playback-sw";

const origin = "https://example.com";
const ownerId = "browser-window-one";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function encryptedVideo(size = CHUNK_SIZE * 3 + 73) {
  const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
  const file = new File([bytes], "sample-video.mp4", { type: "video/mp4" });
  const video = await createVideo(file);
  const packets = await Promise.all(
    Array.from({ length: video.manifest.chunkCount }, async (_, index) => {
      const plaintext = await file
        .slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)
        .arrayBuffer();
      return encryptChunk(
        plaintext,
        index,
        video.manifest,
        video.credentials.key,
      );
    }),
  );
  return { ...video, bytes, packets };
}

async function setup(
  video: Awaited<ReturnType<typeof encryptedVideo>>,
  customFetch?: typeof fetch,
) {
  const fetcher = vi.fn<typeof fetch>(
    customFetch ??
      (async (input) => {
        const url = new URL(
          input instanceof Request ? input.url : input.toString(),
        );
        const index = Number(url.pathname.split("/").at(-1));
        const packet = video.packets[index];
        return packet
          ? new Response(packet, {
              headers: { "Content-Length": String(packet.byteLength) },
            })
          : new Response(null, { status: 404 });
      }),
  );
  const notify = vi.fn();
  const service = new PlaybackService({
    origin,
    fetch: fetcher,
    getClient: async (id) => ({
      id,
      type: "window",
      url: `${origin}/watch/${video.manifest.id}`,
      postMessage: notify,
    }),
  });
  const sessionId = crypto.randomUUID();
  expect(
    await service.unlock(ownerId, { type: "unlock", sessionId, ...video }),
  ).toEqual({ ok: true });
  const url = `${origin}/__eeevp_media__/${sessionId}`;
  return { service, sessionId, fetcher, notify, url };
}

function bodyReader(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Expected a streaming response.");
  return reader;
}

function restorable(
  video: Awaited<ReturnType<typeof encryptedVideo>>,
  fetcher: typeof fetch,
  send: (message: object, port: MessagePort) => void,
) {
  const requests = vi.fn((message: object, transfer?: Transferable[]) => {
    if ("type" in message && message.type === "decryption-activity") return;
    const port = transfer?.[0];
    if (!(port instanceof MessagePort))
      throw new Error("Expected an owner-only restoration channel.");
    send(message, port);
  });
  const service = new PlaybackService({
    origin,
    fetch: fetcher,
    getClient: async (id) => ({
      id,
      type: "window",
      url: `${origin}/watch/${video.manifest.id}`,
      postMessage: requests,
    }),
  });
  return { service, requests };
}

describe("encrypted video progressive playback", () => {
  it("emits only owner-bound verified decryption activity after real AES-GCM output", async () => {
    const video = await encryptedVideo(19);
    const { service, sessionId, notify, url } = await setup(video);
    const response = service.respond(ownerId, new Request(url));
    expect(
      Buffer.from(await response.arrayBuffer()).equals(
        Buffer.from(video.bytes),
      ),
    ).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls.map(([message]) => message)).toEqual([
      {
        type: "decryption-activity",
        sessionId,
        index: 0,
        plaintextBytes: 19,
        phase: "verified",
      },
    ]);
    for (const [message] of notify.mock.calls) {
      expect(JSON.stringify(message)).not.toContain(video.credentials.key);
      expect(JSON.stringify(message)).not.toContain(video.manifest.id);
      expect(Object.keys(message as object).sort()).toEqual([
        "index",
        "phase",
        "plaintextBytes",
        "sessionId",
        "type",
      ]);
    }
  });

  it("does not emit verified activity for corrupted or canceled ciphertext", async () => {
    const video = await encryptedVideo(19);
    const invalid = new Uint8Array(video.packets[0]);
    new DataView(invalid.buffer).setUint8(12, invalid[12] === 0 ? 1 : 0);
    const tampered = await setup(video, async () => new Response(invalid));
    await expect(
      tampered.service
        .respond(ownerId, new Request(tampered.url))
        .arrayBuffer(),
    ).rejects.toThrow("Secure playback failed");
    expect(tampered.notify).not.toHaveBeenCalled();

    const pending = Promise.withResolvers<Response>();
    const canceled = await setup(video, () => pending.promise);
    const response = canceled.service.respond(
      ownerId,
      new Request(canceled.url),
    );
    const reader = bodyReader(response);
    const reading = reader.read();
    await Promise.resolve();
    await reader.cancel();
    pending.resolve(new Response(video.packets[0]));
    await reading;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(canceled.notify).not.toHaveBeenCalled();
  });

  it("keeps byte streaming independent of a closed telemetry recipient", async () => {
    const video = await encryptedVideo(19);
    const { service, notify, url } = await setup(video);
    notify.mockImplementation(() => {
      throw new Error("Owner window closed");
    });
    expect(
      Buffer.from(
        await service.respond(ownerId, new Request(url)).arrayBuffer(),
      ).equals(Buffer.from(video.bytes)),
    ).toBe(true);
  });

  it("cannot restore a competing client's session id while its owner is restoring", async () => {
    const video = await encryptedVideo(19);
    const { sessionId, fetcher, url } = await setup(video);
    const channel = Promise.withResolvers<MessagePort>();
    const { service, requests } = restorable(video, fetcher, (_message, port) =>
      channel.resolve(port),
    );
    const own = service.respondWithResume(ownerId, new Request(url));
    const port = await channel.promise;
    expect(
      (await service.respondWithResume("browser-window-two", new Request(url)))
        .status,
    ).toBe(403);
    expect(requests).toHaveBeenCalledTimes(1);
    port.postMessage({ type: "unlock", sessionId, ...video });
    port.close();
    const response = await own;
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(video.bytes);
    service.lock(ownerId, sessionId);
  });

  it("does not resurrect a locked session when real metadata decryption completes late", async () => {
    const video = await encryptedVideo(19);
    const { sessionId, fetcher, url } = await setup(video);
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(crypto.subtle, "decrypt").mockImplementation(async (...args) => {
      const plaintext = await decrypt(...args);
      entered.resolve();
      await release.promise;
      return plaintext;
    });
    const { service } = restorable(video, fetcher, (_message, port) => {
      port.postMessage({ type: "unlock", sessionId, ...video });
      port.close();
    });
    const restoring = service.respondWithResume(ownerId, new Request(url));
    await entered.promise;
    service.lock(ownerId, sessionId);
    expect((await restoring).status).toBe(403);
    release.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(service.respond(ownerId, new Request(url)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("restores an idle-terminated worker from its still-open owning window before a seek", async () => {
    const video = await encryptedVideo(CHUNK_SIZE + 19);
    const { sessionId, fetcher, url } = await setup(video);
    const { service, requests } = restorable(
      video,
      fetcher,
      (_message, port) => {
        port.postMessage({ type: "unlock", sessionId, ...video });
        port.close();
      },
    );
    const response = await service.respondWithResume(
      ownerId,
      new Request(url, {
        headers: { Range: `bytes=${CHUNK_SIZE - 5}-${CHUNK_SIZE + 8}` },
      }),
    );
    expect(requests).toHaveBeenCalledTimes(1);
    expect(requests.mock.calls[0]?.[0]).toEqual({
      type: "playback-resume",
      sessionId,
    });
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      video.bytes.slice(CHUNK_SIZE - 5, CHUNK_SIZE + 9),
    );
    expect(service.respond("browser-window-two", new Request(url)).status).toBe(
      403,
    );
    service.lock(ownerId, sessionId);
  });

  it("deduplicates simultaneous range restorations and preserves a second reader when one cancels", async () => {
    const video = await encryptedVideo(19);
    const { sessionId, fetcher, url } = await setup(video);
    const channel = Promise.withResolvers<MessagePort>();
    const { service, requests } = restorable(video, fetcher, (_message, port) =>
      channel.resolve(port),
    );
    const cancelled = new AbortController();
    const first = service.respondWithResume(
      ownerId,
      new Request(url, {
        signal: cancelled.signal,
        headers: { Range: "bytes=0-8" },
      }),
    );
    const second = service.respondWithResume(
      ownerId,
      new Request(url, { headers: { Range: "bytes=9-18" } }),
    );
    const port = await channel.promise;
    expect(requests).toHaveBeenCalledTimes(1);
    cancelled.abort();
    expect((await first).status).toBe(403);
    port.postMessage({ type: "unlock", sessionId, ...video });
    port.close();
    const response = await second;
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      video.bytes.slice(9),
    );
    service.lock(ownerId, sessionId);
  });

  it.each(["lock", "cancel"])(
    "refuses late restoration keys after %s",
    async (action) => {
      const video = await encryptedVideo(19);
      const { sessionId, fetcher, url } = await setup(video);
      const channel = Promise.withResolvers<MessagePort>();
      const { service } = restorable(video, fetcher, (_message, port) =>
        channel.resolve(port),
      );
      const cancellation = new AbortController();
      const pending = service.respondWithResume(
        ownerId,
        new Request(url, { signal: cancellation.signal }),
      );
      const port = await channel.promise;
      if (action === "lock") service.lock(ownerId, sessionId);
      else cancellation.abort();
      expect((await pending).status).toBe(403);
      port.postMessage({ type: "unlock", sessionId, ...video });
      port.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(service.respond(ownerId, new Request(url)).status).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("times out restoration without persisting or accepting a late key", async () => {
    const video = await encryptedVideo(19);
    const { sessionId, fetcher, url } = await setup(video);
    const channel = Promise.withResolvers<MessagePort>();
    const { service } = restorable(video, fetcher, (_message, port) =>
      channel.resolve(port),
    );
    vi.useFakeTimers();
    const pending = service.respondWithResume(ownerId, new Request(url));
    const port = await channel.promise;
    await vi.advanceTimersByTimeAsync(5_001);
    expect((await pending).status).toBe(403);
    port.postMessage({ type: "unlock", sessionId, ...video });
    port.close();
    expect(service.respond(ownerId, new Request(url)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("decrypts only chunks crossed by a seek and returns exact HTTP range headers", async () => {
    const video = await encryptedVideo();
    const { service, fetcher, url } = await setup(video);
    const start = CHUNK_SIZE * 2 - 17;
    const end = CHUNK_SIZE * 2 + 28;
    const response = service.respond(
      ownerId,
      new Request(url, { headers: { Range: `bytes=${start}-${end}` } }),
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(
      `bytes ${start}-${end}/${video.manifest.size}`,
    );
    expect(response.headers.get("Content-Length")).toBe(
      String(end - start + 1),
    );
    expect(response.headers.get("Content-Type")).toBe("video/mp4");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(fetcher).not.toHaveBeenCalled();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      video.bytes.slice(start, end + 1),
    );
    expect(fetcher.mock.calls.map(([input]) => String(input))).toEqual([
      `${origin}/api/videos/${video.manifest.id}/chunks/1`,
      `${origin}/api/videos/${video.manifest.id}/chunks/2`,
    ]);
    for (const [, options] of fetcher.mock.calls) {
      expect(new Headers(options?.headers).has("X-Video-Token")).toBe(false);
      expect(new Headers(options?.headers).has("Authorization")).toBe(false);
      expect(options).toMatchObject({
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
      });
      expect(options?.body).toBeUndefined();
    }
  });

  it("revokes playback and notifies only its owner when the library cookie expires", async () => {
    const video = await encryptedVideo(19);
    const { service, sessionId, fetcher, notify, url } = await setup(
      video,
      async () => new Response(null, { status: 401 }),
    );
    const response = service.respond(ownerId, new Request(url));
    await expect(response.arrayBuffer()).rejects.toThrow(
      "Your library session expired. Sign in and unlock the library again.",
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      type: "playback-error",
      sessionId,
      code: "session-expired",
      message:
        "Your library session expired. Sign in and unlock the library again.",
    });
    expect(
      notify.mock.calls.filter(
        ([message]) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "playback-error",
      ),
    ).toHaveLength(1);
    expect(service.respond(ownerId, new Request(url)).status).toBe(403);
    expect(service.respond("browser-window-two", new Request(url)).status).toBe(
      403,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("backpressures full playback to one decrypted chunk per read", async () => {
    const video = await encryptedVideo(CHUNK_SIZE * 2 + 11);
    const { service, fetcher, url } = await setup(video);
    const response = service.respond(ownerId, new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(
      String(video.manifest.size),
    );
    expect(response.headers.has("Content-Range")).toBe(false);
    const reader = bodyReader(response);
    expect(fetcher).not.toHaveBeenCalled();
    const first = await reader.read();
    expect(first.value).toEqual(video.bytes.slice(0, CHUNK_SIZE));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const second = await reader.read();
    expect(second.value).toEqual(video.bytes.slice(CHUNK_SIZE, CHUNK_SIZE * 2));
    expect(fetcher).toHaveBeenCalledTimes(2);
    const last = await reader.read();
    expect(last.value).toEqual(video.bytes.slice(CHUNK_SIZE * 2));
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it.each(["bytes=-11", `bytes=${CHUNK_SIZE * 2}-`])(
    "serves the final partial chunk for %s",
    async (range) => {
      const video = await encryptedVideo(CHUNK_SIZE * 2 + 11);
      const { service, fetcher, url } = await setup(video);
      const response = service.respond(
        ownerId,
        new Request(url, { headers: { Range: range } }),
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(
        video.bytes.slice(-11),
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(String(fetcher.mock.calls[0]?.[0])).toBe(
        `${origin}/api/videos/${video.manifest.id}/chunks/2`,
      );
    },
  );

  it("handles HEAD without fetching or decrypting chunks, ignoring its Range header", async () => {
    const video = await encryptedVideo(19);
    const { service, fetcher, url } = await setup(video);
    const response = service.respond(
      ownerId,
      new Request(url, { method: "HEAD", headers: { Range: "bytes=3-7" } }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get("Content-Length")).toBe("19");
    expect(response.headers.has("Content-Range")).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed and multiple ranges without fetching ciphertext", async () => {
    const video = await encryptedVideo(19);
    const { service, fetcher, url } = await setup(video);
    for (const range of [
      "bytes=0-2,4-6",
      "bytes=-0",
      "bytes=19-",
      "bytes=4-2",
      "items=0-3",
    ]) {
      const response = service.respond(
        ownerId,
        new Request(url, { headers: { Range: range } }),
      );
      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe("bytes */19");
      expect(response.headers.get("Content-Length")).toBe("0");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("binds a session to its originating browser client and rejects replay after locking or restart", async () => {
    const video = await encryptedVideo(19);
    const { service, sessionId, fetcher, url } = await setup(video);
    expect(service.respond("browser-window-two", new Request(url)).status).toBe(
      403,
    );
    expect(service.respond("", new Request(url)).status).toBe(403);
    expect(
      service.respond(ownerId, new Request(`${url}?key=untrusted`)).status,
    ).toBe(403);
    service.lock("browser-window-two", sessionId);
    expect(
      service.respond(ownerId, new Request(url, { method: "HEAD" })).status,
    ).toBe(200);
    service.lock(ownerId, sessionId);
    expect(service.respond(ownerId, new Request(url)).status).toBe(403);
    const restarted = new PlaybackService({
      origin,
      fetch: fetcher,
      getClient: async () => undefined,
    });
    expect(restarted.respond(ownerId, new Request(url)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects wrong keys, mismatched identities, forged metadata, and non-window owners at unlock", async () => {
    const video = await encryptedVideo(19);
    const other = await encryptedVideo(19);
    const service = new PlaybackService({
      origin,
      fetch: vi.fn<typeof fetch>(),
      getClient: async (id) => ({
        id,
        type: id === "worker-client" ? "worker" : "window",
        url: `${origin}/`,
        postMessage: vi.fn(),
      }),
    });
    for (const message of [
      {
        ...video,
        credentials: { ...video.credentials, key: other.credentials.key },
      },
      { ...video, credentials: other.credentials },
      { ...video, metadata: { ...video.metadata, type: "video/webm" } },
      { ...video, metadata: { ...video.metadata, name: "forged.mp4" } },
    ]) {
      expect(
        await service.unlock(ownerId, {
          sessionId: crypto.randomUUID(),
          ...message,
        }),
      ).toMatchObject({ ok: false });
    }
    expect(
      await service.unlock("worker-client", {
        sessionId: crypto.randomUUID(),
        ...video,
      }),
    ).toMatchObject({ ok: false });
  });

  it("does not resurrect a pending unlock after its owner closes it", async () => {
    const video = await encryptedVideo(19);
    const client = Promise.withResolvers<{
      id: string;
      type: string;
      url: string;
      postMessage: (message: object) => void;
    }>();
    const service = new PlaybackService({
      origin,
      fetch: vi.fn<typeof fetch>(),
      getClient: () => client.promise,
    });
    const sessionId = crypto.randomUUID();
    const unlocking = service.unlock(ownerId, { sessionId, ...video });
    service.lock(ownerId, sessionId);
    client.resolve({
      id: ownerId,
      type: "window",
      url: origin,
      postMessage: vi.fn(),
    });
    expect(await unlocking).toMatchObject({ ok: false });
    expect(
      service.respond(
        ownerId,
        new Request(`${origin}/__eeevp_media__/${sessionId}`),
      ).status,
    ).toBe(403);
  });

  it("propagates reader cancellation to its in-flight chunk request", async () => {
    const video = await encryptedVideo(19);
    const started = Promise.withResolvers<AbortSignal>();
    const { service, url } = await setup(video, async (_input, options) => {
      const signal = options?.signal;
      if (!signal) throw new Error("Expected an abortable fetch.");
      started.resolve(signal);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    });
    const reader = bodyReader(service.respond(ownerId, new Request(url)));
    const reading = reader.read();
    const signal = await started.promise;
    await reader.cancel();
    expect(signal.aborted).toBe(true);
    expect(await reading).toEqual({ done: true, value: undefined });
  });

  it("aborts an active request as soon as its owner locks playback", async () => {
    const video = await encryptedVideo(19);
    const started = Promise.withResolvers<AbortSignal>();
    const { service, sessionId, url } = await setup(
      video,
      async (_input, options) => {
        const signal = options?.signal;
        if (!signal) throw new Error("Expected an abortable fetch.");
        started.resolve(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    );
    const reader = bodyReader(service.respond(ownerId, new Request(url)));
    const reading = expect(reader.read()).rejects.toThrow(
      "Secure playback failed",
    );
    const signal = await started.promise;
    service.lock(ownerId, sessionId);
    await reading;
    expect(signal.aborted).toBe(true);
    expect(service.respond(ownerId, new Request(url)).status).toBe(403);
  });

  it.each(["tampered", "truncated", "oversized", "unavailable"])(
    "fails closed when the backing encrypted chunk is %s",
    async (kind) => {
      const video = await encryptedVideo(19);
      const { service, url } = await setup(video, async () => {
        if (kind === "unavailable") return new Response(null, { status: 404 });
        const packet = video.packets[0];
        if (!packet) throw new Error("Expected a packet.");
        if (kind === "truncated") return new Response(packet.slice(0, -1));
        if (kind === "oversized")
          return new Response(new Uint8Array(packet.byteLength + 1));
        const copy = packet.slice(0);
        const bytes = new DataView(copy);
        bytes.setUint8(12, bytes.getUint8(12) ^ 1);
        return new Response(copy);
      });
      await expect(
        service.respond(ownerId, new Request(url)).arrayBuffer(),
      ).rejects.toThrow("Secure playback failed");
    },
  );
});
