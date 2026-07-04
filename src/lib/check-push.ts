/**
 * The enforcement half of the landing queue. `land.ts` (and `promote.ts`)
 * are *conventions* — "always land through here" — and conventions are
 * exactly the kind of rule a confused agent, or a human moving fast,
 * eventually skips by hand-rolling `git push`. This is the mechanism that
 * makes the convention unnecessary to trust: it reads the same ref-update
 * lines git's pre-push hook always gets on stdin, and rejects a direct push
 * to the integration branch or any protected/production branch by default.
 *
 * `land.ts` sets CLAUDE_CODE_LOCAL_MERGE_LANDING=1 right before its own push — that's
 * the only thing that legitimately unblocks the integration branch on the
 * normal path. `promote.ts` pushes to productionBranch with `--no-verify`,
 * which skips this hook entirely (same as git always does for --no-verify).
 *
 * Every branch here (including the integration branch, which used to have
 * NO override at all) also has a genuine emergency hatch: set
 * CLAUDE_CODE_LOCAL_MERGE_EMERGENCY_PUSH=1 and push. One env var, no prompts, no second
 * factor to remember — the same trust model as CLAUDE_CODE_LOCAL_MERGE_LANDING=1 above
 * it. This is a convention, not a hard guarantee: it stops mistakes and
 * stray pushes, not a truly adversarial agent that sets it itself. Worth
 * knowing, not worth building 18 hoops to (marginally) defend against.
 */
import type { ClaudeCodeLocalMergeConfig } from "./config.js";

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

function emergencyConfirmed(env: NodeJS.ProcessEnv): boolean {
  return env.CLAUDE_CODE_LOCAL_MERGE_EMERGENCY_PUSH === "1";
}

export function checkPush(
  refUpdates: RefUpdate[],
  cfg: Pick<ClaudeCodeLocalMergeConfig, "integrationBranch" | "productionBranch" | "protectedBranches">,
  env: NodeJS.ProcessEnv,
): CheckResult {
  const integrationRef = `refs/heads/${cfg.integrationBranch}`;
  const protectedBranches = cfg.productionBranch ? [...cfg.protectedBranches, cfg.productionBranch] : cfg.protectedBranches;
  const protectedRefs = new Set(protectedBranches.map((b) => `refs/heads/${b}`));

  for (const { remoteRef } of refUpdates) {
    const branch = remoteRef.replace("refs/heads/", "");

    if (protectedRefs.has(remoteRef) && !emergencyConfirmed(env)) {
      return {
        ok: false,
        message: [
          "",
          `✋ Direct pushes to '${branch}' are blocked.`,
          `   This is a protected branch — promote it deliberately, not with a stray push.`,
          `   Emergency override:  CLAUDE_CODE_LOCAL_MERGE_EMERGENCY_PUSH=1 git push …`,
          "",
        ].join("\n"),
      };
    }
    if (remoteRef === integrationRef && env.CLAUDE_CODE_LOCAL_MERGE_LANDING !== "1" && !emergencyConfirmed(env)) {
      return {
        ok: false,
        message: [
          "",
          `✋ Direct pushes to '${cfg.integrationBranch}' are blocked — landing goes through the queue.`,
          `   Land your work:  claude-code-local-merge land`,
          `   Genuine emergency:  CLAUDE_CODE_LOCAL_MERGE_EMERGENCY_PUSH=1 git push …`,
          "",
        ].join("\n"),
      };
    }
  }
  return { ok: true };
}
