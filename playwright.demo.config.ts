// Read-only production acceptance uses the promoted public fixture and leaves the private filesystem flow separate.
import { defineConfig } from "@playwright/test";

if (process.env.EEEVP_DEMO_PHASE !== "readonly")
  throw new Error(
    "The public-demo suite requires readonly mode and an existing v2 receipt",
  );

export default defineConfig({
  testDir: "./tests/demo-browser",
  testMatch: [
    "**/public-demo.spec.ts",
    "**/readonly-widgets.spec.ts",
    "**/readonly-presentation.spec.ts",
    "**/decryption-activity.spec.ts",
  ],
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/public-demo-final-readonly",
  use: {
    baseURL: "http://localhost:3001",
    browserName: "chromium",
    viewport: { width: 1440, height: 1000 },
    actionTimeout: 30_000,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
