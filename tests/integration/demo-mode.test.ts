// Real route and filesystem coverage proves public demos reject writes before parsing bodies or accessing storage.
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/health/route";
import {
  POST as initialize,
  GET as readLibrary,
} from "@/app/api/library/route";
import {
  DELETE as closeSession,
  POST as openSession,
  GET as readSession,
} from "@/app/api/session/route";
import {
  GET as readChunk,
  PUT as uploadChunk,
} from "@/app/api/videos/[id]/chunks/[index]/route";
import { POST as complete } from "@/app/api/videos/[id]/complete/route";
import {
  DELETE as deleteVideo,
  GET as readVideo,
} from "@/app/api/videos/[id]/route";
import { POST as createDraft, GET as listVideos } from "@/app/api/videos/route";
import {
  createLibraryDescriptor,
  createLibraryKey,
  wrapVideoKey,
} from "@/lib/crypto/library-crypto";
import { createVideo, encryptChunk } from "@/lib/crypto/video-crypto";
import { getConfig } from "@/lib/server/config";
import { VideoStorage } from "@/lib/server/storage";

const origin = "https://example.com";
let root: string;
let key: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "eeevp-demo-"));
  key = createLibraryKey();
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubEnv(
    "SESSION_SECRET",
    "sample-session-secret-for-tests-only-123456789",
  );
  vi.stubEnv("STORAGE_DRIVER", "filesystem");
  vi.stubEnv("STORAGE_PATH", root);
  vi.stubEnv("DEMO_MODE", "false");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function request(
  path: string,
  method: string,
  body?: string,
  cookie?: string,
  crafted = false,
) {
  return new NextRequest(`${origin}${path}`, {
    method,
    body,
    headers: crafted
      ? {}
      : {
          origin,
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
  });
}

async function snapshot(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const children = await snapshot(path);
      for (const [name, body] of Object.entries(children))
        result[`${entry.name}/${name}`] = body;
    } else if (entry.isFile())
      result[entry.name] = (await readFile(path)).toString("base64");
  }
  return result;
}

async function seed() {
  const storage = new VideoStorage(getConfig());
  const library = await createLibraryDescriptor(key);
  await storage.createLibrary(library);
  const file = new File([new Uint8Array([1, 2, 3, 4, 5])], "sample.webm", {
    type: "video/webm",
  });
  const video = await createVideo(file);
  const wrappedKey = await wrapVideoKey(
    video.manifest,
    video.credentials.key,
    key,
    library.id,
  );
  await storage.createDraft(video.manifest, wrappedKey, library.id);
  const packet = new Uint8Array(
    await encryptChunk(
      await file.arrayBuffer(),
      0,
      video.manifest,
      video.credentials.key,
    ),
  );
  await storage.putChunk(video.manifest.id, 0, packet);
  await storage.complete(video.manifest.id);
  return { library, video: await storage.readable(video.manifest.id), packet };
}

function enableDemo() {
  vi.stubEnv("DEMO_MODE", "true");
  vi.stubEnv("DEMO_PUBLIC_KEY", key);
}

async function sessionCookie() {
  const opened = await openSession(request("/api/session", "POST", "{}"));
  expect(opened.status).toBe(200);
  const cookie = opened.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Expected an opaque session cookie");
  return cookie;
}

async function rejectEveryMutation(
  id: string,
  cookie?: string,
  crafted = false,
) {
  const context = { params: Promise.resolve({ id }) };
  const chunkContext = { params: Promise.resolve({ id, index: "0" }) };
  const libraryRequest = request(
    "/api/library",
    "POST",
    "{malformed",
    cookie,
    crafted,
  );
  const draftRequest = request(
    "/api/videos",
    "POST",
    "{malformed",
    cookie,
    crafted,
  );
  const chunkRequest = request(
    `/api/videos/${id}/chunks/0`,
    "PUT",
    "opaque",
    cookie,
    crafted,
  );
  const completeRequest = request(
    `/api/videos/${id}/complete`,
    "POST",
    "not-empty",
    cookie,
    crafted,
  );
  const deleteRequest = request(
    `/api/videos/${id}`,
    "DELETE",
    undefined,
    cookie,
    crafted,
  );
  const responses = [
    await initialize(libraryRequest),
    await createDraft(draftRequest),
    await uploadChunk(chunkRequest, chunkContext),
    await complete(completeRequest, context),
    await deleteVideo(deleteRequest, context),
  ];
  for (const response of responses) {
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "This demo is read-only. Uploads and deletion are disabled.",
    });
  }
  for (const input of [
    libraryRequest,
    draftRequest,
    chunkRequest,
    completeRequest,
    deleteRequest,
  ])
    expect(input.bodyUsed).toBe(false);
}

describe("read-only public demo", () => {
  it("rejects every mutation with valid or crafted requests without changing seeded encrypted files", async () => {
    const seeded = await seed();
    const before = await snapshot(root);
    enableDemo();
    const cookie = await sessionCookie();
    await rejectEveryMutation(seeded.video.manifest.id, cookie);
    await rejectEveryMutation(seeded.video.manifest.id, undefined, true);
    expect(await snapshot(root)).toEqual(before);
  });

  it("returns the demo error before attempting to access an unavailable storage directory", async () => {
    const unavailable = join(root, "unavailable");
    await writeFile(unavailable, "not-a-directory");
    vi.stubEnv("STORAGE_PATH", unavailable);
    enableDemo();
    await rejectEveryMutation(crypto.randomUUID(), undefined, true);
    expect(await readFile(unavailable, "utf8")).toBe("not-a-directory");
  });

  it("allows sessions, encrypted catalog and chunk reads, health and cookie clearing", async () => {
    const seeded = await seed();
    enableDemo();
    const cookie = await sessionCookie();
    const id = seeded.video.manifest.id;
    const context = { params: Promise.resolve({ id }) };
    const read = (path: string) => request(path, "GET", undefined, cookie);
    expect(await (await readSession(read("/api/session"))).json()).toEqual({
      authenticated: true,
    });
    expect(await (await readLibrary(read("/api/library"))).json()).toEqual({
      library: seeded.library,
    });
    expect(await (await listVideos(read("/api/videos"))).json()).toEqual({
      videos: [seeded.video],
    });
    expect(
      await (await readVideo(read(`/api/videos/${id}`), context)).json(),
    ).toEqual({ video: seeded.video });
    const response = await readChunk(read(`/api/videos/${id}/chunks/0`), {
      params: Promise.resolve({ id, index: "0" }),
    });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(seeded.packet);
    expect((await health()).status).toBe(200);
    const closed = await closeSession(
      request("/api/session", "DELETE", undefined, cookie),
    );
    expect(closed.status).toBe(200);
    expect(closed.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
