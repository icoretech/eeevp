// Every library record is immutable shared storage; deletion tombstones prevent cross-replica resurrection.
import "server-only";
import {
  CHUNK_SIZE,
  type LibraryDescriptor,
  type LibraryVideo,
  libraryDescriptorSchema,
  libraryVideoSchema,
  type VideoManifest,
  videoIdSchema,
} from "@/lib/video/schema";
import type { ServerConfig } from "./config";
import { FilesystemObjectStore } from "./filesystem-object-store";
import { HttpError } from "./http";
import type { ObjectStore } from "./object-store";
import { createObjectStore } from "./storage-factory";

const MAX_CHUNK_MANIFESTS = 256;
// Only positive immutable manifests are cached. Each packet still checks the shared
// tombstone after its read, so deletion is authoritative across processes/replicas.
const chunkManifests = new WeakMap<ObjectStore, Map<string, VideoManifest>>();

function parseRecord(body: Buffer, id: string) {
  try {
    const record = libraryVideoSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
    );
    if (record.manifest.id !== id)
      throw new Error("Mismatched video identifier");
    return record;
  } catch {
    throw new HttpError(503, "Stored video is unavailable");
  }
}

export function expectedChunkLength(manifest: VideoManifest, index: number) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.chunkCount)
    throw new HttpError(404, "Video chunk not found");
  return Math.min(CHUNK_SIZE, manifest.size - index * CHUNK_SIZE) + 28;
}

export function parseChunkIndex(value: string) {
  if (!/^(0|[1-9]\d*)$/.test(value))
    throw new HttpError(404, "Video chunk not found");
  const index = Number(value);
  if (!Number.isSafeInteger(index))
    throw new HttpError(404, "Video chunk not found");
  return index;
}

export class VideoStorage {
  private readonly store: ObjectStore;

  constructor(config: ServerConfig) {
    this.store = createObjectStore(config);
  }

  private key(id: string, suffix: string) {
    const parsed = videoIdSchema.safeParse(id);
    if (!parsed.success) throw new HttpError(404, "Video not found");
    return `videos/${parsed.data}/${suffix}`;
  }

  private tombstoneKey(id: string) {
    const parsed = videoIdSchema.safeParse(id);
    if (!parsed.success) throw new HttpError(404, "Video not found");
    return `tombstones/videos/${parsed.data}.json`;
  }

  private async deleted(id: string, signal?: AbortSignal) {
    return (await this.store.head(this.tombstoneKey(id), signal)) !== null;
  }

  private async requirePresent(id: string, signal?: AbortSignal) {
    if (await this.deleted(id, signal))
      throw new HttpError(404, "Video not found");
  }

  ready() {
    return this.store.ready();
  }

  private async getRecord(id: string, kind: "draft" | "manifest") {
    if (await this.deleted(id)) return null;
    const body = await this.store.read(this.key(id, `${kind}.json`), 65536);
    if (!body) return null;
    const record = parseRecord(body, id);
    if (await this.deleted(id)) return null;
    return record;
  }

  async library() {
    const bytes = await this.store.read("library.json", 4096);
    if (!bytes) return null;
    try {
      return libraryDescriptorSchema.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
      );
    } catch {
      throw new HttpError(503, "Stored library is unavailable");
    }
  }

  async createLibrary(descriptor: LibraryDescriptor) {
    const library = libraryDescriptorSchema.parse(descriptor);
    if (!(await this.store.publish("library.json", JSON.stringify(library))))
      throw new HttpError(409, "Library has already been initialized");
    return library;
  }

  async createDraft(
    manifest: VideoManifest,
    wrappedKey: string,
    libraryId: string,
  ) {
    const record = libraryVideoSchema.parse({
      manifest,
      wrappedKey,
      libraryId,
      createdAt: new Date().toISOString(),
    });
    const library = await this.library();
    if (!library || library.id !== record.libraryId)
      throw new HttpError(409, "Open the initialized library before uploading");
    await this.requirePresent(record.manifest.id);
    if (
      !(await this.store.publish(
        this.key(record.manifest.id, "draft.json"),
        JSON.stringify(record),
      ))
    )
      throw new HttpError(409, "Video identifier already exists");
    await this.requirePresent(record.manifest.id);
  }

  async draft(id: string) {
    const record = await this.getRecord(id, "draft");
    if (!record) throw new HttpError(404, "Upload not found");
    return record;
  }

  async list() {
    const keys = await this.store.list("videos/");
    const ids = new Set<string>();
    for (const key of keys) {
      const match = /^videos\/([^/]+)\/manifest\.json$/.exec(key);
      if (match?.[1] && videoIdSchema.safeParse(match[1]).success)
        ids.add(match[1]);
    }
    const ordered = [...ids];
    const records: LibraryVideo[] = [];
    for (let offset = 0; offset < ordered.length; offset += 8) {
      const batch = await Promise.all(
        ordered
          .slice(offset, offset + 8)
          .map((id) => this.getRecord(id, "manifest")),
      );
      for (const record of batch) if (record) records.push(record);
    }
    return records.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        left.manifest.id.localeCompare(right.manifest.id),
    );
  }

  async putChunk(id: string, index: number, packet: Uint8Array) {
    const record = await this.draft(id);
    if (packet.byteLength !== expectedChunkLength(record.manifest, index))
      throw new HttpError(400, "Encrypted chunk has an invalid length");
    const key = this.key(id, `chunks/${index}`);
    if (!(await this.store.publish(key, packet))) {
      const existing = await this.store.read(key, packet.byteLength);
      if (!existing?.equals(packet))
        throw new HttpError(
          409,
          "Encrypted chunk already exists with different content",
        );
    }
    await this.requirePresent(id);
  }

  async complete(id: string) {
    const record = await this.draft(id);
    for (let offset = 0; offset < record.manifest.chunkCount; offset += 8) {
      const count = Math.min(8, record.manifest.chunkCount - offset);
      await Promise.all(
        Array.from({ length: count }, async (_, position) => {
          const index = offset + position;
          const object = await this.store.head(this.key(id, `chunks/${index}`));
          if (
            !object ||
            object.size !== expectedChunkLength(record.manifest, index)
          )
            throw new HttpError(409, "Upload is incomplete");
        }),
      );
    }
    await this.requirePresent(id);
    if (
      !(await this.store.publish(
        this.key(id, "manifest.json"),
        JSON.stringify(record),
      ))
    ) {
      await this.requirePresent(id);
      const committed = await this.getRecord(id, "manifest");
      if (!committed || JSON.stringify(committed) !== JSON.stringify(record))
        throw new HttpError(
          409,
          "Video has already been committed with different content",
        );
    }
    await this.requirePresent(id);
  }

  async readable(id: string) {
    const record = await this.getRecord(id, "manifest");
    if (!record) throw new HttpError(404, "Video not found");
    return record;
  }

  async readChunk(id: string, index: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const manifestKey = this.key(id, "manifest.json");
    let cache = chunkManifests.get(this.store);
    if (!cache) {
      cache = new Map();
      chunkManifests.set(this.store, cache);
    }
    try {
      let manifest = cache.get(id);
      if (!manifest) {
        const bytes = await this.store.read(manifestKey, 65536, signal);
        signal?.throwIfAborted();
        if (!bytes) throw new HttpError(404, "Video not found");
        manifest = parseRecord(bytes, id).manifest;
      }
      const length = expectedChunkLength(manifest, index);
      const body = await this.store.read(
        this.key(id, `chunks/${index}`),
        length,
        signal,
      );
      signal?.throwIfAborted();
      if (!body) throw new HttpError(404, "Video chunk not found");
      if (body.byteLength !== length)
        throw new HttpError(503, "Stored video is unavailable");
      // This must follow the object download: a deletion racing with it wins.
      await this.requirePresent(id, signal);
      signal?.throwIfAborted();
      cache.delete(id);
      cache.set(id, manifest);
      if (cache.size > MAX_CHUNK_MANIFESTS) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return body;
    } catch (error) {
      cache.delete(id);
      throw error;
    }
  }

  async deleteVideo(id: string) {
    const tombstone = this.tombstoneKey(id);
    if (!(await this.deleted(id))) {
      await this.readable(id);
      await this.store.publish(
        tombstone,
        JSON.stringify({ version: 1, id, createdAt: new Date().toISOString() }),
      );
    }
    if (this.store instanceof FilesystemObjectStore) {
      await this.store.removeVideo(id);
      return;
    }
    const keys = await this.store.list(this.key(id, ""));
    for (let offset = 0; offset < keys.length; offset += 8)
      await Promise.all(
        keys.slice(offset, offset + 8).map((key) => this.store.remove(key)),
      );
  }
}

export async function withStorage<Result>(
  config: ServerConfig,
  action: (storage: VideoStorage) => Promise<Result>,
) {
  return action(new VideoStorage(config));
}
