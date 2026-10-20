// Atomic files on one persistent volume keep upload state durable and safe across Node processes.
import "server-only";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { HttpError } from "./http";

function hasFileCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

export function expectedChunkLength(manifest: VideoManifest, index: number) {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= manifest.chunkCount
  ) {
    throw new HttpError(404, "Video chunk not found");
  }
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
  private readonly root: string;

  constructor(config: ServerConfig) {
    this.root = config.STORAGE_PATH;
  }

  private filePath(id: string, suffix: string) {
    const parsed = videoIdSchema.safeParse(id);
    if (!parsed.success) throw new HttpError(404, "Video not found");
    return join(this.root, "videos", parsed.data, suffix);
  }

  async ready() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, `.health-${randomUUID()}`);
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile("ready");
      await handle.sync();
    } finally {
      await handle.close();
      await unlink(path);
    }
  }

  private async readFile(path: string, limit: number) {
    let handle: FileHandle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (hasFileCode(error, "ENOENT")) return null;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limit)
        throw new HttpError(503, "Stored video is unavailable");
      // Bound allocation and reads even if an operator modifies a published file outside the app.
      const bytes = Buffer.alloc(Math.min(stat.size, limit) + 1);
      let length = 0;
      while (length < bytes.byteLength) {
        const result = await handle.read(
          bytes,
          length,
          bytes.byteLength - length,
          length,
        );
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length > limit || length !== stat.size)
        throw new HttpError(503, "Stored video is unavailable");
      return bytes.subarray(0, length);
    } finally {
      await handle.close();
    }
  }

  private async publish(
    path: string,
    body: string | Uint8Array,
    createParents = true,
  ) {
    if (createParents)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(path), `.pending-${randomUUID()}`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(body);
        await handle.sync();
      } finally {
        await handle.close();
      }
      // A hard link publishes a fully written inode atomically and never replaces an existing object.
      await link(temporary, path);
      const directory = await open(dirname(path), constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return true;
    } catch (error) {
      if (hasFileCode(error, "EEXIST")) return false;
      throw error;
    } finally {
      await unlink(temporary);
    }
  }

  private async getRecord(id: string, kind: "draft" | "manifest") {
    const body = await this.readFile(this.filePath(id, `${kind}.json`), 65536);
    if (!body) return null;
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

  async library() {
    const bytes = await this.readFile(join(this.root, "library.json"), 4096);
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
    if (
      !(await this.publish(
        join(this.root, "library.json"),
        JSON.stringify(library),
      ))
    ) {
      throw new HttpError(409, "Library has already been initialized");
    }
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
    if (!library || library.id !== record.libraryId) {
      throw new HttpError(
        409,
        "Unlock the initialized library before uploading",
      );
    }
    await mkdir(dirname(this.filePath(record.manifest.id, "chunks/0")), {
      recursive: true,
      mode: 0o700,
    });
    if (
      !(await this.publish(
        this.filePath(record.manifest.id, "draft.json"),
        JSON.stringify(record),
      ))
    ) {
      throw new HttpError(409, "Video identifier already exists");
    }
  }

  async draft(id: string) {
    const record = await this.getRecord(id, "draft");
    if (!record) throw new HttpError(404, "Upload not found");
    return record;
  }

  async list() {
    const directory = join(this.root, "videos");
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: unknown) => {
        if (hasFileCode(error, "ENOENT")) return [];
        throw error;
      },
    );
    const ids = entries
      .filter(
        (entry) =>
          entry.isDirectory() && videoIdSchema.safeParse(entry.name).success,
      )
      .map((entry) => entry.name);
    const records: LibraryVideo[] = [];
    for (let offset = 0; offset < ids.length; offset += 8) {
      const batch = await Promise.all(
        ids
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
    if (packet.byteLength !== expectedChunkLength(record.manifest, index)) {
      throw new HttpError(400, "Encrypted chunk has an invalid length");
    }
    const path = this.filePath(id, `chunks/${index}`);
    if (!(await this.publish(path, packet, false))) {
      const existing = await this.readFile(path, packet.byteLength);
      if (!existing?.equals(packet)) {
        throw new HttpError(
          409,
          "Encrypted chunk already exists with different content",
        );
      }
    }
  }

  async complete(id: string) {
    const record = await this.draft(id);
    // Bound open file concurrency independently of video size.
    for (let offset = 0; offset < record.manifest.chunkCount; offset += 8) {
      const count = Math.min(8, record.manifest.chunkCount - offset);
      await Promise.all(
        Array.from({ length: count }, async (_, position) => {
          const index = offset + position;
          let handle: FileHandle | undefined;
          try {
            handle = await open(
              this.filePath(id, `chunks/${index}`),
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            const stat = await handle.stat();
            if (
              !stat.isFile() ||
              stat.size !== expectedChunkLength(record.manifest, index)
            ) {
              throw new HttpError(409, "Upload is incomplete");
            }
          } catch (error) {
            if (hasFileCode(error, "ENOENT"))
              throw new HttpError(409, "Upload is incomplete");
            throw error;
          } finally {
            await handle?.close();
          }
        }),
      );
    }
    if (
      !(await this.publish(
        this.filePath(id, "manifest.json"),
        JSON.stringify(record),
        false,
      ))
    ) {
      const committed = await this.getRecord(id, "manifest");
      if (!committed || JSON.stringify(committed) !== JSON.stringify(record)) {
        throw new HttpError(
          409,
          "Video has already been committed with different content",
        );
      }
    }
  }

  async readable(id: string) {
    const record = await this.getRecord(id, "manifest");
    if (!record) throw new HttpError(404, "Video not found");
    return record;
  }

  async readChunk(id: string, index: number) {
    const video = await this.readable(id);
    const length = expectedChunkLength(video.manifest, index);
    const body = await this.readFile(
      this.filePath(id, `chunks/${index}`),
      length,
    );
    if (!body) throw new HttpError(404, "Video chunk not found");
    if (body.byteLength !== length)
      throw new HttpError(503, "Stored video is unavailable");
    return body;
  }

  async deleteVideo(id: string) {
    await this.readable(id);
    const path = this.filePath(id, "");
    const entry = await lstat(path).catch((error: unknown) => {
      if (hasFileCode(error, "ENOENT"))
        throw new HttpError(404, "Video not found");
      throw error;
    });
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new HttpError(404, "Video not found");
    const trash = join(this.root, ".trash");
    await mkdir(trash, { recursive: true, mode: 0o700 });
    const trashEntry = await lstat(trash);
    if (!trashEntry.isDirectory() || trashEntry.isSymbolicLink())
      throw new HttpError(503, "Video storage is unavailable");
    const removed = join(trash, randomUUID());
    try {
      await rename(path, removed);
    } catch (error) {
      if (hasFileCode(error, "ENOENT"))
        throw new HttpError(404, "Video not found");
      throw error;
    }
    const directory = await open(join(this.root, "videos"), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    await rm(removed, { recursive: true });
  }
}

export async function withStorage<Result>(
  config: ServerConfig,
  action: (storage: VideoStorage) => Promise<Result>,
) {
  return action(new VideoStorage(config));
}
