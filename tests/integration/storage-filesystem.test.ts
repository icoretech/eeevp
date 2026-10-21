// Real disk and Web Crypto tests protect the private library boundary without mocking the filesystem.
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLibraryDescriptor,
  createLibraryKey,
  unwrapVideoKey,
  wrapVideoKey,
} from "@/lib/crypto/library-crypto";
import {
  createVideo,
  decryptChunk,
  encryptChunk,
} from "@/lib/crypto/video-crypto";
import type { ServerConfig } from "@/lib/server/config";
import { FilesystemObjectStore } from "@/lib/server/filesystem-object-store";
import { VideoStorage } from "@/lib/server/storage";
import { CHUNK_SIZE, type LibraryDescriptor } from "@/lib/video/schema";

let directory: string;
let config: Extract<ServerConfig, { STORAGE_DRIVER: "filesystem" }>;
let libraryKey: string;
let library: LibraryDescriptor;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "eeevp-storage-"));
  config = {
    APP_ORIGIN: "https://example.com",
    STORAGE_DRIVER: "filesystem",
    DEMO_MODE: false,
    SESSION_SECRET: "sample-session-secret-for-tests-only-123456789",
    STORAGE_PATH: directory,
  };
  libraryKey = createLibraryKey();
  library = await createLibraryDescriptor(libraryKey);
  await new VideoStorage(config).createLibrary(library);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function fixture(size = CHUNK_SIZE + 37) {
  const plaintext = new Uint8Array(size).map((_, index) => index % 251);
  const file = new File([plaintext], "sample.webm", { type: "video/webm" });
  const video = await createVideo(file);
  const wrappedKey = await wrapVideoKey(
    video.manifest,
    video.credentials.key,
    libraryKey,
    library.id,
  );
  return { ...video, wrappedKey, libraryId: library.id, file, plaintext };
}

describe("persistent private video library", () => {
  it("creates one immutable descriptor and refuses uninitialized or mismatched-library drafts", async () => {
    const empty = new VideoStorage({
      ...config,
      STORAGE_PATH: join(directory, "empty"),
    });
    expect(await empty.library()).toBeNull();
    expect(await empty.list()).toEqual([]);
    const video = await fixture(40);
    await expect(
      empty.createDraft(video.manifest, video.wrappedKey, library.id),
    ).rejects.toMatchObject({ status: 409 });
    const other = await createLibraryDescriptor(createLibraryKey());
    await expect(
      new VideoStorage(config).createLibrary(other),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      new VideoStorage(config).createDraft(
        video.manifest,
        video.wrappedKey,
        other.id,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await new VideoStorage(config).library()).toEqual(library);
  });

  it("keeps drafts out of the catalog, checks every real chunk, and reopens committed encrypted records", async () => {
    const storage = new VideoStorage(config);
    const video = await fixture();
    await storage.ready();
    expect(await readdir(directory)).toEqual(["library.json"]);
    await storage.createDraft(video.manifest, video.wrappedKey, library.id);
    expect(await storage.list()).toEqual([]);
    await expect(storage.readable(video.manifest.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(storage.complete(video.manifest.id)).rejects.toMatchObject({
      status: 409,
    });
    const packets: Uint8Array[] = [];
    for (let index = 0; index < video.manifest.chunkCount; index += 1) {
      const plaintext = await video.file
        .slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)
        .arrayBuffer();
      const packet = new Uint8Array(
        await encryptChunk(
          plaintext,
          index,
          video.manifest,
          video.credentials.key,
        ),
      );
      packets.push(packet);
      await storage.putChunk(video.manifest.id, index, packet);
    }
    await Promise.all([
      storage.complete(video.manifest.id),
      new VideoStorage(config).complete(video.manifest.id),
    ]);
    const reopened = new VideoStorage(config);
    const record = await reopened.readable(video.manifest.id);
    expect(record).toMatchObject({
      manifest: video.manifest,
      wrappedKey: video.wrappedKey,
      libraryId: library.id,
    });
    expect(await reopened.list()).toEqual([record]);
    const videoKey = await unwrapVideoKey(
      record.manifest,
      record.wrappedKey,
      libraryKey,
      record.libraryId,
    );
    expect(videoKey).toBe(video.credentials.key);
    for (let index = 0; index < packets.length; index += 1) {
      const stored = await reopened.readChunk(video.manifest.id, index);
      expect(new Uint8Array(stored)).toEqual(packets[index]);
      const decoded = await decryptChunk(
        new Uint8Array(stored).buffer,
        index,
        video.manifest,
        videoKey,
      );
      expect(new Uint8Array(decoded)).toEqual(
        video.plaintext.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
      );
    }
    const recordPath = join(
      directory,
      "videos",
      video.manifest.id,
      "manifest.json",
    );
    const persisted = JSON.parse(await readFile(recordPath, "utf8"));
    expect(Object.keys(persisted).sort()).toEqual([
      "createdAt",
      "libraryId",
      "manifest",
      "wrappedKey",
    ]);
    expect(persisted.wrappedKey).not.toBe(video.credentials.key);
    expect((await stat(recordPath)).mode & 0o777).toBe(0o600);
  });

  it("atomically reserves a draft identifier and rejects overwrite attempts", async () => {
    const video = await fixture(40);
    const results = await Promise.allSettled([
      new VideoStorage(config).createDraft(
        video.manifest,
        video.wrappedKey,
        library.id,
      ),
      new VideoStorage(config).createDraft(
        video.manifest,
        video.wrappedKey,
        library.id,
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toMatchObject([{ reason: { status: 409 } }]);
  });

  it("permits byte-identical concurrent retries and preserves the first packet against changed retries", async () => {
    const storage = new VideoStorage(config);
    const video = await fixture(40);
    await storage.createDraft(video.manifest, video.wrappedKey, library.id);
    const packet = new Uint8Array(
      await encryptChunk(
        await video.file.arrayBuffer(),
        0,
        video.manifest,
        video.credentials.key,
      ),
    );
    await Promise.all([
      storage.putChunk(video.manifest.id, 0, packet),
      new VideoStorage(config).putChunk(video.manifest.id, 0, packet),
    ]);
    const changed = packet.slice();
    changed[0] = (changed[0] ?? 0) ^ 1;
    await expect(
      storage.putChunk(video.manifest.id, 0, changed),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      storage.putChunk(video.manifest.id, 0, packet.slice(1)),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      storage.putChunk(video.manifest.id, 1, packet),
    ).rejects.toMatchObject({ status: 404 });
    await storage.complete(video.manifest.id);
    expect(
      new Uint8Array(await storage.readChunk(video.manifest.id, 0)),
    ).toEqual(packet);
    expect(
      await readdir(join(directory, "videos", video.manifest.id, "chunks")),
    ).toEqual(["0"]);
  });

  it("deletes a committed video from the canonical catalog and disk, while preserving descriptor and drafts", async () => {
    const storage = new VideoStorage(config);
    const committed = await fixture(40);
    const pending = await fixture(40);
    for (const video of [committed, pending])
      await storage.createDraft(video.manifest, video.wrappedKey, library.id);
    await storage.putChunk(committed.manifest.id, 0, new Uint8Array(68));
    await storage.complete(committed.manifest.id);
    await expect(
      storage.deleteVideo(pending.manifest.id),
    ).rejects.toMatchObject({ status: 404 });
    await storage.deleteVideo(committed.manifest.id);
    expect(await storage.list()).toEqual([]);
    expect(await storage.library()).toEqual(library);
    expect(await storage.draft(pending.manifest.id)).toMatchObject({
      manifest: pending.manifest,
    });
    await expect(storage.readable(committed.manifest.id)).rejects.toMatchObject(
      { status: 404 },
    );
    await expect(
      storage.deleteVideo(committed.manifest.id),
    ).resolves.toBeUndefined();
    await expect(
      stat(join(directory, "videos", committed.manifest.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(directory, ".trash"))).toEqual([]);
  });

  it("keeps deleted identifiers invisible when a delayed writer recreates a manifest", async () => {
    const storage = new VideoStorage(config);
    const video = await fixture(40);
    const id = video.manifest.id;
    await storage.createDraft(video.manifest, video.wrappedKey, library.id);
    await storage.putChunk(id, 0, new Uint8Array(68));
    await storage.complete(id);
    const record = await storage.readable(id);
    await storage.deleteVideo(id);
    const path = join(directory, "videos", id);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "manifest.json"), JSON.stringify(record));
    const replica = new VideoStorage(config);
    expect(await replica.list()).toEqual([]);
    await expect(replica.readable(id)).rejects.toMatchObject({ status: 404 });
    await expect(
      replica.createDraft(video.manifest, video.wrappedKey, library.id),
    ).rejects.toMatchObject({ status: 404 });
    await replica.deleteVideo(id);
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (
        await stat(join(directory, "tombstones", "videos", `${id}.json`))
      ).isFile(),
    ).toBe(true);
  });

  it("rejects truncated chunk files and malformed persisted records", async () => {
    const storage = new VideoStorage(config);
    const video = await fixture(40);
    await storage.createDraft(video.manifest, video.wrappedKey, library.id);
    await storage.putChunk(video.manifest.id, 0, new Uint8Array(68));
    const videoPath = join(directory, "videos", video.manifest.id);
    await writeFile(join(videoPath, "chunks", "0"), new Uint8Array(67));
    await expect(storage.complete(video.manifest.id)).rejects.toMatchObject({
      status: 409,
    });
    await writeFile(join(videoPath, "draft.json"), "{broken");
    await expect(storage.draft(video.manifest.id)).rejects.toMatchObject({
      status: 503,
    });
  });

  it("refuses symlinked ancestor directories without reading, writing or deleting their targets", async () => {
    const store = new FilesystemObjectStore(directory);
    const outside = await mkdtemp(join(tmpdir(), "eeevp-outside-"));
    try {
      await writeFile(join(outside, "marker"), "preserve");
      const videos = join(directory, "videos");
      await symlink(outside, videos);
      await expect(store.read("videos/marker", 32)).rejects.toThrow(
        "directory",
      );
      await expect(store.head("videos/marker")).rejects.toThrow("directory");
      await expect(
        store.publish("videos/changed", "overwrite"),
      ).rejects.toThrow("directory");
      await expect(store.remove("videos/marker")).rejects.toThrow("directory");
      await expect(store.removeVideo(library.id)).rejects.toThrow("directory");
      expect(await readFile(join(outside, "marker"), "utf8")).toBe("preserve");
      await rm(videos);
      const videoPath = join(videos, library.id);
      await mkdir(videoPath, { recursive: true });
      await symlink(outside, join(videoPath, "chunks"));
      await expect(
        store.publish(`videos/${library.id}/chunks/0`, "ciphertext"),
      ).rejects.toThrow("directory");
      expect(await readdir(outside)).toEqual(["marker"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects traversal identifiers and follows no object-file symlinks", async () => {
    const storage = new VideoStorage(config);
    await expect(storage.draft("../outside")).rejects.toMatchObject({
      status: 404,
    });
    await expect(storage.deleteVideo("../outside")).rejects.toMatchObject({
      status: 404,
    });
    const video = await fixture(40);
    await storage.createDraft(video.manifest, video.wrappedKey, library.id);
    const draftPath = join(
      directory,
      "videos",
      video.manifest.id,
      "draft.json",
    );
    const outsidePath = join(directory, "outside.json");
    await writeFile(outsidePath, await readFile(draftPath));
    await rm(draftPath);
    await symlink(outsidePath, draftPath);
    await expect(storage.draft(video.manifest.id)).rejects.toThrow();
  });
});
