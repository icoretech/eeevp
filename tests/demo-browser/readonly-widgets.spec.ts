// The real public-demo app must keep read widgets useful while DOM bypass attempts cannot start mutations or workers.
import { expect, test } from "@playwright/test";

test("prefills the public demo key and keeps upload/deletion read-only even after disabled DOM attributes are removed", async ({
  page,
}) => {
  const mutations: string[] = [];
  await page.addInitScript(() => {
    let starts = 0;
    window.Worker = new Proxy(window.Worker, {
      construct(target, args, newTarget) {
        starts += 1;
        return Reflect.construct(target, args, newTarget);
      },
    });
    Object.defineProperty(window, "eeevpTestWorkerStarts", {
      get: () => starts,
    });
  });
  await page.route(/\/api\/(videos|library)(?:\/|$)/, async (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) {
      mutations.push(
        `${route.request().method()} ${new URL(route.request().url()).pathname}`,
      );
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "Read-only demo" }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/");
  const keyInput = page.getByLabel("Encryption key", { exact: true });
  await expect(keyInput).not.toHaveValue("");
  await expect(keyInput).toBeEditable();
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  await expect(page.getByText("Library open", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Read-only demo. Uploads are disabled.", { exact: true }),
  ).toBeVisible();
  const chooser = page.getByLabel("Choose your video", { exact: true });
  const encrypt = page.getByRole("button", {
    name: "Encrypt & upload",
    exact: true,
  });
  await expect(chooser).toBeDisabled();
  await expect(encrypt).toBeDisabled();
  const firstCard = page.locator(".catalog-card").first();
  await expect(firstCard).toBeVisible();
  const title = await firstCard.locator('[data-slot="card-title"]').innerText();
  await page.getByLabel("Search videos", { exact: true }).fill(title);
  await expect(firstCard).toBeVisible();
  await page.getByLabel("Search videos", { exact: true }).clear();
  const deletion = firstCard.getByRole("button", { name: /^Delete / });
  await expect(deletion).toBeDisabled();

  await chooser.evaluate((element) => element.removeAttribute("disabled"));
  await chooser.setInputFiles({
    name: "sample-video.webm",
    mimeType: "video/webm",
    buffer: Buffer.from([1, 2, 3]),
  });
  for (const control of [encrypt, deletion]) {
    await control.evaluate((element) => {
      element.removeAttribute("disabled");
      element.removeAttribute("aria-disabled");
      if (element instanceof HTMLButtonElement) element.click();
    });
  }
  await page.waitForLoadState("networkidle");

  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(mutations).toEqual([]);
  expect(
    await page.evaluate(() =>
      Number(Reflect.get(window, "eeevpTestWorkerStarts")),
    ),
  ).toBe(0);
});
