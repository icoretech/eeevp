// Build the browser Service Worker as a static same-origin script for Next.js.
import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("public", { recursive: true });
await build({
  entryPoints: ["src/workers/playback-sw.ts"],
  outfile: "public/eeevp-sw.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: false,
  legalComments: "none",
});
