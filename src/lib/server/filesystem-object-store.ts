// Local development implements the same immutable object contract on its explicit persistent volume.
import "server-only";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { hasFileCode, publishStoredFile, readStoredFile } from "./filesystem";
import type { ObjectStore } from "./object-store";

function validateKey(key: string, prefix = false) {
  if (prefix && key === "") return;
  const value = prefix && key.endsWith("/") ? key.slice(0, -1) : key;
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Invalid object key");
}

export class FilesystemObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  private async directory(path: string, create: boolean, recursive = false) {
    let entry = await lstat(path).catch((error: unknown) => {
      if (hasFileCode(error, "ENOENT")) return null;
      throw error;
    });
    if (!entry && create) {
      await mkdir(path, { recursive, mode: 0o700 }).catch((error: unknown) => {
        if (!hasFileCode(error, "EEXIST")) throw error;
      });
      entry = await lstat(path);
    }
    if (!entry) return false;
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Invalid storage directory");
    return true;
  }

  private async path(key: string, create = false) {
    validateKey(key);
    if (!(await this.directory(this.root, create, true))) return null;
    let current = this.root;
    for (const part of key.split("/").slice(0, -1)) {
      current = join(current, part);
      if (!(await this.directory(current, create))) return null;
    }
    return join(this.root, key);
  }

  async read(key: string, limit: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new Error("Invalid read limit");
    const path = await this.path(key);
    signal?.throwIfAborted();
    return path ? readStoredFile(path, limit, signal) : null;
  }

  async publish(key: string, body: string | Uint8Array) {
    const path = await this.path(key, true);
    if (!path) throw new Error("Storage directory is unavailable");
    return publishStoredFile(path, body, false);
  }

  async head(key: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const path = await this.path(key);
    signal?.throwIfAborted();
    if (!path) return null;
    try {
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        signal?.throwIfAborted();
        if (!stat.isFile()) throw new Error("Invalid stored object");
        return { size: stat.size };
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (hasFileCode(error, "ENOENT")) return null;
      throw error;
    }
  }

  async list(prefix: string) {
    validateKey(prefix, true);
    const keys: string[] = [];
    const initial = prefix.includes("/")
      ? prefix.slice(0, prefix.lastIndexOf("/") + 1)
      : "";
    const directories = [initial];
    while (directories.length > 0) {
      const directory = directories.pop();
      if (directory === undefined) break;
      const anchor = await this.path(`${directory}.list-check`);
      if (!anchor) continue;
      const entries = await readdir(dirname(anchor), {
        withFileTypes: true,
      }).catch((error: unknown) => {
        if (hasFileCode(error, "ENOENT")) return [];
        throw error;
      });
      for (const entry of entries) {
        const key = directory + entry.name;
        if (entry.isDirectory()) directories.push(`${key}/`);
        else if (entry.isFile() && key.startsWith(prefix)) keys.push(key);
      }
    }
    return keys.sort();
  }

  async remove(key: string) {
    const path = await this.path(key);
    if (!path) return;
    try {
      await unlink(path);
    } catch (error) {
      if (!hasFileCode(error, "ENOENT")) throw error;
    }
  }

  async ready() {
    const key = `.health-${randomUUID()}`;
    await this.publish(key, "ready");
    try {
      if ((await this.read(key, 5))?.toString() !== "ready")
        throw new Error("Storage readiness failed");
    } finally {
      await this.remove(key);
    }
  }

  async removeVideo(id: string) {
    validateKey(id);
    if (id.includes("/")) throw new Error("Invalid video directory");
    const source = await this.path(`videos/${id}/.delete-check`);
    if (!source) return;
    const path = dirname(source);
    const removed = await this.path(`.trash/${randomUUID()}`, true);
    if (!removed) throw new Error("Trash directory is unavailable");
    try {
      await rename(path, removed);
    } catch (error) {
      if (hasFileCode(error, "ENOENT")) return;
      throw error;
    }
    await Promise.all(
      [join(this.root, "videos"), join(this.root, ".trash")].map(
        async (parent) => {
          // The mounted runtime directory is not a bundled application asset.
          const handle = await open(
            /* turbopackIgnore: true */ parent,
            constants.O_RDONLY,
          );
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        },
      ),
    );
    await rm(removed, { recursive: true });
  }
}
