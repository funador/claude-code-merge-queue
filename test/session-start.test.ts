import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatOrphanedLanesAdvisory } from "../src/hooks/session-start.js";
import { DEFAULTS } from "../src/lib/config.js";
import type { OrphanedLane } from "../src/lib/prune-lanes.js";

const CLI = resolve(fileURLToPath(import.meta.url), "..", "..", "dist", "bin", "claude-code-merge-queue.js");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

// --- formatOrphanedLanesAdvisory (pure) ------------------------------------

test("formatOrphanedLanesAdvisory returns null when nothing is stranded", () => {
  assert.equal(formatOrphanedLanesAdvisory([], "main"), null);
});

test("formatOrphanedLanesAdvisory singular/plural wording and content match describeOrphanedLane", () => {
  const one: OrphanedLane[] = [{ path: "/repo-lane-1", branch: "lane/1", reason: "unlanded-commits", aheadCount: 2, dirtyCount: 0 }];
  const oneMsg = formatOrphanedLanesAdvisory(one, "main")!;
  assert.match(oneMsg, /1 sibling lane needs a decision/);
  assert.match(oneMsg, /lane\/1 has 2 commits not on main/);
  assert.match(oneMsg, /Never silently delete a lane/);

  const two: OrphanedLane[] = [
    ...one,
    { path: "/repo-lane-2", branch: "lane/2", reason: "uncommitted-work", aheadCount: 0, dirtyCount: 3 },
  ];
  const twoMsg = formatOrphanedLanesAdvisory(two, "main")!;
  assert.match(twoMsg, /2 sibling lanes need a decision/);
  assert.match(twoMsg, /lane\/2 landed, but has 3 uncommitted files never committed/);
});

// --- `hook session-start` CLI (integration) --------------------------------

// findOrphanedLanes checks ahead-count against origin/<integrationBranch> —
// a plain `git init` with no remote leaves that ref unresolvable, which it
// treats as "nothing to report" (see prune-lanes.ts). A real bare remote,
// mirroring prune-lanes.test.ts's makeRepoWithRemote, is required for the
// orphaned-lane case to actually exercise anything.
function scratchRepoWithConfig(): string {
  const base = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-session-start-"));
  const remote = join(base, "remote.git");
  const dir = join(base, "main");
  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  execFileSync("git", ["clone", "--quiet", remote, dir]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["checkout", "-q", "-b", "main"]);
  writeFileSync(join(dir, "file.txt"), "v1\n");
  writeFileSync(
    join(dir, "claude-code-merge-queue.config.mjs"),
    `export default { branchPrefix: "lane/", worktreeSuffix: "-lane-", portBase: 3000, integrationBranch: "main", productionBranch: null, protectedBranches: [], regenerableFiles: [], symlinks: [], buildOutputDirs: [], disposableUntracked: [], checkCommand: "exit 0", checksRequired: true };\n`,
  );
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  git(dir, ["push", "-q", "-u", "origin", "main"]);
  return dir;
}

function runHook(dir: string): string {
  return execFileSync("node", [CLI, "hook", "session-start"], {
    cwd: dir,
    encoding: "utf8",
    input: JSON.stringify({ cwd: dir }),
  });
}

test("hook session-start is silent and exits 0 when there's no claude-code-merge-queue config at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-session-start-noconfig-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  try {
    const out = runHook(dir);
    assert.equal(out, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hook session-start is silent and exits 0 when no sibling lane is stranded", () => {
  const dir = scratchRepoWithConfig();
  try {
    const out = runHook(dir);
    assert.equal(out, "");
  } finally {
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});

test("hook session-start surfaces a sibling lane with real unlanded commits, exactly like `reconcile`", () => {
  const dir = scratchRepoWithConfig();
  const wt1 = `${dir}${DEFAULTS.worktreeSuffix}1`;
  try {
    git(dir, ["worktree", "add", wt1, "-b", `${DEFAULTS.branchPrefix}1`]);
    writeFileSync(join(wt1, "unfinished.txt"), "wip\n");
    git(wt1, ["add", "-A"]);
    git(wt1, ["commit", "-q", "-m", "work that never landed"]);
    // Deliberately not pushed anywhere — the "session torn down mid-land" shape.

    const out = runHook(dir);

    assert.match(out, /1 sibling lane needs a decision/);
    assert.match(out, new RegExp(`${DEFAULTS.branchPrefix}1 has 1 commit not on main`));
  } finally {
    rmSync(dirname(dir), { recursive: true, force: true });
  }
});
