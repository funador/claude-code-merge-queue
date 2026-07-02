/**
 * After a lane lands, sibling lanes that were ALSO already fully landed have
 * no more reason to keep a worktree around — nothing created one on the way
 * in tore it down on the way out (Claude Code's own worktree lifecycle
 * doesn't either), so directories silently accumulate on disk forever
 * unless something sweeps them. This runs that sweep as a side effect of
 * every successful `land`, never touching the worktree currently running
 * this process or the main checkout itself.
 *
 * Safety:
 *   1. Only prune a worktree whose branch is a git ANCESTOR of
 *      origin/<integrationBranch> — the authoritative, already-pushed
 *      truth — not the local integration branch, which may not be
 *      fast-forwarded yet at the exact moment this runs. That's the literal
 *      definition of "nothing to lose": the work already made it upstream
 *      under its own name.
 *   2. `git worktree remove` (no `--force`) refuses on its own if the
 *      worktree has uncommitted changes — dirty work is never discarded
 *      just because its branch happens to be merged.
 * Deleting the now-redundant local branch (`git branch -d`, never `-D`) is a
 * separate, best-effort tidiness step AFTER the worktree is already gone —
 * it checks merge state against local HEAD rather than origin, so it can
 * legitimately fail if the local integration branch hasn't caught up yet.
 * That failure doesn't undo the (already-safe) worktree removal or keep it
 * out of the returned list; it just leaves a harmless leftover branch ref.
 */
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { LaneKeeperConfig } from "./config.js";

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

// Best-effort realpath — a "current worktree" that's already gone (or was
// never real to begin with) shouldn't crash the sweep over one path.
function existsRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function listWorktrees(mainTop: string): WorktreeEntry[] {
  const out = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: mainTop, encoding: "utf8" });
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  const flush = () => {
    if (current.path) entries.push({ path: current.path, branch: current.branch ?? null });
    current = {};
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current.path = line.slice("worktree ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return entries;
}

/**
 * Removes already-landed sibling lane worktrees. Returns the paths it
 * actually removed. Best-effort throughout — any failure for a given
 * worktree (dirty, diverged, busy) just skips that one; this never blocks
 * or fails the `land` it's running as part of.
 */
export function pruneLandedLanes(
  mainTop: string,
  cfg: Pick<LaneKeeperConfig, "worktreeSuffix" | "branchPrefix" | "integrationBranch">,
  currentWorktree: string,
): string[] {
  const pruned: string[] = [];
  // `git worktree list` reports fully realpath-resolved paths (symlinks like
  // macOS's /var -> /private/var followed) — resolve our own reference
  // points the same way, or every comparison below silently never matches.
  const mainTopReal = realpathSync(mainTop);
  const currentWorktreeReal = existsRealpath(currentWorktree);
  const laneDirPrefix = `${basename(mainTopReal)}${cfg.worktreeSuffix}`;
  const parent = dirname(mainTopReal);
  const upstream = `origin/${cfg.integrationBranch}`;

  let worktrees: WorktreeEntry[];
  try {
    worktrees = listWorktrees(mainTop);
  } catch {
    return pruned;
  }

  for (const { path: wt, branch } of worktrees) {
    if (wt === mainTopReal || wt === currentWorktreeReal) continue;
    if (dirname(wt) !== parent || !basename(wt).startsWith(laneDirPrefix)) continue; // not one of ours
    if (!branch || !branch.startsWith(cfg.branchPrefix)) continue;

    try {
      execFileSync("git", ["merge-base", "--is-ancestor", branch, upstream], {
        cwd: mainTop,
        stdio: "ignore",
      }); // throws (non-zero exit) if NOT an ancestor — caught below, left alone
    } catch {
      continue; // not safe to touch — leave this lane exactly as it is
    }

    try {
      execFileSync("git", ["worktree", "remove", wt], { cwd: mainTop, stdio: "ignore" });
    } catch {
      continue; // dirty or busy — worktree remove refused on its own, nothing removed
    }

    // The worktree is gone — this is now unconditionally a pruned lane,
    // regardless of what happens to the branch ref below.
    pruned.push(wt);
    try {
      execFileSync("git", ["branch", "-d", branch], { cwd: mainTop, stdio: "ignore" });
    } catch {
      /* local integration branch may not be fast-forwarded yet — harmless, leaves the ref behind */
    }
  }

  return pruned;
}
