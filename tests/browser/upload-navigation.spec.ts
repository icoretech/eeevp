// The private Upload action focuses its real section both on the library and after SPA navigation back from a player route.
import { expect, test } from "@playwright/test";
import {
  createLibraryDescriptor,
  createLibraryKey,
  wrapVideoKey,
} from "../../src/lib/crypto/library-crypto";
import { createVideo } from "../../src/lib/crypto/video-crypto";

test("private Upload focuses and highlights its section without mutating videos", async ({
  page,
}) => {
  const key = createLibraryKey();
  const library = await createLibraryDescriptor(key);
  const fixture = await createVideo(
    new File([new Uint8Array([1, 2, 3])], "sample-video.webm", {
      type: "video/webm",
    }),
  );
  const video = {
    manifest: fixture.manifest,
    libraryId: library.id,
    wrappedKey: await wrapVideoKey(
      fixture.manifest,
      fixture.credentials.key,
      key,
      library.id,
    ),
    createdAt: "2026-01-01T12:00:00.000Z",
  };
  const mutations: string[] = [];
  const { promise: mediaResponse, resolve: releaseMedia } =
    Promise.withResolvers<void>();
  await page.route("**/api/session", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        authenticated: route.request().method() === "POST",
      }),
    }),
  );
  await page.route("**/api/library", async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ library }),
    }),
  );
  await page.route("**/api/videos", async (route) => {
    if (route.request().method() !== "GET")
      mutations.push(route.request().method());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ videos: [video] }),
    });
  });
  await page.route(`**/api/videos/${video.manifest.id}`, async (route) => {
    await mediaResponse;
    await route
      .fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ video }),
      })
      .catch(() => {});
  });

  await page.goto("/");
  await page.getByLabel("Encryption key", { exact: true }).fill(key);
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  await expect(
    page.getByText("sample-video.webm", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page.locator("#upload")).toBeFocused();
  expect(
    Number.parseFloat(
      await page
        .locator(".upload-card")
        .evaluate((element) => getComputedStyle(element).outlineWidth),
    ),
  ).toBeGreaterThanOrEqual(2);

  await page.getByRole("button", { name: "Watch video", exact: true }).click();
  await expect(page).toHaveURL(`/watch/${video.manifest.id}`);
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(page).toHaveURL("/#upload");
  await expect(page.locator("#upload")).toBeFocused();
  releaseMedia();
  expect(mutations).toEqual([]);
});
