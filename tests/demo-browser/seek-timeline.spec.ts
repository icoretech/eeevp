// A finalized public fixture must expose stable finite timing and decode the requested frames through encrypted ranges.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { CHUNK_SIZE, libraryVideoSchema } from "../../src/lib/video/schema";

const candidateSchema = z.object({
  filename: z.literal("Motion study - 90 seconds.webm"),
  sourceFile: z.literal("seek-study-90s-v1.webm"),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceBytes: z.number().int().positive(),
  durationSeconds: z.literal(90),
  video: libraryVideoSchema,
});

test("finalized public video keeps its timeline stable during rapid and random encrypted seeks", async ({
  page,
  context,
  browserName,
}, info) => {
  test.setTimeout(240_000);
  const directory = resolve("test-results/public-demo-dataset");
  const candidate = candidateSchema.parse(
    JSON.parse(
      await readFile(resolve(directory, "replacement-receipt.json"), "utf8"),
    ),
  );
  const source = await readFile(resolve(directory, candidate.sourceFile));
  expect(source.length).toBe(candidate.sourceBytes);
  expect(createHash("sha256").update(source).digest("hex")).toBe(
    candidate.sourceSha256,
  );
  const verificationPath = resolve(
    directory,
    `seek-verification-${browserName}.json`,
  );
  await writeFile(
    verificationPath,
    JSON.stringify({
      verdict: "RUNNING",
      videoId: candidate.video.manifest.id,
      sourceSha256: candidate.sourceSha256,
    }),
    { mode: 0o600 },
  );
  const packetTimings: Array<{ source: string; elapsedMilliseconds: number }> =
    [];
  context.on("requestfinished", (request) => {
    if (
      !/^\/api\/videos\/[^/]+\/chunks\/\d+$/.test(
        new URL(request.url()).pathname,
      )
    )
      return;
    packetTimings.push({
      source:
        browserName === "chromium" && request.serviceWorker()
          ? "service-worker"
          : "page",
      elapsedMilliseconds: request.timing().responseEnd,
    });
  });
  await page.addInitScript(() => {
    const finite = (value: number) =>
      Number.isFinite(value) ? value : String(value);
    const sample = (video: HTMLVideoElement) => {
      const rect = video.getBoundingClientRect();
      const stage = video.parentElement?.getBoundingClientRect();
      return {
        duration: finite(video.duration),
        currentTime: finite(video.currentTime),
        seeking: video.seeking,
        readyState: video.readyState,
        width: rect.width,
        height: rect.height,
        stageWidth: stage?.width,
        stageHeight: stage?.height,
      };
    };
    const events: Array<ReturnType<typeof sample> & { event: string }> = [];
    for (const type of [
      "loadedmetadata",
      "durationchange",
      "seeking",
      "seeked",
      "timeupdate",
      "error",
    ]) {
      document.addEventListener(
        type,
        (event) => {
          if (
            !(event.target instanceof HTMLVideoElement) ||
            events.length >= 500
          )
            return;
          events.push({ event: type, ...sample(event.target) });
          document.documentElement.dataset.eeevpSeekTrace =
            JSON.stringify(events);
        },
        true,
      );
    }
  });
  const throttle =
    browserName === "chromium" ? await context.newCDPSession(page) : null;
  if (throttle) {
    await throttle.send("Network.enable");
    await throttle.send("Network.emulateNetworkConditionsByRule", {
      matchedNetworkConditions: [
        {
          urlPattern: "",
          latency: 120,
          downloadThroughput: 786_432,
          uploadThroughput: -1,
          offline: false,
        },
      ],
    });
  }
  await page.goto("http://localhost:3001/");
  await expect(page).toHaveURL("http://localhost:3001/");
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Lock library", exact: true }),
  ).toBeVisible();
  await page.locator(`a[href="/watch/${candidate.video.manifest.id}"]`).click();
  await expect(page).toHaveURL(
    `http://localhost:3001/watch/${candidate.video.manifest.id}`,
  );
  const video = page.locator("video");
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.readyState),
    )
    .toBeGreaterThanOrEqual(2);
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.duration),
  ).toBeCloseTo(90, 2);
  const initialBounds = await video.boundingBox();
  if (!initialBounds)
    throw new Error("The public video has no rendered bounds.");
  const targets = [67.35, 12.4, 83.2, 31.1, 5.2, 48.8, 21.6, 74.25];
  const decodedFrames: Array<{
    target: number;
    mediaTime: number;
    duration: number;
  }> = [];
  for (const target of targets) {
    const frame = await video.evaluate(
      (element: HTMLVideoElement, target) =>
        new Promise<{ mediaTime: number; duration: number }>(
          (resolve, reject) => {
            element.pause();
            const timeout = window.setTimeout(
              () =>
                reject(
                  new Error("The requested native video frame did not decode."),
                ),
              30_000,
            );
            element.requestVideoFrameCallback((_now, metadata) => {
              window.clearTimeout(timeout);
              resolve({
                mediaTime: metadata.mediaTime,
                duration: element.duration,
              });
            });
            element.currentTime = target;
          },
        ),
      target,
    );
    expect(frame.duration).toBeCloseTo(90, 2);
    expect(Math.abs(frame.mediaTime - target)).toBeLessThanOrEqual(0.1);
    decodedFrames.push({ target, ...frame });
  }
  await video.evaluate(async (element: HTMLVideoElement) => {
    for (const target of [58, 7, 85, 29, 65, 3, 47.7]) {
      element.currentTime = target;
      await new Promise((resolve) => window.setTimeout(resolve, 45));
    }
  });
  await expect
    .poll(() =>
      video.evaluate(
        (element: HTMLVideoElement) =>
          !element.seeking &&
          Math.abs(element.currentTime - 47.7) < 0.1 &&
          element.readyState >= 2,
      ),
    )
    .toBe(true);
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
  });
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(47.9);
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  const finalBounds = await video.boundingBox();
  if (!finalBounds)
    throw new Error("The public video disappeared after seeking.");
  for (const dimension of ["width", "height", "x", "y"] as const) {
    expect(
      Math.abs(finalBounds[dimension] - initialBounds[dimension]),
    ).toBeLessThanOrEqual(1.5);
  }
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.error),
  ).toBeNull();
  const playbackUrl = await video.getAttribute("src");
  if (!playbackUrl)
    throw new Error("The public encrypted stream URL is missing.");
  const start = CHUNK_SIZE * 20 - 500;
  const end = start + 1_499;
  const range = await page.evaluate(
    async ({ source, start, end }) => {
      const response = await fetch(source, {
        headers: { Range: `bytes=${start}-${end}` },
      });
      return {
        status: response.status,
        contentRange: response.headers.get("Content-Range"),
        bytes: Array.from(new Uint8Array(await response.arrayBuffer())),
      };
    },
    { source: playbackUrl, start, end },
  );
  expect(range.status).toBe(206);
  expect(range.contentRange).toBe(`bytes ${start}-${end}/${source.length}`);
  expect(Buffer.from(range.bytes).equals(source.subarray(start, end + 1))).toBe(
    true,
  );
  const screenshot = info.outputPath(`long-seek-${browserName}.png`);
  await page.screenshot({
    path: screenshot,
    fullPage: true,
    animations: "disabled",
  });
  const trace = await page
    .locator("html")
    .getAttribute("data-eeevp-seek-trace");
  const tracePath = info.outputPath(`long-seek-${browserName}.json`);
  await writeFile(
    tracePath,
    JSON.stringify(
      {
        events: trace ? JSON.parse(trace) : [],
        decodedFrames,
        initialBounds,
        finalBounds,
        packetTimings,
      },
      null,
      2,
    ),
  );
  if (throttle) {
    expect(
      packetTimings.some(
        (packet) =>
          packet.source === "service-worker" &&
          packet.elapsedMilliseconds >= 1_000,
      ),
    ).toBe(true);
  }
  await writeFile(
    verificationPath,
    JSON.stringify(
      {
        verdict: "PASS",
        videoId: candidate.video.manifest.id,
        sourceSha256: candidate.sourceSha256,
        durationSeconds: 90,
        seekTargets: targets,
        artifactRefs: [screenshot, tracePath],
        browser: browserName,
        throttle: throttle
          ? {
              latencyMilliseconds: 120,
              bytesPerSecond: 786_432,
              observedServiceWorkerPacketMilliseconds: packetTimings
                .filter((packet) => packet.source === "service-worker")
                .map((packet) => packet.elapsedMilliseconds),
            }
          : null,
        decodedFrames,
        rangeStatus: range.status,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
});
