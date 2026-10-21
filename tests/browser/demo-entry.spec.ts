// The public demo prefills its intentional public key and never initializes missing library state.
import { expect, test } from "@playwright/test";
import {
  createLibraryDescriptor,
  createLibraryKey,
} from "../../src/lib/crypto/library-crypto";
import { credentialsSchema } from "../../src/lib/video/schema";

test.beforeEach(() => {
  test.skip(process.env.DEMO_MODE !== "true", "Requires a demo-mode runtime.");
});

test("prefills a valid public demo key without offering private-key generation", async ({
  page,
}) => {
  await page.goto("/");
  const input = page.getByLabel("Encryption key", { exact: true });

  await expect(input).not.toHaveValue("");
  expect(
    credentialsSchema.shape.key.safeParse(await input.inputValue()).success,
  ).toBe(true);
  await expect(
    page.getByRole("button", {
      name: "Generate a new library key",
      exact: true,
    }),
  ).toHaveCount(0);
});

test("reports a missing demo descriptor without attempting initialization on entry or retry", async ({
  page,
}) => {
  const mutations: string[] = [];
  let descriptorReads = 0;
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
    if (route.request().method() !== "GET") {
      mutations.push(route.request().method());
      await route.fulfill({ status: 403 });
      return;
    }
    descriptorReads += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ library: null }),
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
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();

  const unavailable = page.getByText(
    "The demo library has not been initialized. Please try again later.",
    { exact: true },
  );
  await expect(unavailable).toBeVisible();
  await page
    .getByRole("button", { name: "Refresh library", exact: true })
    .click();
  await expect.poll(() => descriptorReads).toBe(2);
  await expect(unavailable).toBeVisible();
  expect(sessionBody).toBe("{}");
  expect(mutations).toEqual([]);
});

test("describes the demo playback key as public and its library as read-only", async ({
  page,
}) => {
  const library = await createLibraryDescriptor(createLibraryKey());
  const id = crypto.randomUUID();
  await page.route("**/api/session", async (route) => {
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
      body: JSON.stringify({ library }),
    });
  });
  await page.route(`**/api/videos/${id}`, async (route) => {
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Video is temporarily unavailable" }),
    });
  });

  await page.goto(`/watch/${id}`);
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();

  await expect(
    page.getByText(
      "This demo key is public. Decryption happens in your browser.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Demo video player", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Upload", exact: true }).click();
  const notice = page.getByRole("dialog", {
    name: "Read-only demo",
    exact: true,
  });
  await expect(notice).toBeVisible();
  await expect(
    notice.getByText(
      "Uploads are disabled in this public demo. You can browse and play the sample videos.",
      { exact: true },
    ),
  ).toBeVisible();
  await notice
    .getByRole("button", { name: "Continue browsing", exact: true })
    .click();
  await expect(notice).toHaveCount(0);
  await expect(
    page.getByText("Your library stays private", { exact: true }),
  ).toHaveCount(0);
});
