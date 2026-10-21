// Real disk reads verify the optimized manifest cache without mocking storage semantics.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVideo } from "@/lib/crypto/video-crypto";
import { FilesystemObjectStore } from "@/lib/server/filesystem-object-store";
import { VideoStorage } from "@/lib/server/storage";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "stream-storage-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function fixture(root = directory) {
  const config = {
    APP_ORIGIN: "https://example.com",
    SESSION_SECRET: "sample-session-secret-for-tests-only",
    DEMO_MODE: false as const,
    STORAGE_DRIVER: "filesystem" as const,
    STORAGE_PATH: root,
  };
  const raw = new FilesystemObjectStore(root);
  const video = await createVideo(
    new File([new Uint8Array(17)], "sample.mp4", { type: "video/mp4" }),
  );
  const record = {
    manifest: video.manifest,
    wrappedKey: "A".repeat(80),
    libraryId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  const id = video.manifest.id;
  const packet = Buffer.alloc(45, 23);
  await raw.publish(`videos/${id}/manifest.json`, JSON.stringify(record));
  await raw.publish(`videos/${id}/chunks/0`, packet);
  return { config, raw, record, id, packet, storage: new VideoStorage(config) };
}

describe("bounded immutable streaming metadata", () => {
  it("uses only a packet read and fresh tombstone check on a warm path", async () => {
    const f = await fixture();
    const reads = vi.spyOn(FilesystemObjectStore.prototype, "read");
    const heads = vi.spyOn(FilesystemObjectStore.prototype, "head");
    expect(await f.storage.readChunk(f.id, 0)).toEqual(f.packet);
    expect(reads.mock.calls.map(([key]) => key)).toEqual([
      `videos/${f.id}/manifest.json`,
      `videos/${f.id}/chunks/0`,
    ]);
    reads.mockClear();
    heads.mockClear();
    expect(await f.storage.readChunk(f.id, 0)).toEqual(f.packet);
    expect(reads.mock.calls.map(([key]) => key)).toEqual([
      `videos/${f.id}/chunks/0`,
    ]);
    expect(heads.mock.calls.map(([key]) => key)).toEqual([
      `tombstones/videos/${f.id}.json`,
    ]);
  });

  it("never treats cached metadata as proof a video still exists", async () => {
    const f = await fixture();
    await f.storage.readChunk(f.id, 0);
    await new FilesystemObjectStore(directory).publish(
      `tombstones/videos/${f.id}.json`,
      "{}",
    );
    await expect(f.storage.readChunk(f.id, 0)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("lets deletion racing with a real chunk read win before returning bytes", async () => {
    const f = await fixture();
    await f.storage.readChunk(f.id, 0);
    const original = FilesystemObjectStore.prototype.read;
    vi.spyOn(FilesystemObjectStore.prototype, "read").mockImplementation(
      async function (this: FilesystemObjectStore, key, limit, signal) {
        const bytes = await original.call(this, key, limit, signal);
        if (key.endsWith("/chunks/0"))
          await f.raw.publish(`tombstones/videos/${f.id}.json`, "{}");
        return bytes;
      },
    );
    await expect(f.storage.readChunk(f.id, 0)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("checks cancellation before reads and after the packet arrives", async () => {
    const f = await fixture();
    const abort = new AbortController();
    abort.abort(new Error("seek superseded"));
    const reads = vi.spyOn(FilesystemObjectStore.prototype, "read");
    await expect(f.storage.readChunk(f.id, 0, abort.signal)).rejects.toThrow(
      "seek superseded",
    );
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    const running = new AbortController();
    const original = FilesystemObjectStore.prototype.read;
    vi.spyOn(FilesystemObjectStore.prototype, "read").mockImplementation(
      async function (this: FilesystemObjectStore, key, limit, signal) {
        expect(signal).toBe(running.signal);
        const bytes = await original.call(this, key, limit, signal);
        if (key.endsWith("/chunks/0")) running.abort(new Error("new seek"));
        return bytes;
      },
    );
    const heads = vi.spyOn(FilesystemObjectStore.prototype, "head");
    await expect(f.storage.readChunk(f.id, 0, running.signal)).rejects.toThrow(
      "new seek",
    );
    expect(heads).not.toHaveBeenCalled();
  });

  it("does not cache missing or malformed manifests", async () => {
    const f = await fixture();
    const key = `videos/${f.id}/manifest.json`;
    await f.raw.remove(key);
    await expect(f.storage.readChunk(f.id, 0)).rejects.toMatchObject({
      status: 404,
    });
    await f.raw.publish(
      key,
      JSON.stringify({
        ...f.record,
        manifest: { ...f.record.manifest, id: crypto.randomUUID() },
      }),
    );
    await expect(f.storage.readChunk(f.id, 0)).rejects.toMatchObject({
      status: 503,
    });
    await f.raw.remove(key);
    await f.raw.publish(key, JSON.stringify(f.record));
    expect(await f.storage.readChunk(f.id, 0)).toEqual(f.packet);
    await expect(f.storage.readChunk(f.id, 1)).rejects.toMatchObject({
      status: 404,
    });
    await expect(f.storage.readChunk(f.id, -1)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("keeps cached manifests isolated from a different storage namespace", async () => {
    const f = await fixture();
    await f.storage.readChunk(f.id, 0);
    const second = new VideoStorage({
      ...f.config,
      STORAGE_PATH: join(directory, "other"),
    });
    await expect(second.readChunk(f.id, 0)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("evicts least-recently-used metadata instead of growing with the catalog", async () => {
    const f = await fixture();
    await f.storage.readChunk(f.id, 0);
    for (let i = 0; i < 256; i += 1) {
      const id = crypto.randomUUID();
      await f.raw.publish(
        `videos/${id}/manifest.json`,
        JSON.stringify({ ...f.record, manifest: { ...f.record.manifest, id } }),
      );
      await f.raw.publish(`videos/${id}/chunks/0`, f.packet);
      await f.storage.readChunk(id, 0);
    }
    const reads = vi.spyOn(FilesystemObjectStore.prototype, "read");
    await f.storage.readChunk(f.id, 0);
    expect(reads.mock.calls[0]?.[0]).toBe(`videos/${f.id}/manifest.json`);
  });
});
