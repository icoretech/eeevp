// Browser regressions keep failed session transport at the key gate while preserving permissive key entry.
import { expect, test } from "@playwright/test";
import {
  createLibraryDescriptor,
  createLibraryKey,
} from "../../src/lib/crypto/library-crypto";

const inputKey = "sample-non-aes-input";

test("preserves a rejected session's operational error without opening or requesting the catalog", async ({
  page,
}) => {
  let sessionBody: string | null = null;
  const laterRequests: string[] = [];
  await page.route("**/api/session", async (route) => {
    sessionBody = route.request().postData();
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "Request origin is not allowed" }),
    });
  });
  await page.route(/\/api\/(library|videos)(?:\/|$)/, async (route) => {
    laterRequests.push(new URL(route.request().url()).pathname);
    await route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "Browser session required" }),
    });
  });

  await page.goto("/");
  await page.getByLabel("Encryption key", { exact: true }).fill(inputKey);
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  await expect(
    page.getByText("Request origin is not allowed (HTTP 403)", { exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");

  await expect(
    page.getByLabel("Encryption key", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Lock library", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText(
      "Your browser session expired. Enter your encryption key to continue.",
      { exact: true },
    ),
  ).toHaveCount(0);
  expect(sessionBody).toBe("{}");
  expect(laterRequests).toEqual([]);
});

test("opens the workspace with non-AES text after a successful empty session request", async ({
  page,
}) => {
  const descriptor = await createLibraryDescriptor(createLibraryKey());
  let sessionBody: string | null = null;
  await page.route("**/api/session", async (route) => {
    sessionBody = route.request().postData();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ authenticated: true }),
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
  await page.getByLabel("Encryption key", { exact: true }).fill(inputKey);
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();

  await expect(
    page.getByRole("button", { name: "Lock library", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Library open", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Encryption key", { exact: true })).toHaveCount(
    0,
  );
  expect(sessionBody).toBe("{}");
});

test("refresh recovers a transient descriptor failure without another key entry or session request", async ({
  page,
}) => {
  const descriptor = await createLibraryDescriptor(createLibraryKey());
  let sessionRequests = 0;
  let descriptorRequests = 0;
  let catalogRequests = 0;
  await page.route("**/api/session", async (route) => {
    sessionRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ authenticated: true }),
    });
  });
  await page.route("**/api/library", async (route) => {
    descriptorRequests += 1;
    await route.fulfill({
      status: descriptorRequests === 1 ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        descriptorRequests === 1
          ? { error: "Temporary storage failure" }
          : { library: descriptor },
      ),
    });
  });
  await page.route("**/api/videos", async (route) => {
    catalogRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ videos: [] }),
    });
  });

  await page.goto("/");
  await page.getByLabel("Encryption key", { exact: true }).fill(inputKey);
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  await expect(
    page.getByText("Library unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Choose your video", { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Refresh library", exact: true }),
  ).toBeEnabled();

  const initialCatalogRequests = catalogRequests;
  await page
    .getByRole("button", { name: "Refresh library", exact: true })
    .click();

  await expect(
    page.getByText("Library unavailable", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Choose your video", { exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Refresh library", exact: true }),
  ).toBeEnabled();
  await expect(page.getByText("Library open", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Encryption key", { exact: true })).toHaveCount(
    0,
  );
  expect(sessionRequests).toBe(1);
  expect(descriptorRequests).toBe(2);
  expect(catalogRequests).toBeGreaterThan(initialCatalogRequests);
});

test("locking cancels descriptor recovery so its late response cannot reopen the workspace", async ({
  page,
}) => {
  const descriptor = await createLibraryDescriptor(createLibraryKey());
  let descriptorRequests = 0;
  let releaseRetry: (() => void) | undefined;
  const retryResponse = new Promise<void>((resolve) => {
    releaseRetry = resolve;
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
    descriptorRequests += 1;
    if (descriptorRequests === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Temporary storage failure" }),
      });
      return;
    }
    await retryResponse;
    await route
      .fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ library: descriptor }),
      })
      .catch(() => {});
  });
  await page.route("**/api/videos", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ videos: [] }),
    });
  });

  await page.goto("/");
  await page.getByLabel("Encryption key", { exact: true }).fill(inputKey);
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  await expect(
    page.getByText("Library unavailable", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Refresh library", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Refresh library", exact: true })
    .click();
  await expect.poll(() => descriptorRequests).toBe(2);
  await page.getByRole("button", { name: "Lock library", exact: true }).click();
  await expect(
    page.getByLabel("Encryption key", { exact: true }),
  ).toBeVisible();
  releaseRetry?.();
  await page.waitForLoadState("networkidle");

  await expect(
    page.getByLabel("Encryption key", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Lock library", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Library open", { exact: true })).toHaveCount(0);
});
