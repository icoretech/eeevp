// Real route invocations cover opaque library sessions, strict bodies and durable encrypted video records.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/health/route";
import {
  POST as initializeLibrary,
  GET as libraryDescriptor,
} from "@/app/api/library/route";
import {
  POST as login,
  DELETE as logout,
  GET as session,
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
import {
  createVideo,
  decryptChunk,
  encryptChunk,
} from "@/lib/crypto/video-crypto";
import { handleApi, readJson } from "@/lib/server/http";

const origin = "https://example.com";
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "eeevp-route-"));
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubEnv("STORAGE_DRIVER", "filesystem");
  vi.stubEnv("DEMO_MODE", "false");
  vi.stubEnv(
    "SESSION_SECRET",
    "sample-session-secret-for-tests-only-123456789",
  );
  vi.stubEnv("STORAGE_PATH", directory);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function request(
  path: string,
  init: ConstructorParameters<typeof NextRequest>[1] = {},
) {
  return new NextRequest(`${origin}${path}`, init);
}

async function signIn() {
  const response = await login(
    request("/api/session", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("Expected a real session cookie");
  return cookie;
}

describe("HTTP session guards", () => {
  it("signs and clears HttpOnly secure cookies and rejects foreign origins without receiving encryption keys", async () => {
    expect(await (await session(request("/api/session"))).json()).toEqual({
      authenticated: false,
    });
    const cookie = await signIn();
    const current = await session(
      request("/api/session", { headers: { cookie } }),
    );
    expect(await current.json()).toEqual({ authenticated: true });
    const blocked = await login(
      request("/api/session", {
        method: "POST",
        headers: {
          origin: "https://other.example.com",
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      }),
    );
    expect(blocked.status).toBe(403);
    const cleared = await logout(
      request("/api/session", {
        method: "DELETE",
        headers: { origin, cookie },
      }),
    );
    expect(cleared.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(cleared.headers.get("set-cookie")).toContain("HttpOnly");
    expect(cleared.headers.get("set-cookie")).toContain("Secure");
    expect(cleared.headers.get("set-cookie")).toContain("SameSite=strict");
  });

  it.each([
    ["missing", undefined],
    ["opaque null", "null"],
  ] as const)(
    "rejects %s Origin on session creation and logout even with a matching Referer",
    async (_label, suppliedOrigin) => {
      const headers = new Headers({
        "content-type": "application/json",
        referer: `${origin}/`,
      });
      if (suppliedOrigin !== undefined) headers.set("origin", suppliedOrigin);
      const rejectedLogin = await login(
        request("/api/session", {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        }),
      );
      expect(rejectedLogin.status).toBe(403);
      expect(rejectedLogin.headers.get("set-cookie")).toBeNull();
      expect(await rejectedLogin.json()).toEqual({
        error: "Request origin is not allowed",
      });

      const cookie = await signIn();
      headers.set("cookie", cookie);
      const rejectedLogout = await logout(
        request("/api/session", { method: "DELETE", headers }),
      );
      expect(rejectedLogout.status).toBe(403);
      expect(rejectedLogout.headers.get("set-cookie")).toBeNull();
      expect(
        await (
          await session(request("/api/session", { headers: { cookie } }))
        ).json(),
      ).toEqual({ authenticated: true });
    },
  );

  it("rejects unknown fields, wrong media types, malformed JSON and oversized bodies", async () => {
    for (const [body, contentType, expected] of [
      [JSON.stringify({ key: "browser-only" }), "application/json", 400],
      [JSON.stringify({}), "text/plain", 415],
      ["{", "application/json", 400],
      [" ".repeat(4097), "application/json", 413],
    ] as const) {
      const result = await login(
        request("/api/session", {
          method: "POST",
          headers: { origin, "content-type": contentType },
          body,
        }),
      );
      expect(result.status).toBe(expected);
    }
    const excessive = await handleApi(async () => {
      await readJson(
        request("/test", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": "1000",
          },
          body: "{}",
        }),
        10,
      );
      return new Response();
    });
    expect(excessive.status).toBe(413);
  });

  it("reports missing configuration without revealing environment values", async () => {
    vi.stubEnv("SESSION_SECRET", undefined);
    const response = await health();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Server configuration is unavailable",
    });
  });
});

describe("private encrypted library routes", () => {
  it("requires a valid library cookie for descriptor, catalog, records and chunks", async () => {
    const id = crypto.randomUUID();
    const context = { params: Promise.resolve({ id }) };
    const chunkContext = { params: Promise.resolve({ id, index: "0" }) };
    expect((await libraryDescriptor(request("/api/library"))).status).toBe(401);
    expect((await listVideos(request("/api/videos"))).status).toBe(401);
    expect(
      (await readVideo(request(`/api/videos/${id}`), context)).status,
    ).toBe(401);
    expect(
      (await readChunk(request(`/api/videos/${id}/chunks/0`), chunkContext))
        .status,
    ).toBe(401);
    expect(
      (
        await deleteVideo(
          request(`/api/videos/${id}`, { method: "DELETE" }),
          context,
        )
      ).status,
    ).toBe(401);
    const cookie = await signIn();
    expect(
      await (
        await libraryDescriptor(
          request("/api/library", { headers: { cookie } }),
        )
      ).json(),
    ).toEqual({ library: null });
    expect(
      await (
        await listVideos(request("/api/videos", { headers: { cookie } }))
      ).json(),
    ).toEqual({ videos: [] });
    expect(
      (
        await readVideo(
          request(`/api/videos/${id}`, { headers: { cookie } }),
          context,
        )
      ).status,
    ).toBe(404);
  });

  it("initializes one immutable descriptor, commits real ciphertext, lists it across sessions and permanently deletes it", async () => {
    const cookie = await signIn();
    const key = createLibraryKey();
    const library = await createLibraryDescriptor(key);
    const initialize = () =>
      initializeLibrary(
        request("/api/library", {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/json" },
          body: JSON.stringify(library),
        }),
      );
    expect((await initialize()).status).toBe(201);
    expect((await initialize()).status).toBe(409);
    expect(
      await (
        await libraryDescriptor(
          request("/api/library", { headers: { cookie } }),
        )
      ).json(),
    ).toEqual({ library });
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
    const payload = {
      manifest: video.manifest,
      wrappedKey,
      libraryId: library.id,
    };
    const draftRequest = (sessionCookie?: string) =>
      request("/api/videos", {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          ...(sessionCookie ? { cookie: sessionCookie } : {}),
        },
        body: JSON.stringify(payload),
      });
    expect((await createDraft(draftRequest())).status).toBe(401);
    expect((await createDraft(draftRequest(cookie))).status).toBe(201);
    expect(
      await (
        await listVideos(request("/api/videos", { headers: { cookie } }))
      ).json(),
    ).toEqual({ videos: [] });
    const id = video.manifest.id;
    const context = { params: Promise.resolve({ id }) };
    const chunkContext = { params: Promise.resolve({ id, index: "0" }) };
    expect(
      (
        await complete(
          request(`/api/videos/${id}/complete`, {
            method: "POST",
            headers: { origin, cookie },
          }),
          context,
        )
      ).status,
    ).toBe(409);
    const packet = await encryptChunk(
      await file.arrayBuffer(),
      0,
      video.manifest,
      video.credentials.key,
    );
    expect(
      (
        await uploadChunk(
          request(`/api/videos/${id}/chunks/0`, {
            method: "PUT",
            headers: {
              origin,
              cookie,
              "content-type": "application/octet-stream",
            },
            body: new Uint8Array(packet),
          }),
          chunkContext,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await complete(
          request(`/api/videos/${id}/complete`, {
            method: "POST",
            headers: { origin, cookie },
          }),
          context,
        )
      ).status,
    ).toBe(200);
    const recordResponse = await readVideo(
      request(`/api/videos/${id}`, { headers: { cookie } }),
      context,
    );
    const record = await recordResponse.json();
    expect(record).toMatchObject({ video: payload });
    const secondCookie = await signIn();
    expect(
      await (
        await listVideos(
          request("/api/videos", { headers: { cookie: secondCookie } }),
        )
      ).json(),
    ).toEqual({ videos: [record.video] });
    const downloaded = await readChunk(
      request(`/api/videos/${id}/chunks/0`, {
        headers: { cookie: secondCookie },
      }),
      chunkContext,
    );
    expect(downloaded.headers.get("cache-control")).toBe("no-store");
    expect(downloaded.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    const plaintext = await decryptChunk(
      await downloaded.arrayBuffer(),
      0,
      video.manifest,
      video.credentials.key,
    );
    expect(new Uint8Array(plaintext)).toEqual(
      new Uint8Array(await file.arrayBuffer()),
    );
    expect(
      (
        await deleteVideo(
          request(`/api/videos/${id}`, {
            method: "DELETE",
            headers: { cookie, origin: "https://other.example.com" },
          }),
          context,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await deleteVideo(
          request(`/api/videos/${id}`, {
            method: "DELETE",
            headers: { cookie, origin },
          }),
          context,
        )
      ).status,
    ).toBe(204);
    expect(
      await (
        await listVideos(
          request("/api/videos", { headers: { cookie: secondCookie } }),
        )
      ).json(),
    ).toEqual({ videos: [] });
    expect(
      (
        await readVideo(
          request(`/api/videos/${id}`, { headers: { cookie } }),
          context,
        )
      ).status,
    ).toBe(404);
    expect(
      await (
        await libraryDescriptor(
          request("/api/library", { headers: { cookie } }),
        )
      ).json(),
    ).toEqual({ library });
    expect((await health()).status).toBe(200);
  });

  it("rejects clear keys in descriptor or draft input and refuses mismatched library ids", async () => {
    const cookie = await signIn();
    const key = createLibraryKey();
    const library = await createLibraryDescriptor(key);
    const initialized = await initializeLibrary(
      request("/api/library", {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ ...library, key }),
      }),
    );
    expect(initialized.status).toBe(400);
    await initializeLibrary(
      request("/api/library", {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify(library),
      }),
    );
    const video = await createVideo(
      new File(["sample"], "sample.mp4", { type: "video/mp4" }),
    );
    const wrappedKey = await wrapVideoKey(
      video.manifest,
      video.credentials.key,
      key,
      library.id,
    );
    const send = (body: object) =>
      createDraft(
        request("/api/videos", {
          method: "POST",
          headers: { origin, cookie, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    expect(
      (
        await send({
          manifest: video.manifest,
          wrappedKey,
          libraryId: library.id,
          key: video.credentials.key,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await send({
          manifest: video.manifest,
          wrappedKey,
          libraryId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(409);
    const invalid = await readVideo(
      request("/api/videos/invalid", { headers: { cookie } }),
      { params: Promise.resolve({ id: "../outside" }) },
    );
    expect(invalid.status).toBe(404);
  });
});
