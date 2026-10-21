// Real UI mutation and refresh lifecycles recover from transport failures without losing visible catalog rows.
import { expect, test } from "@playwright/test";
import {
  createLibraryDescriptor,
  createLibraryKey,
  wrapVideoKey,
} from "../../src/lib/crypto/library-crypto";
import { createVideo } from "../../src/lib/crypto/video-crypto";

test.use({ timezoneId: "America/Los_Angeles" });

test("keeps rows after a failed refresh, formats UTC dates, and releases a failed deletion for retry", async ({
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
    createdAt: "2026-01-01T00:30:00.000Z",
  };
  let failCatalog = false;
  let deleted = false;
  let deletionAttempts = 0;
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
      status: failCatalog ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        failCatalog
          ? { error: "Temporary storage failure" }
          : { videos: deleted ? [] : [video] },
      ),
    });
  });
  await page.route(`**/api/videos/${video.manifest.id}`, async (route) => {
    expect(route.request().method()).toBe("DELETE");
    deletionAttempts += 1;
    if (deletionAttempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary storage failure" }),
      });
      return;
    }
    deleted = true;
    await route.fulfill({ status: 204 });
  });

  await page.goto("/");
  await page.getByLabel("Encryption key", { exact: true }).fill(key);
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  await expect(
    page.getByText("sample-video.webm", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("time")).toHaveText("Jan 1, 2026");
  failCatalog = true;
  await page
    .getByRole("button", { name: "Refresh library", exact: true })
    .click();
  await expect(
    page.getByText("Library could not refresh", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("sample-video.webm", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh library", exact: true }),
  ).toBeEnabled();
  failCatalog = false;
  await page
    .getByRole("button", { name: "Refresh library", exact: true })
    .click();
  await expect(
    page.getByText("Library could not refresh", { exact: true }),
  ).toHaveCount(0);

  await page
    .getByRole("button", { name: "Delete sample-video.webm", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(
    page.getByText("Deletion failed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete permanently", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByText("sample-video.webm", { exact: true }),
  ).toHaveCount(0);
  expect(deletionAttempts).toBe(2);
});
