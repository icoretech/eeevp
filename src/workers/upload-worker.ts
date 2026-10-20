// The upload worker reads, encrypts, and uploads one chunk at a time; plaintext stays in the browser.
import { z } from "zod";
import { verifyLibraryKey, wrapVideoKey } from "@/lib/crypto/library-crypto";
import { createVideo, encryptChunk } from "@/lib/crypto/video-crypto";
import {
  credentialsSchema,
  type LibraryDescriptor,
  libraryDescriptorSchema,
  libraryVideoSchema,
  type VideoManifest,
} from "@/lib/video/schema";

const requestSchema = z.strictObject({
  type: z.literal("upload"),
  file: z.instanceof(File),
  libraryKey: credentialsSchema.shape.key,
  library: libraryDescriptorSchema,
});
let uploading = false;

async function request(
  path: string,
  init: RequestInit,
  status: number,
  action: string,
) {
  const response = await fetch(path, {
    ...init,
    mode: "same-origin",
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
  });
  if (response.status !== status) {
    await response.body?.cancel();
    if (response.status === 401)
      throw new Error("Your library session expired. Sign in again.");
    throw new Error(
      `${action} failed (HTTP ${response.status}). Please try again.`,
    );
  }
  return response;
}

async function send(
  path: string,
  init: RequestInit,
  status: number,
  action: string,
) {
  const response = await request(path, init, status, action);
  await response.body?.cancel();
}

async function readCompleted(
  manifest: VideoManifest,
  wrappedKey: string,
  libraryId: string,
) {
  const response = await request(
    `/api/videos/${manifest.id}`,
    { method: "GET" },
    200,
    "Reading the completed video",
  );
  if (!response.body)
    throw new Error("The completed video record is unavailable.");
  const bytes = new Uint8Array(8_192);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value.byteLength > bytes.byteLength - offset) {
        await reader.cancel();
        throw new Error("The completed video record is too large.");
      }
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const body = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset)),
  );
  const { video } = z.strictObject({ video: libraryVideoSchema }).parse(body);
  if (
    video.libraryId !== libraryId ||
    video.wrappedKey !== wrappedKey ||
    JSON.stringify(video.manifest) !== JSON.stringify(manifest)
  ) {
    throw new Error("The completed video record does not match this upload.");
  }
  return video;
}

async function upload(
  file: File,
  libraryKey: string,
  library: LibraryDescriptor,
) {
  await verifyLibraryKey(library, libraryKey);
  const result = await createVideo(file);
  const { manifest, credentials } = result;
  const wrappedKey = await wrapVideoKey(
    manifest,
    credentials.key,
    libraryKey,
    library.id,
  );
  await send(
    "/api/videos",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest, wrappedKey, libraryId: library.id }),
    },
    201,
    "Starting the upload",
  );

  for (let index = 0; index < manifest.chunkCount; index += 1) {
    const start = index * manifest.chunkSize;
    self.postMessage({
      type: "progress",
      phase: "encrypting",
      completed: start,
      total: manifest.size,
    });
    const plaintext = await file
      .slice(start, Math.min(start + manifest.chunkSize, manifest.size))
      .arrayBuffer();
    const ciphertext = await encryptChunk(
      plaintext,
      index,
      manifest,
      credentials.key,
    );
    self.postMessage({
      type: "progress",
      phase: "uploading",
      completed: start,
      total: manifest.size,
    });
    await send(
      `/api/videos/${manifest.id}/chunks/${index}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: ciphertext,
      },
      204,
      "Uploading an encrypted chunk",
    );
    self.postMessage({
      type: "progress",
      phase: "uploading",
      completed: Math.min(start + manifest.chunkSize, manifest.size),
      total: manifest.size,
    });
  }

  self.postMessage({
    type: "progress",
    phase: "completing",
    completed: manifest.size,
    total: manifest.size,
  });
  await send(
    `/api/videos/${manifest.id}/complete`,
    { method: "POST" },
    200,
    "Completing the upload",
  );
  const video = await readCompleted(manifest, wrappedKey, library.id);
  self.postMessage({ type: "complete", video, metadata: result.metadata });
}

self.addEventListener("message", async (event: MessageEvent<unknown>) => {
  if (uploading) {
    self.postMessage({
      type: "error",
      message: "An upload is already running in this worker.",
    });
    self.close();
    return;
  }
  const parsed = requestSchema.safeParse(event.data);
  if (!parsed.success) {
    self.postMessage({
      type: "error",
      message: "Choose a valid video file before uploading.",
    });
    self.close();
    return;
  }
  uploading = true;
  try {
    await upload(parsed.data.file, parsed.data.libraryKey, parsed.data.library);
  } catch (error) {
    self.postMessage({
      type: "error",
      message:
        error instanceof Error
          ? error.message
          : "The encrypted upload failed. Please try again.",
    });
  } finally {
    uploading = false;
    self.close();
  }
});
