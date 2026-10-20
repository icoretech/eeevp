// A browser-only master key authenticates the private library and wraps independently generated video keys.
import {
  credentialsSchema,
  type LibraryDescriptor,
  libraryDescriptorSchema,
  libraryVideoSchema,
  manifestSchema,
  type VideoManifest,
  videoIdSchema,
} from "@/lib/video/schema";
import {
  decodeBase64url,
  decryptPacket,
  encodeBase64url,
  encryptPacket,
  getCrypto,
  randomKey,
} from "./packets";

const encoder = new TextEncoder();
const VERIFIER = "EEEVP private library encryption key version 1";

function verifierContext(
  descriptor: Pick<LibraryDescriptor, "id" | "version">,
) {
  return encoder.encode(
    JSON.stringify([
      "EEEVP",
      descriptor.version,
      "library-verifier",
      descriptor.id,
    ]),
  );
}

function wrappingContext(manifest: VideoManifest, libraryId: string) {
  const parsed = manifestSchema.parse(manifest);
  const id = videoIdSchema.parse(libraryId);
  return encoder.encode(
    JSON.stringify([
      "EEEVP",
      1,
      "wrapped-video-key",
      id,
      parsed.version,
      parsed.id,
      parsed.size,
      parsed.chunkSize,
      parsed.chunkCount,
      parsed.encryptedMetadata,
    ]),
  );
}

export function createLibraryKey(): string {
  return randomKey();
}

export async function createLibraryDescriptor(
  key: string,
): Promise<LibraryDescriptor> {
  const descriptor = { version: 1 as const, id: getCrypto().randomUUID() };
  const encrypted = await encryptPacket(
    encoder.encode(VERIFIER).buffer,
    verifierContext(descriptor),
    key,
  );
  return libraryDescriptorSchema.parse({
    ...descriptor,
    encryptedVerifier: encodeBase64url(new Uint8Array(encrypted)),
  });
}

export async function verifyLibraryKey(
  descriptor: LibraryDescriptor,
  key: string,
): Promise<void> {
  const parsed = libraryDescriptorSchema.parse(descriptor);
  const decrypted = new Uint8Array(
    await decryptPacket(
      decodeBase64url(parsed.encryptedVerifier).buffer,
      verifierContext(parsed),
      key,
    ),
  );
  const expected = encoder.encode(VERIFIER);
  if (
    decrypted.byteLength !== expected.byteLength ||
    !decrypted.every((byte, index) => byte === expected[index])
  ) {
    throw new Error("The library key verifier is invalid.");
  }
}

export async function wrapVideoKey(
  manifest: VideoManifest,
  videoKey: string,
  libraryKey: string,
  libraryId: string,
): Promise<string> {
  const key = credentialsSchema.shape.key.parse(videoKey);
  const packet = await encryptPacket(
    decodeBase64url(key).buffer,
    wrappingContext(manifest, libraryId),
    libraryKey,
  );
  return libraryVideoSchema.shape.wrappedKey.parse(
    encodeBase64url(new Uint8Array(packet)),
  );
}

export async function unwrapVideoKey(
  manifest: VideoManifest,
  wrappedKey: string,
  libraryKey: string,
  libraryId: string,
): Promise<string> {
  const packet = decodeBase64url(
    libraryVideoSchema.shape.wrappedKey.parse(wrappedKey),
  ).buffer;
  const key = await decryptPacket(
    packet,
    wrappingContext(manifest, libraryId),
    libraryKey,
  );
  return credentialsSchema.shape.key.parse(
    encodeBase64url(new Uint8Array(key)),
  );
}
