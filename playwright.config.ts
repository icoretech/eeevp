// Real Chromium acceptance runs against the existing Compose application.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  outputDir: "test-results/browser-acceptance",
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000",
    browserName: "chromium",
    actionTimeout: 20_000,
    viewport: { width: 1440, height: 1000 },
    // Traces can include authentication material: retain only explicit, masked evidence.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
