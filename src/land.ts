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
import { createQueueLock } from "./lib/queue-lock.js";
import { hasConfig, loadConfig } from "./lib/config.js";
import { resolveMainCheckout } from "./lib/main-checkout.js";
import { pruneLandedLanes, findOrphanedLanes } from "./lib/prune-lanes.js";
import { sync } from "./sync.js";

const DIM = "\x1b[2m", RESET = "\x1b[0m", RED = "\x1b[31m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m";

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

  const lock = createQueueLock("land");
  await lock.acquire({
    label: branch,
    onWait: ({ ahead, holder }) => {
      if (ahead > 0) {
        console.log(`${DIM}[land-queue] ${branch}: waiting — ${ahead} landing${ahead === 1 ? "" : "s"} ahead…${RESET}`);
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

    console.log(`${DIM}rebasing onto origin/${cfg.integrationBranch}…${RESET}`);
    const rebase = spawnSync("git", ["rebase", `origin/${cfg.integrationBranch}`], { stdio: "inherit" });
    if (rebase.status !== 0) {
      spawnSync("git", ["rebase", "--abort"], { stdio: "ignore" });
      console.error(`\n${RED}land: rebase onto origin/${cfg.integrationBranch} conflicted — aborted, working tree left clean.${RESET}`);
      console.error(`Resolve it yourself (git fetch origin ${cfg.integrationBranch} && git rebase origin/${cfg.integrationBranch}), then re-run 'claude-code-merge-queue land'.`);
      exitCode = 1;
    } else {
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

          // Sibling lanes with real commits that never reached the integration
          // branch and no one currently at the keyboard — a session/terminal
          // that got torn down mid-land, or work that just never got landed.
          // Report-only: never touched, never auto-landed for someone else.
          const orphaned = findOrphanedLanes(mainTop, cfg, process.cwd());
          for (const o of orphaned) {
            console.log(
              `${YELLOW}⚠ ${o.branch} has ${o.aheadCount} commit${o.aheadCount === 1 ? "" : "s"} not on ` +
                `${cfg.integrationBranch} and no active session (${o.path}) — looks orphaned. cd in and land it, or discard it.${RESET}`,
            );
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
