import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(fileURLToPath(import.meta.url), "..", "..", "dist", "bin", "lanekeeper.js");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function scratchRepo(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lanekeeper-init-"));
  git(dir, ["init", "-q", "-b", branch]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "hi\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function runInit(cwd: string): string {
  return execFileSync("node", [CLI, "init"], { cwd, encoding: "utf8" });
}

test("init on a non-default branch name auto-detects it as integrationBranch", () => {
  const dir = scratchRepo("trunk");
  try {
    const out = runInit(dir);
    assert.match(out, /detected current branch "trunk"/);
    const cfg = readFileSync(join(dir, "lanekeeper.config.mjs"), "utf8");
    assert.match(cfg, /"integrationBranch": "trunk"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init on detached HEAD warns instead of silently defaulting to main", () => {
  const dir = scratchRepo("trunk");
  try {
    git(dir, ["checkout", "-q", "--detach", "HEAD"]);
    const out = runInit(dir);
    assert.match(out, /Couldn't detect the current branch/);
    const cfg = readFileSync(join(dir, "lanekeeper.config.mjs"), "utf8");
    // Still falls back to the DEFAULTS value, but now the user is told so.
    assert.match(cfg, /"integrationBranch": "main"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
