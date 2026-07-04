/**
 * The part of the merge queue that actually earns the name: running your
 * lint/typecheck/test/build before a landing is allowed through. Without
 * this, "merge queue" is just "push queue" — serialized, but blind.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { MergeQueueConfig } from "./config.js";

// Priority order: prefer a script that already bundles multiple checks
// (a repo's own "check" or CI script) over a narrower "test" script, but
// take whatever exists rather than assume one specific name.
const CANDIDATE_SCRIPTS = ["check:push", "check", "ci", "test"];

/**
 * Which package manager actually installed this project — detected from its
 * lockfile, since that's the one signal that's always there regardless of
 * what's on PATH. Defaulting straight to npm regardless of the real answer
 * isn't a hypothetical: a pnpm workspace's scripts can rely on pnpm-specific
 * behavior (workspace: protocol deps, `--filter`), and `npm run` may not
 * even be installed on a pnpm/yarn/bun-only machine.
 */
export function detectPackageManager(root: string): "npm" | "pnpm" | "yarn" | "bun" {
  if (existsSync(join(root, "pnpm-lock.yaml")) || existsSync(join(root, "pnpm-workspace.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  return "npm";
}

/** Look at package.json's own scripts for something to run — best-effort, never throws. */
export function detectCheckCommand(root: string): string | null {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    const found = CANDIDATE_SCRIPTS.find((name) => pkg.scripts?.[name]);
    return found ? `${detectPackageManager(root)} run ${found}` : null;
  } catch {
    return null;
  }
}

/**
 * Run the configured check command. Returns the exit code to propagate.
 *
 * A null checkCommand is only ever silent if checksRequired was explicitly
 * turned off — the default is to FAIL the push, because a merge queue that
 * lets unverified code through by default isn't one, it's a false sense of
 * safety.
 *
 * Always runs from `root`, not whatever the caller's cwd happens to be. In
 * the real git-push flow that's moot — git always resets cwd to the repo
 * root before running a hook — but `check-push` is also a directly
 * user-runnable command, and silently depending on git's hook behavior for
 * correctness (instead of just being correct on its own) is exactly the
 * kind of implicit assumption that bites the first time someone runs it by
 * hand from a subdirectory.
 */
export function runCheckCommand(cfg: Pick<MergeQueueConfig, "checkCommand" | "checksRequired">, root: string): number {
  if (!cfg.checkCommand) {
    if (cfg.checksRequired) {
      console.error([
        "",
        "✋ No checkCommand configured, and checksRequired is true (the default).",
        "   This push would land with NOTHING verifying it — no lint, no test, no build.",
        "   Set checkCommand in mergequeue.config.mjs, e.g. \"npm run check\".",
        "   Or, if you really have nothing to check yet, set checksRequired: false —",
        "   deliberately, so it's a visible, committed choice, not a silent gap.",
        "",
      ].join("\n"));
      return 1;
    }
    console.log("mergequeue check-push: no checkCommand configured (checksRequired: false — running with no checks, on purpose).");
    return 0;
  }

  console.log(`mergequeue check-push: running "${cfg.checkCommand}"…`);
  const result = spawnSync(cfg.checkCommand, { shell: true, stdio: "inherit", cwd: root });
  if (result.status !== 0) {
    console.error(`\n✋ checkCommand failed (exit ${result.status ?? 1}) — landing blocked.`);
  }
  return result.status ?? 1;
}
