/**
 * promote.ts — ship the integration branch to production by fast-forwarding
 * origin/<productionBranch> to origin/<integrationBranch>.
 *
 * This is the one command in Lane Keeper that's deliberately NOT part of the
 * automated workflow. Agents land on `integrationBranch` continuously and
 * autonomously (see the CLAUDE.md workflow section `lanekeeper init` writes) —
 * production only moves when a human decides to run this. If your
 * lanekeeper.config has no `productionBranch` set, there's nothing to
 * promote: `integrationBranch` already IS production, and this is a no-op.
 *
 *   Usage:  lanekeeper promote   (run from anywhere in the repo)
 *
 * Safe by construction:
 *   - Fetches first, then verifies origin/productionBranch is an ANCESTOR of
 *     origin/integrationBranch — a pure fast-forward, linear history, no
 *     merge commit. If production has commits not on the integration branch
 *     (someone pushed it directly), it ABORTS rather than force anything.
 *   - No local checkout needed: pushes the remote ref straight across.
 *   - --no-verify on the push: every commit on the integration branch
 *     already passed the full pre-push check when it landed, so re-running
 *     that suite here is pure waste. Your own CI still gates whatever runs
 *     on the production branch on its side.
 *   - Nothing to promote (already equal) → reports and exits 0.
 */
import { execFileSync } from "node:child_process";
import { hasConfig, loadConfig } from "./lib/config.js";

function git(args: string[], { allowFail = false } = {}): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    if (!allowFail) throw e;
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() };
  }
}

export async function promote(): Promise<number> {
  if (!hasConfig()) {
    console.error("lanekeeper promote: no lanekeeper.config found at the repo root.");
    return 1;
  }
  const cfg = await loadConfig();
  if (!cfg.productionBranch) {
    console.log(`lanekeeper promote: no productionBranch configured — '${cfg.integrationBranch}' already IS production. Nothing to do.`);
    return 0;
  }
  const { integrationBranch, productionBranch } = cfg;

  git(["fetch", "origin", "--quiet"], { allowFail: true });

  const prod = git(["rev-parse", `origin/${productionBranch}`], { allowFail: true });
  const integ = git(["rev-parse", `origin/${integrationBranch}`], { allowFail: true });
  if (!prod.ok || !integ.ok) {
    console.error(`lanekeeper promote: could not resolve origin/${productionBranch} or origin/${integrationBranch} — are both branches created and fetched?`);
    return 1;
  }

  if (prod.out === integ.out) {
    console.log(`lanekeeper promote: ${productionBranch} already at ${integrationBranch} (${integ.out.slice(0, 7)}) — nothing to ship.`);
    return 0;
  }

  // Pure fast-forward only: origin/productionBranch must be an ancestor of
  // origin/integrationBranch.
  const ff = git(["merge-base", "--is-ancestor", `origin/${productionBranch}`, `origin/${integrationBranch}`], { allowFail: true });
  if (!ff.ok) {
    console.error(
      `lanekeeper promote: origin/${productionBranch} has commits NOT on origin/${integrationBranch} — history has diverged.\n` +
        `Someone pushed ${productionBranch} directly. Reconcile manually before promoting.\n` +
        "Left untouched — refusing to force-push production.",
    );
    return 1;
  }

  const push = git(["push", "--no-verify", "origin", `origin/${integrationBranch}:${productionBranch}`], { allowFail: true });
  if (!push.ok) {
    console.error(`lanekeeper promote: push to ${productionBranch} FAILED — production NOT updated.\n${push.out}`);
    return 1;
  }

  console.log(`lanekeeper promote: shipped ${integrationBranch} → ${productionBranch}  ${prod.out.slice(0, 7)} → ${integ.out.slice(0, 7)}`);
  return 0;
}
