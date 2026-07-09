// Unit tests for land's lane-side reinstall DECISION (laneNeedsReinstall) — the
// safety-critical gates, exercised against real git + fs state without paying for
// an actual `npm install`. The install action itself is a thin spawnSync the
// predicate guards; these pin the gating that keeps it safe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { laneNeedsReinstall } from "../src/land.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// A committed repo with an npm lockfile; returns its dir + the HEAD to treat as
// the pre-rebase point.
function initRepo(): { dir: string; preRebaseHead: string } {
  const dir = mkdtempSync(join(tmpdir(), "ccmq-reinstall-"));
  git(dir, ["init", "--quiet"]);
  git(dir, ["config", "user.email", "t@t.com"]);
  git(dir, ["config", "user.name", "T"]);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ v: 1 }));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return { dir, preRebaseHead: git(dir, ["rev-parse", "HEAD"]).trim() };
}

test("laneNeedsReinstall: lockfile changed by the rebase + a real node_modules → true", () => {
  const { dir, preRebaseHead } = initRepo();
  try {
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ v: 2 }));
    git(dir, ["commit", "-qam", "another lane's dep landed"]);
    mkdirSync(join(dir, "node_modules")); // this lane broke the symlink for its own dep
    assert.equal(laneNeedsReinstall(dir, preRebaseHead), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("laneNeedsReinstall: lockfile changed but node_modules is the shared SYMLINK → false (never install into it)", () => {
  const { dir, preRebaseHead } = initRepo();
  const shared = mkdtempSync(join(tmpdir(), "ccmq-shared-nm-"));
  try {
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ v: 2 }));
    git(dir, ["commit", "-qam", "another lane's dep landed"]);
    symlinkSync(shared, join(dir, "node_modules")); // fresh lane: node_modules symlinks main's
    assert.equal(laneNeedsReinstall(dir, preRebaseHead), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  }
});

test("laneNeedsReinstall: rebase left the lockfile untouched → false (no-op on the common path)", () => {
  const { dir, preRebaseHead } = initRepo();
  try {
    writeFileSync(join(dir, "src.txt"), "unrelated work");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qam", "no dep change"]);
    mkdirSync(join(dir, "node_modules"));
    assert.equal(laneNeedsReinstall(dir, preRebaseHead), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
