// Pass a locally held recovery file to the browser test process through stdin, never an on-disk server copy.
import { spawn } from "node:child_process";

const parts = [];
let length = 0;
for await (const part of process.stdin) {
  length += part.length;
  if (length > 8192) throw new Error("Recovery input exceeds 8 KiB");
  parts.push(part);
}
if (length === 0)
  throw new Error("Provide the existing recovery file through stdin");
const recoveryText = Buffer.concat(parts).toString("utf8");
const child = spawn(
  process.execPath,
  ["node_modules/playwright/cli.js", "test", ...process.argv.slice(2)],
  {
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, EEEVP_BROWSER_RECOVERY_TEXT: recoveryText },
  },
);
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
