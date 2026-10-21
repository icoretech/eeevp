// Real browser acceptance preserves the existing private library and deletes only its own synthetic upload.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, type Page, type Request, test } from "@playwright/test";
import { z } from "zod";
import { normalizeLibraryKeyInput } from "../../src/lib/crypto/key-input";
import {
  libraryDescriptorSchema,
  libraryVideoSchema,
} from "../../src/lib/video/schema";

async function syntheticVideo(page: Page) {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const drawing = canvas.getContext("2d");
    if (!drawing) throw new Error("Canvas rendering unavailable");
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8",
      videoBitsPerSecond: 6_000_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const finished = new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: "video/webm" }));
    });
    let state = 123456;
    const frame = drawing.createImageData(canvas.width, canvas.height);
    const paint = () => {
      for (let index = 0; index < frame.data.length; index += 4) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        frame.data[index] = state & 255;
        frame.data[index + 1] = (state >>> 8) & 255;
        frame.data[index + 2] = (state >>> 16) & 255;
        frame.data[index + 3] = 255;
      }
      drawing.putImageData(frame, 0, 0);
    };
    paint();
    recorder.start(250);
    const timer = window.setInterval(paint, 33);
    await new Promise((resolve) => window.setTimeout(resolve, 8000));
    recorder.stop();
    window.clearInterval(timer);
    const blob = await finished;
    for (const track of stream.getTracks()) track.stop();
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Fixture encoding failed"));
      reader.onload = () => {
        if (typeof reader.result !== "string")
          return reject(new Error("Fixture encoding missing"));
        resolve(reader.result.slice(reader.result.indexOf(",") + 1));
      };
      reader.readAsDataURL(blob);
    });
  });
  return Buffer.from(bytes, "base64");
}

async function screenshot(page: Page, path: string) {
  await page.screenshot({
    path,
    fullPage: true,
    mask: [page.locator('input[type="password"]')],
  });
}

// A disposable loopback origin observes the browser's real referrer behavior without external services.
async function crossOriginReferrerIsSuppressed(page: Page) {
  let received = false;
  let referrer: string | undefined;
  const probe = createServer((request, response) => {
    received = true;
    referrer = request.headers.referer;
    response.writeHead(204, { "Cache-Control": "no-store" });
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = probe.address();
    if (!address || typeof address === "string")
      throw new Error("Referrer probe did not bind a TCP port");
    await page.evaluate(async (target) => {
      await fetch(target, { mode: "no-cors", cache: "no-store" });
    }, `http://127.0.0.1:${address.port}/referrer-probe`);
    expect(received).toBe(true);
    expect(referrer).toBeUndefined();
  } finally {
    await new Promise<void>((resolve, reject) => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

async function signIn(page: Page, recoveryText: string, key: string) {
  const input = page.getByLabel("Encryption key", { exact: true });
  await expect(input).toBeVisible();
  await expect(
    page.getByLabel("Library password", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Unlock library", exact: true }),
  ).toHaveCount(0);
  const advanced = page.getByRole("button", {
    name: "Advanced key tools",
    exact: true,
  });
  if ((await advanced.getAttribute("aria-expanded")) !== "true")
    await advanced.click();
  await expect(
    page.getByLabel("Import .txt recovery file", { exact: true }),
  ).toBeVisible();
  let importRequests = 0;
  const observeImport = (request: Request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      importRequests += 1;
  };
  page.on("request", observeImport);
  try {
    await page
      .getByLabel("Import .txt recovery file", { exact: true })
      .setInputFiles({
        name: "library-recovery.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(recoveryText),
      });
    await expect
      .poll(async () => (await input.inputValue()) === key)
      .toBe(true);
  } finally {
    page.off("request", observeImport);
  }
  expect(importRequests).toBe(0);
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Lock library", exact: true }),
  ).toBeVisible();
}

async function catalog(page: Page) {
  const body: unknown = await page.evaluate(async () => {
    const response = await fetch("/api/videos", { cache: "no-store" });
    if (!response.ok)
      throw new Error(`Catalog failed: HTTP ${response.status}`);
    return response.json();
  });
  return z.strictObject({ videos: z.array(libraryVideoSchema) }).parse(body)
    .videos;
}

async function lockedApiStatuses(page: Page, id: string) {
  return page.evaluate(async (videoId) => {
    const paths = [
      "/api/library",
      "/api/videos",
      `/api/videos/${videoId}`,
      `/api/videos/${videoId}/chunks/0`,
    ];
    return Promise.all(
      paths.map(async (path) => {
        const response = await fetch(path, { cache: "no-store" });
        await response.body?.cancel();
        return response.status;
      }),
    );
  }, id);
}

async function noPersistentKey(page: Page, key: string) {
  const persisted = await page.evaluate(
    async (secrets) => ({
      keyInLocalStorage: Object.values(localStorage).some(
        (value) =>
          typeof value === "string" &&
          secrets.some((secret) => value.includes(secret)),
      ),
      keyInSessionStorage: Object.values(sessionStorage).some(
        (value) =>
          typeof value === "string" &&
          secrets.some((secret) => value.includes(secret)),
      ),
      indexedDatabases: (await indexedDB.databases()).length,
    }),
    [key],
  );
  expect(persisted).toEqual({
    keyInLocalStorage: false,
    keyInSessionStorage: false,
    indexedDatabases: 0,
  });
}

async function noSharingSurface(page: Page) {
  await expect(
    page.getByRole("button", { name: /share|copy.*link|forget/i }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Private video link")).toHaveCount(0);
  expect(new URL(page.url()).hash).toBe("");
  expect(new URL(page.url()).search).toBe("");
}

test("browser key opens the catalog across devices and decrypts only with the correct key", async ({
  browser,
  page,
  context,
  baseURL,
}, info) => {
  if (!baseURL || new URL(baseURL).hostname !== "localhost")
    throw new Error("Acceptance requires the coordinated local preview");
  if (process.env.STORAGE_DRIVER !== "filesystem")
    throw new Error(
      "This acceptance requires the coordinated filesystem preview",
    );
  const storage = process.env.STORAGE_PATH;
  const recoveryText = process.env.EEEVP_BROWSER_RECOVERY_TEXT;
  if (!storage || !recoveryText)
    throw new Error(
      "Provide existing recovery text through run-private-library.mjs stdin; STORAGE_PATH is required",
    );
  const key = normalizeLibraryKeyInput(recoveryText);
  const descriptorPath = join(storage, "library.json");
  const originalDescriptor = await readFile(descriptorPath);
  const descriptor = libraryDescriptorSchema.parse(
    JSON.parse(originalDescriptor.toString("utf8")),
  );
  const existing = new Set(await readdir(join(storage, "videos")));
  const existingManifests = new Map<string, Buffer>();
  for (const id of existing) {
    try {
      existingManifests.set(
        id,
        await readFile(join(storage, "videos", id, "manifest.json")),
      );
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
  }
  await mkdir(info.outputDir, { recursive: true });
  const actions: string[] = [];
  const recordAction = (message: string) => {
    actions.push(message);
    appendFileSync(
      info.outputPath("actions.jsonl"),
      `${JSON.stringify({ action: message })}\n`,
    );
    console.log(message);
  };
  const requests: Request[] = [];
  const workers: string[] = [];
  const createdIds = new Set<string>();
  const filename = `qa-video-${randomUUID()}.webm`;
  const trackOwnedUpload = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === "/api/videos") {
      const rawBody = request.postData();
      if (!rawBody) return;
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return;
      }
      const record = z
        .object({ manifest: z.object({ id: z.uuid() }) })
        .safeParse(body);
      if (record.success && !existing.has(record.data.manifest.id))
        createdIds.add(record.data.manifest.id);
    }
  };
  context.on("request", (request) => {
    requests.push(request);
    trackOwnedUpload(request);
  });
  page.on("worker", (worker) => workers.push(worker.url()));
  const viewer = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  viewer.on("request", (request) => requests.push(request));
  const invalidViewer = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const invalidRequests: Request[] = [];
  invalidViewer.on("request", (request) => {
    requests.push(request);
    invalidRequests.push(request);
    trackOwnedUpload(request);
  });
  const wrongKey = "not-the-video-key";
  try {
    const navigation = await page.goto("/");
    if (!navigation) throw new Error("Initial document response missing");
    expect(navigation.headers()["referrer-policy"]).toBe("same-origin");
    await expect(page.locator('meta[name="referrer"]')).toHaveAttribute(
      "content",
      "same-origin",
    );
    await crossOriginReferrerIsSuppressed(page);
    recordAction(
      "Document header and meta both use same-origin; an actual request to a second loopback origin sends no Referer",
    );
    await expect(
      page.getByLabel("Encryption key", { exact: true }),
    ).toBeVisible();
    expect(
      await lockedApiStatuses(page, "00000000-0000-4000-8000-000000000001"),
    ).toEqual([401, 401, 401, 401]);
    await screenshot(page, info.outputPath("single-key-login.png"));
    await signIn(page, recoveryText, key);
    const baseline = await catalog(page);
    expect(
      baseline.every((entry) => existingManifests.has(entry.manifest.id)),
    ).toBe(true);
    await noSharingSurface(page);
    await noPersistentKey(page, key);
    recordAction(
      "Local recovery file fills the sole Encryption key field without an API request; empty session payload opens the catalog and correct key decrypts metadata",
    );
    const fixture = await syntheticVideo(page);
    await writeFile(info.outputPath("sample-video.webm"), fixture);
    expect(fixture.length).toBeGreaterThan(2 * 1_048_576);
    await page.getByLabel("Choose your video", { exact: true }).setInputFiles({
      name: filename,
      mimeType: "video/webm",
      buffer: fixture,
    });
    await page
      .getByRole("button", { name: "Encrypt & upload", exact: true })
      .click();
    const ownCard = page.locator(".catalog-card").filter({ hasText: filename });
    await expect(ownCard).toBeVisible({ timeout: 60_000 });
    expect(createdIds.size).toBe(1);
    const id = createdIds.values().next().value;
    if (!id) throw new Error("Owned upload identifier missing");
    const record = (await catalog(page)).find(
      (entry) => entry.manifest.id === id,
    );
    if (!record)
      throw new Error("Uploaded record missing from canonical catalog");
    expect(record.libraryId).toBe(descriptor.id);
    expect(record.wrappedKey.length).toBe(80);
    expect(JSON.stringify(record).includes(filename)).toBe(false);
    expect(workers.length).toBeGreaterThan(0);
    const stored = await readFile(join(storage, "videos", id, "chunks", "0"));
    expect(stored.length).toBe(1_048_576 + 28);
    expect(stored.equals(fixture.subarray(0, stored.length))).toBe(false);
    const diskRecord = await readFile(
      join(storage, "videos", id, "manifest.json"),
      "utf8",
    );
    expect(diskRecord.includes(filename)).toBe(false);
    expect(diskRecord.includes(key)).toBe(false);
    recordAction(
      `Owned synthetic upload persists ${fixture.length} bytes as bounded ciphertext with wrapped key and encrypted filename`,
    );
    await page.getByLabel("Search videos", { exact: true }).fill(filename);
    await noSharingSurface(page);
    await screenshot(page, info.outputPath("desktop-library.png"));
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(page);
    await screenshot(page, info.outputPath("mobile-library.png"));
    await page.setViewportSize({ width: 1440, height: 1000 });

    const opaquePage = await invalidViewer.newPage();
    await opaquePage.goto(baseURL);
    await opaquePage
      .getByLabel("Encryption key", { exact: true })
      .fill(wrongKey);
    await opaquePage
      .getByRole("button", { name: "Decrypt & Login", exact: true })
      .click();
    await expect(
      opaquePage.getByRole("button", { name: "Lock library", exact: true }),
    ).toBeVisible();
    const opaqueCard = opaquePage
      .locator(".catalog-card")
      .filter({ hasText: record.manifest.encryptedMetadata.slice(0, 56) });
    await expect(opaqueCard).toBeVisible();
    await expect(
      opaqueCard.getByText("Encrypted metadata", { exact: true }),
    ).toBeVisible();
    await expect(
      opaqueCard.getByRole("button", { name: "Watch video", exact: true }),
    ).toBeDisabled();
    await expect(
      opaqueCard.getByRole("button", {
        name: "Delete encrypted video",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(opaquePage.getByText(filename, { exact: true })).toHaveCount(
      0,
    );
    expect(
      (await catalog(opaquePage)).some((entry) => entry.manifest.id === id),
    ).toBe(true);
    await screenshot(
      opaquePage,
      info.outputPath("wrong-key-opaque-catalog.png"),
    );
    await opaquePage
      .getByLabel("Choose your video", { exact: true })
      .setInputFiles({
        name: "rejected-video.webm",
        mimeType: "video/webm",
        buffer: fixture,
      });
    await opaquePage
      .getByRole("button", { name: "Encrypt & upload", exact: true })
      .click();
    await expect(
      opaquePage.getByText("Upload needs attention", { exact: true }),
    ).toBeVisible();
    expect(
      invalidRequests.filter(
        (request) =>
          request.method() === "POST" &&
          new URL(request.url()).pathname === "/api/videos",
      ),
    ).toHaveLength(0);
    await opaquePage.goto(`${baseURL}/watch/${id}`);
    await opaquePage
      .getByLabel("Encryption key", { exact: true })
      .fill(wrongKey);
    await opaquePage
      .getByRole("button", { name: "Decrypt & Login", exact: true })
      .click();
    await expect(
      opaquePage.getByRole("button", { name: "Lock library", exact: true }),
    ).toBeVisible();
    await expect(
      opaquePage.getByRole("heading", {
        name: "This video could not be opened.",
        exact: true,
      }),
    ).toBeVisible();
    await expect(opaquePage.locator("video")).toHaveCount(0);
    await noPersistentKey(opaquePage, wrongKey);
    await screenshot(opaquePage, info.outputPath("wrong-key-unplayable.png"));
    recordAction(
      "Arbitrary nonempty wrong key enters the catalog: encrypted metadata stays opaque, watch/delete controls disabled, direct playback fails locally, and upload causes no server mutation",
    );

    const watch = await viewer.newPage();
    expect(await viewer.cookies()).toHaveLength(0);
    await watch.goto(`${baseURL}/watch/${id}`);
    await expect(
      watch.getByLabel("Encryption key", { exact: true }),
    ).toBeVisible();
    expect(await lockedApiStatuses(watch, id)).toEqual([401, 401, 401, 401]);
    await watch.goto(baseURL);
    await signIn(watch, recoveryText, key);
    const secondDeviceCard = watch
      .locator(".catalog-card")
      .filter({ hasText: filename });
    await expect(secondDeviceCard).toBeVisible();
    expect(
      (await catalog(watch)).some((entry) => entry.manifest.id === id),
    ).toBe(true);
    await secondDeviceCard
      .getByRole("button", { name: "Watch video", exact: true })
      .click();
    await expect(
      watch.getByRole("heading", { name: filename, exact: true }),
    ).toBeVisible();
    const video = watch.locator("video");
    await expect
      .poll(() =>
        video.evaluate((element: HTMLVideoElement) => element.readyState),
      )
      .toBeGreaterThanOrEqual(2);
    const playbackUrl = await video.getAttribute("src");
    expect(playbackUrl?.includes("/__eeevp_media__/")).toBe(true);
    expect(playbackUrl?.startsWith("blob:")).toBe(false);
    expect(
      await watch.evaluate(() =>
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
      element.currentTime = 4;
    });
    await expect
      .poll(() =>
        video.evaluate(
          (element: HTMLVideoElement) =>
            !element.seeking &&
            element.currentTime >= 3.9 &&
            element.readyState >= 2,
        ),
      )
      .toBe(true);
    await noSharingSurface(watch);
    await noPersistentKey(watch, key);
    recordAction(
      "Fresh independent browser imports the same recovery file and logs in once; canonical video plays and seeks at 4 seconds after first SW control",
    );
    await screenshot(watch, info.outputPath("desktop-playback.png"));
    await watch.setViewportSize({ width: 390, height: 844 });
    await noOverflow(watch);
    await screenshot(watch, info.outputPath("mobile-playback.png"));
    if (!playbackUrl) throw new Error("Playback URL missing");
    const range = await watch.evaluate(async (source) => {
      const response = await fetch(source, {
        headers: { Range: "bytes=1048000-1049500" },
      });
      return {
        status: response.status,
        range: response.headers.get("content-range"),
        bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
      };
    }, playbackUrl);
    expect(range.status).toBe(206);
    expect(range.range).toBe(`bytes 1048000-1049500/${fixture.length}`);
    expect(
      Buffer.from(range.bytes).equals(fixture.subarray(1_048_000, 1_049_501)),
    ).toBe(true);
    recordAction(
      "Cross-chunk stream returns 206 and 1501 exact source bytes without a decrypted Blob",
    );
    await video.evaluate(async (element: HTMLVideoElement) => {
      await element.play();
    });
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
      .toBe(false);
    const sessionCleared = watch.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/session" &&
        response.request().method() === "DELETE",
    );
    await watch
      .getByRole("button", { name: "Lock library", exact: true })
      .click();
    const cleared = await sessionCleared;
    expect(cleared.ok()).toBe(true);
    await cleared.finished();
    await expect(
      watch.getByLabel("Encryption key", { exact: true }),
    ).toBeVisible();
    await expect(watch.locator("video")).toHaveCount(0);
    expect(await lockedApiStatuses(watch, id)).toEqual([401, 401, 401, 401]);
    expect(
      await watch.evaluate(
        async (source) => (await fetch(source)).status,
        playbackUrl,
      ),
    ).toBe(403);
    await noPersistentKey(watch, key);
    recordAction(
      "Lock clears browser key, player and cookie; protected APIs return 401 and former media URL returns 403",
    );
    await signIn(watch, recoveryText, key);
    await expect
      .poll(() =>
        watch
          .locator("video")
          .evaluate((element: HTMLVideoElement) => element.readyState),
      )
      .toBeGreaterThanOrEqual(2);
    const expiringStream = await watch.locator("video").getAttribute("src");
    if (!expiringStream)
      throw new Error("Expiration scenario requires an active media stream");
    await viewer.clearCookies();
    const deniedChunk = viewer.waitForEvent("response", {
      predicate: (response) =>
        new URL(response.url()).pathname.includes("/chunks/") &&
        response.status() === 401,
    });
    await watch.evaluate(async (source) => {
      try {
        const response = await fetch(source, {
          headers: { Range: "bytes=0-1023" },
        });
        await response.arrayBuffer();
      } catch {
        /* Expected cancellation when the real private chunk request returns 401. */
      }
    }, expiringStream);
    await deniedChunk;
    await expect(
      watch.getByLabel("Encryption key", { exact: true }),
    ).toBeVisible();
    await expect(watch.locator("video")).toHaveCount(0);
    await noPersistentKey(watch, key);
    recordAction(
      "Actual cookie expiry during SW chunk fetch returns 401 and removes both playback and in-memory key",
    );
    await signIn(watch, recoveryText, key);
    await expect(watch.locator("video")).toBeVisible();

    await page.reload();
    await expect(
      page.getByLabel("Encryption key", { exact: true }),
    ).toBeVisible();
    await expect(ownCard).toHaveCount(0);
    await signIn(page, recoveryText, key);
    await expect(ownCard).toBeVisible();
    await noPersistentKey(page, key);
    recordAction(
      "Reload asks only for the same encryption key; one login restores the existing catalog without a second secret",
    );
    await page.getByLabel("Search videos", { exact: true }).fill(filename);
    await page
      .getByRole("button", { name: `Delete ${filename}`, exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await screenshot(page, info.outputPath("delete-confirmation.png"));
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete permanently", exact: true })
      .click();
    await expect(ownCard).toHaveCount(0);
    const afterDelete = await catalog(page);
    expect(afterDelete.some((entry) => entry.manifest.id === id)).toBe(false);
    expect(
      baseline.every((entry) =>
        afterDelete.some(
          (current) => current.manifest.id === entry.manifest.id,
        ),
      ),
    ).toBe(true);
    expect(await readdir(join(storage, "videos"))).not.toContain(id);
    await watch.goto(baseURL);
    await signIn(watch, recoveryText, key);
    expect(
      (await catalog(watch)).some((entry) => entry.manifest.id === id),
    ).toBe(false);
    await expect(
      watch.locator(".catalog-card").filter({ hasText: filename }),
    ).toHaveCount(0);
    recordAction(
      "Confirmed deletion removes only the owned QA video from both browsers and disk; pre-existing library entries remain",
    );

    let uploads = 0;
    let downloads = 0;
    let logins = 0;
    for (const request of requests) {
      expect(request.url().includes(key)).toBe(false);
      expect(request.url().includes(wrongKey)).toBe(false);
      expect(JSON.stringify(request.headers()).includes(key)).toBe(false);
      expect(JSON.stringify(request.headers()).includes(wrongKey)).toBe(false);
      expect(
        request.postDataBuffer()?.includes(Buffer.from(wrongKey)) ?? false,
      ).toBe(false);
      expect(
        request.postDataBuffer()?.includes(Buffer.from(key)) ?? false,
      ).toBe(false);
      expect(
        request.postDataBuffer()?.includes(Buffer.from(key, "base64url")) ??
          false,
      ).toBe(false);
      const path = new URL(request.url()).pathname;
      if (path === "/api/session" && request.method() === "POST") {
        z.strictObject({}).parse(request.postDataJSON());
        expect((await request.allHeaders()).origin).toBe(
          new URL(baseURL).origin,
        );
        logins += 1;
      }
      if (/\/chunks\/\d+$/.test(path)) {
        if (request.method() === "PUT") {
          uploads += 1;
          expect(request.postDataBuffer()?.length).toBeLessThanOrEqual(
            1_048_576 + 28,
          );
        }
        if (request.method() === "GET") downloads += 1;
      }
    }
    expect(logins).toBeGreaterThanOrEqual(5);
    expect(uploads).toBeGreaterThanOrEqual(3);
    expect(downloads).toBeGreaterThan(0);
    recordAction(
      `${requests.length} requests contain no raw encryption key; ${logins} session requests contain only an empty object with the actual same-origin Origin header; ${uploads} bounded encrypted uploads and ${downloads} encrypted reads`,
    );
  } finally {
    try {
      await Promise.all([viewer.close(), invalidViewer.close()]);
    } finally {
      for (const id of createdIds)
        if (!existing.has(id))
          await rm(join(storage, "videos", id), {
            recursive: true,
            force: true,
          });
      expect((await readFile(descriptorPath)).equals(originalDescriptor)).toBe(
        true,
      );
      for (const [id, original] of existingManifests)
        expect(
          (await readFile(join(storage, "videos", id, "manifest.json"))).equals(
            original,
          ),
        ).toBe(true);
    }
  }
  recordAction(
    "Existing library descriptor and committed manifest bytes preserved; only test-owned upload cleaned up",
  );
  await writeFile(
    info.outputPath("acceptance-actions.json"),
    JSON.stringify({ verdict: "PASS", actions }, null, 2),
  );
});
