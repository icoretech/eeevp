// Real React/Next navigation proves native transition frames, reduced motion, Firefox fallback, and urgent key clearing.
import { expect, type Page, type Request, test } from "@playwright/test";
import {
  createLibraryDescriptor,
  createLibraryKey,
  wrapVideoKey,
} from "../../src/lib/crypto/library-crypto";
import { createVideo } from "../../src/lib/crypto/video-crypto";

type MotionReceipt = {
  types: string[];
  ready: boolean;
  finished: boolean;
  error: string | null;
  rootName: string | null;
  animations: { name: string; duration: string; delay: number }[];
};

declare global {
  interface Window {
    __eeevpMotion: {
      boot: string;
      supported: boolean;
      receipts: MotionReceipt[];
    };
  }
}

async function observeMotion(page: Page, disable = false) {
  await page.addInitScript((withoutNativeApi) => {
    const native = document.startViewTransition;
    window.__eeevpMotion = {
      boot: crypto.randomUUID(),
      supported: typeof native === "function" && !withoutNativeApi,
      receipts: [],
    };
    if (withoutNativeApi) {
      Object.defineProperty(document, "startViewTransition", {
        configurable: true,
        value: undefined,
      });
      return;
    }
    if (typeof native !== "function") return;
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value(...args: Parameters<Document["startViewTransition"]>) {
        const options = args[0];
        const receipt: MotionReceipt = {
          types:
            options && typeof options === "object"
              ? Array.from(options.types ?? [])
              : [],
          ready: false,
          finished: false,
          error: null,
          rootName: null,
          animations: [],
        };
        window.__eeevpMotion.receipts.push(receipt);
        const transition = native.apply(document, args);
        void transition.ready.then(
          () => {
            receipt.ready = true;
            receipt.rootName = getComputedStyle(
              document.documentElement,
            ).viewTransitionName;
            receipt.animations = document
              .getAnimations()
              .filter((animation) => animation instanceof CSSAnimation)
              .filter(
                (animation) =>
                  animation.effect instanceof KeyframeEffect &&
                  animation.effect.pseudoElement?.includes("view-transition"),
              )
              .map((animation) => ({
                name: animation.animationName,
                duration: String(animation.effect?.getTiming().duration ?? 0),
                delay: animation.effect?.getTiming().delay ?? 0,
              }));
          },
          (failure: Error) => {
            receipt.error = failure.name;
          },
        );
        void transition.finished.then(
          () => {
            receipt.finished = true;
          },
          () => {},
        );
        return transition;
      },
    });
  }, disable);
}

async function prepareSyntheticLibrary(page: Page) {
  const key = createLibraryKey();
  const library = await createLibraryDescriptor(key);
  const videos = await Promise.all(
    ["first-video.webm", "second-video.webm"].map(async (name) => {
      const source = await createVideo(
        new File([new Uint8Array([1, 2, 3, 4])], name, {
          type: "video/webm",
        }),
      );
      return {
        manifest: source.manifest,
        libraryId: library.id,
        wrappedKey: await wrapVideoKey(
          source.manifest,
          source.credentials.key,
          key,
          library.id,
        ),
        createdAt: "2026-01-01T12:00:00.000Z",
      };
    }),
  );
  let sessionRequests = 0;
  const manifests = Promise.withResolvers<void>();
  await page.route("**/api/session", async (route) => {
    if (route.request().method() === "POST") sessionRequests += 1;
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
  await page.route("**/api/videos", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ videos }),
    });
  });
  await page.route(/\/api\/videos\/[\da-f-]+$/, async (route) => {
    await manifests.promise;
    await route
      .fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "Synthetic playback was cancelled" }),
      })
      .catch(() => {});
  });
  await page.goto("/");
  return {
    id: videos[0].manifest.id,
    sessionRequests: () => sessionRequests,
    release: () => manifests.resolve(),
    async enter(input = key) {
      await page.getByLabel("Encryption key", { exact: true }).fill(input);
      await page
        .getByRole("button", { name: "Decrypt & Login", exact: true })
        .click();
    },
  };
}

async function openSyntheticLibrary(page: Page) {
  const fixture = await prepareSyntheticLibrary(page);
  await fixture.enter();
  await expect(
    page.getByText("first-video.webm", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("second-video.webm", { exact: true }),
  ).toBeVisible();
  return fixture;
}

function recordErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      errors.push(`${message.type()}: ${message.text()}`);
  });
  return errors;
}

test.afterEach(async ({ page }, info) => {
  if (info.status !== "passed") {
    console.log(
      "native-motion-failure",
      JSON.stringify(await page.evaluate(() => window.__eeevpMotion ?? null)),
    );
  }
  await info.attach("native-motion-receipts", {
    contentType: "application/json",
    body: JSON.stringify(
      await page.evaluate(() => window.__eeevpMotion ?? null),
    ),
  });
});

test("login visibly staggers the workspace and encrypted catalog without capturing key entry", async ({
  page,
}) => {
  const errors = recordErrors(page);
  await observeMotion(page);
  const fixture = await prepareSyntheticLibrary(page);
  try {
    expect(
      await page
        .getByLabel("Encryption key", { exact: true })
        .evaluate((element) => ({
          name: getComputedStyle(element).viewTransitionName,
          root: getComputedStyle(document.documentElement).viewTransitionName,
          animations: document
            .getAnimations()
            .filter((animation) => animation instanceof CSSAnimation)
            .map((animation) => animation.animationName),
        })),
    ).toEqual({ name: "none", root: "none", animations: [] });
    await fixture.enter();
    await expect(
      page.getByText("first-video.webm", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__eeevpMotion.receipts.some(
            (receipt) =>
              receipt.ready &&
              receipt.types.includes("library-open") &&
              receipt.animations.some(
                (animation) => animation.name === "workspace-heading-arrive",
              ) &&
              receipt.animations.filter(
                (animation) => animation.name === "workspace-panel-arrive",
              ).length === 1,
          ),
        ),
      )
      .toBe(true);
    const opening = await page.evaluate(() =>
      window.__eeevpMotion.receipts.find(
        (receipt) => receipt.ready && receipt.types.includes("library-open"),
      ),
    );
    expect(opening?.rootName).toBe("none");
    expect(
      opening?.animations
        .filter((animation) => animation.name === "workspace-panel-arrive")
        .map((animation) => animation.delay)
        .sort((left, right) => left - right),
    ).toEqual([65]);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__eeevpMotion.receipts.some(
            (receipt) =>
              receipt.ready &&
              receipt.types.includes("catalog-reveal") &&
              receipt.animations.some(
                (animation) => animation.name === "workspace-arrive",
              ),
          ),
        ),
      )
      .toBe(true);
    expect(errors).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("locking during login entrance immediately cancels every decrypted snapshot and allows another login", async ({
  page,
}) => {
  const errors = recordErrors(page);
  await observeMotion(page);
  const fixture = await prepareSyntheticLibrary(page);
  try {
    const prolonged = await page.addStyleTag({
      content:
        "::view-transition-new(.workspace-heading), ::view-transition-new(.workspace-panels) { animation-duration: 8s; }",
    });
    await fixture.enter();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__eeevpMotion.receipts.some(
            (receipt) =>
              receipt.ready &&
              !receipt.finished &&
              receipt.types.includes("library-open"),
          ),
        ),
      )
      .toBe(true);
    await page
      .getByRole("button", { name: "Lock library", exact: true })
      .click();
    await expect(
      page.getByLabel("Encryption key", { exact: true }),
    ).toBeVisible({ timeout: 1500 });
    await expect(
      page.locator(".motion-page, .motion-catalog-item, video"),
    ).toHaveCount(0);
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            window.__eeevpMotion.receipts
              .filter((receipt) => receipt.ready)
              .every((receipt) => receipt.finished),
          ),
        { timeout: 1500 },
      )
      .toBe(true);
    await prolonged.evaluate((element) =>
      element.parentNode?.removeChild(element),
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await fixture.enter();
    await expect(
      page.getByText("first-video.webm", { exact: true }),
    ).toBeVisible();
    expect(fixture.sessionRequests()).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("wrong key text still receives the workspace entrance and only opaque encrypted records", async ({
  page,
}) => {
  const errors = recordErrors(page);
  await observeMotion(page);
  const fixture = await prepareSyntheticLibrary(page);
  try {
    await fixture.enter("sample-wrong-key");
    await expect(page.getByText("Library open", { exact: true })).toBeVisible();
    await expect(page.locator(".catalog-card")).toHaveCount(2);
    await expect(
      page.getByText("first-video.webm", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("second-video.webm", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Watch video", exact: true }).first(),
    ).toBeDisabled();
    expect(
      await page.evaluate(() =>
        window.__eeevpMotion.receipts.some(
          (receipt) => receipt.ready && receipt.types.includes("library-open"),
        ),
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("native App Router transitions animate forward/back and deferred catalog search without reloading the key", async ({
  page,
}) => {
  const errors = recordErrors(page);
  await observeMotion(page);
  const fixture = await openSyntheticLibrary(page);
  try {
    expect(await page.evaluate(() => window.__eeevpMotion.supported)).toBe(
      true,
    );
    const boot = await page.evaluate(() => window.__eeevpMotion.boot);
    const header = page.getByRole("banner");
    const headerPosition = await header.boundingBox();
    await header.evaluate((element) => {
      element.setAttribute("data-motion-test-identity", "persistent-header");
    });
    await page.getByRole("contentinfo").evaluate((element) => {
      element.setAttribute("data-motion-test-identity", "persistent-footer");
    });
    await page
      .getByRole("button", { name: "Watch video", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(`/watch/${fixture.id}`);
    await expect(
      page.getByRole("heading", { name: "Opening your video", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__eeevpMotion.receipts.some(
            (receipt) =>
              receipt.ready &&
              receipt.types.includes("nav-forward") &&
              receipt.animations.some(
                (animation) =>
                  animation.name === "page-arrive-forward" &&
                  Number(animation.duration) > 0,
              ),
          ),
        ),
      )
      .toBe(true);
    await expect(header).toHaveAttribute(
      "data-motion-test-identity",
      "persistent-header",
    );
    expect(await header.boundingBox()).toEqual(headerPosition);
    await expect(page.getByRole("contentinfo")).toHaveAttribute(
      "data-motion-test-identity",
      "persistent-footer",
    );
    await page
      .locator(".player-toolbar")
      .getByRole("button", { name: "Video library", exact: true })
      .click();
    await expect(page).toHaveURL("/");
    await expect(
      page.getByText("first-video.webm", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__eeevpMotion.receipts.some(
            (receipt) =>
              receipt.ready &&
              receipt.types.includes("nav-back") &&
              receipt.animations.some(
                (animation) => animation.name === "page-arrive-back",
              ),
          ),
        ),
      )
      .toBe(true);
    const search = page.getByRole("searchbox", {
      name: "Search videos",
      exact: true,
    });
    await search.fill("first");
    await expect(
      page.getByText("second-video.webm", { exact: true }),
    ).toHaveCount(0);
    await expect(search).toBeFocused();
    await search.clear();
    await expect(
      page.getByText("second-video.webm", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__eeevpMotion.receipts.some(
            (receipt) =>
              receipt.ready &&
              receipt.animations.some(
                (animation) => animation.name === "workspace-arrive",
              ),
          ),
        ),
      )
      .toBe(true);
    expect(await page.evaluate(() => window.__eeevpMotion.boot)).toBe(boot);
    expect(fixture.sessionRequests()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("the active header library link is inert while returning from Watch still navigates and animates", async ({
  page,
}) => {
  const errors = recordErrors(page);
  await observeMotion(page);
  await page.setViewportSize({ width: 1440, height: 600 });
  const fixture = await openSyntheticLibrary(page);
  try {
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__eeevpMotion.receipts.every((receipt) => receipt.finished),
        ),
      )
      .toBe(true);
    await page.waitForLoadState("networkidle");
    const headerLink = page
      .getByRole("navigation", { name: "Library navigation", exact: true })
      .getByRole("button", { name: "Video library", exact: true });
    await expect(headerLink).toHaveAttribute("aria-current", "page");
    await page.evaluate(() => window.scrollTo(0, 24));
    const before = await page.evaluate(() => ({
      boot: window.__eeevpMotion.boot,
      transitions: window.__eeevpMotion.receipts.length,
      scrollY: window.scrollY,
      url: window.location.href,
    }));
    expect(before.scrollY).toBe(24);
    const unexpected: string[] = [];
    const observeNavigation = (request: Request) => {
      const url = new URL(request.url());
      if (
        request.isNavigationRequest() ||
        request.headers().rsc === "1" ||
        url.searchParams.has("_rsc") ||
        url.pathname.startsWith("/api/")
      )
        unexpected.push(`${request.method()} ${url.pathname}`);
    };
    page.on("request", observeNavigation);
    try {
      await headerLink.click();
      await page.waitForLoadState("networkidle");
      expect(
        await page.evaluate(() => ({
          boot: window.__eeevpMotion.boot,
          transitions: window.__eeevpMotion.receipts.length,
          scrollY: window.scrollY,
          url: window.location.href,
        })),
      ).toEqual(before);
      expect(unexpected).toEqual([]);
    } finally {
      page.off("request", observeNavigation);
    }
    await expect(
      page.getByText("first-video.webm", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("second-video.webm", { exact: true }),
    ).toBeVisible();
    expect(fixture.sessionRequests()).toBe(1);

    const opened = page.context().waitForEvent("page", { timeout: 5000 });
    await headerLink.click({ modifiers: ["ControlOrMeta"] });
    const newTab = await opened;
    try {
      await expect(newTab).toHaveURL("/");
      await expect(
        newTab.getByLabel("Encryption key", { exact: true }),
      ).toBeVisible();
    } finally {
      await newTab.close();
    }
    expect(
      await page.evaluate(() => window.__eeevpMotion.receipts.length),
    ).toBe(before.transitions);

    await page
      .getByRole("button", { name: "Watch video", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(`/watch/${fixture.id}`);
    await expect(headerLink).not.toHaveAttribute("aria-current");
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__eeevpMotion.receipts.some(
            (receipt) =>
              receipt.ready &&
              receipt.finished &&
              receipt.types.includes("nav-forward"),
          ),
        ),
      )
      .toBe(true);
    await headerLink.click();
    await expect(page).toHaveURL("/");
    await expect(headerLink).toHaveAttribute("aria-current", "page");
    await expect(
      page.getByText("first-video.webm", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__eeevpMotion.receipts.some(
            (receipt) =>
              receipt.ready &&
              receipt.types.includes("nav-back") &&
              receipt.animations.some(
                (animation) => animation.name === "page-arrive-back",
              ),
          ),
        ),
      )
      .toBe(true);
    expect(await page.evaluate(() => window.__eeevpMotion.boot)).toBe(
      before.boot,
    );
    expect(fixture.sessionRequests()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("reduced motion removes native movement and delays while navigation stays usable", async ({
  page,
}) => {
  const errors = recordErrors(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await observeMotion(page);
  const fixture = await openSyntheticLibrary(page);
  try {
    const opening = await page.evaluate(() =>
      window.__eeevpMotion.receipts.find(
        (receipt) => receipt.ready && receipt.types.includes("library-open"),
      ),
    );
    expect(opening?.rootName).toBe("none");
    expect(
      opening?.animations.every(
        (animation) =>
          Number(animation.duration) === 0 && animation.delay === 0,
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Watch video", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(`/watch/${fixture.id}`);
    await expect(
      page.getByRole("heading", { name: "Opening your video", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__eeevpMotion.receipts.some(
            (receipt) => receipt.ready && receipt.types.includes("nav-forward"),
          ),
        ),
      )
      .toBe(true);
    const motion = await page.evaluate(() => ({
      duration: getComputedStyle(
        document.documentElement,
        "::view-transition-group(root)",
      ).animationDuration,
      delay: getComputedStyle(
        document.documentElement,
        "::view-transition-group(root)",
      ).animationDelay,
    }));
    expect(motion).toEqual({ duration: "0s", delay: "0s" });
    await page
      .locator(".player-toolbar")
      .getByRole("button", { name: "Video library", exact: true })
      .click();
    await expect(
      page.getByText("first-video.webm", { exact: true }),
    ).toBeVisible();
    expect(fixture.sessionRequests()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("locking interrupts an active route animation immediately and drops the decrypted workspace", async ({
  page,
}) => {
  const errors = recordErrors(page);
  await observeMotion(page);
  const fixture = await openSyntheticLibrary(page);
  try {
    await page.addStyleTag({ content: ":root { --motion-duration: 8s; }" });
    await page
      .getByRole("button", { name: "Watch video", exact: true })
      .first()
      .click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__eeevpMotion.receipts.some(
            (receipt) =>
              receipt.ready &&
              !receipt.finished &&
              receipt.types.includes("nav-forward"),
          ),
        ),
      )
      .toBe(true);
    await page
      .getByRole("button", { name: "Lock library", exact: true })
      .click();
    await expect(
      page.getByLabel("Encryption key", { exact: true }),
    ).toBeVisible({ timeout: 1500 });
    await expect(
      page.getByRole("heading", { name: "Opening your video", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.locator(".motion-page, .motion-catalog-item, video"),
    ).toHaveCount(0);
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            window.__eeevpMotion.receipts
              .filter((receipt) => receipt.ready)
              .every((receipt) => receipt.finished),
          ),
        { timeout: 1500 },
      )
      .toBe(true);
    expect(errors).toEqual([]);
  } finally {
    fixture.release();
  }
});

test("Firefox keeps same-tab navigation, catalog search, and key clearing without the native API", async ({
  playwright,
  baseURL,
}) => {
  const browser = await playwright.firefox.launch();
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const errors = recordErrors(page);
  await observeMotion(page, true);
  const fixture = await openSyntheticLibrary(page);
  try {
    const boot = await page.evaluate(() => window.__eeevpMotion.boot);
    await page
      .getByRole("button", { name: "Watch video", exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(`/watch/${fixture.id}`);
    await expect(
      page.getByRole("heading", { name: "Opening your video", exact: true }),
    ).toBeVisible();
    await page
      .locator(".player-toolbar")
      .getByRole("button", { name: "Video library", exact: true })
      .click();
    await expect(
      page.getByText("first-video.webm", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("searchbox", { name: "Search videos", exact: true })
      .fill("second");
    await expect(
      page.getByText("first-video.webm", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText("second-video.webm", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Lock library", exact: true })
      .click();
    await expect(
      page.getByLabel("Encryption key", { exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => window.__eeevpMotion.boot)).toBe(boot);
    expect(await page.evaluate(() => window.__eeevpMotion.receipts)).toEqual(
      [],
    );
    expect(fixture.sessionRequests()).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    fixture.release();
    await browser.close();
  }
});
