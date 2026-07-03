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
 *   2. Never touch a worktree with a LIVE process currently working in it
 *      (checked via `lsof -a -d cwd`, see below) — this is NOT redundant
 *      with the ancestor check. A brand-new lane that hasn't diverged yet
 *      is *trivially* an ancestor of upstream (its tip IS a commit already
 *      on the integration branch, just because nothing's been committed
 *      there yet) — structurally identical, in the git graph alone, to a
 *      lane whose own real work already landed. Only a liveness check can
 *      tell "someone's about to start working here" apart from "this is
 *      truly done." Confirmed live: a fresh, zero-commit lane got swept by
 *      another lane's land before its own first commit.
 *   3. `git worktree remove` (no `--force`) refuses on its own if the
 *      worktree has uncommitted changes — dirty work is never discarded
 *      just because its branch happens to be merged. The ONE exception,
 *      matching `sync`/`land`: files listed in `regenerableFiles`
 *      (next-env.d.ts and the like) are discarded first and the removal
 *      retried, since a build tool rewriting its own output shouldn't be
 *      the thing that leaves an otherwise fully-landed lane stuck forever.
 *      Any OTHER dirty file blocks pruning exactly as before — real
 *      uncommitted work is never discarded just to tidy up disk space.
 * Deleting the now-redundant local branch (`git branch -d`, never `-D`) is a
 * separate, best-effort tidiness step AFTER the worktree is already gone —
 * it checks merge state against local HEAD rather than origin, so it can
 * legitimately fail if the local integration branch hasn't caught up yet.
 * That failure doesn't undo the (already-safe) worktree removal or keep it
 * out of the returned list; it just leaves a harmless leftover branch ref.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { LaneKeeperConfig } from "./config.js";

/**
 * Is any live process's current working directory inside `dir` right now?
 * `lsof`'s own exit code is NOT reliable for this — it returns non-zero
 * both when nothing matches AND when it merely fails to inspect some
 * unrelated process it lacks permission for (common, e.g. root-owned system
 * daemons), even while correctly printing real matches. The trustworthy
 * signal is whether stdout has any content at all: genuinely idle
 * directories produce completely empty output; a live process's cwd entry
 * always prints a real row. `-a` ANDs the two filters together (lsof ORs by
 * default) so this only matches things actually inside `dir`, not every
 * process on the system.
 *
 * If `lsof` isn't available at all, this fails CLOSED — treats liveness as
 * unknown/possible rather than confirmed-safe, so an unverifiable state
 * never gets treated the same as a verified-idle one.
 */
function hasLiveProcessInside(dir: string): boolean {
  const result = spawnSync("lsof", ["-a", "-d", "cwd", "+D", dir], { encoding: "utf8" });
  if (result.error) return true; // lsof missing/unspawnable — can't verify, assume in use
  return result.stdout.trim().length > 0;
}

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

function tryRemoveWorktree(mainTop: string, wt: string): boolean {
  try {
    execFileSync("git", ["worktree", "remove", wt], { cwd: mainTop, stdio: "ignore" });
    return true;
  } catch {
    return false;
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
  cfg: Pick<LaneKeeperConfig, "worktreeSuffix" | "branchPrefix" | "integrationBranch" | "regenerableFiles">,
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
  const regenerable = new Set(cfg.regenerableFiles);

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

    if (hasLiveProcessInside(wt)) continue; // someone's actively in here — never touch it

    let removed = tryRemoveWorktree(mainTop, wt);
    if (!removed) {
      // Blocked by dirty files? Only retry if EVERY one of them is a
      // configured regenerable file — anything else is real uncommitted
      // work, and this lane is left alone exactly as before.
      const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" })
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(3).trim());
      const blocking = dirty.filter((f) => !regenerable.has(f));
      if (dirty.length > 0 && blocking.length === 0) {
        execFileSync("git", ["checkout", "--", ...dirty], { cwd: wt, stdio: "ignore" });
        removed = tryRemoveWorktree(mainTop, wt);
      }
    }
    if (!removed) continue; // still dirty (real work) or otherwise busy — leave it alone

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
