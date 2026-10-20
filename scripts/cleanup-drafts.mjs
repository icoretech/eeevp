// Operator maintenance for abandoned encrypted uploads; run with uploads stopped before using --apply.
import { lstat, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const help = `Usage: STORAGE_PATH=/absolute/storage node scripts/cleanup-drafts.mjs [--apply] [--older-than-hours 24]

Defaults to dry-run. The age must be a whole number of hours, at least 24.
Stop uploads before --apply and keep the persistent volume mounted.
Only stale UUID draft directories without a committed manifest are eligible.
Recent entries, symlinks and special files are preserved. Output contains counts only.`;

function options() {
  let apply = false;
  let age = 24;
  let ageSet = false;
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") return null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--apply" && !apply) apply = true;
    else if (argument === "--older-than-hours" && !ageSet) {
      const value = args[index + 1];
      if (!value || !/^\d+$/.test(value))
        throw new Error("Invalid cleanup options");
      age = Number(value);
      ageSet = true;
      index += 1;
    } else throw new Error("Invalid cleanup options");
  }
  if (!Number.isSafeInteger(age) || age < 24 || age > 24 * 365 * 100) {
    throw new Error(
      "Minimum age must be a whole number of hours between 24 and 876000",
    );
  }
  const storage = process.env.STORAGE_PATH;
  if (
    !storage ||
    !isAbsolute(storage) ||
    resolve(storage) === parse(storage).root
  ) {
    throw new Error(
      "STORAGE_PATH must identify an absolute persistent storage directory",
    );
  }
  return { apply, age, storage: resolve(storage) };
}

function missing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function directory(path, optional = false) {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Unsafe storage directory");
    return true;
  } catch (error) {
    if (optional && missing(error)) return false;
    throw error;
  }
}

async function inspect(path, cutoff) {
  const pending = [path];
  const fingerprint = [];
  let draft = false;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if (missing(error)) return { status: "preserved" };
      throw error;
    }
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
      return { status: "refused" };
    if (entry.mtimeMs > cutoff) return { status: "preserved" };
    fingerprint.push([
      current,
      entry.dev,
      entry.ino,
      entry.mode,
      entry.size,
      entry.mtimeMs,
      entry.ctimeMs,
    ]);
    if (entry.isDirectory()) {
      const children = await readdir(current);
      if (current === path && children.includes("manifest.json"))
        return { status: "preserved" };
      if (current === path && children.includes("draft.json")) {
        const record = await lstat(join(current, "draft.json"));
        if (!record.isFile() || record.isSymbolicLink())
          return { status: "refused" };
        draft = true;
      }
      for (const child of children) pending.push(join(current, child));
    }
  }
  if (!draft) return { status: "preserved" };
  fingerprint.sort((left, right) =>
    String(left[0]).localeCompare(String(right[0])),
  );
  return { status: "eligible", fingerprint: JSON.stringify(fingerprint) };
}

async function main() {
  const config = options();
  if (!config) {
    console.log(help);
    return;
  }
  await directory(config.storage);
  const videos = join(config.storage, "videos");
  const summary = {
    mode: config.apply ? "apply" : "dry-run",
    minimumAgeHours: config.age,
    examined: 0,
    eligible: 0,
    removed: 0,
    preserved: 0,
    refused: 0,
  };
  if (await directory(videos, true)) {
    const cutoff = Date.now() - config.age * 60 * 60 * 1000;
    for (const id of await readdir(videos)) {
      if (!uuid.test(id)) continue;
      summary.examined += 1;
      const path = join(videos, id);
      const first = await inspect(path, cutoff);
      if (first.status !== "eligible") {
        summary[first.status] += 1;
        continue;
      }
      if (!config.apply) {
        summary.eligible += 1;
        continue;
      }
      // Recheck the complete tree immediately before deletion; a changed tree must survive.
      const second = await inspect(path, cutoff);
      if (
        second.status !== "eligible" ||
        first.fingerprint !== second.fingerprint
      ) {
        summary.preserved += 1;
        continue;
      }
      summary.eligible += 1;
      await rm(path, { recursive: true });
      summary.removed += 1;
    }
  }
  console.log(JSON.stringify(summary));
}

try {
  await main();
} catch {
  console.error(
    "Draft cleanup could not complete; verify options, directory permissions and that uploads are stopped",
  );
  process.exitCode = 1;
}
