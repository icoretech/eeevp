// The operator CLI runs in a real child process against disk; cleanup never mocks filesystem metadata.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
let storage: string;
const stale = new Date(Date.now() - 49 * 60 * 60 * 1000);

beforeEach(async () => {
  storage = await mkdtemp(join(tmpdir(), "eeevp-cleanup-"));
});

afterEach(async () => {
  await rm(storage, { recursive: true, force: true });
});

async function run(args: string[] = [], root = storage) {
  const result = await execute(
    process.execPath,
    ["scripts/cleanup-drafts.mjs", ...args],
    {
      cwd: process.cwd(),
      env: { ...process.env, STORAGE_PATH: root },
    },
  );
  return {
    summary: JSON.parse(result.stdout),
    output: result.stdout,
    stderr: result.stderr,
  };
}

async function ageTree(path: string) {
  const entry = await lstat(path);
  if (entry.isDirectory()) {
    for (const name of await readdir(path)) await ageTree(join(path, name));
  }
  if (!entry.isSymbolicLink()) await utimes(path, stale, stale);
}

async function draft(
  options: { old?: boolean; committed?: boolean; id?: string } = {},
) {
  const id = options.id ?? randomUUID();
  const path = join(storage, "videos", id);
  await mkdir(join(path, "chunks"), { recursive: true });
  await writeFile(join(path, "draft.json"), "{}");
  await writeFile(join(path, "chunks", "0"), new Uint8Array([1, 2, 3]));
  if (options.committed) await writeFile(join(path, "manifest.json"), "{}");
  if (options.old) await ageTree(path);
  return { id, path };
}

describe("abandoned upload maintenance", () => {
  it("defaults to dry-run and reports aggregate counts without deleting or disclosing directory names", async () => {
    const abandoned = await draft({ old: true });
    const result = await run();
    expect(result.summary).toMatchObject({
      mode: "dry-run",
      eligible: 1,
      removed: 0,
    });
    expect((await lstat(abandoned.path)).isDirectory()).toBe(true);
    expect(result.output).not.toContain(abandoned.id);
    expect(result.output).not.toContain("draft.json");
    expect(result.output).not.toContain(storage);
    expect(result.stderr).toBe("");
  });

  it("removes only stale uncommitted drafts and preserves committed, recent and non-UUID directories", async () => {
    const abandoned = await draft({ old: true });
    const committed = await draft({ old: true, committed: true });
    const recent = await draft();
    const unrelated = await draft({ old: true, id: "unrelated" });
    const result = await run(["--apply"]);
    expect(result.summary).toMatchObject({
      mode: "apply",
      examined: 3,
      eligible: 1,
      removed: 1,
      preserved: 2,
    });
    await expect(lstat(abandoned.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const preserved of [committed.path, recent.path, unrelated.path]) {
      expect((await lstat(preserved)).isDirectory()).toBe(true);
    }
  });

  it("preserves an old draft when a nested chunk has a recent modification", async () => {
    const active = await draft({ old: true });
    await writeFile(join(active.path, "chunks", "0"), "updated");
    const result = await run(["--apply"]);
    expect(result.summary).toMatchObject({
      eligible: 0,
      removed: 0,
      preserved: 1,
    });
    expect((await lstat(active.path)).isDirectory()).toBe(true);
  });

  it("refuses symbolic links in candidate trees and at the configured storage root", async () => {
    const abandoned = await draft({ old: true });
    const outside = join(storage, "outside");
    await writeFile(outside, "preserve");
    await symlink(outside, join(abandoned.path, "linked"));
    await utimes(abandoned.path, stale, stale);
    const result = await run(["--apply"]);
    expect(result.summary).toMatchObject({ refused: 1, removed: 0 });
    expect((await lstat(outside)).isFile()).toBe(true);
    const linkedRoot = join(storage, "linked-root");
    await symlink(storage, linkedRoot);
    await expect(run(["--apply"], linkedRoot)).rejects.toMatchObject({
      code: 1,
    });
  });

  it("requires an absolute storage path and an age of at least 24 whole hours", async () => {
    await expect(
      run(["--apply", "--older-than-hours", "23"]),
    ).rejects.toMatchObject({ code: 1 });
    await expect(run(["--apply"], "relative/path")).rejects.toMatchObject({
      code: 1,
    });
    await expect(run(["--apply", "--unexpected"])).rejects.toMatchObject({
      code: 1,
    });
    const abandoned = await draft({ old: true });
    const result = await run(["--apply", "--older-than-hours", "72"]);
    expect(result.summary).toMatchObject({
      eligible: 0,
      removed: 0,
      preserved: 1,
    });
    expect((await lstat(abandoned.path)).isDirectory()).toBe(true);
  });
});
