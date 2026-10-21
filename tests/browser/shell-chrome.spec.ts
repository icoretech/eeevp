// Header/footer acceptance exercises the real server projection across open/locked client states without changing stored videos.
import { expect, test } from "@playwright/test";
import {
  createLibraryDescriptor,
  createLibraryKey,
  wrapVideoKey,
} from "../../src/lib/crypto/library-crypto";
import { createVideo } from "../../src/lib/crypto/video-crypto";

test("shows configured storage and official footer links before entry, while open, and after locking", async ({
  page,
}) => {
  const driver = process.env.STORAGE_DRIVER;
  const bucket = process.env.S3_BUCKET;
  const label =
    driver === "filesystem"
      ? "Local filesystem"
      : driver === "s3" && bucket
        ? bucket
        : null;
  if (!label)
    throw new Error(
      "Set the real storage driver and bucket for header acceptance.",
    );
  const descriptor = await createLibraryDescriptor(createLibraryKey());
  await page.route("**/api/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: route.request().method() === "POST",
      }),
    });
  });
  await page.route("**/api/library", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ library: descriptor }),
    });
  });
  await page.route("**/api/videos", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ videos: [] }),
    });
  });

  await page.goto("/");
  const storage = page.getByRole("banner").getByText(label, { exact: true });
  await expect(storage).toHaveText(label);
  await expect(
    page.getByText("Keys stay in your browser", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Encrypted End-to-End Video Player", { exact: true }),
  ).toBeVisible();
  const socialLinks = page.getByRole("navigation", {
    name: "EEEVP social links",
    exact: true,
  });
  await expect(socialLinks.getByRole("link")).toHaveCount(2);
  await expect(
    socialLinks.getByRole("link", { name: "icoretech", exact: true }),
  ).toHaveAttribute("href", "https://github.com/icoretech");
  await expect(
    socialLinks.getByRole("link", { name: "@icoretech_inc", exact: true }),
  ).toHaveAttribute("href", "https://x.com/icoretech_inc");
  await expect(socialLinks.locator('svg[aria-hidden="true"]')).toHaveCount(2);

  await page
    .getByLabel("Encryption key", { exact: true })
    .fill("sample-non-aes-input");
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Lock library", exact: true }),
  ).toBeVisible();
  await expect(storage).toHaveText(label);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(storage).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "Lock library", exact: true }).click();
  await expect(
    page.getByLabel("Encryption key", { exact: true }),
  ).toBeVisible();
  await expect(storage).toHaveText(label);
});

test("hydrates cleanly on fresh home/watch loads and after open SPA navigation, locking, and reload", async ({
  page,
}) => {
  const key = createLibraryKey();
  const descriptor = await createLibraryDescriptor(key);
  const fixture = await createVideo(
    new File([new Uint8Array([1, 2, 3])], "sample-video.webm", {
      type: "video/webm",
    }),
  );
  const video = {
    manifest: fixture.manifest,
    libraryId: descriptor.id,
    wrappedKey: await wrapVideoKey(
      fixture.manifest,
      fixture.credentials.key,
      key,
      descriptor.id,
    ),
    createdAt: "2026-01-01T12:00:00.000Z",
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      errors.push(`${message.type()}: ${message.text()}`);
  });
  const { promise: manifestReply, resolve: releaseManifest } =
    Promise.withResolvers<void>();
  await page.route("**/api/session", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: route.request().method() === "POST",
      }),
    });
  });
  await page.route("**/api/library", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ library: descriptor }),
    });
  });
  await page.route("**/api/videos", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ videos: [video] }),
    });
  });
  await page.route(`**/api/videos/${video.manifest.id}`, async (route) => {
    await manifestReply;
    await route
      .fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ video }),
      })
      .catch(() => {});
  });

  await page.goto(`/watch/${video.manifest.id}`);
  await expect(
    page.getByLabel("Encryption key", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "EEEVP home", exact: true }).click();
  await expect(page).toHaveURL("/");
  await page.getByLabel("Encryption key", { exact: true }).fill(key);
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  await expect(
    page.getByText("sample-video.webm", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Watch video", exact: true }).click();
  await expect(page).toHaveURL(`/watch/${video.manifest.id}`);
  await expect(
    page.getByRole("heading", { name: "Opening your video", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Lock library", exact: true }).click();
  await expect(
    page.getByLabel("Encryption key", { exact: true }),
  ).toBeVisible();
  releaseManifest();
  await page.reload();
  await expect(
    page.getByLabel("Encryption key", { exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");

  expect(errors).toEqual([]);
});
