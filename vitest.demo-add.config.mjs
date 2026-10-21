// Explicit administrative actions have their own opt-in test harness; ordinary tests never discover them.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(
        new URL("./node_modules/server-only/empty.js", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/demo-operator/add-sample.test.ts"],
    environment: "node",
    testTimeout: 300_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
});
