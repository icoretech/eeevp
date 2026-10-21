// Verify the promoted indexed public video against real S3 and browser streaming while all application mutations remain blocked.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type BrowserContext,
  expect,
  type Page,
  type Request,
  test,
} from "@playwright/test";
import { z } from "zod";
import {
  unwrapVideoKey,
  verifyLibraryKey,
} from "../../src/lib/crypto/library-crypto";
import { decryptChunk } from "../../src/lib/crypto/video-crypto";
import { CHUNK_SIZE, libraryVideoSchema } from "../../src/lib/video/schema";
import {
  apiCatalog,
  apiLibrary,
  cloudReader,
  datasetDirectory,
  demoSettings,
  filename,
  hash,
  maximumSize,
  minimumSize,
  optionalJson,
  playback,
  receiptPath,
  receiptSchema,
  screenshot,
} from "./demo-support";

async function openLibrary(page: Page, key: string) {
  const response = await page.goto("/");
  if (!response) throw new Error("Production document response missing");
  expect(response.headers()["referrer-policy"]).toBe("same-origin");
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
    "content",
    "same-origin",
  );
  const input = page.getByLabel("Encryption key", { exact: true });
  await expect(input).toBeVisible();
  expect((await input.inputValue()) === key).toBe(true);
  await expect(
    page.getByRole("button", { name: "Advanced key tools", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Import .txt recovery file", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: "Generate a new library key",
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Lock library", exact: true }),
  ).toBeVisible();
}

async function blockedMutation(
  page: Page,
  path: string,
  method: "POST" | "PUT" | "DELETE",
  body: string | null,
  binary = false,
) {
  return page.evaluate(
    async ({ path, method, body, binary }) => {
      const headers = new Headers();
      if (body !== null)
        headers.set(
          "Content-Type",
          binary ? "application/octet-stream" : "application/json",
        );
      const response = await fetch(path, {
        method,
        headers,
        body:
          body === null
            ? undefined
            : binary
              ? Uint8Array.from(atob(body), (character) =>
                  character.charCodeAt(0),
                )
              : body,
        credentials: "same-origin",
      });
      await response.body?.cancel();
      return response.status;
    },
    { path, method, body, binary },
  );
}

test("public production demo retains its indexed cloud video and enforces read-only mode", async ({
  page,
  browser,
  context,
}, info) => {
  const { settings, key } = demoSettings();
  await mkdir(datasetDirectory, { recursive: true });
  await mkdir(info.outputDir, { recursive: true });
  const actions: string[] = [];
  const note = (message: string) => {
    actions.push(message);
    console.log(message);
  };
  const requests: Request[] = [];
  const browserWarnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") browserWarnings.push(message.text());
  });
  context.on("request", (request) => requests.push(request));
  const cloud = cloudReader(settings);
  const extraContexts: BrowserContext[] = [];
  try {
    await openLibrary(page, key);
    const library = await apiLibrary(page);
    await verifyLibraryKey(library, key);
    const catalog = await apiCatalog(page);
    const receipt = receiptSchema.parse(await optionalJson(receiptPath));
    expect(receipt.publicKeyDigest).toBe(hash(key));
    expect(receipt.library).toEqual(library);
    const source = await readFile(
      resolve(datasetDirectory, receipt.sourceFile),
    );
    expect(hash(source)).toBe(receipt.sourceSha256);
    expect(source.length).toBe(receipt.sourceBytes);
    const addedReceipt = await optionalJson(
      resolve(datasetDirectory, "token-rumble-receipt.json"),
    );
    const expectedCatalog = [receipt.video];
    if (addedReceipt !== null) {
      const added = z
        .object({
          state: z.literal("published"),
          publicKeyDigest: z.string().length(64),
          video: libraryVideoSchema,
        })
        .parse(addedReceipt);
      expect(added.publicKeyDigest).toBe(hash(key));
      expect(added.video.libraryId).toBe(library.id);
      expectedCatalog.push(added.video);
    }
    const byId = (
      left: z.infer<typeof libraryVideoSchema>,
      right: z.infer<typeof libraryVideoSchema>,
    ) => left.manifest.id.localeCompare(right.manifest.id);
    expect([...catalog].sort(byId)).toEqual(expectedCatalog.sort(byId));
    expect(
      await cloud.read(`videos/${receipt.legacy.id}/manifest.json`),
    ).toBeNull();
    const tombstone = await cloud.read(
      `tombstones/videos/${receipt.legacy.id}.json`,
      4096,
    );
    if (!tombstone) throw new Error("Retired sample tombstone missing");
    expect(hash(tombstone)).toBe(receipt.legacy.tombstoneSha256);
    note(
      "Promoted v2 receipt, indexed 90-second source and its committed catalog record match; old sample remains retired",
    );
    expect(source.length).toBeGreaterThanOrEqual(minimumSize);
    expect(source.length).toBeLessThanOrEqual(maximumSize);
    expect(receipt.video.manifest.size).toBe(source.length);
    expect(receipt.video.manifest.chunkCount).toBe(
      Math.ceil(source.length / CHUNK_SIZE),
    );
    expect(receipt.video.manifest.chunkCount).toBeGreaterThan(20);
    const cloudManifest = await cloud.read(
      `videos/${receipt.video.manifest.id}/manifest.json`,
      65_536,
    );
    if (!cloudManifest)
      throw new Error("Committed manifest missing from real cloud storage");
    expect(
      libraryVideoSchema.parse(JSON.parse(cloudManifest.toString("utf8"))),
    ).toEqual(receipt.video);
    const videoKey = await unwrapVideoKey(
      receipt.video.manifest,
      receipt.video.wrappedKey,
      key,
      library.id,
    );
    let firstPacket: Buffer | undefined;
    for (let index = 0; index < receipt.video.manifest.chunkCount; index += 1) {
      const packet = await cloud.read(
        `videos/${receipt.video.manifest.id}/chunks/${index}`,
      );
      if (!packet) throw new Error("Encrypted cloud chunk missing");
      const plain = source.subarray(
        index * CHUNK_SIZE,
        (index + 1) * CHUNK_SIZE,
      );
      expect(packet.length).toBe(plain.length + 28);
      expect(packet.subarray(12, packet.length - 16).equals(plain)).toBe(false);
      const decrypted = await decryptChunk(
        new Uint8Array(packet).buffer,
        index,
        receipt.video.manifest,
        videoKey,
      );
      expect(Buffer.from(decrypted).equals(plain)).toBe(true);
      if (index === 0) firstPacket = packet;
    }
    if (!firstPacket) throw new Error("First encrypted chunk missing");
    const before = await cloud.snapshot();
    note(
      "Direct S3 GETs matched the canonical manifest and all bounded ciphertext chunks and authenticated source bytes; no filesystem substitution",
    );

    {
      await expect(
        page.getByLabel("Choose your video", { exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Encrypt & upload", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: `Delete ${filename}`, exact: true }),
      ).toBeDisabled();
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        "content",
        /noindex/,
      );
      const robots = await page.evaluate(async () => {
        const response = await fetch("/robots.txt");
        return { status: response.status, body: await response.text() };
      });
      expect(robots.status).toBe(200);
      expect(robots.body).toMatch(/User-Agent:\s*\*/i);
      expect(robots.body).toMatch(/Disallow:\s*\/\s*(?:\n|$)/i);
      const id = receipt.video.manifest.id;
      const guarded = [
        {
          label: "POST library",
          status: await blockedMutation(
            page,
            "/api/library",
            "POST",
            JSON.stringify(library),
          ),
        },
        {
          label: "POST videos",
          status: await blockedMutation(
            page,
            "/api/videos",
            "POST",
            JSON.stringify({
              manifest: receipt.video.manifest,
              wrappedKey: receipt.video.wrappedKey,
              libraryId: receipt.video.libraryId,
            }),
          ),
        },
        {
          label: "PUT chunk",
          status: await blockedMutation(
            page,
            `/api/videos/${id}/chunks/0`,
            "PUT",
            firstPacket.toString("base64"),
            true,
          ),
        },
        {
          label: "POST complete",
          status: await blockedMutation(
            page,
            `/api/videos/${id}/complete`,
            "POST",
            null,
          ),
        },
        // A valid absent identifier tests the deletion guard without risking the public presentation record on a regression.
        {
          label: "DELETE absent valid video",
          status: await blockedMutation(
            page,
            `/api/videos/${randomUUID()}`,
            "DELETE",
            null,
          ),
        },
      ];
      await writeFile(
        info.outputPath("mutation-statuses.json"),
        JSON.stringify(guarded, null, 2),
      );
      expect(guarded.map((entry) => entry.status)).toEqual([
        403, 403, 403, 403, 403,
      ]);
      note(
        "Public input prefilled; UI upload/delete disabled; all five real crafted mutation requests returned403; noindex and robots disallow verified",
      );
    }
    await page
      .getByLabel("Search videos", { exact: true })
      .fill("no matching presentation");
    await expect(
      page.getByText("No matching videos", { exact: true }),
    ).toBeVisible();
    await page.getByLabel("Search videos", { exact: true }).fill("Motion");
    await expect(
      page.locator(".catalog-card").filter({ hasText: filename }),
    ).toBeVisible();
    await screenshot(page, info.outputPath("demo-library.png"));
    await playback(page, receipt, source);
    await screenshot(page, info.outputPath("demo-playback.png"));
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await screenshot(page, info.outputPath("demo-mobile-playback.png"));
    note(
      "Production Chromium decoded the real cloud-backed clip, played, sought to67.35s with stable90s duration and returned1501 exact cross-chunk bytes with HTTP206",
    );

    {
      await page.reload();
      const keyInput = page.getByLabel("Encryption key", { exact: true });
      await expect
        .poll(async () => (await keyInput.inputValue()) === key)
        .toBe(true);
      await page
        .getByRole("button", { name: "Decrypt & Login", exact: true })
        .click();
      await expect(page.locator("video")).toBeVisible();
      const cleared = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/session" &&
          response.request().method() === "DELETE",
      );
      await page
        .getByRole("button", { name: "Lock library", exact: true })
        .click();
      expect((await cleared).ok()).toBe(true);
      await expect
        .poll(async () => (await keyInput.inputValue()) === key)
        .toBe(true);
      const other = await browser.newContext();
      extraContexts.push(other);
      other.on("request", (request) => requests.push(request));
      {
        const wrong = await other.newPage();
        wrong.on("console", (message) => {
          if (message.type() === "warning")
            browserWarnings.push(message.text());
        });
        await wrong.goto(settings.APP_ORIGIN);
        expect(
          (await wrong
            .getByLabel("Encryption key", { exact: true })
            .inputValue()) === key,
        ).toBe(true);
        await wrong
          .getByLabel("Encryption key", { exact: true })
          .fill("a-different-demo-key");
        await wrong
          .getByRole("button", { name: "Decrypt & Login", exact: true })
          .click();
        const opaque = wrong.locator(".catalog-card").filter({
          hasText: receipt.video.manifest.encryptedMetadata.slice(0, 56),
        });
        await expect(opaque).toBeVisible();
        await expect(
          opaque.getByRole("button", { name: "Watch video", exact: true }),
        ).toBeDisabled();
        await expect(wrong.getByText(filename, { exact: true })).toHaveCount(0);
        await screenshot(wrong, info.outputPath("demo-wrong-key.png"));
      }
      note(
        "Reload and Lock restore the public prefill; editing it to a wrong key still opens only opaque encrypted metadata",
      );
    }
    expect(await cloud.snapshot()).toEqual(before);
    expect(browserWarnings).toEqual([]);
    note(
      "No browser warnings, including unused font preload warnings, were emitted",
    );
    let sessionPosts = 0;
    for (const request of requests) {
      expect(request.url().includes(key)).toBe(false);
      expect(
        request.postDataBuffer()?.includes(Buffer.from(key)) ?? false,
      ).toBe(false);
      if (
        new URL(request.url()).pathname === "/api/session" &&
        request.method() === "POST"
      ) {
        z.strictObject({}).parse(request.postDataJSON());
        expect((await request.allHeaders()).origin).toBe(settings.APP_ORIGIN);
        sessionPosts += 1;
      }
    }
    expect(sessionPosts).toBeGreaterThan(0);
    note(
      "Cloud canonical object hashes unchanged by acceptance probes; presentation dataset retained with its persistent receipt",
    );
    await writeFile(
      info.outputPath("cloud-snapshot.json"),
      JSON.stringify(before, null, 2),
    );
    await writeFile(
      info.outputPath("actions.json"),
      JSON.stringify(
        {
          phase: settings.EEEVP_DEMO_PHASE,
          verdict: "PASS",
          id: receipt.video.manifest.id,
          sourceBytes: source.length,
          actions,
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      await Promise.all(extraContexts.map((context) => context.close()));
    } finally {
      cloud.close();
    }
  }
});
