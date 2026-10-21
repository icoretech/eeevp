// Explicit real-endpoint acceptance isolates every object under a unique test-owned prefix.
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
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
import type { ServerConfig } from "@/lib/server/config";
import { S3ObjectStore } from "@/lib/server/r2-object-store";
import { VideoStorage } from "@/lib/server/storage";
import { CHUNK_SIZE } from "@/lib/video/schema";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing integration setting: ${name}`);
  return value;
}

it.skipIf(process.env.S3_CONTRACT_TEST !== "true")(
  "real single-bucket library preserves ciphertext, immutable completion and deletion tombstones across replicas",
  async () => {
    const style = required("S3_FORCE_PATH_STYLE");
    if (style !== "true" && style !== "false")
      throw new Error("Invalid S3_FORCE_PATH_STYLE");
    const config: Extract<ServerConfig, { STORAGE_DRIVER: "s3" }> = {
      APP_ORIGIN: "https://example.com",
      SESSION_SECRET: "sample-integration-session-secret-only",
      STORAGE_DRIVER: "s3",
      DEMO_MODE: false,
      S3_ENDPOINT: required("S3_ENDPOINT"),
      S3_REGION: required("S3_REGION"),
      S3_BUCKET: required("S3_BUCKET"),
      S3_ACCESS_KEY_ID: required("S3_ACCESS_KEY_ID"),
      S3_SECRET_ACCESS_KEY: required("S3_SECRET_ACCESS_KEY"),
      S3_FORCE_PATH_STYLE: style === "true",
      S3_PREFIX: `${required("S3_PREFIX")}/logical-${randomUUID()}`,
    };
    const raw = new S3ObjectStore({
      endpoint: config.S3_ENDPOINT,
      region: config.S3_REGION,
      bucket: config.S3_BUCKET,
      accessKeyId: config.S3_ACCESS_KEY_ID,
      secretAccessKey: config.S3_SECRET_ACCESS_KEY,
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
      prefix: config.S3_PREFIX,
    });
    const storage = new VideoStorage(config);
    try {
      await storage.ready();
      const key = createLibraryKey();
      const library = await createLibraryDescriptor(key);
      await storage.createLibrary(library);
      expect(await new VideoStorage(config).library()).toEqual(library);
      const plaintext = new Uint8Array(CHUNK_SIZE + 37).fill(19);
      const file = new File([plaintext], "sample.webm", { type: "video/webm" });
      const video = await createVideo(file);
      const wrappedKey = await wrapVideoKey(
        video.manifest,
        video.credentials.key,
        key,
        library.id,
      );
      const id = video.manifest.id;
      await storage.createDraft(video.manifest, wrappedKey, library.id);
      expect(await storage.list()).toEqual([]);
      await expect(storage.readable(id)).rejects.toMatchObject({ status: 404 });
      for (let index = 0; index < video.manifest.chunkCount; index += 1) {
        const bytes = await file
          .slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE)
          .arrayBuffer();
        const packet = new Uint8Array(
          await encryptChunk(
            bytes,
            index,
            video.manifest,
            video.credentials.key,
          ),
        );
        await Promise.all([
          storage.putChunk(id, index, packet),
          new VideoStorage(config).putChunk(id, index, packet),
        ]);
        if (index === 0)
          await expect(storage.complete(id)).rejects.toMatchObject({
            status: 409,
          });
      }
      await Promise.all([
        storage.complete(id),
        new VideoStorage(config).complete(id),
      ]);
      const replica = new VideoStorage(config);
      const record = await replica.readable(id);
      expect(await replica.list()).toEqual([record]);
      const packet = await replica.readChunk(id, 1);
      expect(
        new Uint8Array(
          await decryptChunk(
            new Uint8Array(packet).buffer,
            1,
            video.manifest,
            video.credentials.key,
          ),
        ),
      ).toEqual(plaintext.slice(CHUNK_SIZE));
      // The warm manifest cache must still obey deletion from another replica.
      expect(await replica.readChunk(id, 1)).toEqual(packet);
      await storage.deleteVideo(id);
      expect(await raw.head(`tombstones/videos/${id}.json`)).not.toBeNull();
      await expect(replica.readable(id)).rejects.toMatchObject({ status: 404 });
      expect(await replica.list()).toEqual([]);
      await expect(
        replica.createDraft(video.manifest, wrappedKey, library.id),
      ).rejects.toMatchObject({ status: 404 });
      // A delayed writer may finish after physical cleanup; the permanent tombstone still wins.
      await raw.publish(`videos/${id}/manifest.json`, JSON.stringify(record));
      await raw.publish(`videos/${id}/chunks/1`, packet);
      await expect(replica.readChunk(id, 1)).rejects.toMatchObject({
        status: 404,
      });
      expect(await replica.list()).toEqual([]);
      await expect(replica.readable(id)).rejects.toMatchObject({ status: 404 });
      await replica.deleteVideo(id);
      expect(await raw.head(`videos/${id}/manifest.json`)).toBeNull();
      expect(await replica.library()).toEqual(library);
    } finally {
      const keys = await raw.list("");
      for (let offset = 0; offset < keys.length; offset += 8)
        await Promise.all(
          keys.slice(offset, offset + 8).map((key) => raw.remove(key)),
        );
      expect(await raw.list("")).toEqual([]);
    }
  },
  180_000,
);
