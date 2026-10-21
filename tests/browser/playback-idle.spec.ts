// Read-only browser regression: an idle service worker must recover only its still-open owner's memory session.
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { CHUNK_SIZE, libraryVideoSchema } from "../../src/lib/video/schema";

test("private video plays and seeks after its service worker becomes idle", async ({
  page,
  baseURL,
}, info) => {
  const recoveryText = process.env.EEEVP_BROWSER_RECOVERY_TEXT;
  if (!recoveryText || !baseURL || new URL(baseURL).hostname !== "localhost") {
    throw new Error(
      "Run against the coordinated local preview with recovery text provided through the stdin browser runner.",
    );
  }
  await page.goto("/");
  await page
    .getByLabel("Import .txt recovery file", { exact: true })
    .setInputFiles({
      name: "library-recovery.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(recoveryText),
    });
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Lock library", exact: true }),
  ).toBeVisible();
  const body: unknown = await page.evaluate(async () => {
    const response = await fetch("/api/videos", { cache: "no-store" });
    if (!response.ok)
      throw new Error("The coordinated private catalog is unavailable.");
    return response.json();
  });
  const catalog = z
    .strictObject({ videos: z.array(libraryVideoSchema) })
    .parse(body);
  const videoRecord = catalog.videos.find(
    (entry) => entry.manifest.size > CHUNK_SIZE + 4_096,
  );
  if (!videoRecord)
    throw new Error(
      "The coordinated preview needs an existing supported video larger than one encrypted chunk.",
    );
  await page.locator(`a[href="/watch/${videoRecord.manifest.id}"]`).click();
  const video = page.locator("video");
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.readyState),
    )
    .toBeGreaterThanOrEqual(2);
  const source = await video.getAttribute("src");
  if (!source) throw new Error("The private playback URL is missing.");

  // Gecko normally terminates an idle worker after 30 seconds; active browser memory stays unlocked.
  await page.waitForTimeout(35_000);
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
  });
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0.15);
  const seekTime = await video.evaluate((element: HTMLVideoElement) => {
    element.pause();
    if (!Number.isFinite(element.duration) || element.duration <= 0)
      throw new Error("The video duration is unavailable.");
    const target = Math.min(1, element.duration / 2);
    element.currentTime = target;
    return target;
  });
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => ({
        seeking: element.seeking,
        ready: element.readyState,
        currentTime: element.currentTime,
      })),
    )
    .toMatchObject({
      seeking: false,
      ready: expect.any(Number),
      currentTime: expect.closeTo(seekTime, 1),
    });
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.readyState),
    )
    .toBeGreaterThanOrEqual(2);
  const range = await page.evaluate(async (url) => {
    const response = await fetch(url, {
      headers: { Range: "bytes=1048000-1049500" },
    });
    return {
      status: response.status,
      range: response.headers.get("Content-Range"),
      size: (await response.arrayBuffer()).byteLength,
    };
  }, source);
  expect(range).toEqual({
    status: 206,
    range: `bytes 1048000-1049500/${videoRecord.manifest.size}`,
    size: 1_501,
  });
  await page.getByRole("button", { name: "Lock library", exact: true }).click();
  await expect(
    page.getByLabel("Encryption key", { exact: true }),
  ).toBeVisible();
  const afterLock = await page.evaluate(async (url) => {
    const response = await fetch(url, { headers: { Range: "bytes=0-0" } });
    await response.body?.cancel();
    return response.status;
  }, source);
  expect(afterLock).toBe(403);
  await info.attach("idle-playback-contract", {
    body: JSON.stringify({
      browser: info.project.use.browserName,
      idleMilliseconds: 35_000,
      nativePlay: true,
      seek: true,
      crossChunkRange: range.status,
      lockedRange: afterLock,
    }),
    contentType: "application/json",
  });
});
