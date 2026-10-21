// The real upload worker talks to actual Next routes and disk storage through a browser transport adapter.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { POST as initializeLibrary } from "@/app/api/library/route";
import { POST as signIn } from "@/app/api/session/route";
import {
  GET as readChunk,
  PUT as uploadChunk,
} from "@/app/api/videos/[id]/chunks/[index]/route";
import { POST as complete } from "@/app/api/videos/[id]/complete/route";
import { GET as readVideo } from "@/app/api/videos/[id]/route";
import { POST as createDraft } from "@/app/api/videos/route";
import {
  createLibraryDescriptor,
  createLibraryKey,
  unwrapVideoKey,
} from "@/lib/crypto/library-crypto";
import { decryptChunk } from "@/lib/crypto/video-crypto";
import {
  CHUNK_SIZE,
  libraryVideoSchema,
  metadataSchema,
} from "@/lib/video/schema";

const origin = "https://example.com";
let directory: string;
let libraryKey: string;

beforeEach(async () => {
  vi.resetModules();
  directory = await mkdtemp(join(tmpdir(), "eeevp-worker-route-"));
  libraryKey = createLibraryKey();
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubEnv("DEMO_MODE", "false");
  vi.stubEnv("STORAGE_DRIVER", "filesystem");
  vi.stubEnv(
    "SESSION_SECRET",
    "sample-session-secret-for-tests-only-123456789",
  );
  vi.stubEnv("STORAGE_PATH", directory);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("upload worker and real route contract", () => {
  it.each([
    {
      scenario: "completes after each chunk is acknowledged",
      failFirstChunk: false,
    },
    {
      scenario: "stops reading and encrypting after the first failed chunk",
      failFirstChunk: true,
    },
  ])("bounds upload memory and $scenario", async ({ failFirstChunk }) => {
    const session = await signIn(
      new NextRequest(`${origin}/api/session`, {
        method: "POST",
        headers: { origin, "Content-Type": "application/json" },
        body: "{}",
      }),
    );
    expect(session.status).toBe(200);
    const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("A real browser session is required.");
    const library = await createLibraryDescriptor(libraryKey);
    const initialized = await initializeLibrary(
      new NextRequest(`${origin}/api/library`, {
        method: "POST",
        headers: { origin, cookie, "Content-Type": "application/json" },
        body: JSON.stringify(library),
      }),
    );
    expect(initialized.status).toBe(201);

    const requests: Array<{ path: string; init: RequestInit }> = [];
    const firstChunkStarted = Promise.withResolvers<void>();
    const releaseFirstChunk = Promise.withResolvers<void>();
    const messages: unknown[] = [];
    const handlers: Array<(event: MessageEvent<unknown>) => Promise<void>> = [];
    let closed = false;
    vi.stubGlobal("self", {
      postMessage(message: unknown) {
        messages.push(message);
      },
      close() {
        closed = true;
      },
      addEventListener(
        type: string,
        handler: (event: MessageEvent<unknown>) => Promise<void>,
      ) {
        expect(type).toBe("message");
        handlers.push(handler);
      },
    });
    // Only browser transport is adapted: validation, sessions, crypto, routes, and storage are real.
    vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
      requests.push({ path, init });
      expect(init.mode).toBe("same-origin");
      expect(init.credentials).toBe("same-origin");
      expect(init.redirect).toBe("error");
      const headers = new Headers(init.headers);
      headers.set("origin", origin);
      headers.set("cookie", cookie);
      const { signal, ...options } = init;
      const request = new NextRequest(new URL(path, origin), {
        ...options,
        headers,
        ...(signal ? { signal } : {}),
      });
      if (path === "/api/videos") return createDraft(request);
      const chunk = /^\/api\/videos\/([^/]+)\/chunks\/(\d+)$/.exec(path);
      if (chunk) {
        const [, id, index] = chunk;
        if (index === "0") {
          firstChunkStarted.resolve();
          await releaseFirstChunk.promise;
          if (failFirstChunk) return new Response(null, { status: 503 });
        }
        return uploadChunk(request, { params: Promise.resolve({ id, index }) });
      }
      const finalization = /^\/api\/videos\/([^/]+)\/complete$/.exec(path);
      if (finalization) {
        const [, id] = finalization;
        return complete(request, { params: Promise.resolve({ id }) });
      }
      const video = /^\/api\/videos\/([^/]+)$/.exec(path);
      if (video) {
        const [, id] = video;
        return readVideo(request, { params: Promise.resolve({ id }) });
      }
      throw new Error("Unexpected upload request path.");
    });

    await import("@/workers/upload-worker");
    const receive = handlers.at(0);
    if (!receive)
      throw new Error(
        "The upload worker did not register its message handler.",
      );
    const bytes = new Uint8Array(CHUNK_SIZE + 37).map(
      (_, index) => index % 251,
    );
    const file = new File([bytes], "sample-video.webm", { type: "video/webm" });
    const slices = vi.spyOn(file, "slice");
    const wholeFile = vi.spyOn(file, "arrayBuffer");
    const uploading = receive(
      new MessageEvent("message", {
        data: { type: "upload", file, libraryKey, library },
      }),
    );
    try {
      await firstChunkStarted.promise;
      expect(slices).toHaveBeenCalledExactlyOnceWith(0, CHUNK_SIZE);
      expect(wholeFile).not.toHaveBeenCalled();
      expect(requests.filter(({ init }) => init.method === "PUT")).toHaveLength(
        1,
      );
      expect(messages).toEqual([
        {
          type: "progress",
          phase: "encrypting",
          completed: 0,
          total: file.size,
        },
        {
          type: "progress",
          phase: "uploading",
          completed: 0,
          total: file.size,
        },
      ]);
      expect(closed).toBe(false);
    } finally {
      releaseFirstChunk.resolve();
      await uploading;
    }
    const draftBody = requests[0]?.init.body;
    expect(typeof draftBody).toBe("string");
    expect(draftBody).not.toContain(libraryKey);
    expect(draftBody).not.toContain(file.name);
    expect(draftBody).not.toContain(file.type);
    if (failFirstChunk) {
      expect(slices).toHaveBeenCalledExactlyOnceWith(0, CHUNK_SIZE);
      expect(wholeFile).not.toHaveBeenCalled();
      expect(requests.map(({ init }) => init.method)).toEqual(["POST", "PUT"]);
      expect(messages).toEqual([
        {
          type: "progress",
          phase: "encrypting",
          completed: 0,
          total: file.size,
        },
        {
          type: "progress",
          phase: "uploading",
          completed: 0,
          total: file.size,
        },
        {
          type: "error",
          message:
            "Uploading an encrypted chunk failed (HTTP 503). Please try again.",
        },
      ]);
      expect(closed).toBe(true);
      return;
    }
    expect(slices.mock.calls).toEqual([
      [0, CHUNK_SIZE],
      [CHUNK_SIZE, file.size],
    ]);
    expect(wholeFile).not.toHaveBeenCalled();

    const result = z
      .strictObject({
        type: z.literal("complete"),
        video: libraryVideoSchema,
        metadata: metadataSchema,
      })
      .parse(messages.at(-1));
    const { video } = result;
    expect(closed).toBe(true);
    expect(requests).toHaveLength(video.manifest.chunkCount + 3);
    const finalRequest = requests.at(-2);
    expect(finalRequest?.path).toBe(
      `/api/videos/${video.manifest.id}/complete`,
    );
    expect(finalRequest?.init.body).toBeUndefined();
    const chunkRequests = requests.filter(({ init }) => init.method === "PUT");
    expect(chunkRequests).toHaveLength(2);
    expect(
      chunkRequests.every(
        ({ init }) =>
          init.body instanceof ArrayBuffer &&
          init.body.byteLength <= CHUNK_SIZE + 28,
      ),
    ).toBe(true);

    const headers = { cookie };
    const manifestResponse = await readVideo(
      new NextRequest(`${origin}/api/videos/${video.manifest.id}`, { headers }),
      {
        params: Promise.resolve({ id: video.manifest.id }),
      },
    );
    expect(manifestResponse.status).toBe(200);
    expect(await manifestResponse.json()).toEqual({ video });
    const videoKey = await unwrapVideoKey(
      video.manifest,
      video.wrappedKey,
      libraryKey,
      library.id,
    );
    for (let index = 0; index < video.manifest.chunkCount; index += 1) {
      const response = await readChunk(
        new NextRequest(
          `${origin}/api/videos/${video.manifest.id}/chunks/${index}`,
          { headers },
        ),
        {
          params: Promise.resolve({
            id: video.manifest.id,
            index: String(index),
          }),
        },
      );
      expect(response.status).toBe(200);
      const plaintext = await decryptChunk(
        await response.arrayBuffer(),
        index,
        video.manifest,
        videoKey,
      );
      expect(
        Buffer.from(plaintext).equals(
          Buffer.from(
            bytes.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
          ),
        ),
      ).toBe(true);
    }
  });

  it.each([
    {
      scenario: "incorrect canonical key",
      malformedKey: false,
      validFile: true,
      expectedMessage: null,
    },
    {
      scenario: "noncanonical entered key",
      malformedKey: true,
      validFile: true,
      expectedMessage: "This encryption key cannot add videos to the library.",
    },
    {
      scenario: "invalid file",
      malformedKey: false,
      validFile: false,
      expectedMessage: "Choose a valid video file before uploading.",
    },
  ])(
    "rejects $scenario before sending a request and closes its key-holding realm",
    async ({ malformedKey, validFile, expectedMessage }) => {
      const library = await createLibraryDescriptor(createLibraryKey());
      const messages: unknown[] = [];
      const handlers: Array<(event: MessageEvent<unknown>) => Promise<void>> =
        [];
      let closed = false;
      vi.stubGlobal("self", {
        postMessage(message: unknown) {
          messages.push(message);
        },
        close() {
          closed = true;
        },
        addEventListener(
          _type: string,
          handler: (event: MessageEvent<unknown>) => Promise<void>,
        ) {
          handlers.push(handler);
        },
      });
      const network = vi.fn(async () => {
        throw new Error(
          "The network must not be reached with a wrong library key.",
        );
      });
      vi.stubGlobal("fetch", network);
      await import("@/workers/upload-worker");
      const receive = handlers.at(0);
      if (!receive)
        throw new Error(
          "The upload worker did not register its message handler.",
        );
      await receive(
        new MessageEvent("message", {
          data: {
            type: "upload",
            file: validFile
              ? new File(["sample"], "sample.mp4", { type: "video/mp4" })
              : { name: "sample.mp4", type: "video/mp4" },
            libraryKey: malformedKey
              ? "not-an-encryption-key"
              : createLibraryKey(),
            library,
          },
        }),
      );
      expect(network).not.toHaveBeenCalled();
      expect(closed).toBe(true);
      expect(messages).toEqual([
        { type: "error", message: expectedMessage ?? expect.any(String) },
      ]);
    },
  );
});
