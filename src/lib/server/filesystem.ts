// Server records share bounded reads and atomic immutable publication on the persistent volume.
import "server-only";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { HttpError } from "./http";

export function hasFileCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function readStoredFile(path: string, limit: number) {
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
      throw new HttpError(503, "Stored data is unavailable");
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
      throw new HttpError(503, "Stored data is unavailable");
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

export async function publishStoredFile(
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
