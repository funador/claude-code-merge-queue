import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneLandedLanes } from "../src/lib/prune-lanes.js";
import { DEFAULTS } from "../src/lib/config.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepoWithRemote(): { mainTop: string; remote: string } {
  const base = mkdtempSync(join(tmpdir(), "lanekeeper-prune-"));
  const remote = join(base, "remote.git");
  const mainTop = join(base, "main");
  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  execFileSync("git", ["clone", "--quiet", remote, mainTop]);
  git(mainTop, ["config", "user.email", "test@test.com"]);
  git(mainTop, ["config", "user.name", "Test"]);
  git(mainTop, ["checkout", "-q", "-b", "main"]);
  writeFileSync(join(mainTop, "file.txt"), "v1\n");
  git(mainTop, ["add", "-A"]);
  git(mainTop, ["commit", "-q", "-m", "init"]);
  git(mainTop, ["push", "-q", "-u", "origin", "main"]);
  return { mainTop, remote };
}

function addLaneWorktree(mainTop: string, laneNum: number): string {
  const wt = `${mainTop}${DEFAULTS.worktreeSuffix}${laneNum}`;
  const branch = `${DEFAULTS.branchPrefix}${laneNum}`;
  git(mainTop, ["worktree", "add", wt, "-b", branch]);
  return wt;
}

const cfg = { worktreeSuffix: DEFAULTS.worktreeSuffix, branchPrefix: DEFAULTS.branchPrefix, integrationBranch: "main" };

test("pruneLandedLanes removes a sibling lane whose branch is already fully merged upstream", () => {
  const { mainTop } = makeRepoWithRemote();
  try {
    const wt1 = addLaneWorktree(mainTop, 1);
    // Land lane 1's work directly (simulating a prior successful `land`).
    writeFileSync(join(wt1, "lane1.txt"), "done\n");
    git(wt1, ["add", "-A"]);
    git(wt1, ["commit", "-q", "-m", "lane 1 work"]);
    git(wt1, ["push", "-q", "origin", "HEAD:main"]);
    git(mainTop, ["fetch", "origin", "--quiet"]);
    // The real land.ts flow runs sync() (fast-forwards local integrationBranch
    // to match origin) before pruning — mirror that so `git branch -d`, which
    // checks against local HEAD rather than origin, sees the merge for real.
    git(mainTop, ["merge", "--ff-only", "origin/main"]);
    const wt1Real = realpathSync(wt1); // git worktree list reports the realpath-resolved form

    const pruned = pruneLandedLanes(mainTop, cfg, "/some/other/currently-active-lane");

    assert.deepEqual(pruned, [wt1Real]);
    assert.ok(!existsSync(wt1), "worktree directory should be gone");
    const branches = git(mainTop, ["branch", "--list"]);
    assert.doesNotMatch(branches, /lane\/1/, "merged branch should be deleted too");
  } finally {
    rmSync(mainTop, { recursive: true, force: true });
  }
});

test("pruneLandedLanes still removes the worktree (and still reports it) even when the local integration branch hasn't caught up to origin yet", () => {
  const { mainTop } = makeRepoWithRemote();
  try {
    const wt1 = addLaneWorktree(mainTop, 1);
    writeFileSync(join(wt1, "lane1.txt"), "done\n");
    git(wt1, ["add", "-A"]);
    git(wt1, ["commit", "-q", "-m", "lane 1 work"]);
    git(wt1, ["push", "-q", "origin", "HEAD:main"]);
    git(mainTop, ["fetch", "origin", "--quiet"]);
    // Deliberately skip fast-forwarding local main — `git branch -d` (which
    // checks merge state against local HEAD) will fail, but the ancestor
    // check against origin/main already proved it's safe to remove.
    const wt1Real = realpathSync(wt1);

    const pruned = pruneLandedLanes(mainTop, cfg, "/some/other/currently-active-lane");

    assert.deepEqual(pruned, [wt1Real], "worktree removal must be reported regardless of the best-effort branch delete outcome");
    assert.ok(!existsSync(wt1));
    const branches = git(mainTop, ["branch", "--list"]);
    assert.match(branches, /lane\/1/, "branch ref is harmlessly left behind when local HEAD hasn't caught up");
  } finally {
    rmSync(mainTop, { recursive: true, force: true });
  }
});

test("pruneLandedLanes leaves a lane alone whose branch has NOT landed yet", () => {
  const { mainTop } = makeRepoWithRemote();
  try {
    const wt1 = addLaneWorktree(mainTop, 1);
    writeFileSync(join(wt1, "unlanded.txt"), "wip\n");
    git(wt1, ["add", "-A"]);
    git(wt1, ["commit", "-q", "-m", "unlanded work"]);
    // Deliberately NOT pushed to origin/main.

    const pruned = pruneLandedLanes(mainTop, cfg, "/some/other/currently-active-lane");

    assert.deepEqual(pruned, []);
    assert.ok(existsSync(wt1), "unlanded worktree must survive");
  } finally {
    rmSync(mainTop, { recursive: true, force: true });
  }
});

test("pruneLandedLanes never touches the currently-active worktree, even if fully merged", () => {
  const { mainTop } = makeRepoWithRemote();
  try {
    const wt1 = addLaneWorktree(mainTop, 1);
    writeFileSync(join(wt1, "lane1.txt"), "done\n");
    git(wt1, ["add", "-A"]);
    git(wt1, ["commit", "-q", "-m", "lane 1 work"]);
    git(wt1, ["push", "-q", "origin", "HEAD:main"]);
    git(mainTop, ["fetch", "origin", "--quiet"]);

    const pruned = pruneLandedLanes(mainTop, cfg, wt1); // wt1 IS the "current" one this time

    assert.deepEqual(pruned, []);
    assert.ok(existsSync(wt1), "the active worktree must never be pruned");
  } finally {
    rmSync(mainTop, { recursive: true, force: true });
  }
});

test("pruneLandedLanes leaves a merged-but-dirty worktree alone", () => {
  const { mainTop } = makeRepoWithRemote();
  try {
    const wt1 = addLaneWorktree(mainTop, 1);
    writeFileSync(join(wt1, "lane1.txt"), "done\n");
    git(wt1, ["add", "-A"]);
    git(wt1, ["commit", "-q", "-m", "lane 1 work"]);
    git(wt1, ["push", "-q", "origin", "HEAD:main"]);
    git(mainTop, ["fetch", "origin", "--quiet"]);
    writeFileSync(join(wt1, "uncommitted.txt"), "in progress\n"); // dirty, unrelated to the merged commit

    const pruned = pruneLandedLanes(mainTop, cfg, "/some/other/currently-active-lane");

    assert.deepEqual(pruned, [], "git worktree remove should refuse a dirty tree, no --force used");
    assert.ok(existsSync(wt1));
  } finally {
    rmSync(mainTop, { recursive: true, force: true });
  }
});

test("pruneLandedLanes ignores worktrees that don't match this repo's lane naming pattern", () => {
  const { mainTop } = makeRepoWithRemote();
  try {
    const unrelated = `${mainTop}-not-a-lane`;
    git(mainTop, ["worktree", "add", unrelated, "-b", "totally-unrelated-branch"]);

    const pruned = pruneLandedLanes(mainTop, cfg, "/some/other/currently-active-lane");

    assert.deepEqual(pruned, []);
    assert.ok(existsSync(unrelated));
  } finally {
    rmSync(mainTop, { recursive: true, force: true });
  }
});
