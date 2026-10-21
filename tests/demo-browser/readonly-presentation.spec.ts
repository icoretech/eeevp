// Public-demo presentation checks use actual rendered geometry and accessible feedback at the reported desktop and mobile sizes.
import { expect, type Page, test } from "@playwright/test";

async function presentationGeometry(page: Page) {
  const header = page.locator(".app-header");
  const brand = await header.locator(".brand").boundingBox();
  const storage = await header.locator(".header-storage").boundingBox();
  const navigation = await header.locator(".library-navigation").boundingBox();
  if (!brand || !storage || !navigation)
    throw new Error("The header layout is missing.");
  expect(brand.x + brand.width).toBeLessThanOrEqual(storage.x);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("The presentation viewport is missing.");
  if (viewport.width <= 760)
    expect(navigation.y).toBeGreaterThanOrEqual(storage.y + storage.height);
  else expect(storage.x + storage.width).toBeLessThanOrEqual(navigation.x);
  if (await header.locator(".brand-label").isVisible()) {
    const concept = await header.locator(".brand-label").boundingBox();
    if (!concept) throw new Error("The streaming concept label is missing.");
    expect(concept.x + concept.width).toBeLessThanOrEqual(storage.x);
    await expect(header.locator(".brand-label")).toHaveText(
      "Zero-trust streaming concept",
    );
  }
  const security = page.locator(".upload-security-note");
  const footer = page.locator("#upload [data-slot=card-footer]");
  await expect(security).toHaveCSS("align-items", "center");
  const note = await security.boundingBox();
  const icon = await security.locator("svg").boundingBox();
  const text = await security.locator(":scope > span").boundingBox();
  const footerBox = await footer.boundingBox();
  if (!note || !icon || !text || !footerBox)
    throw new Error("Upload security note geometry is missing");
  expect(
    Math.abs(icon.y + icon.height / 2 - (text.y + text.height / 2)),
  ).toBeLessThanOrEqual(2);
  expect(note.x - footerBox.x).toBeGreaterThanOrEqual(15);
  expect(note.y - footerBox.y).toBeGreaterThanOrEqual(15);
  expect(
    footerBox.y + footerBox.height - note.y - note.height,
  ).toBeGreaterThanOrEqual(15);
  const lineHeight = Number.parseFloat(
    await security.evaluate((element) => getComputedStyle(element).lineHeight),
  );
  expect(Math.abs(text.height - lineHeight * 2)).toBeLessThanOrEqual(2);

  const card = page.locator(".catalog-card").first();
  const cardHeader = card.locator('[data-slot="card-header"]');
  const title = await cardHeader
    .locator('[data-slot="card-title"]')
    .boundingBox();
  const badge = await cardHeader
    .locator('[data-slot="card-action"] [data-slot="badge"]')
    .boundingBox();
  const headerBox = await cardHeader.boundingBox();
  if (!title || !badge || !headerBox)
    throw new Error("Catalog title/action geometry is missing");
  const rightPadding = Number.parseFloat(
    await cardHeader.evaluate(
      (element) => getComputedStyle(element).paddingRight,
    ),
  );
  expect(
    Math.abs(
      headerBox.x + headerBox.width - rightPadding - badge.x - badge.width,
    ),
  ).toBeLessThanOrEqual(2);
  expect(Math.abs(badge.y - title.y)).toBeLessThanOrEqual(4);
  await expect(
    card.locator('[data-slot="card-content"] [data-slot="badge"]'),
  ).toHaveCount(0);

  const expansion = page.getByText("Encrypted End-to-End Video Player", {
    exact: true,
  });
  const brandSize = Number.parseFloat(
    await expansion.evaluate((element) => getComputedStyle(element).fontSize),
  );
  expect(brandSize).toBeGreaterThanOrEqual(12);
  const links = page.getByRole("navigation", {
    name: "EEEVP social links",
    exact: true,
  });
  await expect(links.getByRole("link")).toHaveCount(2);
  for (const [name, href] of [
    ["icoretech", "https://github.com/icoretech/eeevp"],
    ["@icoretech_inc", "https://x.com/icoretech_inc"],
  ] as const) {
    const link = links.getByRole("link", { name, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", href);
    await expect(link.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    expect(
      Number.parseFloat(
        await link.evaluate((element) => getComputedStyle(element).fontSize),
      ),
    ).toBeGreaterThanOrEqual(12);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

test("aligns upload security text, places the badge in the header, and gives Upload visible demo feedback", async ({
  page,
}) => {
  const mutations: string[] = [];
  await page.route(/\/api\/(videos|library)(?:\/|$)/, async (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) {
      mutations.push(route.request().method());
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: "Read-only demo" }),
      });
      return;
    }
    await route.continue();
  });
  await page.setViewportSize({ width: 1286, height: 1719 });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  const lock = page.getByRole("button", { name: "Lock library", exact: true });
  await expect(lock).toBeVisible();
  await expect(lock.locator('svg[data-icon="inline-start"]')).toHaveCount(1);
  await expect(page.locator(".catalog-card").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await presentationGeometry(page);

  const upload = page.getByRole("button", { name: "Upload", exact: true });
  await upload.click();
  const notice = page.getByRole("dialog");
  await expect(
    notice.getByRole("heading", { name: "Read-only demo", exact: true }),
  ).toBeVisible();
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
  await expect(upload).toBeFocused();
  await page.screenshot({
    path: ".omo/evidence/presentation-desktop-1286.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await presentationGeometry(page);
  await page.screenshot({
    path: ".omo/evidence/presentation-mobile-390.png",
    fullPage: true,
  });
  expect(mutations).toEqual([]);
});
