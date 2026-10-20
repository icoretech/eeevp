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
const password = "sample-library-password";
let directory: string;

beforeEach(async () => {
  vi.resetModules();
  directory = await mkdtemp(join(tmpdir(), "eeevp-worker-route-"));
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubEnv("LIBRARY_PASSWORD", password);
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
  it("encrypts bounded chunks and completes through the bodyless finalization endpoint", async () => {
    const session = await signIn(
      new NextRequest(`${origin}/api/session`, {
        method: "POST",
        headers: { origin, "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      }),
    );
    expect(session.status).toBe(200);
    const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie)
      throw new Error("A real authenticated upload session is required.");
    const libraryKey = createLibraryKey();
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
    await receive(
      new MessageEvent("message", {
        data: { type: "upload", file, libraryKey, library },
      }),
    );

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

  it("rejects an incorrect library key before sending a request and closes its key-holding realm", async () => {
    const library = await createLibraryDescriptor(createLibraryKey());
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
          file: new File(["sample"], "sample.mp4", { type: "video/mp4" }),
          libraryKey: createLibraryKey(),
          library,
        },
      }),
    );
    expect(network).not.toHaveBeenCalled();
    expect(closed).toBe(true);
    expect(messages).toEqual([{ type: "error", message: expect.any(String) }]);
  });
});
