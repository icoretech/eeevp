// The actual production Service Worker drives HUD metrics; telemetry must never replace or resize native media.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import { CHUNK_SIZE, libraryVideoSchema } from "../../src/lib/video/schema";

const candidateSchema = z.object({ video: libraryVideoSchema });

async function candidateVideo() {
  return candidateSchema.parse(
    JSON.parse(
      await readFile(
        resolve("test-results/public-demo-dataset/replacement-receipt.json"),
        "utf8",
      ),
    ),
  ).video;
}

async function enterDemo(page: Page, input?: string) {
  await page.goto("http://localhost:3001/");
  await expect(page).toHaveURL("http://localhost:3001/");
  if (input !== undefined)
    await page.getByLabel("Encryption key", { exact: true }).fill(input);
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Lock library", exact: true }),
  ).toBeVisible();
}

async function metrics(page: Page) {
  const summary = await page
    .getByRole("region", { name: "Browser decryption activity" })
    .locator(".sr-only")
    .textContent();
  const matched = summary?.match(
    /(\d+) of (\d+) unique blocks\s*verified\.\s*(\d+) of (\d+) bytes\s*verified\./,
  );
  if (!matched) throw new Error("Verified decryption metrics are missing.");
  return {
    chunks: Number(matched[1]),
    totalChunks: Number(matched[2]),
    bytes: Number(matched[3]),
    totalBytes: Number(matched[4]),
  };
}

async function playbackPresentation(page: Page) {
  const badge = page.locator(".player-toolbar .playback-mode-badge");
  await expect(badge).toHaveText("Demo playback");
  await expect(badge).toHaveCSS("font-size", "13px");
  const bounds = await badge.boundingBox();
  if (!bounds) throw new Error("The playback mode badge is missing.");
  expect(bounds.height).toBeGreaterThanOrEqual(24);
  expect(bounds.height).toBeLessThanOrEqual(26);
  await expect(page.locator(".viewer-note")).toHaveCount(0);
  await expect(page.locator(".player-content [data-slot=alert]")).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

async function observeNativeMotion(page: Page) {
  await page.addInitScript(() => {
    const native = document.startViewTransition;
    const receipts: Array<{
      types: string[];
      startedAt: number;
      readyAt: number;
      finishedAt: number;
      error: string;
    }> = [];
    const samples: number[] = [];
    const publish = () => {
      document.documentElement.dataset.activityMotion = JSON.stringify({
        receipts,
        samples,
      });
    };
    if (typeof native === "function")
      Object.defineProperty(document, "startViewTransition", {
        configurable: true,
        value(...args: Parameters<Document["startViewTransition"]>) {
          const options = args[0];
          const receipt = {
            types:
              options && typeof options === "object"
                ? Array.from(options.types ?? [])
                : [],
            startedAt: performance.now(),
            readyAt: 0,
            finishedAt: 0,
            error: "",
          };
          receipts.push(receipt);
          const transition = native.apply(document, args);
          void transition.ready.then(
            () => {
              receipt.readyAt = performance.now();
              publish();
            },
            (error: Error) => {
              receipt.error = error.name;
              publish();
            },
          );
          void transition.finished.then(
            () => {
              receipt.finishedAt = performance.now();
              publish();
            },
            () => {},
          );
          publish();
          return transition;
        },
      });
    const observer = new MutationObserver((mutations) => {
      if (samples.length >= 100) return;
      if (
        mutations.some((mutation) => {
          const target =
            mutation.target instanceof Element
              ? mutation.target
              : mutation.target.parentElement;
          return target?.closest(".decryption-activity");
        })
      ) {
        samples.push(performance.now());
        publish();
      }
    });
    observer.observe(document, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
}

const motionSchema = z.object({
  receipts: z.array(
    z.object({
      types: z.array(z.string()),
      startedAt: z.number(),
      readyAt: z.number(),
      finishedAt: z.number(),
      error: z.string(),
    }),
  ),
  samples: z.array(z.number()),
});

test("actual verified chunk activity keeps the native video and reserved HUD geometry stable", async ({
  page,
  context,
}, info) => {
  const candidate = await candidateVideo();
  const errors: string[] = [];
  const requestedChunks = new Set<number>();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      errors.push(`${message.type()}: ${message.text()}`);
  });
  context.on("requestfinished", (request) => {
    const match = new URL(request.url()).pathname.match(
      new RegExp(`/api/videos/${candidate.manifest.id}/chunks/(\\d+)$`),
    );
    if (match) requestedChunks.add(Number(match[1]));
  });
  await page.setViewportSize({ width: 1286, height: 1719 });
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await observeNativeMotion(page);
  await enterDemo(page);
  await page.locator(`a[href="/watch/${candidate.manifest.id}"]`).click();
  await expect(page).toHaveURL(
    `http://localhost:3001/watch/${candidate.manifest.id}`,
  );
  await playbackPresentation(page);
  const activity = page.getByRole("region", {
    name: "Browser decryption activity",
  });
  await expect(activity).toBeVisible();
  const openingHeight = await activity.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  expect(openingHeight).toBe(56);
  const video = page.locator("video");
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.readyState),
    )
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(() => metrics(page).then((value) => value.chunks))
    .toBeGreaterThan(0);
  const originalVideo = await video.elementHandle();
  const initialStage = await page.locator(".video-stage").boundingBox();
  if (!originalVideo || !initialStage)
    throw new Error("Native playback geometry is missing.");
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  const source = await video.getAttribute("src");
  if (!source) throw new Error("The encrypted playback stream is missing.");
  const before = await metrics(page);
  await expect(activity).toHaveAttribute("aria-live", "off");
  await expect(activity.locator(".decryption-activity-cell")).toHaveCount(
    Math.min(32, candidate.manifest.chunkCount),
  );
  const pausedTime = await video.evaluate(
    (element: HTMLVideoElement) => element.currentTime,
  );
  await activity.evaluate((element) => {
    element.dataset.observedPulses = "0";
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations)
        for (const added of mutation.addedNodes)
          if (
            added instanceof Element &&
            added.matches(".decryption-activity-pulse")
          )
            element.dataset.observedPulses = String(
              Number(element.dataset.observedPulses) + 1,
            );
    });
    observer.observe(element, { childList: true, subtree: true });
  });
  const start = CHUNK_SIZE * (candidate.manifest.chunkCount - 1);
  const end = candidate.manifest.size - 1;
  const range = await page.evaluate(
    async ({ source, start, end }) => {
      const response = await fetch(source, {
        headers: { Range: `bytes=${start}-${end}` },
      });
      return {
        status: response.status,
        bytes: (await response.arrayBuffer()).byteLength,
      };
    },
    { source, start, end },
  );
  expect(range).toEqual({ status: 206, bytes: end - start + 1 });
  await expect
    .poll(() => activity.getAttribute("data-observed-pulses").then(Number))
    .toBeGreaterThan(0);
  await expect
    .poll(() => activity.locator(".decryption-activity-phase").textContent())
    .toBe("Verified locally");
  const after = await metrics(page);
  expect(after.totalChunks).toBe(candidate.manifest.chunkCount);
  expect(after.totalBytes).toBe(candidate.manifest.size);
  expect(after.chunks).toBeGreaterThanOrEqual(before.chunks);
  expect(after.chunks).toBeLessThanOrEqual(after.totalChunks);
  expect(after.bytes).toBeGreaterThanOrEqual(before.bytes);
  expect(after.bytes).toBeLessThanOrEqual(after.totalBytes);
  expect(after.bytes).toBeGreaterThan(0);
  await expect(activity.locator(".decryption-activity-bytes")).toHaveText(
    `${(after.bytes / 1_048_576).toFixed(2)} MiB verified`,
  );
  await expect
    .poll(() =>
      activity
        .locator('.decryption-activity-cell[data-state="verified"]')
        .count(),
    )
    .toBeGreaterThan(0);
  expect(
    await video.evaluate(
      (element, original) => element === original,
      originalVideo,
    ),
  ).toBe(true);
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.currentTime),
  ).toBe(pausedTime);
  const finalStage = await page.locator(".video-stage").boundingBox();
  if (!finalStage) throw new Error("The native video stage disappeared.");
  for (const dimension of ["x", "y", "width", "height"] as const)
    expect(
      Math.abs(finalStage[dimension] - initialStage[dimension]),
    ).toBeLessThanOrEqual(1);
  expect(
    await activity.evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
  ).toBe(openingHeight);
  expect(requestedChunks.size).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  const motion = motionSchema.parse(
    JSON.parse(
      await page
        .locator("html")
        .getAttribute("data-activity-motion")
        .then((value) => {
          if (!value)
            throw new Error("Native motion observations are missing.");
          return value;
        }),
    ),
  );
  const navigation = motion.receipts.filter((receipt) =>
    receipt.types.includes("nav-forward"),
  );
  expect(navigation.length).toBeGreaterThan(0);
  for (const receipt of navigation) {
    expect(receipt.error).toBe("");
    expect(receipt.readyAt).toBeGreaterThan(receipt.startedAt);
    expect(receipt.finishedAt).toBeGreaterThanOrEqual(receipt.readyAt);
  }
  const observedOverlap = motion.samples.filter((time) =>
    navigation.some(
      (receipt) => time >= receipt.readyAt && time <= receipt.finishedAt,
    ),
  ).length;
  await info.attach("actual-decryption-metrics", {
    contentType: "application/json",
    body: JSON.stringify({
      before,
      after,
      requestedChunks: [...requestedChunks],
    }),
  });
  await info.attach("native-motion-and-real-activity", {
    contentType: "application/json",
    body: JSON.stringify({ ...motion, observedOverlap }),
  });
  await page.screenshot({
    path: ".omo/evidence/decryption-activity-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await playbackPresentation(page);
  await page.screenshot({
    path: ".omo/evidence/decryption-activity-mobile.png",
    fullPage: true,
  });
});

test("reduced motion leaves real verified coverage static", async ({
  page,
}) => {
  const candidate = await candidateVideo();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await enterDemo(page);
  await page.locator(`a[href="/watch/${candidate.manifest.id}"]`).click();
  await expect(page).toHaveURL(
    `http://localhost:3001/watch/${candidate.manifest.id}`,
  );
  const activity = page.getByRole("region", {
    name: "Browser decryption activity",
  });
  await expect
    .poll(() => metrics(page).then((value) => value.bytes))
    .toBeGreaterThan(0);
  expect(
    await activity.evaluate(
      (element) => element.getAnimations({ subtree: true }).length,
    ),
  ).toBe(0);
  expect(
    await activity
      .locator(".decryption-activity-pulse")
      .evaluateAll((elements) =>
        elements.every(
          (element) => getComputedStyle(element).animationName === "none",
        ),
      ),
  ).toBe(true);
  expect(
    await activity.evaluate(
      (element) => element.getBoundingClientRect().height,
    ),
  ).toBe(56);
});

test("a wrong key opens no verified activity and sends no encrypted chunk requests", async ({
  page,
  context,
}) => {
  const candidate = await candidateVideo();
  const chunks: string[] = [];
  context.on("request", (request) => {
    if (
      /\/api\/videos\/[^/]+\/chunks\/\d+$/.test(new URL(request.url()).pathname)
    )
      chunks.push(new URL(request.url()).pathname);
  });
  await enterDemo(page, "sample-wrong-encryption-key");
  await expect(page.locator(".catalog-card").first()).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Watch video", exact: true }),
  ).toHaveCount(0);
  await page.goto(`http://localhost:3001/watch/${candidate.manifest.id}`);
  await expect(page).toHaveURL(
    `http://localhost:3001/watch/${candidate.manifest.id}`,
  );
  await page
    .getByLabel("Encryption key", { exact: true })
    .fill("sample-wrong-encryption-key");
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "This video could not be opened.",
      exact: true,
    }),
  ).toBeVisible();
  const activity = page.getByRole("region", {
    name: "Browser decryption activity",
  });
  await expect(
    activity.getByText("No active decryption", { exact: true }),
  ).toBeVisible();
  await expect(activity.locator(".decryption-activity-cell")).toHaveCount(0);
  await expect(activity.locator(".decryption-activity-bytes")).toHaveCount(0);
  await expect(page.locator("video")).toHaveCount(0);
  expect(chunks).toEqual([]);
});
