// Browser-only video encryption uses independently authenticated, bounded AES-GCM packets.
import {
  CHUNK_SIZE,
  credentialsSchema,
  MAX_VIDEO_SIZE,
  manifestSchema,
  metadataSchema,
  type VideoManifest,
} from "@/lib/video/schema";
import {
  decodeBase64url,
  decryptPacket,
  encodeBase64url,
  encryptPacket,
  getCrypto,
  randomKey,
} from "./packets";

const PACKET_OVERHEAD = 28;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function authenticationData(
  manifest: VideoManifest,
  purpose: "metadata" | "chunk",
  index: number | null,
) {
  return encoder.encode(
    JSON.stringify([
      "EEEVP",
      manifest.version,
      manifest.id,
      manifest.size,
      manifest.chunkSize,
      manifest.chunkCount,
      purpose,
      index,
      ...(purpose === "chunk" ? [manifest.encryptedMetadata] : []),
    ]),
  );
}

function chunkLength(index: number, manifest: VideoManifest) {
  if (!Number.isInteger(index) || index < 0 || index >= manifest.chunkCount) {
    throw new Error("Chunk index is outside the declared video.");
  }
  return Math.min(
    manifest.chunkSize,
    manifest.size - index * manifest.chunkSize,
  );
}

export async function createVideo(file: File) {
  if (
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > MAX_VIDEO_SIZE
  ) {
    throw new Error(
      "Choose a video larger than 0 bytes and no larger than 2 GiB.",
    );
  }
  const metadata = metadataSchema.parse({ name: file.name, type: file.type });
  const crypto = getCrypto();
  const credentials = credentialsSchema.parse({
    id: crypto.randomUUID(),
    key: randomKey(),
  });
  const context: VideoManifest = {
    version: 1,
    id: credentials.id,
    size: file.size,
    chunkSize: CHUNK_SIZE,
    chunkCount: Math.ceil(file.size / CHUNK_SIZE),
    encryptedMetadata: "",
  };
  const encrypted = await encryptPacket(
    encoder.encode(JSON.stringify(metadata)).buffer,
    authenticationData(context, "metadata", null),
    credentials.key,
  );
  const manifest = manifestSchema.parse({
    ...context,
    encryptedMetadata: encodeBase64url(new Uint8Array(encrypted)),
  });
  return { manifest, credentials, metadata };
}

export async function encryptChunk(
  plaintext: ArrayBuffer,
  index: number,
  manifest: VideoManifest,
  key: string,
) {
  const parsed = manifestSchema.parse(manifest);
  if (plaintext.byteLength !== chunkLength(index, parsed)) {
    throw new Error(
      "Plaintext chunk length does not match the declared video.",
    );
  }
  return encryptPacket(
    plaintext,
    authenticationData(parsed, "chunk", index),
    key,
  );
}

export async function decryptChunk(
  ciphertext: ArrayBuffer,
  index: number,
  manifest: VideoManifest,
  key: string,
) {
  const parsed = manifestSchema.parse(manifest);
  if (ciphertext.byteLength !== chunkLength(index, parsed) + PACKET_OVERHEAD) {
    throw new Error(
      "Encrypted chunk length does not match the declared video.",
    );
  }
  return decryptPacket(
    ciphertext,
    authenticationData(parsed, "chunk", index),
    key,
  );
}

export async function decryptMetadata(manifest: VideoManifest, key: string) {
  const parsed = manifestSchema.parse(manifest);
  const packet = decodeBase64url(parsed.encryptedMetadata).buffer;
  const plaintext = await decryptPacket(
    packet,
    authenticationData(parsed, "metadata", null),
    key,
  );
  return metadataSchema.parse(JSON.parse(decoder.decode(plaintext)));
}
