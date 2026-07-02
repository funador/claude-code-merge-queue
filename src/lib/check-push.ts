/**
 * The enforcement half of the landing queue. `land.ts` is a *convention* —
 * "always land through here" — and conventions are exactly the kind of rule
 * a confused agent, or a human moving fast, eventually skips by hand-rolling
 * `git push`. This is the mechanism that makes the convention unnecessary to
 * trust: it reads the same ref-update lines git's pre-push hook always gets
 * on stdin, and rejects a direct push to the integration branch unless
 * LANEKEEPER_LANDING=1 is set — which only `land.ts` sets, right before its
 * own push.
 *
 * Same idea for `protectedBranches`: a push straight to a production branch
 * gets bounced unless LANEKEEPER_ALLOW_PROTECTED_PUSH=1 is set by hand, for
 * the rare deliberate exception.
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

export function checkPush(
  refUpdates: RefUpdate[],
  cfg: Pick<LaneKeeperConfig, "integrationBranch" | "protectedBranches">,
  env: NodeJS.ProcessEnv,
): CheckResult {
  const integrationRef = `refs/heads/${cfg.integrationBranch}`;
  const protectedRefs = new Set(cfg.protectedBranches.map((b) => `refs/heads/${b}`));

  for (const { remoteRef } of refUpdates) {
    if (protectedRefs.has(remoteRef) && env.LANEKEEPER_ALLOW_PROTECTED_PUSH !== "1") {
      const branch = remoteRef.replace("refs/heads/", "");
      return {
        ok: false,
        message: [
          "",
          `✋ Direct pushes to '${branch}' are blocked.`,
          `   This is a protected branch — promote it deliberately, not with a stray push.`,
          `   Emergency override: LANEKEEPER_ALLOW_PROTECTED_PUSH=1 git push …`,
          "",
        ].join("\n"),
      };
    }
    if (remoteRef === integrationRef && env.LANEKEEPER_LANDING !== "1") {
      return {
        ok: false,
        message: [
          "",
          `✋ Direct pushes to '${cfg.integrationBranch}' are blocked — landing goes through the queue.`,
          `   Land your work:  lanekeeper land`,
          "",
        ].join("\n"),
      };
    }
  }
  return { ok: true };
}
