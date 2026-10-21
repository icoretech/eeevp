// Real React and WebCrypto verify that locking cancels an in-flight playback opener.
import { expect, test } from "@playwright/test";
import {
  createLibraryDescriptor,
  createLibraryKey,
  wrapVideoKey,
} from "../../src/lib/crypto/library-crypto";
import { createVideo } from "../../src/lib/crypto/video-crypto";

test("locking aborts a pending video request and ignores its late response", async ({
  page,
}) => {
  const key = createLibraryKey();
  const library = await createLibraryDescriptor(key);
  const { manifest, credentials } = await createVideo(
    new File([new Uint8Array([1, 2, 3, 4])], "sample-video.webm", {
      type: "video/webm",
    }),
  );
  const video = {
    manifest,
    wrappedKey: await wrapVideoKey(manifest, credentials.key, key, library.id),
    libraryId: library.id,
    createdAt: "2026-01-01T12:00:00.000Z",
  };
  const videoPath = `/api/videos/${manifest.id}`;
  let releaseResponse: (() => void) | undefined;
  const heldResponse = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
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
      body: JSON.stringify({ library }),
    });
  });
  await page.route(`**${videoPath}`, async (route) => {
    await heldResponse;
    await route
      .fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ video }),
      })
      .catch(() => {});
  });

  try {
    await page.goto(`/watch/${manifest.id}`);
    await page.getByLabel("Encryption key", { exact: true }).fill(key);
    const requested = page.waitForRequest(
      (request) => new URL(request.url()).pathname === videoPath,
    );
    await page
      .getByRole("button", { name: "Decrypt & Login", exact: true })
      .click();
    await requested;
    await expect(
      page.getByRole("heading", { name: "Opening your video", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Your encryption key stays in this browser. The server delivers encrypted chunks.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText("Your library stays private", { exact: true }),
    ).toBeVisible();
    const failedRequest = page.waitForEvent("requestfailed", {
      predicate: (request) => new URL(request.url()).pathname === videoPath,
    });

    await page
      .getByRole("button", { name: "Lock library", exact: true })
      .click();

    expect((await failedRequest).failure()?.errorText).toMatch(/abort|cancel/i);
    await expect(
      page.getByLabel("Encryption key", { exact: true }),
    ).toBeVisible();
    releaseResponse?.();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("video")).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Opening your video", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Lock library", exact: true }),
    ).toHaveCount(0);
  } finally {
    releaseResponse?.();
  }
});
