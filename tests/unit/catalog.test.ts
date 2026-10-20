// Real WebCrypto catalog tests adapt only HTTP transport; wrapped keys and metadata are authenticated in full.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLibraryDescriptor,
  createLibraryKey,
  wrapVideoKey,
} from "@/lib/crypto/library-crypto";
import { createVideo } from "@/lib/crypto/video-crypto";
import {
  fetchLibraryCatalog,
  LibrarySessionExpired,
  libraryRequest,
  openLibraryVideo,
} from "@/lib/video/catalog";
import { libraryVideoSchema } from "@/lib/video/schema";

async function libraryFixture() {
  const key = createLibraryKey();
  const descriptor = await createLibraryDescriptor(key);
  return { key, descriptor };
}

async function videoFixture(
  key: string,
  libraryId: string,
  name = "sample-video.webm",
  createdAt = "2026-01-01T12:00:00.000Z",
) {
  const file = new File([new Uint8Array([1, 2, 3, 4])], name, {
    type: "video/webm",
  });
  const { manifest, credentials, metadata } = await createVideo(file);
  const wrappedKey = await wrapVideoKey(
    manifest,
    credentials.key,
    key,
    libraryId,
  );
  const video = libraryVideoSchema.parse({
    manifest,
    wrappedKey,
    libraryId,
    createdAt,
  });
  return { video, credentials, metadata };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("private library catalog", () => {
  it("decrypts canonical server rows in their supplied order through real wrapped keys", async () => {
    const { key, descriptor } = await libraryFixture();
    const newer = await videoFixture(
      key,
      descriptor.id,
      "newer-video.webm",
      "2026-01-02T12:00:00.000Z",
    );
    const older = await videoFixture(key, descriptor.id, "older-video.webm");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ videos: [newer.video, older.video] }));
    vi.stubGlobal("fetch", fetcher);
    const { signal } = new AbortController();

    const rows = await fetchLibraryCatalog(key, descriptor.id, signal);

    expect(rows).toEqual([
      { video: newer.video, metadata: newer.metadata, error: null },
      { video: older.video, metadata: older.metadata, error: null },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/videos", {
      signal,
      mode: "same-origin",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
    const outgoing = JSON.stringify(fetcher.mock.calls);
    for (const secret of [key, newer.credentials.key, older.credentials.key])
      expect(outgoing).not.toContain(secret);
    expect(outgoing).not.toContain(newer.metadata.name);
    expect(outgoing).not.toContain(older.metadata.name);
  });

  it("opens a record with the original video credentials and no capability token", async () => {
    const { key, descriptor } = await libraryFixture();
    const fixture = await videoFixture(key, descriptor.id);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    await expect(
      openLibraryVideo(fixture.video, key, descriptor.id),
    ).resolves.toEqual({
      metadata: fixture.metadata,
      credentials: fixture.credentials,
    });
    expect(Object.keys(fixture.credentials).sort()).toEqual(["id", "key"]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retains a corrupt row with an error while decrypting the remaining canonical rows", async () => {
    const { key, descriptor } = await libraryFixture();
    const intact = await videoFixture(key, descriptor.id, "intact-video.webm");
    const damaged = await videoFixture(
      key,
      descriptor.id,
      "damaged-video.webm",
    );
    const first = damaged.video.wrappedKey.startsWith("A") ? "B" : "A";
    const corrupted = {
      ...damaged.video,
      wrappedKey: first + damaged.video.wrappedKey.slice(1),
    };
    expect(libraryVideoSchema.safeParse(corrupted).success).toBe(true);
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ videos: [corrupted, intact.video] }),
        ),
    );

    await expect(
      fetchLibraryCatalog(key, descriptor.id, new AbortController().signal),
    ).resolves.toEqual([
      {
        video: corrupted,
        metadata: null,
        error: "This video's encrypted metadata could not be opened.",
      },
      { video: intact.video, metadata: intact.metadata, error: null },
    ]);
  });

  it("rejects a foreign library locally before making a request", async () => {
    const { key, descriptor } = await libraryFixture();
    const fixture = await videoFixture(key, descriptor.id);
    const other = await libraryFixture();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    await expect(
      openLibraryVideo(fixture.video, key, other.descriptor.id),
    ).rejects.toThrow("This video belongs to a different encrypted library.");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an unknown master key through native authentication without sending it", async () => {
    const { key, descriptor } = await libraryFixture();
    const fixture = await videoFixture(key, descriptor.id);
    const otherKey = createLibraryKey();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    await expect(
      openLibraryVideo(fixture.video, otherKey, descriptor.id),
    ).rejects.toThrow("authentication failed");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports an expired session before attempting to parse its response as catalog data", async () => {
    const { key, descriptor } = await libraryFixture();
    const response = Response.json(
      { error: "Authentication required" },
      { status: 401 },
    );
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));

    await expect(
      fetchLibraryCatalog(key, descriptor.id, new AbortController().signal),
    ).rejects.toBeInstanceOf(LibrarySessionExpired);
    expect(response.bodyUsed).toBe(true);
  });

  it.each([
    { label: "missing list", body: {} },
    { label: "non-array list", body: { videos: "invalid" } },
    { label: "invalid row", body: { videos: [{}] } },
    { label: "unexpected wire field", body: { videos: [], extra: true } },
  ])("rejects $label with a generic catalog error", async ({ body }) => {
    const { key, descriptor } = await libraryFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(body)),
    );

    await expect(
      fetchLibraryCatalog(key, descriptor.id, new AbortController().signal),
    ).rejects.toThrow("The server returned invalid library records.");
  });

  it("keeps server failures separate from an empty library", async () => {
    const { key, descriptor } = await libraryFixture();
    const response = Response.json(
      { error: "Internal storage details" },
      { status: 503 },
    );
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));

    await expect(
      fetchLibraryCatalog(key, descriptor.id, new AbortController().signal),
    ).rejects.toThrow(
      "The video library could not be loaded. Please try again.",
    );
    expect(response.bodyUsed).toBe(true);
  });

  it("accepts a canonical empty collection", async () => {
    const { key, descriptor } = await libraryFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(Response.json({ videos: [] })),
    );

    await expect(
      fetchLibraryCatalog(key, descriptor.id, new AbortController().signal),
    ).resolves.toEqual([]);
  });

  it("enforces the same-origin transport contract even when caller options differ", async () => {
    const response = Response.json({ videos: [] });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetcher);

    await expect(
      libraryRequest("/api/videos", {
        mode: "cors",
        credentials: "omit",
        cache: "force-cache",
        redirect: "follow",
      }),
    ).resolves.toBe(response);
    expect(fetcher).toHaveBeenCalledWith("/api/videos", {
      mode: "same-origin",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
    });
  });
});
