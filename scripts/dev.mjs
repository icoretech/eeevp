// Keep the generated Service Worker in sync while Next.js reloads application code.
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { context } from "esbuild";

await mkdir("public", { recursive: true });
const worker = await context({
  entryPoints: ["src/workers/playback-sw.ts"],
  outfile: "public/eeevp-sw.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: false,
});
await worker.rebuild();
await worker.watch();
const next = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", "--hostname", "0.0.0.0"],
  { stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => next.kill(signal));
}
next.once("exit", async (code) => {
  await worker.dispose();
  process.exitCode = code ?? 1;
});
