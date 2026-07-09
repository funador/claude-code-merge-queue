import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isClaudeProcessRow, isDisposableUntracked, pruneLandedLanes, findOrphanedLanes } from "../src/lib/prune-lanes.js";
import { DEFAULTS } from "../src/lib/config.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepoWithRemote(): { mainTop: string; remote: string } {
  const base = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-prune-"));
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

const cfg = { worktreeSuffix: DEFAULTS.worktreeSuffix, branchPrefix: DEFAULTS.branchPrefix, integrationBranch: "main", regenerableFiles: [] as string[], disposableUntracked: [] as string[] };

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

test("findOrphanedLanes reports a sibling lane with unlanded commits and no live session — the abandoned-mid-land case", () => {
  const { mainTop } = makeRepoWithRemote();
  try {
    const wt1 = addLaneWorktree(mainTop, 1);
    writeFileSync(join(wt1, "unfinished.txt"), "wip\n");
    git(wt1, ["add", "-A"]);
    git(wt1, ["commit", "-q", "-m", "work that never landed"]);
    // Deliberately NOT pushed — this is the "session got torn down mid-land" shape.

    const orphaned = findOrphanedLanes(mainTop, cfg, "/some/other/currently-active-lane");

    assert.equal(orphaned.length, 1);
    assert.equal(orphaned[0]!.branch, `${DEFAULTS.branchPrefix}1`);
    assert.equal(orphaned[0]!.aheadCount, 1);
    assert.ok(existsSync(wt1), "reporting must never touch the lane");
  } finally {
    rmSync(mainTop, { recursive: true, force: true });
  }
});

test("findOrphanedLanes leaves alone a lane that's already fully landed", () => {
  const { mainTop } = makeRepoWithRemote();
  try {
    const wt1 = addLaneWorktree(mainTop, 1);
    writeFileSync(join(wt1, "lane1.txt"), "done\n");
    git(wt1, ["add", "-A"]);
    git(wt1, ["commit", "-q", "-m", "lane 1 work"]);
    git(wt1, ["push", "-q", "origin", "HEAD:main"]);
    git(mainTop, ["fetch", "origin", "--quiet"]);

    const orphaned = findOrphanedLanes(mainTop, cfg, "/some/other/currently-active-lane");

    assert.deepEqual(orphaned, [], "fully-landed work has nothing to report — that's pruneLandedLanes' job");
  } finally {
    rmSync(mainTop, { recursive: true, force: true });
  }
});

test("findOrphanedLanes never reports a lane with an active Claude Code session, no matter how far behind it is", () => {
  const { mainTop } = makeRepoWithRemote();
  const { binDir } = fakeLsofReporting("claude.ex  1234  jesse  cwd  DIR 1,18  64  123  __TARGET__");
  const originalPath = process.env.PATH;
  try {
    const wt1 = addLaneWorktree(mainTop, 1);
    writeFileSync(join(wt1, "wip.txt"), "still working\n");
    git(wt1, ["add", "-A"]);
    git(wt1, ["commit", "-q", "-m", "in progress"]);
    process.env.PATH = `${binDir}:${originalPath}`;

    const orphaned = findOrphanedLanes(mainTop, cfg, "/some/other/currently-active-lane");

    assert.deepEqual(orphaned, [], "someone's actually at the keyboard here — never call this orphaned");
  } finally {
    process.env.PATH = originalPath;
    rmSync(mainTop, { recursive: true, force: true });
  }
});

test("findOrphanedLanes never reports the currently-active worktree, even with unlanded commits", () => {
  const { mainTop } = makeRepoWithRemote();
  try {
    const wt1 = addLaneWorktree(mainTop, 1);
    writeFileSync(join(wt1, "wip.txt"), "still working\n");
    git(wt1, ["add", "-A"]);
    git(wt1, ["commit", "-q", "-m", "in progress"]);

    const orphaned = findOrphanedLanes(mainTop, cfg, wt1); // wt1 IS the "current" one this time

    assert.deepEqual(orphaned, []);
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

test("pruneLandedLanes discards regenerable-only dirty files and still prunes — confirmed live, next-env.d.ts/tsconfig.json blocked otherwise-safe lanes", () => {
  const { mainTop } = makeRepoWithRemote();
  const cfgWithRegenerable = { ...cfg, regenerableFiles: ["next-env.d.ts", "tsconfig.json"] };
  try {
    const wt1 = addLaneWorktree(mainTop, 1);
    // next-env.d.ts/tsconfig.json must already be TRACKED for this to be
    // realistic — the real bug was git status showing them MODIFIED (a
    // build tool rewrote committed files), not untracked. An untracked
    // file can't be `git checkout --`'d back to anything; that's not what
    // blocked real lanes.
    writeFileSync(join(wt1, "next-env.d.ts"), "// original\n");
    writeFileSync(join(wt1, "tsconfig.json"), "{}\n");
    writeFileSync(join(wt1, "lane1.txt"), "done\n");
    git(wt1, ["add", "-A"]);
    git(wt1, ["commit", "-q", "-m", "lane 1 work"]);
    git(wt1, ["push", "-q", "origin", "HEAD:main"]);
    git(mainTop, ["fetch", "origin", "--quiet"]);
    git(mainTop, ["merge", "--ff-only", "origin/main"]);
    // A build tool rewriting its own regenerated output — the exact shape
    // that silently blocked pruning on otherwise fully-landed, idle lanes.
    writeFileSync(join(wt1, "next-env.d.ts"), "// regenerated\n");
    writeFileSync(join(wt1, "tsconfig.json"), '{"regenerated": true}\n');
    const wt1Real = realpathSync(wt1);

    const pruned = pruneLandedLanes(mainTop, cfgWithRegenerable, "/some/other/currently-active-lane");

    assert.deepEqual(pruned, [wt1Real], "regenerable-only dirt should not block pruning a genuinely merged lane");
    assert.ok(!existsSync(wt1));
  } finally {
    rmSync(mainTop, { recursive: true, force: true });
  }
});

test("pruneLandedLanes reclaims a landed idle lane blocked only by disposable untracked litter — the scratchpad/ case that pinned lanes forever", () => {
  const { mainTop } = makeRepoWithRemote();
  const cfgDisposable = { ...cfg, disposableUntracked: ["scratchpad/"] };
  try {
    const wt1 = addLaneWorktree(mainTop, 1);
    writeFileSync(join(wt1, "lane1.txt"), "done\n");
    git(wt1, ["add", "-A"]);
    git(wt1, ["commit", "-q", "-m", "lane 1 work"]);
    git(wt1, ["push", "-q", "origin", "HEAD:main"]);
    git(mainTop, ["fetch", "origin", "--quiet"]);
    git(mainTop, ["merge", "--ff-only", "origin/main"]);
    // Untracked session litter — never committed, so `git checkout --` can't
    // restore it and `git worktree remove` refuses over it. Exactly what kept
    // fully-landed, abandoned lanes stuck on disk.
    execFileSync("mkdir", ["-p", join(wt1, "scratchpad")]);
    writeFileSync(join(wt1, "scratchpad", "run.log"), "noise\n");
    writeFileSync(join(wt1, "scratchpad", "tmp.mjs"), "// scratch\n");
    const wt1Real = realpathSync(wt1);

    const pruned = pruneLandedLanes(mainTop, cfgDisposable, "/some/other/currently-active-lane");

    assert.deepEqual(pruned, [wt1Real], "disposable-only untracked litter must not block reclaiming a merged lane");
    assert.ok(!existsSync(wt1));
  } finally {
    rmSync(mainTop, { recursive: true, force: true });
  }
});

test("pruneLandedLanes leaves a landed lane alone when it holds NON-disposable untracked work", () => {
  const { mainTop } = makeRepoWithRemote();
  const cfgDisposable = { ...cfg, disposableUntracked: ["scratchpad/"] };
  try {
    const wt1 = addLaneWorktree(mainTop, 1);
    writeFileSync(join(wt1, "lane1.txt"), "done\n");
    git(wt1, ["add", "-A"]);
    git(wt1, ["commit", "-q", "-m", "lane 1 work"]);
    git(wt1, ["push", "-q", "origin", "HEAD:main"]);
    git(mainTop, ["fetch", "origin", "--quiet"]);
    git(mainTop, ["merge", "--ff-only", "origin/main"]);
    // A brand-new source file someone wrote but never committed — real work,
    // NOT in disposableUntracked. Must never be `git clean`'d away to tidy up.
    writeFileSync(join(wt1, "new-feature.ts"), "export const real = 1;\n");
    writeFileSync(join(wt1, "scratchpad-note.txt"), "also untracked but not under scratchpad/\n");

    const pruned = pruneLandedLanes(mainTop, cfgDisposable, "/some/other/currently-active-lane");

    assert.deepEqual(pruned, [], "any untracked file outside the disposable list is real work and must block pruning");
    assert.ok(existsSync(wt1));
    assert.ok(existsSync(join(wt1, "new-feature.ts")), "real untracked work must never be cleaned");
  } finally {
    rmSync(mainTop, { recursive: true, force: true });
  }
});

test("findOrphanedLanes reports a LANDED lane that still holds real uncommitted work — the case the ahead-count check is blind to", () => {
  const { mainTop } = makeRepoWithRemote();
  const cfgDisposable = { ...cfg, regenerableFiles: ["next-env.d.ts"], disposableUntracked: ["scratchpad/"] };
  try {
    const wt1 = addLaneWorktree(mainTop, 1);
    writeFileSync(join(wt1, "lane1.txt"), "done\n");
    writeFileSync(join(wt1, "next-env.d.ts"), "// original\n"); // TRACKED, so a later rewrite reads as regenerable noise
    git(wt1, ["add", "-A"]);
    git(wt1, ["commit", "-q", "-m", "lane 1 work"]);
    git(wt1, ["push", "-q", "origin", "HEAD:main"]); // its branch DID land — ahead count is 0
    git(mainTop, ["fetch", "origin", "--quiet"]);
    // Real uncommitted edits left behind, plus pure noise that must NOT count.
    writeFileSync(join(wt1, "lane1.txt"), "edited but never committed\n");
    writeFileSync(join(wt1, "next-env.d.ts"), "// regenerated noise\n");
    execFileSync("mkdir", ["-p", join(wt1, "scratchpad")]);
    writeFileSync(join(wt1, "scratchpad", "run.log"), "noise\n");

    const orphaned = findOrphanedLanes(mainTop, cfgDisposable, "/some/other/currently-active-lane");

    assert.equal(orphaned.length, 1);
    assert.equal(orphaned[0]!.reason, "uncommitted-work");
    assert.equal(orphaned[0]!.aheadCount, 0);
    assert.equal(orphaned[0]!.dirtyCount, 1, "only the real edit counts — regenerable + disposable noise is discounted");
    assert.ok(existsSync(wt1), "reporting must never touch the lane");
  } finally {
    rmSync(mainTop, { recursive: true, force: true });
  }
});

test("findOrphanedLanes stays silent on a landed lane whose only dirt is noise (that's pruneLandedLanes' job)", () => {
  const { mainTop } = makeRepoWithRemote();
  const cfgDisposable = { ...cfg, regenerableFiles: ["next-env.d.ts"], disposableUntracked: ["scratchpad/"] };
  try {
    const wt1 = addLaneWorktree(mainTop, 1);
    writeFileSync(join(wt1, "lane1.txt"), "done\n");
    writeFileSync(join(wt1, "next-env.d.ts"), "// original\n");
    git(wt1, ["add", "-A"]);
    git(wt1, ["commit", "-q", "-m", "lane 1 work"]);
    git(wt1, ["push", "-q", "origin", "HEAD:main"]);
    git(mainTop, ["fetch", "origin", "--quiet"]);
    writeFileSync(join(wt1, "next-env.d.ts"), "// regenerated\n"); // tracked regenerable noise
    execFileSync("mkdir", ["-p", join(wt1, "scratchpad")]);
    writeFileSync(join(wt1, "scratchpad", "run.log"), "noise\n"); // disposable untracked noise

    const orphaned = findOrphanedLanes(mainTop, cfgDisposable, "/some/other/currently-active-lane");

    assert.deepEqual(orphaned, [], "noise-only dirt is safe to auto-reclaim — never surface it as if it needed a human");
  } finally {
    rmSync(mainTop, { recursive: true, force: true });
  }
});

test("isDisposableUntracked matches a dir pattern, its bare form, and nested paths — but nothing else", () => {
  assert.equal(isDisposableUntracked("scratchpad/", ["scratchpad/"]), true, "git reports a wholly-untracked dir with a trailing slash");
  assert.equal(isDisposableUntracked("scratchpad/run.log", ["scratchpad/"]), true, "nested files under the dir");
  assert.equal(isDisposableUntracked("scratchpad", ["scratchpad/"]), true, "the bare dir name");
  assert.equal(isDisposableUntracked("scratchpad/", ["scratchpad"]), true, "trailing slash on the pattern is optional");
  assert.equal(isDisposableUntracked("scratchpad-notes.txt", ["scratchpad/"]), false, "a sibling that merely shares the prefix is NOT under the dir");
  assert.equal(isDisposableUntracked("src/index.ts", ["scratchpad/"]), false, "unrelated real work never matches");
  assert.equal(isDisposableUntracked("anything", []), false, "empty patterns match nothing");
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

test("pruneLandedLanes prunes a merged lane even when an unrelated process is still cwd'd into it — the confirmed live bug", async () => {
  // Confirmed live: a fully-landed, already-abandoned lane stayed stuck on
  // disk indefinitely because a leftover MCP server process (spawned by the
  // Claude session that has since exited) was still sitting there. Any
  // live process used to count as "still in use" — this proves an
  // unrelated one (sleep, standing in for that MCP server) no longer does.
  const { mainTop } = makeRepoWithRemote();
  const child = spawnSyncHelper();
  try {
    const wt1 = addLaneWorktree(mainTop, 1);
    const wt1Real = realpathSync(wt1); // git worktree list reports the realpath-resolved form
    writeFileSync(join(wt1, "lane1.txt"), "done\n");
    git(wt1, ["add", "-A"]);
    git(wt1, ["commit", "-q", "-m", "lane 1 work"]);
    git(wt1, ["push", "-q", "origin", "HEAD:main"]);
    git(mainTop, ["fetch", "origin", "--quiet"]);
    git(mainTop, ["merge", "--ff-only", "origin/main"]);

    const proc = child.spawn("sleep", ["30"], { cwd: wt1 });
    await child.waitUntilCwdVisible(wt1);

    const pruned = pruneLandedLanes(mainTop, cfg, "/some/other/currently-active-lane");

    assert.deepEqual(pruned, [wt1Real]);
    assert.ok(!existsSync(wt1));
    proc.kill();
  } finally {
    rmSync(mainTop, { recursive: true, force: true });
  }
});

test("pruneLandedLanes still never removes a lane with an actual Claude Code session cwd'd into it, even a brand-new lane trivially 'merged' because it hasn't diverged yet", async () => {
  // The exact bug this closes: a fresh lane with ZERO commits is trivially
  // an ancestor of upstream (its tip IS already a commit on the integration
  // branch) — structurally identical, in the git graph alone, to a lane
  // whose real work already landed. Confirmed live: this swept a fresh
  // lane out from under whoever was about to start using it.
  //
  // Faking a real OS process that lsof reports as "claude" isn't practical
  // here (renaming/copying a binary gets killed by macOS Gatekeeper, and
  // Node's process.title fools `ps` but not `lsof`) — so this shims a fake
  // `lsof` onto PATH instead, the same technique used elsewhere in this
  // test suite for fake package managers.
  const { mainTop } = makeRepoWithRemote();
  const { binDir } = fakeLsofReporting("claude.ex  1234  jesse  cwd  DIR 1,18  64  123  __TARGET__");
  const originalPath = process.env.PATH;
  try {
    const freshLane = addLaneWorktree(mainTop, 1); // zero commits beyond main — "merged" only because it never diverged
    process.env.PATH = `${binDir}:${originalPath}`;

    const pruned = pruneLandedLanes(mainTop, cfg, "/some/other/currently-active-lane");

    assert.deepEqual(pruned, [], "a lane with a live Claude Code session inside must never be pruned, regardless of merge status");
    assert.ok(existsSync(freshLane));
  } finally {
    process.env.PATH = originalPath;
    rmSync(mainTop, { recursive: true, force: true });
  }
});

// Minimal helper: spawn a real long-lived process with a given cwd, and
// poll `lsof` (the same tool prune-lanes.ts itself uses) until it actually
// shows up — spawning is asynchronous from the OS's perspective, so a
// fixed sleep would be a flaky guess instead of an actual confirmation.
function spawnSyncHelper() {
  return {
    spawn(cmd: string, args: string[], opts: { cwd: string }) {
      return spawn(cmd, args, { cwd: opts.cwd, stdio: "ignore" });
    },
    async waitUntilCwdVisible(dir: string): Promise<void> {
      // lsof's own exit code is unreliable (see prune-lanes.ts) — check
      // stdout content, not the exit status.
      for (let i = 0; i < 50; i++) {
        const out = spawnSync("lsof", ["-a", "-d", "cwd", "+D", dir], { encoding: "utf8" }).stdout.trim();
        if (out) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`lsof never showed a live process in ${dir} — test setup itself is broken, not just slow`);
    },
  };
}

// A fake `lsof` that always reports the same single row (with `__TARGET__`
// substituted for whatever directory it was actually asked about), so a
// test can deterministically control what hasLiveProcessInside() sees
// without depending on any real process's name.
function fakeLsofReporting(rowTemplate: string): { binDir: string } {
  const binDir = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-fake-lsof-"));
  // POSIX-only: grab the last arg with a loop, not `${*: -1}` (a bashism). On a
  // Linux runner /bin/sh is dash, which errors "Bad substitution" on the latter,
  // leaving the fake lsof to emit nothing — so a live lane reads as orphaned.
  const script = `#!/bin/sh\ndir=\nfor a in "$@"; do dir="$a"; done\necho "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME"\necho "${rowTemplate}" | sed "s|__TARGET__|\\$dir|"\n`;
  writeFileSync(join(binDir, "lsof"), script);
  chmodSync(join(binDir, "lsof"), 0o755);
  return { binDir };
}

test("isClaudeProcessRow matches the Claude Code binary, however lsof happens to truncate/case it", () => {
  assert.equal(isClaudeProcessRow("claude.ex  58316  jesse  cwd  DIR 1,18  64  123  /some/lane"), true, "macOS truncates COMMAND to ~9 chars");
  assert.equal(isClaudeProcessRow("claude  58316  jesse  cwd  DIR 1,18  64  123  /some/lane"), true);
  assert.equal(isClaudeProcessRow("CLAUDE  58316  jesse  cwd  DIR 1,18  64  123  /some/lane"), true, "case-insensitive");
  assert.equal(isClaudeProcessRow("  claude.ex  58316  jesse  cwd  DIR 1,18  64  123  /some/lane"), true, "leading whitespace tolerated");
});

test("isClaudeProcessRow does not match unrelated processes that happen to share a lane's cwd", () => {
  // The exact confirmed-live bug: an orphaned MCP server process kept an
  // already-landed, already-abandoned lane stuck on disk forever because
  // it counted as "still in use." None of these should count.
  assert.equal(isClaudeProcessRow("node  4441  jesse  cwd  DIR 1,18  64  123  /some/lane"), false);
  assert.equal(isClaudeProcessRow("caffeinat  14829  jesse  cwd  DIR 1,18  64  123  /some/lane"), false);
  assert.equal(isClaudeProcessRow("mcp  4441  jesse  cwd  DIR 1,18  64  123  /some/lane"), false);
  assert.equal(isClaudeProcessRow(""), false, "an empty row (blank line) never matches");
});
