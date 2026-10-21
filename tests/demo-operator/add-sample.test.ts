// This opt-in operator adds one reviewed MP4 to the public demo without changing HTTP mode or existing durable objects.
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
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
  libraryDescriptorSchema,
  libraryVideoSchema,
} from "@/lib/video/schema";

const directory = resolve("test-results/public-demo-dataset");
const checkpointPath = resolve(directory, "token-rumble-receipt.json");
const digest = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const mediaSchema = z.strictObject({
  sourceFile: z.literal("token-rumble-source.mp4"),
  filename: z.string().min(1).max(255),
  mime: z.literal("video/mp4"),
  bytes: z.literal(40_978_404),
  sha256: hashSchema,
  videoCodec: z.literal("h264"),
  audioCodec: z.literal("aac"),
  width: z.literal(1920),
  height: z.literal(1080),
  durationSeconds: z.number().min(62.9).max(62.91),
});
const objectSchema = z.strictObject({
  key: z.string(),
  bytes: z.number().int().positive(),
  sha256: hashSchema,
});
const checkpointSchema = z.strictObject({
  version: z.literal(1),
  state: z.enum(["prepared", "published"]),
  prefix: z.literal("eeevp-demo/v1"),
  publicKeyDigest: hashSchema,
  media: mediaSchema,
  library: libraryDescriptorSchema,
  payload: libraryVideoSchema.omit({ createdAt: true }),
  before: z.array(objectSchema),
  video: libraryVideoSchema.optional(),
  after: z.array(objectSchema).optional(),
  addedKeys: z.array(z.string()).optional(),
});
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing operator setting: ${name}`);
  return value;
}
async function readOptional(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}
async function saveCheckpoint(value: z.infer<typeof checkpointSchema>) {
  const temporary = `${checkpointPath}.${randomUUID()}.pending`;
  await writeFile(temporary, JSON.stringify(value, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, checkpointPath);
}

it("adds only the reviewed encrypted sample while preserving the existing public demo", async () => {
  expect(required("EEEVP_DEMO_ADD_ACTION")).toBe("publish");
  const config = getConfig();
  if (
    config.STORAGE_DRIVER !== "s3" ||
    config.S3_PREFIX !== "eeevp-demo/v1" ||
    !config.DEMO_MODE
  )
    throw new Error(
      "Only the configured read-only public demo prefix is allowed",
    );
  const publicKey = normalizeLibraryKeyInput(
    required("EEEVP_DEMO_ADD_KEY_INPUT"),
  );
  expect(publicKey === config.DEMO_PUBLIC_KEY).toBe(true);
  const media = mediaSchema.parse(
    JSON.parse(await readFile(required("EEEVP_DEMO_ADD_METADATA"), "utf8")),
  );
  expect(media.sha256).toBe(
    hashSchema.parse(required("EEEVP_DEMO_ADD_EXPECTED_SHA256")),
  );
  expect(media.filename).toBe(required("EEEVP_DEMO_ADD_EXPECTED_FILENAME"));
  const sourcePath = await realpath(resolve(directory, media.sourceFile));
  if (!sourcePath.startsWith(`${await realpath(directory)}${sep}`))
    throw new Error("Source escaped the dedicated artifact directory");
  const source = await readFile(sourcePath);
  expect(source.length).toBe(media.bytes);
  expect(digest(source)).toBe(media.sha256);
  expect(source.toString("ascii", 4, 8)).toBe("ftyp");
  expect(Math.ceil(source.length / CHUNK_SIZE)).toBe(40);

  async function assertLiveReadOnly(stage: "before" | "after") {
    const origin = "https://eeevp.synteq.app";
    const absent = "00000000-0000-4000-8000-000000000001";
    const observations = [];
    for (const [method, path, body] of [
      ["POST", "/api/library", "{}"],
      ["POST", "/api/videos", "{}"],
      ["PUT", `/api/videos/${absent}/chunks/0`, "x"],
      ["POST", `/api/videos/${absent}/complete`, undefined],
      ["DELETE", `/api/videos/${absent}`, undefined],
    ] as const) {
      const response = await fetch(`${origin}${path}`, {
        method,
        body,
        headers: {
          origin,
          "content-type":
            method === "PUT" ? "application/octet-stream" : "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      expect(response.status).toBe(403);
      expect(
        z.object({ error: z.string() }).parse(await response.json()).error,
      ).toMatch(/read-only/i);
      observations.push({ method, path, status: response.status });
    }
    await writeFile(
      resolve(directory, `token-rumble-http-${stage}-${randomUUID()}.json`),
      JSON.stringify(observations, null, 2),
      { flag: "wx" },
    );
    console.log(`Live demo: all five write guards403 (${stage})`);
  }
  await assertLiveReadOnly("before");
  // Storage methods do not consult DEMO_MODE. Keep the real configuration intact; never toggle the HTTP app.
  const storage = new VideoStorage(config);
  const raw = createObjectStore(config);
  async function snapshot() {
    // Health probes are concurrent temporary objects owned by the runtime, not library content.
    const keys = (await raw.list(""))
      .filter((key) => !key.startsWith("health/"))
      .sort();
    if (keys.length > 500) throw new Error("Unexpected public prefix size");
    const objects = [];
    for (const key of keys) {
      const bytes = await raw.read(key, CHUNK_SIZE + 65_536);
      if (!bytes) throw new Error("Existing durable object disappeared");
      objects.push({ key, bytes: bytes.length, sha256: digest(bytes) });
    }
    return objects;
  }
  const library = await storage.library();
  if (!library) throw new Error("The existing public library is required");
  await verifyLibraryKey(library, publicKey);
  const saved = await readOptional(checkpointPath);
  let checkpoint: z.infer<typeof checkpointSchema>;
  if (saved !== null) {
    checkpoint = checkpointSchema.parse(saved);
    expect(checkpoint.media).toEqual(media);
    expect(checkpoint.library).toEqual(library);
    expect(checkpoint.publicKeyDigest).toBe(digest(publicKey));
  } else {
    const before = await snapshot();
    expect(before.some((object) => object.key === "library.json")).toBe(true);
    expect((await storage.list()).length).toBeGreaterThan(0);
    const created = await createVideo(
      new File([new Uint8Array(source)], media.filename, { type: media.mime }),
    );
    checkpoint = {
      version: 1,
      state: "prepared",
      prefix: "eeevp-demo/v1",
      publicKeyDigest: digest(publicKey),
      media,
      library,
      payload: {
        manifest: created.manifest,
        libraryId: library.id,
        wrappedKey: await wrapVideoKey(
          created.manifest,
          created.credentials.key,
          publicKey,
          library.id,
        ),
      },
      before,
    };
    // Write the identifier/envelope and original snapshot before any cloud mutation; retries reuse this checkpoint.
    await writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
  }
  const id = checkpoint.payload.manifest.id;
  const ownPrefix = `videos/${id}/`;
  expect(
    checkpoint.before.some((object) => object.key.startsWith(ownPrefix)),
  ).toBe(false);
  async function verifyPreserved(objects: z.infer<typeof objectSchema>[]) {
    expect(
      objects.filter((object) => !object.key.startsWith(ownPrefix)),
    ).toEqual(checkpoint.before);
  }
  await verifyPreserved(await snapshot());
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
  async function chunkMatches(index: number) {
    const plain = source.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
    const packet = await raw.read(
      `${ownPrefix}chunks/${index}`,
      plain.length + 28,
    );
    if (!packet) return false;
    expect(packet.length).toBe(plain.length + 28);
    const decrypted = await decryptChunk(
      new Uint8Array(packet).buffer,
      index,
      checkpoint.payload.manifest,
      videoKey,
    );
    expect(Buffer.from(decrypted).equals(plain)).toBe(true);
    return true;
  }
  if (checkpoint.state === "prepared") {
    let draft: z.infer<typeof libraryVideoSchema> | undefined;
    try {
      draft = await storage.draft(id);
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404)) throw error;
    }
    if (!draft) {
      await storage.createDraft(
        checkpoint.payload.manifest,
        checkpoint.payload.wrappedKey,
        library.id,
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
      if (await chunkMatches(index)) continue;
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
      await storage.putChunk(id, index, packet);
      console.log(`Added encrypted sample chunk ${index + 1}/40`);
    }
    await storage.complete(id);
  }
  const video = await storage.readable(id);
  expect({
    manifest: video.manifest,
    wrappedKey: video.wrappedKey,
    libraryId: video.libraryId,
  }).toEqual(checkpoint.payload);
  for (let index = 0; index < video.manifest.chunkCount; index += 1)
    expect(await chunkMatches(index)).toBe(true);
  const after = await snapshot();
  await verifyPreserved(after);
  const addedKeys = after
    .filter((object) => object.key.startsWith(ownPrefix))
    .map((object) => object.key)
    .sort();
  expect(addedKeys).toEqual(
    [
      `${ownPrefix}draft.json`,
      `${ownPrefix}manifest.json`,
      ...Array.from(
        { length: 40 },
        (_, index) => `${ownPrefix}chunks/${index}`,
      ),
    ].sort(),
  );
  checkpoint = { ...checkpoint, state: "published", video, after, addedKeys };
  await saveCheckpoint(checkpoint);
  await assertLiveReadOnly("after");
  console.log(
    `Published additional sample ${id};40 packets verified;${checkpoint.before.length} previous durable objects unchanged;42 objects added`,
  );
});
