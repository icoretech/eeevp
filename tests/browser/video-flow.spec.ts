// Real browser acceptance for the authenticated library and browser-only master key.
import { appendFileSync } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, type Request, test } from "@playwright/test";
import { z } from "zod";
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
    mask: [page.locator("input")],
  });
}

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

async function signIn(page: Page, password: string) {
  await page.getByLabel("Library password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function unlock(page: Page, key: string) {
  await page.getByLabel("Library key", { exact: true }).fill(key);
  await page
    .getByRole("button", { name: "Unlock library", exact: true })
    .click();
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
    async (candidate) => ({
      keyInLocalStorage: Object.values(localStorage).some(
        (value) => typeof value === "string" && value.includes(candidate),
      ),
      keyInSessionStorage: Object.values(sessionStorage).some(
        (value) => typeof value === "string" && value.includes(candidate),
      ),
      indexedDatabases: (await indexedDB.databases()).length,
    }),
    key,
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

test("private library across devices with memory-only keys and streaming playback", async ({
  browser,
  page,
  context,
  baseURL,
}, info) => {
  // First-use setup must never run against an existing library or a remote deployment.
  if (!baseURL || new URL(baseURL).hostname !== "localhost")
    throw new Error(
      "First-use acceptance requires an isolated localhost library",
    );
  const storage = process.env.STORAGE_PATH;
  const password = process.env.LIBRARY_PASSWORD;
  if (!storage || !password)
    throw new Error("Compose must supply STORAGE_PATH and LIBRARY_PASSWORD");
  const existing = await readdir(storage).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return [];
    throw error;
  });
  if (existing.length !== 0)
    throw new Error(
      "First-use acceptance requires an empty dedicated STORAGE_PATH; existing files are preserved",
    );
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
  let initializedId: string | undefined;
  context.on("request", (request) => {
    requests.push(request);
    if (request.method() === "PUT") {
      const match = new URL(request.url()).pathname.match(
        /^\/api\/videos\/([a-f0-9-]+)\/chunks\/\d+$/,
      );
      if (match?.[1]) createdIds.add(match[1]);
    }
  });
  page.on("worker", (worker) => workers.push(worker.url()));
  const viewer = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  viewer.on("request", (request) => requests.push(request));
  try {
    await page.goto("/");
    await expect(
      page.getByLabel("Library password", { exact: true }),
    ).toBeVisible();
    expect(
      await lockedApiStatuses(page, "00000000-0000-4000-8000-000000000001"),
    ).toEqual([401, 401, 401, 401]);
    await signIn(page, "incorrect-library-password");
    await expect(
      page.getByRole("alert").filter({ hasText: /incorrect|invalid|wrong/i }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Library password", { exact: true }),
    ).toBeVisible();
    recordAction(
      "Public library gate blocks unauthenticated access; descriptor/catalog/manifest/chunk reads all401; incorrect password rejected",
    );
    await signIn(page, password);
    await page
      .getByRole("button", { name: "Create library key", exact: true })
      .click();
    const key = await page
      .getByLabel("Your library key", { exact: true })
      .inputValue();
    expect(Buffer.from(key, "base64url").length).toBe(32);
    const initialize = page.getByRole("button", {
      name: "Initialize library",
      exact: true,
    });
    await expect(initialize).toBeDisabled();
    await page
      .getByRole("checkbox", { name: "I saved my library key", exact: true })
      .check();
    const initialization = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/library" &&
        response.request().method() === "POST",
    );
    await initialize.click();
    const initialized = await initialization;
    expect(initialized.status()).toBe(201);
    const initializedBody: unknown = await initialized.json();
    initializedId = z
      .strictObject({ library: libraryDescriptorSchema })
      .parse(initializedBody).library.id;
    await expect(
      page.getByRole("button", { name: "Lock library", exact: true }),
    ).toBeVisible();
    await noSharingSurface(page);
    await noPersistentKey(page, key);
    recordAction(
      "First-use key generated in browser; initialization disabled before recovery acknowledgement; immutable descriptor created only after confirmation",
    );
    await screenshot(page, info.outputPath("desktop-empty-library.png"));
    const fixture = await syntheticVideo(page);
    await writeFile(info.outputPath("sample-video.webm"), fixture);
    expect(fixture.length).toBeGreaterThan(2 * 1_048_576);
    await page.getByLabel("Choose your video", { exact: true }).setInputFiles({
      name: "sample-video.webm",
      mimeType: "video/webm",
      buffer: fixture,
    });
    await page
      .getByRole("button", { name: "Encrypt & upload", exact: true })
      .click();
    await expect(
      page.locator(".catalog-card").filter({ hasText: "sample-video.webm" }),
    ).toBeVisible({ timeout: 60_000 });
    const records = await catalog(page);
    expect(records).toHaveLength(1);
    const record = records[0];
    if (!record) throw new Error("Uploaded record missing");
    const id = record.manifest.id;
    createdIds.add(id);
    expect(record.libraryId).toBe(initializedId);
    expect(record.wrappedKey.length).toBe(80);
    expect(JSON.stringify(records).includes("sample-video.webm")).toBe(false);
    expect(workers.length).toBeGreaterThan(0);
    const stored = await readFile(join(storage, "videos", id, "chunks", "0"));
    expect(stored.length).toBe(1_048_576 + 28);
    expect(stored.equals(fixture.subarray(0, stored.length))).toBe(false);
    const diskRecord = await readFile(
      join(storage, "videos", id, "manifest.json"),
      "utf8",
    );
    expect(diskRecord.includes("sample-video.webm")).toBe(false);
    expect(diskRecord.includes(key)).toBe(false);
    recordAction(
      `UI worker upload persisted ${fixture.length} bytes as bounded ciphertext; canonical authenticated catalog contains encrypted metadata and wrapped key`,
    );
    await noSharingSurface(page);
    await screenshot(page, info.outputPath("desktop-library.png"));
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(page);
    await screenshot(page, info.outputPath("mobile-library.png"));
    await page.setViewportSize({ width: 1440, height: 1000 });

    const watch = await viewer.newPage();
    expect(await viewer.cookies()).toHaveLength(0);
    await watch.goto(`${baseURL}/watch/${id}`);
    await expect(
      watch.getByLabel("Library password", { exact: true }),
    ).toBeVisible();
    expect(await lockedApiStatuses(watch, id)).toEqual([401, 401, 401, 401]);
    await watch.goto(baseURL);
    await signIn(watch, password);
    await expect(
      watch.getByLabel("Library key", { exact: true }),
    ).toBeVisible();
    const apiCallsBeforeWrongKey = requests.filter((request) =>
      new URL(request.url()).pathname.startsWith("/api/"),
    ).length;
    await unlock(watch, Buffer.alloc(32, 7).toString("base64url"));
    await expect(
      watch.getByRole("alert").filter({ hasText: /key|unlock/i }),
    ).toBeVisible();
    await expect(watch.locator("video")).toHaveCount(0);
    await expect(
      watch.getByLabel("Choose your video", { exact: true }),
    ).toHaveCount(0);
    expect(
      requests.filter((request) =>
        new URL(request.url()).pathname.startsWith("/api/"),
      ).length,
    ).toBe(apiCallsBeforeWrongKey);
    await screenshot(watch, info.outputPath("wrong-key.png"));
    recordAction(
      "Second device without cookies cannot read existing video; correct server password with wrong masterkey remains locked",
    );
    await unlock(watch, key);
    const secondDeviceCard = watch
      .locator(".catalog-card")
      .filter({ hasText: "sample-video.webm" });
    await expect(secondDeviceCard).toBeVisible();
    expect((await catalog(watch)).map((entry) => entry.manifest.id)).toEqual([
      id,
    ]);
    await secondDeviceCard
      .getByRole("button", { name: "Watch video", exact: true })
      .click();
    await expect(
      watch.getByRole("heading", { name: "sample-video.webm", exact: true }),
    ).toBeVisible();
    const video = watch.locator("video");
    await expect(video).toBeVisible();
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
      "Second device enters same masterkey: original filename, first SW install/control, native video decode/play and seek4s succeed with normal URL",
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
      "Cross-chunk streaming range returns206 and1501 exact source bytes; no full decrypted Blob",
    );

    await video.evaluate(async (element: HTMLVideoElement) => {
      await element.play();
    });
    await expect
      .poll(() => video.evaluate((element: HTMLVideoElement) => element.paused))
      .toBe(false);
    await watch
      .getByRole("button", { name: "Lock library", exact: true })
      .click();
    await expect(
      watch.getByLabel("Library password", { exact: true }),
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
      "Lock clears authenticated access and playback: no video, API401, former stream403, no persistent key",
    );
    await signIn(watch, password);
    await unlock(watch, key);
    await expect(watch.locator("video")).toBeVisible();
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
        /* Authenticated stream cancellation is expected after cookie expiry. */
      }
    }, expiringStream);
    await deniedChunk;
    await expect(
      watch.getByLabel("Library password", { exact: true }),
    ).toBeVisible();
    await expect(watch.locator("video")).toHaveCount(0);
    await noPersistentKey(watch, key);
    recordAction(
      "Real cookie expiration during SW chunk fetch returns401 and clears browser key/playback, returning to sign-in",
    );
    await signIn(watch, password);
    await unlock(watch, key);
    await expect(watch.locator("video")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Library key", { exact: true })).toBeVisible();
    await expect(
      page.locator(".catalog-card").filter({ hasText: "sample-video.webm" }),
    ).toHaveCount(0);
    await unlock(page, key);
    await expect(
      page.locator(".catalog-card").filter({ hasText: "sample-video.webm" }),
    ).toBeVisible();
    await noPersistentKey(page, key);
    recordAction(
      "Reload discards browser masterkey; key reentry restores canonical filesystem catalog",
    );
    await page
      .getByRole("button", { name: /delete sample-video.webm/i })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await screenshot(page, info.outputPath("delete-confirmation.png"));
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete permanently", exact: true })
      .click();
    await expect(
      page.locator(".catalog-card").filter({ hasText: "sample-video.webm" }),
    ).toHaveCount(0);
    expect(await catalog(page)).toHaveLength(0);
    expect(await readdir(join(storage, "videos"))).not.toContain(id);
    await watch.goto(baseURL);
    // Full navigation deliberately drops the in-memory key and asks for it again.
    await expect(
      watch.getByLabel("Library key", { exact: true }),
    ).toBeVisible();
    await unlock(watch, key);
    await expect(
      watch.getByRole("button", { name: "Lock library", exact: true }),
    ).toBeVisible();
    expect(await catalog(watch)).toHaveLength(0);
    await expect(
      watch.getByRole("heading", { name: "sample-video.webm", exact: true }),
    ).toHaveCount(0);
    recordAction(
      "Confirmed delete removes canonical video directory and record; both authenticated clients see empty library after refresh",
    );

    let uploads = 0;
    let downloads = 0;
    for (const request of requests) {
      expect(request.url().includes(key)).toBe(false);
      expect(JSON.stringify(request.headers()).includes(key)).toBe(false);
      expect(
        request.postDataBuffer()?.includes(Buffer.from(key)) ?? false,
      ).toBe(false);
      if (/\/chunks\/\d+$/.test(request.url())) {
        if (request.method() === "PUT") {
          uploads += 1;
          expect(request.postDataBuffer()?.length).toBeLessThanOrEqual(
            1_048_576 + 28,
          );
        }
        if (request.method() === "GET") downloads += 1;
      }
    }
    expect(uploads).toBeGreaterThanOrEqual(3);
    expect(downloads).toBeGreaterThan(0);
    recordAction(
      `${requests.length} outgoing requests contain no generated masterkey in URL/headers/body; ${uploads} bounded encrypted uploads; ${downloads} encrypted reads`,
    );
    await writeFile(
      info.outputPath("acceptance-actions.json"),
      JSON.stringify({ verdict: "PASS", actions }, null, 2),
    );
  } finally {
    await viewer.close();
    // Only records created by this test are removed; all pre-existing data was rejected above.
    for (const id of createdIds)
      await rm(join(storage, "videos", id), { recursive: true, force: true });
    if (initializedId) {
      const descriptor = libraryDescriptorSchema.parse(
        JSON.parse(await readFile(join(storage, "library.json"), "utf8")),
      );
      if (descriptor.id === initializedId)
        await unlink(join(storage, "library.json"));
    }
    // Remove an empty test-created catalog directory so the next first-use run can start cleanly.
    for (const directory of ["videos", ".trash"]) {
      const remaining = await readdir(join(storage, directory)).catch(() => [
        "unavailable",
      ]);
      if (remaining.length === 0) await rmdir(join(storage, directory));
    }
  }
});
