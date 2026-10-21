// The promoted indexed fixture receipt and bounded S3 reads keep public-demo acceptance reproducible without seeding or deleting data.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";
import { normalizeLibraryKeyInput } from "../../src/lib/crypto/key-input";
import {
  CHUNK_SIZE,
  libraryDescriptorSchema,
  libraryVideoSchema,
} from "../../src/lib/video/schema";

export const datasetDirectory = resolve("test-results/public-demo-dataset");
export const receiptPath = resolve(datasetDirectory, "receipt.json");
export const filename = "Motion study - 90 seconds.webm";
export const minimumSize = 15 * 1_048_576;
export const maximumSize = 30 * 1_048_576;
export const hash = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

const environment = z.object({
  APP_ORIGIN: z.literal("http://localhost:3001"),
  STORAGE_DRIVER: z.literal("s3"),
  S3_PREFIX: z.literal("eeevp-demo/v1"),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]),
  DEMO_MODE: z.literal("true"),
  DEMO_PUBLIC_KEY: z.string().min(1),
  EEEVP_DEMO_PHASE: z.literal("readonly"),
  EEEVP_DEMO_KEY_INPUT: z.string().min(1),
});

export function demoSettings() {
  const settings = environment.parse(process.env);
  const key = normalizeLibraryKeyInput(settings.EEEVP_DEMO_KEY_INPUT);
  if (key !== settings.DEMO_PUBLIC_KEY)
    throw new Error(
      "Stdin must match the explicitly configured public demonstration key",
    );
  return { settings, key };
}

export const receiptSchema = z.strictObject({
  version: z.literal(2),
  prefix: z.literal("eeevp-demo/v1"),
  publicKeyDigest: z.string().length(64),
  filename: z.literal(filename),
  sourceSha256: z.string().length(64),
  sourceFile: z.literal("seek-study-90s-v1.webm"),
  sourceBytes: z.number().int().min(minimumSize).max(maximumSize),
  durationSeconds: z.literal(90),
  codec: z.literal("vp8"),
  legacy: z.strictObject({
    id: z.uuid(),
    tombstoneSha256: z.string().length(64),
    retiredAt: z.iso.datetime(),
  }),
  library: libraryDescriptorSchema,
  video: libraryVideoSchema,
});
export type Receipt = z.infer<typeof receiptSchema>;
export async function optionalJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

export function cloudReader(
  settings: ReturnType<typeof demoSettings>["settings"],
) {
  const client = new S3Client({
    endpoint: settings.S3_ENDPOINT,
    region: settings.S3_REGION,
    forcePathStyle: settings.S3_FORCE_PATH_STYLE === "true",
    credentials: {
      accessKeyId: settings.S3_ACCESS_KEY_ID,
      secretAccessKey: settings.S3_SECRET_ACCESS_KEY,
    },
    maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const objectKey = (key: string) => {
    if (!key || key.startsWith("/") || key.includes("..") || key.includes("\\"))
      throw new Error("Invalid scoped demo object key");
    return `${settings.S3_PREFIX}/${key}`;
  };
  async function read(key: string, limit = CHUNK_SIZE + 4096) {
    try {
      const response = await client.send(
        new GetObjectCommand({
          Bucket: settings.S3_BUCKET,
          Key: objectKey(key),
        }),
      );
      if (!response.Body) throw new Error("Cloud object has no body");
      const reader = response.Body.transformToWebStream().getReader();
      const chunks: Buffer[] = [];
      let length = 0;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          length += item.value.byteLength;
          if (length > limit) {
            await reader.cancel();
            throw new Error("Cloud demo object exceeds its bounded size");
          }
          chunks.push(Buffer.from(item.value));
        }
      } finally {
        reader.releaseLock();
      }
      return Buffer.concat(chunks, length);
    } catch (error) {
      if (
        error instanceof S3ServiceException &&
        error.$metadata.httpStatusCode === 404
      )
        return null;
      throw error;
    }
  }
  async function listed(prefix: string) {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: settings.S3_BUCKET,
        Prefix: objectKey(prefix),
        MaxKeys: 1000,
      }),
    );
    if (response.IsTruncated)
      throw new Error(
        "Demo prefix is unexpectedly large; refusing a broad listing",
      );
    return (response.Contents ?? []).map((entry) => {
      if (!entry.Key?.startsWith(`${settings.S3_PREFIX}/${prefix}`))
        throw new Error("Unexpected object outside the dedicated prefix");
      return entry.Key.slice(settings.S3_PREFIX.length + 1);
    });
  }
  async function snapshot() {
    const keys = [
      "library.json",
      ...(await listed("videos/")),
      ...(await listed("tombstones/videos/")),
    ].sort();
    const entries = [];
    for (const key of keys) {
      const bytes = await read(key);
      if (!bytes) throw new Error("Demo object disappeared during observation");
      entries.push({ key, bytes: bytes.length, sha256: hash(bytes) });
    }
    return entries;
  }
  return { read, snapshot, close: () => client.destroy() };
}

export async function apiCatalog(page: Page) {
  const result: unknown = await page.evaluate(async () => {
    const response = await fetch("/api/videos", { cache: "no-store" });
    if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
    return response.json();
  });
  return z.strictObject({ videos: z.array(libraryVideoSchema) }).parse(result)
    .videos;
}

export async function apiLibrary(page: Page) {
  const result: unknown = await page.evaluate(async () => {
    const response = await fetch("/api/library", { cache: "no-store" });
    if (!response.ok) throw new Error(`Library HTTP ${response.status}`);
    return response.json();
  });
  return z.strictObject({ library: libraryDescriptorSchema }).parse(result)
    .library;
}

export async function screenshot(page: Page, path: string) {
  await page.screenshot({
    path,
    fullPage: true,
    animations: "disabled",
    mask: [page.locator('input[type="password"]')],
  });
}

export async function playback(page: Page, receipt: Receipt, bytes: Buffer) {
  const card = page
    .locator(".catalog-card")
    .filter({ hasText: receipt.filename });
  await card.getByRole("button", { name: "Watch video", exact: true }).click();
  const video = page.locator("video");
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.readyState),
    )
    .toBeGreaterThanOrEqual(2);
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.duration),
  ).toBe(receipt.durationSeconds);
  const source = await video.getAttribute("src");
  if (!source?.includes("/__eeevp_media__/"))
    throw new Error("Expected a browser-owned streaming URL");
  expect(
    await page.evaluate(() =>
      navigator.serviceWorker.controller?.scriptURL.endsWith("/eeevp-sw.js"),
    ),
  ).toBe(true);
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
  });
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0.2);
  await video.evaluate((element: HTMLVideoElement) => {
    element.pause();
    element.currentTime = 67.35;
  });
  await expect
    .poll(() =>
      video.evaluate(
        (element: HTMLVideoElement) =>
          !element.seeking &&
          Math.abs(element.currentTime - 67.35) < 0.1 &&
          element.duration === 90 &&
          element.readyState >= 2,
      ),
    )
    .toBe(true);
  const range = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      headers: { Range: "bytes=1048000-1049500" },
    });
    return {
      status: response.status,
      contentRange: response.headers.get("content-range"),
      bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
    };
  }, source);
  expect(range.status).toBe(206);
  expect(range.contentRange).toBe(`bytes 1048000-1049500/${bytes.length}`);
  expect(
    Buffer.from(range.bytes).equals(bytes.subarray(1_048_000, 1_049_501)),
  ).toBe(true);
}
