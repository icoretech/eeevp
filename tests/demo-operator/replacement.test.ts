// This opt-in operator publishes an indexed public fixture with existing crypto/storage contracts and retires only its verified legacy record.
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { normalizeLibraryKeyInput } from "@/lib/crypto/key-input";
import {
  unwrapVideoKey,
  verifyLibraryKey,
  wrapVideoKey,
} from "@/lib/crypto/library-crypto";
import {
  createVideo,
  decryptChunk,
  decryptMetadata,
  encryptChunk,
} from "@/lib/crypto/video-crypto";
import { getConfig } from "@/lib/server/config";
import { HttpError } from "@/lib/server/http";
import { VideoStorage } from "@/lib/server/storage";
import { createObjectStore } from "@/lib/server/storage-factory";
import {
  CHUNK_SIZE,
  type LibraryVideo,
  libraryDescriptorSchema,
  libraryVideoSchema,
} from "@/lib/video/schema";

const directory = resolve("test-results/public-demo-dataset");
const checkpointPath = resolve(directory, "replacement-receipt.json");
const canonicalPath = resolve(directory, "receipt.json");
const digest = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const mediaSchema = z.object({
  path: z.string().min(1),
  filename: z.string().min(1).max(255),
  mime: z.literal("video/webm"),
  size: z
    .number()
    .int()
    .min(15 * 1_048_576)
    .max(30 * 1_048_576),
  sha256: hashSchema,
  durationSeconds: z.number().min(60).max(90.5),
  codec: z.literal("vp8"),
  resolution: z.tuple([
    z.number().int().positive(),
    z.number().int().positive(),
  ]),
  keyframeCount: z.number().int().positive(),
  keyframeMaximumGapSeconds: z.number().positive().max(1.1),
  cueCount: z.number().int().positive(),
  cueOffset: z.number().int().nonnegative(),
  firstClusterOffset: z.number().int().positive(),
  cuesBeforeFirstCluster: z.literal(true),
  chunkCount: z.number().int().positive(),
});
const legacySchema = z.object({
  version: z.literal(1),
  prefix: z.literal("eeevp-demo/v1"),
  publicKeyDigest: hashSchema,
  filename: z.string(),
  sourceSha256: hashSchema,
  library: libraryDescriptorSchema,
  video: libraryVideoSchema,
});
const payloadSchema = libraryVideoSchema.omit({ createdAt: true });
const checkpointSchema = z.object({
  version: z.literal(2),
  state: z.enum(["prepared", "published", "retired"]),
  prefix: z.literal("eeevp-demo/v1"),
  publicKeyDigest: hashSchema,
  filename: z.string(),
  sourceFile: z.string(),
  sourceSha256: hashSchema,
  sourceBytes: z.number().int().positive(),
  durationSeconds: z.number().positive(),
  codec: z.literal("vp8"),
  library: libraryDescriptorSchema,
  libraryObjectSha256: hashSchema,
  payload: payloadSchema,
  video: libraryVideoSchema.optional(),
  legacy: z.object({
    id: z.uuid(),
    receipt: legacySchema,
    tombstoneSha256: hashSchema.optional(),
    retiredAt: z.string().optional(),
  }),
});
const verificationSchema = z.object({
  verdict: z.literal("PASS"),
  videoId: z.uuid(),
  sourceSha256: hashSchema,
  durationSeconds: z.number().min(60).max(90.5),
  seekTargets: z.array(z.number().nonnegative()).min(3),
  artifactRefs: z.array(z.string().min(1)).min(1),
});

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing operator setting: ${name}`);
  return value;
}
async function optionalJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
async function atomicJson(path: string, value: object) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.pending`;
  await writeFile(temporary, JSON.stringify(value, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, path);
}

it("performs only the explicitly requested scoped public-demo operator action", async () => {
  const action = z
    .enum(["publish", "retire"])
    .parse(required("EEEVP_DEMO_OPERATOR_ACTION"));
  const runtime = getConfig();
  if (
    runtime.STORAGE_DRIVER !== "s3" ||
    runtime.S3_PREFIX !== "eeevp-demo/v1" ||
    !runtime.DEMO_MODE
  )
    throw new Error(
      "Operator requires the dedicated S3 public demo configuration; the running application must remain read-only",
    );
  const publicKey = normalizeLibraryKeyInput(
    required("EEEVP_DEMO_OPERATOR_KEY_INPUT"),
  );
  expect(publicKey === runtime.DEMO_PUBLIC_KEY).toBe(true);
  const media = mediaSchema.parse(
    JSON.parse(await readFile(required("DEMO_OPERATOR_METADATA"), "utf8")),
  );
  expect(media.sha256).toBe(
    hashSchema.parse(required("DEMO_OPERATOR_EXPECTED_SHA256")),
  );
  expect(media.cueOffset).toBeLessThan(media.firstClusterOffset);
  expect(media.chunkCount).toBe(Math.ceil(media.size / CHUNK_SIZE));
  const sourcePath = await realpath(resolve(media.path));
  if (!sourcePath.startsWith(`${await realpath(directory)}${sep}`))
    throw new Error(
      "Fixture must live in the dedicated public-demo artifact directory",
    );
  const source = await readFile(sourcePath);
  expect(source.length).toBe(media.size);
  expect(digest(source)).toBe(media.sha256);
  expect(
    source.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
  ).toBe(true);

  async function assertActiveAppReadOnly(stage: "before" | "after") {
    const origin = "http://localhost:3001";
    const absentId = "00000000-0000-4000-8000-000000000001";
    const observations = [];
    for (const [method, path, body] of [
      ["POST", "/api/library", "{}"],
      ["POST", "/api/videos", "{}"],
      ["PUT", `/api/videos/${absentId}/chunks/0`, "x"],
      ["POST", `/api/videos/${absentId}/complete`, undefined],
      ["DELETE", `/api/videos/${absentId}`, undefined],
    ] as const) {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: {
          origin,
          "content-type":
            method === "PUT" ? "application/octet-stream" : "application/json",
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      expect(response.status).toBe(403);
      const reply = z
        .object({ error: z.string() })
        .parse(await response.json());
      expect(reply.error).toMatch(/read-only/i);
      observations.push({ method, path, status: response.status });
    }
    await atomicJson(
      resolve(directory, `operator-http-${action}-${stage}.json`),
      { stage, action, observations },
    );
    console.log(
      `Active demo write guards remained403 (${stage} operator ${action})`,
    );
  }
  await assertActiveAppReadOnly("before");

  // This changes only a local object passed to storage helpers, never process.env, an app process, or an environment file.
  const adminConfig = { ...runtime, DEMO_MODE: false as const };
  const storage = new VideoStorage(adminConfig);
  const raw = createObjectStore(adminConfig);
  const library = await storage.library();
  if (!library)
    throw new Error("Existing public library descriptor is required");
  await verifyLibraryKey(library, publicKey);
  const libraryBytes = await raw.read("library.json", 4096);
  if (!libraryBytes) throw new Error("Library object is unavailable");
  const saved = await optionalJson(checkpointPath);
  let checkpoint: z.infer<typeof checkpointSchema>;
  if (saved !== null) {
    checkpoint = checkpointSchema.parse(saved);
    expect(checkpoint.publicKeyDigest).toBe(digest(publicKey));
    expect(checkpoint.sourceSha256).toBe(media.sha256);
    expect(checkpoint.sourceBytes).toBe(source.length);
    expect(checkpoint.filename).toBe(media.filename);
    expect(checkpoint.library).toEqual(library);
    expect(checkpoint.libraryObjectSha256).toBe(digest(libraryBytes));
  } else {
    if (action !== "publish")
      throw new Error("Nothing has been published for retirement");
    const legacy = legacySchema.parse(await optionalJson(canonicalPath));
    expect(legacy.publicKeyDigest).toBe(digest(publicKey));
    expect(legacy.library).toEqual(library);
    expect(await storage.readable(legacy.video.manifest.id)).toEqual(
      legacy.video,
    );
    const prepared = await createVideo(
      new File([new Uint8Array(source)], media.filename, { type: media.mime }),
    );
    const wrappedKey = await wrapVideoKey(
      prepared.manifest,
      prepared.credentials.key,
      publicKey,
      library.id,
    );
    checkpoint = {
      version: 2,
      state: "prepared",
      prefix: "eeevp-demo/v1",
      publicKeyDigest: digest(publicKey),
      filename: media.filename,
      sourceFile: basename(sourcePath),
      sourceSha256: media.sha256,
      sourceBytes: source.length,
      durationSeconds: media.durationSeconds,
      codec: media.codec,
      library,
      libraryObjectSha256: digest(libraryBytes),
      payload: {
        manifest: prepared.manifest,
        wrappedKey,
        libraryId: library.id,
      },
      legacy: { id: legacy.video.manifest.id, receipt: legacy },
    };
    // Persist the immutable identifier/envelope before a cloud write, so retry never creates a second candidate.
    await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
  }
  const id = checkpoint.payload.manifest.id;
  if (id === checkpoint.legacy.id)
    throw new Error("Candidate and legacy identifiers must differ");
  const videoKey = await unwrapVideoKey(
    checkpoint.payload.manifest,
    checkpoint.payload.wrappedKey,
    publicKey,
    library.id,
  );
  expect(await decryptMetadata(checkpoint.payload.manifest, videoKey)).toEqual({
    name: media.filename,
    type: media.mime,
  });

  async function existingChunkMatches(index: number) {
    const plain = source.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
    const existing = await raw.read(
      `videos/${id}/chunks/${index}`,
      plain.length + 28,
    );
    if (!existing) return false;
    expect(existing.length).toBe(plain.length + 28);
    const decrypted = await decryptChunk(
      new Uint8Array(existing).buffer,
      index,
      checkpoint.payload.manifest,
      videoKey,
    );
    expect(Buffer.from(decrypted).equals(plain)).toBe(true);
    return true;
  }

  if (action === "publish") {
    if (checkpoint.state === "prepared") {
      let draft: LibraryVideo | undefined;
      try {
        draft = await storage.draft(id);
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 404)) throw error;
      }
      if (!draft) {
        await storage.createDraft(
          checkpoint.payload.manifest,
          checkpoint.payload.wrappedKey,
          checkpoint.payload.libraryId,
        );
        draft = await storage.draft(id);
      }
      expect({
        manifest: draft.manifest,
        wrappedKey: draft.wrappedKey,
        libraryId: draft.libraryId,
      }).toEqual(checkpoint.payload);
      for (
        let index = 0;
        index < checkpoint.payload.manifest.chunkCount;
        index += 1
      ) {
        if (await existingChunkMatches(index)) continue;
        const plain = new Uint8Array(
          source.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
        );
        const packet = new Uint8Array(
          await encryptChunk(
            plain.buffer,
            index,
            checkpoint.payload.manifest,
            videoKey,
          ),
        );
        try {
          await storage.putChunk(id, index, packet);
        } catch (error) {
          if (
            !(error instanceof HttpError && error.status === 409) ||
            !(await existingChunkMatches(index))
          )
            throw error;
        }
        console.log(
          `Published candidate chunk ${index + 1}/${checkpoint.payload.manifest.chunkCount}`,
        );
      }
      await storage.complete(id);
      const record = await storage.readable(id);
      expect({
        manifest: record.manifest,
        wrappedKey: record.wrappedKey,
        libraryId: record.libraryId,
      }).toEqual(checkpoint.payload);
      checkpoint = { ...checkpoint, state: "published", video: record };
      await atomicJson(checkpointPath, checkpoint);
    }
    if (!checkpoint.video)
      throw new Error("Published candidate record missing");
    expect(await storage.readable(id)).toEqual(checkpoint.video);
    for (
      let index = 0;
      index < checkpoint.payload.manifest.chunkCount;
      index += 1
    )
      expect(await existingChunkMatches(index)).toBe(true);
    if (checkpoint.state !== "retired")
      expect(await storage.readable(checkpoint.legacy.id)).toEqual(
        checkpoint.legacy.receipt.video,
      );
    console.log(
      `Candidate retained: ${id}; ${source.length} bytes; ${media.durationSeconds}s; legacy preserved until verified retirement`,
    );
  } else {
    if (!checkpoint.video)
      throw new Error("Candidate must be committed before retirement");
    expect(await storage.readable(id)).toEqual(checkpoint.video);
    for (
      let index = 0;
      index < checkpoint.payload.manifest.chunkCount;
      index += 1
    )
      expect(await existingChunkMatches(index)).toBe(true);
    for (const browser of ["chromium", "firefox"]) {
      const verification = verificationSchema.parse(
        await optionalJson(
          resolve(directory, `seek-verification-${browser}.json`),
        ),
      );
      expect(verification.videoId).toBe(id);
      expect(verification.sourceSha256).toBe(media.sha256);
      expect(verification.durationSeconds).toBeCloseTo(
        media.durationSeconds,
        1,
      );
      expect(
        verification.seekTargets.some(
          (target) => target < media.durationSeconds * 0.2,
        ),
      ).toBe(true);
      expect(
        verification.seekTargets.some(
          (target) => target > media.durationSeconds * 0.8,
        ),
      ).toBe(true);
      expect(
        verification.seekTargets.every(
          (target) => target < media.durationSeconds,
        ),
      ).toBe(true);
      for (const artifact of verification.artifactRefs)
        expect((await stat(resolve(artifact))).size).toBeGreaterThan(0);
    }
    const archivePath = resolve(
      directory,
      `legacy-receipt-${checkpoint.legacy.id}.json`,
    );
    if ((await optionalJson(archivePath)) === null) {
      const originalReceipt = await readFile(canonicalPath);
      expect(
        legacySchema.parse(JSON.parse(originalReceipt.toString("utf8"))),
      ).toEqual(checkpoint.legacy.receipt);
      await writeFile(archivePath, originalReceipt, {
        flag: "wx",
        mode: 0o600,
      });
    } else
      expect(legacySchema.parse(await optionalJson(archivePath))).toEqual(
        checkpoint.legacy.receipt,
      );
    await storage.deleteVideo(checkpoint.legacy.id);
    const tombstone = await raw.read(
      `tombstones/videos/${checkpoint.legacy.id}.json`,
      4096,
    );
    if (!tombstone) throw new Error("Legacy deletion tombstone missing");
    await expect(storage.readable(checkpoint.legacy.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await raw.list(`videos/${checkpoint.legacy.id}/`)).toEqual([]);
    expect(await storage.readable(id)).toEqual(checkpoint.video);
    checkpoint = {
      ...checkpoint,
      state: "retired",
      legacy: {
        ...checkpoint.legacy,
        tombstoneSha256: digest(tombstone),
        retiredAt: checkpoint.legacy.retiredAt ?? new Date().toISOString(),
      },
    };
    await atomicJson(checkpointPath, checkpoint);
    await atomicJson(canonicalPath, {
      version: 2,
      prefix: checkpoint.prefix,
      publicKeyDigest: checkpoint.publicKeyDigest,
      filename: checkpoint.filename,
      sourceFile: checkpoint.sourceFile,
      sourceSha256: checkpoint.sourceSha256,
      sourceBytes: checkpoint.sourceBytes,
      durationSeconds: checkpoint.durationSeconds,
      codec: checkpoint.codec,
      library: checkpoint.library,
      video: checkpoint.video,
      legacy: {
        id: checkpoint.legacy.id,
        tombstoneSha256: checkpoint.legacy.tombstoneSha256,
        retiredAt: checkpoint.legacy.retiredAt,
      },
    });
    console.log(
      `Verified candidate is primary: ${id}; only legacy ${checkpoint.legacy.id} was tombstoned and removed`,
    );
  }
  const finalLibrary = await raw.read("library.json", 4096);
  expect(finalLibrary?.equals(libraryBytes)).toBe(true);
  expect(process.env.DEMO_MODE).toBe("true");
  await assertActiveAppReadOnly("after");
});
