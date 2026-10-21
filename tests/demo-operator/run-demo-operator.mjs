// A privileged local operator receives only the intentional public demo key through stdin and requires an explicit action.
import { spawn } from "node:child_process";

const action = process.argv[2];
if (action !== "publish" && action !== "retire")
  throw new Error("Choose publish or retire explicitly");
let length = 0;
const pieces = [];
for await (const piece of process.stdin) {
  length += piece.length;
  if (length > 8192) throw new Error("Public key input exceeds 8 KiB");
  pieces.push(piece);
}
if (!length)
  throw new Error("Pass the dedicated public demo key through stdin");
const child = spawn(
  "yarn",
  ["vitest", "run", "--config", "vitest.demo-operator.config.mjs"],
  {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      EEEVP_DEMO_OPERATOR_ACTION: action,
      EEEVP_DEMO_OPERATOR_KEY_INPUT: Buffer.concat(pieces).toString("utf8"),
    },
  },
);
child.on("error", () => {
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
