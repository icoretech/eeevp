// Shared, strict wire schemas keep browser encryption and the private library in agreement.
import { z } from "zod";

export const CHUNK_SIZE = 1_048_576;
export const MAX_VIDEO_SIZE = 2_147_483_648;
export const VIDEO_TYPES = ["video/mp4", "video/webm"] as const;

export const videoIdSchema = z.uuid();

const base64urlSchema = z.base64url().refine((value) => {
  const remainder = value.length % 4;
  if (remainder === 1) return false;
  if (remainder === 2) return /[AQgw]$/.test(value);
  if (remainder === 3) return /[AEIMQUYcgkosw048]$/.test(value);
  return true;
}, "Expected canonical unpadded base64url.");

// A 32-byte value has exactly 43 unpadded base64url characters, including four final bits.
const secretSchema = base64urlSchema
  .length(43)
  .regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);

export const metadataSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(255)
    .refine(
      (name) =>
        Array.from(name).every((character) => {
          const code = character.charCodeAt(0);
          return code > 31 && code !== 127;
        }),
      "Video names must not contain control characters.",
    ),
  type: z.enum(VIDEO_TYPES),
});

export const manifestSchema = z
  .strictObject({
    version: z.literal(1),
    id: videoIdSchema,
    size: z.number().int().positive().max(MAX_VIDEO_SIZE),
    chunkSize: z.literal(CHUNK_SIZE),
    chunkCount: z
      .number()
      .int()
      .positive()
      .max(MAX_VIDEO_SIZE / CHUNK_SIZE),
    encryptedMetadata: base64urlSchema.min(40).max(2_048),
  })
  .refine(
    (manifest) => manifest.chunkCount === Math.ceil(manifest.size / CHUNK_SIZE),
    {
      path: ["chunkCount"],
      error: "Chunk count must match the declared video size.",
    },
  );

export const credentialsSchema = z.strictObject({
  id: videoIdSchema,
  key: secretSchema,
});

export const libraryDescriptorSchema = z.strictObject({
  version: z.literal(1),
  id: videoIdSchema,
  encryptedVerifier: base64urlSchema.min(40).max(512),
});

export const libraryVideoSchema = z.strictObject({
  manifest: manifestSchema,
  wrappedKey: base64urlSchema.length(80),
  libraryId: videoIdSchema,
  createdAt: z.iso.datetime(),
});

export type VideoManifest = z.infer<typeof manifestSchema>;
export type VideoMetadata = z.infer<typeof metadataSchema>;
export type VideoCredentials = z.infer<typeof credentialsSchema>;
export type LibraryDescriptor = z.infer<typeof libraryDescriptorSchema>;
export type LibraryVideo = z.infer<typeof libraryVideoSchema>;
