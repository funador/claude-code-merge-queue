/**
 * The enforcement half of the landing queue. `land.ts` (and `promote.ts`)
 * are *conventions* — "always land through here" — and conventions are
 * exactly the kind of rule a confused agent, or a human moving fast,
 * eventually skips by hand-rolling `git push`. This is the mechanism that
 * makes the convention unnecessary to trust: it reads the same ref-update
 * lines git's pre-push hook always gets on stdin, and rejects a direct push
 * to the integration branch or any protected/production branch by default.
 *
 * `land.ts` sets LANEKEEPER_LANDING=1 right before its own push — that's
 * the only thing that legitimately unblocks the integration branch on the
 * normal path. `promote.ts` pushes to productionBranch with `--no-verify`,
 * which skips this hook entirely (same as git always does for --no-verify).
 *
 * Every branch here (including the integration branch, which used to have
 * NO override at all) also has a genuine emergency hatch: set
 * LANEKEEPER_EMERGENCY_PUSH_CONFIRM=<exact branch name> and push. Naming the
 * specific branch IS the confirmation — a boolean flag next to it wouldn't
 * add anything a script or a fat-fingered alias couldn't set just as easily.
 * The CLI's check-push handler also offers a live convenience for a human
 * sitting at a real terminal: set LANEKEEPER_EMERGENCY_PUSH=1 alone and it
 * prompts you interactively for the branch name and fills CONFIRM in for
 * you — same one env var either way, just typed at a different moment.
 */
import type { LaneKeeperConfig } from "./config.js";

export interface RefUpdate {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

export interface CheckResult {
  ok: boolean;
  message?: string;
}

export function parseRefUpdates(stdin: string): RefUpdate[] {
  return stdin
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
      return { localRef: localRef ?? "", localSha: localSha ?? "", remoteRef: remoteRef ?? "", remoteSha: remoteSha ?? "" };
    });
}

function emergencyConfirmed(branch: string, env: NodeJS.ProcessEnv): boolean {
  return env.LANEKEEPER_EMERGENCY_PUSH_CONFIRM === branch;
}

export function checkPush(
  refUpdates: RefUpdate[],
  cfg: Pick<LaneKeeperConfig, "integrationBranch" | "productionBranch" | "protectedBranches">,
  env: NodeJS.ProcessEnv,
): CheckResult {
  const integrationRef = `refs/heads/${cfg.integrationBranch}`;
  const protectedBranches = cfg.productionBranch ? [...cfg.protectedBranches, cfg.productionBranch] : cfg.protectedBranches;
  const protectedRefs = new Set(protectedBranches.map((b) => `refs/heads/${b}`));

  for (const { remoteRef } of refUpdates) {
    const branch = remoteRef.replace("refs/heads/", "");

    if (protectedRefs.has(remoteRef) && !emergencyConfirmed(branch, env)) {
      return {
        ok: false,
        message: [
          "",
          `✋ Direct pushes to '${branch}' are blocked.`,
          `   This is a protected branch — promote it deliberately, not with a stray push.`,
          `   Emergency override:  LANEKEEPER_EMERGENCY_PUSH_CONFIRM=${branch} git push …`,
          `   (or set LANEKEEPER_EMERGENCY_PUSH=1 alone to type "${branch}" at an interactive prompt instead).`,
          "",
        ].join("\n"),
      };
    }
    if (remoteRef === integrationRef && env.LANEKEEPER_LANDING !== "1" && !emergencyConfirmed(branch, env)) {
      return {
        ok: false,
        message: [
          "",
          `✋ Direct pushes to '${cfg.integrationBranch}' are blocked — landing goes through the queue.`,
          `   Land your work:  lanekeeper land`,
          `   Genuine emergency:  LANEKEEPER_EMERGENCY_PUSH_CONFIRM=${cfg.integrationBranch} git push …`,
          `   (or set LANEKEEPER_EMERGENCY_PUSH=1 alone to type "${cfg.integrationBranch}" at an interactive prompt instead).`,
          "",
        ].join("\n"),
      };
    }
  }
  return { ok: true };
}
