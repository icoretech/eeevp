// Accept the dedicated public demonstration key through stdin; never load a private recovery file implicitly.
import { spawn } from "node:child_process";

const phase = process.argv[2];
if (phase !== "readonly")
  throw new Error("Usage: run-public-demo.mjs readonly < public-demo-key.txt");
const pieces = [];
let length = 0;
for await (const piece of process.stdin) {
  length += piece.length;
  if (length > 8192) throw new Error("Demo key input exceeds 8 KiB");
  pieces.push(piece);
}
if (!length)
  throw new Error("Provide the dedicated public demo key through stdin");
const child = spawn(
  process.execPath,
  [
    "node_modules/playwright/cli.js",
    "test",
    "--config",
    "playwright.demo.config.ts",
    ...process.argv.slice(3),
  ],
  {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      EEEVP_DEMO_PHASE: phase,
      EEEVP_DEMO_KEY_INPUT: Buffer.concat(pieces).toString("utf8"),
    },
  },
);
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
