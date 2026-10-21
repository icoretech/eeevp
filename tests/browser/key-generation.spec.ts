// Fresh browser contexts exercise local recovery-key downloads through the real gate with only API transport adapted.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { normalizeLibraryKeyInput } from "../../src/lib/crypto/key-input";
import {
  createLibraryDescriptor,
  createLibraryKey,
  verifyLibraryKey,
  wrapVideoKey,
} from "../../src/lib/crypto/library-crypto";
import { createVideo } from "../../src/lib/crypto/video-crypto";
import {
  credentialsSchema,
  type LibraryDescriptor,
  type LibraryVideo,
  libraryDescriptorSchema,
} from "../../src/lib/video/schema";

async function libraryTransport(
  page: Page,
  library: LibraryDescriptor | null,
  videos: LibraryVideo[] = [],
) {
  const state = {
    library,
    requests: [] as Array<{
      path: string;
      method: string;
      body: string | null;
    }>,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    state.requests.push({ path, method, body: request.postData() });
    if (path === "/api/session") {
      if (method === "POST") expect(request.postDataJSON()).toEqual({});
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ authenticated: method === "POST" }),
      });
      return;
    }
    if (path === "/api/library") {
      if (method === "POST") {
        if (state.library) {
          await route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ error: "Library already exists" }),
          });
          return;
        }
        state.library = libraryDescriptorSchema.parse(request.postDataJSON());
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ library: state.library }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ library: state.library }),
      });
      return;
    }
    if (path === "/api/videos" && method === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ videos }),
      });
      return;
    }
    await route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "Unexpected mutation" }),
    });
  });
  return state;
}

async function openAdvancedKeyTools(page: Page) {
  const advanced = page.getByRole("button", {
    name: "Advanced key tools",
    exact: true,
  });
  await expect(advanced).toHaveAttribute("aria-expanded", "false");
  await expect(
    page.getByLabel("Import .txt recovery file", { exact: true }),
  ).toBeHidden();
  await expect(
    page.getByRole("button", {
      name: "Generate a new library key",
      exact: true,
    }),
  ).toBeHidden();
  await advanced.click();
  await expect(advanced).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByLabel("Import .txt recovery file", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Generate a new library key",
      exact: true,
    }),
  ).toBeVisible();
  return advanced;
}

test("private key generation downloads a usable recovery file without entering or contacting the server", async ({
  page,
}) => {
  test.skip(
    process.env.DEMO_MODE !== "false",
    "Requires the coordinated private-mode preview.",
  );
  const state = await libraryTransport(page, null);
  const revokedUrls: string[] = [];
  await page.exposeFunction("observeRecoveryUrlRevocation", (url: string) => {
    revokedUrls.push(url);
  });
  // Observe cleanup without replacing the browser's native Blob URL lifecycle.
  await page.addInitScript(() => {
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => {
      revoke(url);
      const observer = window as Window & {
        observeRecoveryUrlRevocation?: (value: string) => Promise<void>;
      };
      if (!observer.observeRecoveryUrlRevocation)
        throw new Error("Recovery URL observer was not installed");
      void observer.observeRecoveryUrlRevocation(url);
    };
  });
  const directory = await mkdtemp(join(tmpdir(), "eeevp-generated-key-"));
  try {
    await page.goto("/");
    const input = page.getByLabel("Encryption key", { exact: true });
    await expect(input).toHaveValue("");
    await page.waitForLoadState("networkidle");
    expect(state.requests).toEqual([]);
    const advanced = await openAdvancedKeyTools(page);

    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Generate a new library key", exact: true })
      .click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe("eeevp-library-key.txt");
    expect(download.url()).toMatch(/^blob:/);
    const path = join(directory, "owned-generated-recovery.txt");
    await download.saveAs(path);
    const text = await readFile(path, "utf8");
    const key = normalizeLibraryKeyInput(text);
    expect(download.url()).not.toContain(key);
    await expect.poll(() => revokedUrls.includes(download.url())).toBe(true);
    expect(credentialsSchema.shape.key.parse(key)).toBe(key);
    await expect(input).toHaveValue(key);
    await expect(
      page.getByRole("button", { name: "Decrypt & Login", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Lock library", exact: true }),
    ).toHaveCount(0);
    expect(state.requests).toEqual([]);
    expect(state.library).toBeNull();
    await advanced.click();
    await expect(advanced).toHaveAttribute("aria-expanded", "false");
    await expect(input).toHaveValue(key);
    await advanced.click();

    await input.fill("");
    await page
      .getByLabel("Import .txt recovery file", { exact: true })
      .setInputFiles(path);
    await expect(input).toHaveValue(key);
    expect(state.requests).toEqual([]);
    await page
      .getByRole("button", { name: "Decrypt & Login", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Lock library", exact: true }),
    ).toBeVisible();
    const library = state.library;
    if (!library)
      throw new Error(
        "Explicit entry did not create the new encrypted library.",
      );
    await verifyLibraryKey(library, key);
    expect(
      state.requests.filter((request) => request.path === "/api/session"),
    ).toEqual([{ path: "/api/session", method: "POST", body: "{}" }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generating a different private key cannot replace an existing library or decrypt its video", async ({
  page,
}) => {
  test.skip(
    process.env.DEMO_MODE !== "false",
    "Requires the coordinated private-mode preview.",
  );
  const originalKey = createLibraryKey();
  const library = await createLibraryDescriptor(originalKey);
  const fixture = await createVideo(
    new File(["sample-video-bytes"], "sample-video.webm", {
      type: "video/webm",
    }),
  );
  const video = {
    manifest: fixture.manifest,
    libraryId: library.id,
    wrappedKey: await wrapVideoKey(
      fixture.manifest,
      fixture.credentials.key,
      originalKey,
      library.id,
    ),
    createdAt: "2026-01-01T12:00:00.000Z",
  };
  const state = await libraryTransport(page, library, [video]);
  await page.goto("/");
  await openAdvancedKeyTools(page);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Generate a new library key", exact: true })
    .click();
  await downloaded;
  const input = page.getByLabel("Encryption key", { exact: true });
  expect(await input.inputValue()).not.toBe(originalKey);
  expect(state.requests).toEqual([]);
  expect(state.library).toEqual(library);
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Lock library", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Encrypted metadata", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Watch video", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText(fixture.metadata.name, { exact: true }),
  ).toHaveCount(0);
  expect(state.library).toEqual(library);
  expect(
    state.requests.some(
      (request) => request.path === "/api/library" && request.method === "POST",
    ),
  ).toBe(false);
});

test("demo prefill is restored after lock and reload while arbitrary edits still open opaque records", async ({
  page,
}) => {
  test.skip(
    process.env.DEMO_MODE !== "true",
    "Requires the coordinated public-demo preview.",
  );
  const videos: LibraryVideo[] = [];
  const state = await libraryTransport(page, null, videos);
  let downloads = 0;
  page.on("download", () => {
    downloads += 1;
  });
  await page.goto("/");
  const input = page.getByLabel("Encryption key", { exact: true });
  await expect(input).not.toHaveValue("");
  const publicKey = credentialsSchema.shape.key.parse(await input.inputValue());
  const library = await createLibraryDescriptor(publicKey);
  const fixture = await createVideo(
    new File(["sample-video-bytes"], "sample-video.webm", {
      type: "video/webm",
    }),
  );
  const video = {
    manifest: fixture.manifest,
    libraryId: library.id,
    wrappedKey: await wrapVideoKey(
      fixture.manifest,
      fixture.credentials.key,
      publicKey,
      library.id,
    ),
    createdAt: "2026-01-01T12:00:00.000Z",
  };
  state.library = library;
  videos.push(video);
  await expect(
    page.getByRole("button", {
      name: "Generate a new library key",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Import .txt recovery file", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Advanced key tools", exact: true }),
  ).toHaveCount(0);
  expect(state.requests).toEqual([]);
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  await expect(
    page.getByText(fixture.metadata.name, { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Lock library", exact: true }).click();
  await expect(input).toHaveValue(publicKey);
  await input.fill("arbitrary-nonempty-key");
  await page
    .getByRole("button", { name: "Decrypt & Login", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Lock library", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Encrypted metadata", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Watch video", exact: true }),
  ).toBeDisabled();
  await page.reload();
  await expect(input).toHaveValue(publicKey);
  await expect(
    page.getByRole("button", {
      name: "Generate a new library key",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Import .txt recovery file", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Advanced key tools", exact: true }),
  ).toHaveCount(0);
  expect(downloads).toBe(0);
  expect(
    state.requests
      .filter(
        (request) =>
          request.path === "/api/session" && request.method === "POST",
      )
      .every((request) => request.body === "{}"),
  ).toBe(true);
  expect(
    state.requests.some(
      (request) => request.path !== "/api/session" && request.method !== "GET",
    ),
  ).toBe(false);
});
