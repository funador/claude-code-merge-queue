/**
 * land.ts — the ONLY sanctioned way for a lane to land onto the integration
 * branch.
 *
 * Left to behavioral convention alone ("only one lane rebases-and-pushes at
 * a time"), several lanes going green around the same time all rebase and
 * push at once: pushes race, the loser's checks run against an already-stale
 * remote, and when something breaks everyone ends up mid-push fixing the
 * same failure. This makes "land" a single cross-worktree FIFO queue
 * (queue-lock.ts — the same crash-safe mechanics build-lock uses) so only
 * one lane is ever fetching, rebasing, pushing, and checking at a time.
 *
 * A failed attempt releases the lock rather than holding it hostage — the
 * next lane in line lands next while the failed lane fixes and re-runs
 * `claude-code-merge-queue land` (re-entering the back of the queue). That keeps one
 * broken lane from blocking every OTHER lane's unrelated, ready-to-land
 * work, while still guaranteeing no two lanes are ever mid-push at once.
 *
 * This is only half the guarantee, though — a convention that says "always
 * run `claude-code-merge-queue land`" is exactly the kind of rule a confused agent (or a
 * human under time pressure) eventually skips by hand-rolling `git push`.
 * The other half lives in hooks/pre-push: it hard-rejects a direct push to
 * the integration branch that didn't set CLAUDE_CODE_MERGE_QUEUE_LANDING=1, which this
 * script sets right before its own push and nothing else legitimately would.
 * Wire that hook up (see the README) and the queue isn't a convention
 * anymore — it's the only door.
 *
 *   Usage:  claude-code-merge-queue land   (run from a lane worktree, on its own branch)
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createQueueLock } from "./lib/queue-lock.js";
import { hasConfig, loadConfig } from "./lib/config.js";
import { resolveMainCheckout } from "./lib/main-checkout.js";
import { pruneLandedLanes, findOrphanedLanes, describeOrphanedLane } from "./lib/prune-lanes.js";
import { detectPackageManager } from "./lib/check-command.js";
import { sync, LOCKFILES } from "./sync.js";

const DIM = "\x1b[2m", RESET = "\x1b[0m", RED = "\x1b[31m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m";

/**
 * A lane that broke its node_modules symlink to install its OWN new dependency
 * (see the config's `symlinks`) runs on a REAL, isolated node_modules — one that
 * `sync`'s shared-node_modules refresh (sync.ts) never touches. So when a rebase
 * here pulls in a lockfile change from ANOTHER lane's dependency, this lane's
 * checks run against stale deps and fail on a "cannot find module" that has
 * nothing to do with the work being landed. Reinstall between the rebase and the
 * push, so the checks (which run in the pre-push hook) see the rebased tree.
 *
 * A no-op unless BOTH hold:
 *   - the rebase actually changed the lockfile (no dep churn → nothing to do), and
 *   - node_modules is a real directory, NOT the shared symlink. A symlinked lane's
 *     node_modules IS the main checkout's, which `sync` keeps current on every
 *     land; installing "into" the symlink would mutate that shared tree out from
 *     under every other lane, so those are covered by sync and skipped here.
 *
 * Isolated by construction, so — unlike sync's shared case — even a dependency
 * REMOVAL is safe to apply without a guard: nothing else reads this tree.
 */
export function laneNeedsReinstall(root: string, preRebaseHead: string): boolean {
  const pm = detectPackageManager(root);
  const lockfiles = LOCKFILES[pm] ?? [];
  const changed = execSync(`git diff --name-only ${preRebaseHead} HEAD`, { cwd: root, encoding: "utf8" }).split("\n");
  if (!lockfiles.some((f) => changed.includes(f))) return false; // no dep churn in the rebase

  // A symlinked node_modules IS the shared main-checkout tree (sync's job); only
  // a lane with its OWN real node_modules needs — and is safe for — a local install.
  const nodeModules = join(root, "node_modules");
  if (existsSync(nodeModules) && lstatSync(nodeModules).isSymbolicLink()) return false;
  return true;
}

function refreshLaneDepsAfterRebase(root: string, preRebaseHead: string): void {
  if (!laneNeedsReinstall(root, preRebaseHead)) return;
  const pm = detectPackageManager(root);
  console.log(`${DIM}land: the rebase changed the lockfile and this lane has its own node_modules — running "${pm} install" so the checks see the rebased deps…${RESET}`);
  const result = spawnSync(pm, ["install"], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`${RED}land: "${pm} install" failed (exit ${result.status ?? 1}) — the checks below may fail on stale dependencies.${RESET}`);
  }
}

export async function land(): Promise<void> {
  if (!hasConfig()) {
    console.error("claude-code-merge-queue land: no claude-code-merge-queue.config found at the repo root. Run `claude-code-merge-queue init` first.");
    process.exit(1);
  }
  const cfg = await loadConfig();

  const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  if (branch === cfg.integrationBranch || cfg.protectedBranches.includes(branch) || branch === "HEAD") {
    console.error(`claude-code-merge-queue land: refusing to run from '${branch}' — land is for lane branches only.`);
    process.exit(1);
  }

  // A rebase refuses to run at all with a dirty tree. Build-tool-regenerated
  // noise shouldn't block landing — discard ONLY the configured
  // regenerableFiles, exactly like sync does for the fast-forward on the
  // other end. Any other dirty file is real work-in-progress: leave it alone
  // and let the rebase fail loud.
  //
  // Checked here AND again right before the rebase itself (not just once):
  // a build tool can regenerate one of these files at any point, including
  // during the (possibly long) wait for the landing queue lock below. A
  // single check up front leaves that whole wait as a window where the
  // exact same harmless noise reappears and gets misreported as a real
  // rebase conflict instead of silently discarded like it should be.
  const regenerable = new Set(cfg.regenerableFiles);
  function discardRegenerableDirt(): void {
    const status = execSync("git status --porcelain", { encoding: "utf8" });
    const dirty = status
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim());
    const blocking = dirty.filter((f) => !regenerable.has(f));
    if (dirty.length > 0 && blocking.length === 0) {
      execSync(`git checkout -- ${dirty.map((f) => `"${f}"`).join(" ")}`);
    }
  }
  discardRegenerableDirt();

  // land pushes COMMITTED work, not your working tree. If real changes remain
  // after discarding regenerable noise, the agent ran `land` before committing
  // — the single most common land failure. Catch it HERE, before taking a
  // queue slot, with the actual fix, instead of letting the rebase fail later
  // on git's cryptic "cannot rebase: you have unstaged changes" (which land
  // used to mis-report as a merge conflict). Untracked files (a scratchpad,
  // stray logs) don't block a rebase and are intentionally uncommitted, so
  // they don't count — only tracked, uncommitted changes do.
  const uncommitted = execSync("git status --porcelain", { encoding: "utf8" })
    .split("\n")
    .filter((l) => l && !l.startsWith("??"));
  if (uncommitted.length > 0) {
    console.error(`${RED}land: you have uncommitted changes — commit them before landing.${RESET}`);
    console.error(
      "land pushes committed work, not your working tree. Green checks aren't enough — commit (or stash) everything, then re-run 'claude-code-merge-queue land':",
    );
    console.error(uncommitted.map((l) => `${DIM}  ${l}${RESET}`).join("\n"));
    process.exit(1);
  }

  const lock = createQueueLock("land");
  await lock.acquire({
    label: branch,
    onWait: ({ ahead, holder, holderElapsedMs }) => {
      if (ahead > 0) {
        console.log(`${DIM}[land-queue] ${branch}: waiting — ${ahead} landing${ahead === 1 ? "" : "s"} ahead…${RESET}`);
      } else if (holder && holderElapsedMs !== undefined) {
        // The lock is never force-released from a live holder (see queue-lock's
        // tryTakeLock — reclaiming it would recreate the exact race the lock
        // exists to prevent), so this is visibility only: a holder alive this
        // long is unusual enough to be worth a human looking at the PID.
        const mins = Math.round(holderElapsedMs / 60_000);
        console.log(
          `${YELLOW}⚠ [land-queue] ${branch}: '${holder.label ?? holder.lane}' (pid ${holder.pid}) has held the ` +
            `lock for ~${mins}m — if it looks wedged, inspect PID ${holder.pid} and kill it if needed to free the queue.${RESET}`,
        );
      } else if (holder) {
        console.log(`${DIM}[land-queue] ${branch}: next up — waiting for '${holder.label ?? holder.lane}' to finish landing…${RESET}`);
      }
    },
  });

  let exitCode = 0;
  try {
    console.log(`${DIM}[land-queue] ${branch}: lock acquired — landing…${RESET}`);
    discardRegenerableDirt(); // re-check right before the rebase — see comment above

    console.log(`${DIM}fetching origin/${cfg.integrationBranch}…${RESET}`);
    execSync(`git fetch origin ${cfg.integrationBranch} --quiet`, { stdio: "inherit" });

    // Captured before the rebase so we can tell, afterward, whether the rebase
    // pulled in a lockfile change and this lane needs a reinstall (see
    // refreshLaneDepsAfterRebase).
    const preRebaseHead = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
    console.log(`${DIM}rebasing onto origin/${cfg.integrationBranch}…${RESET}`);
    const rebase = spawnSync("git", ["rebase", `origin/${cfg.integrationBranch}`], { stdio: "inherit" });
    if (rebase.status !== 0) {
      spawnSync("git", ["rebase", "--abort"], { stdio: "ignore" });
      console.error(`\n${RED}land: rebase onto origin/${cfg.integrationBranch} conflicted — aborted, working tree left clean.${RESET}`);
      console.error(`Resolve it yourself (git fetch origin ${cfg.integrationBranch} && git rebase origin/${cfg.integrationBranch}), then re-run 'claude-code-merge-queue land'.`);
      exitCode = 1;
    } else {
      // Between the rebase and the push (which is where the checks run): if the
      // rebase pulled in another lane's dependency change, reinstall this lane's
      // own node_modules first so the checks don't fail on stale deps.
      refreshLaneDepsAfterRebase(process.cwd(), preRebaseHead);
      console.log(`${DIM}pushing to ${cfg.integrationBranch} (this is where your CI/checks hook runs)…${RESET}`);
      const push = spawnSync("git", ["push", "origin", `HEAD:${cfg.integrationBranch}`], {
        stdio: "inherit",
        env: { ...process.env, CLAUDE_CODE_MERGE_QUEUE_LANDING: "1" },
      });
      if (push.status !== 0) {
        console.error(`\n${RED}land: push to ${cfg.integrationBranch} failed — see output above.${RESET}`);
        console.error(`Fix the failure, then re-run 'claude-code-merge-queue land'.`);
        exitCode = 1;
      } else {
        console.log(`${GREEN}✓ ${branch} landed on ${cfg.integrationBranch}.${RESET}`);
        // Landing isn't "done" until the checkout that actually serves your
        // dev server can see it — call sync in-process rather than shelling
        // back out to the CLI, so this doesn't depend on `claude-code-merge-queue` being
        // resolvable on PATH. Pass this lane's own already-loaded cfg through
        // rather than letting sync() reload from MAIN — MAIN hasn't been
        // fast-forwarded yet at this exact moment (that's what sync is about
        // to do), so if this push just introduced or changed
        // claude-code-merge-queue.config.mjs itself, a fresh MAIN-side load would silently
        // fall back to DEFAULTS instead of the real config.
        exitCode = await sync(cfg);

        // Housekeeping, never a reason to fail this landing: sweep sibling
        // lanes whose OWN branch already made it upstream (nothing created
        // ever tears a worktree down on the way out) so they don't
        // accumulate on disk forever waiting for someone to remember.
        try {
          const mainTop = resolveMainCheckout(process.cwd());
          const pruned = pruneLandedLanes(mainTop, cfg, process.cwd());
          if (pruned.length > 0) {
            const names = pruned.map((p) => p.split("/").pop()).join(", ");
            console.log(`${DIM}pruned ${pruned.length} already-landed lane${pruned.length === 1 ? "" : "s"}: ${names}${RESET}`);
          }

          // Sibling lanes that AREN'T safe to auto-reclaim and have no one at
          // the keyboard — a session/terminal torn down mid-land, or work that
          // was never even committed. Report-only: never touched, never
          // auto-landed for someone else.
          const orphaned = findOrphanedLanes(mainTop, cfg, process.cwd());
          for (const o of orphaned) {
            console.log(`${YELLOW}⚠ ${describeOrphanedLane(o, cfg.integrationBranch)}.${RESET}`);
          }
          if (orphaned.length > 0) {
            // Don't let the agent bury this in the scrollback: it's a question
            // for the human, not housekeeping to skip past (see the CLAUDE.md rule).
            console.log(`${YELLOW}↑ surface ${orphaned.length === 1 ? "this lane" : "these lanes"} to the human and ask what to do — don't discard silently. (\`claude-code-merge-queue reconcile\` re-lists them.)${RESET}`);
          }
        } catch {
          /* best-effort — never block a successful landing over cleanup */
        }
      }
    }
  } finally {
    lock.release();
  }
  process.exit(exitCode);
}
