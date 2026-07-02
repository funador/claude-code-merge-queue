/**
 * lanekeeper.config.ts (or .js — plain JS is fine too) is the only thing
 * that changes between repos. Every command in here reads its knobs from
 * here instead of hardcoding a branch name, a repo name, or a command —
 * that's the difference between "a tool we wrote for one repo" and "a tool
 * anyone can point at theirs."
 *
 * `lanekeeper init` writes a starter config into the repo you run it from.
 * Worktree isolation itself is Claude Code's job now (native `--worktree` /
 * `isolation: worktree`) — this config is read by the WorktreeCreate hook
 * that plugs Lane Keeper's lane numbering into that, and by everything
 * downstream of it (the build queue, the landing queue, preview).
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface LaneKeeperConfig {
  /** Lane branches are named "<branchPrefix><n>" — lane/1, lane/2, ... */
  branchPrefix: string;
  /** Sibling worktree dirs are named "<repo><worktreeSuffix><n>" — ../myapp-lane-1. */
  worktreeSuffix: string;
  /** First lane's dev-server port. Lane n gets portBase + n. */
  portBase: number;
  /** The shared branch `lanekeeper land` rebases onto and pushes to. */
  integrationBranch: string;
  /**
   * The production branch, if you run a two-stage model (agents land on
   * `integrationBranch`; a human promotes that to `productionBranch` on
   * their own schedule via `lanekeeper promote`). `null` means
   * `integrationBranch` IS production — no separate promotion step, and
   * `lanekeeper promote` is a no-op. When set, this branch is automatically
   * protected by the pre-push hook — you don't need to also list it in
   * `protectedBranches`.
   */
  productionBranch: string | null;
  /**
   * Extra branches the pre-push hook refuses a *direct* push to, beyond
   * integrationBranch (always protected) and productionBranch (protected
   * automatically when set). Most repos running the standard two-stage
   * model don't need this at all.
   */
  protectedBranches: string[];
  /**
   * Files a build tool regenerates on its own (next-env.d.ts, a rewritten
   * tsconfig "include" array, ...) that should never block a rebase or a
   * fast-forward. Empty by default — you'll meet your first one the hard
   * way, and then you add it here once, for good.
   */
  regenerableFiles: string[];
  /**
   * Git-ignored paths copied by reference (symlinked) into every new lane
   * so it never needs a fresh install or a copy of your secrets.
   */
  symlinks: string[];
  /**
   * Build-output directories `preview` never copies onto the main checkout,
   * on top of the fixed, always-excluded set (.git, node_modules, .env,
   * .env.local). `preview` itself doesn't know or care what framework
   * you're running — it just rsyncs source files onto a checkout your dev
   * server is watching. The default list covers the common cases; add your
   * own (".output" for Nuxt, ".svelte-kit" for SvelteKit, ...) rather than
   * assuming this tool knows your build tool.
   */
  buildOutputDirs: string[];
}

export const DEFAULTS: LaneKeeperConfig = {
  branchPrefix: "lane/",
  worktreeSuffix: "-lane-",
  portBase: 3000,
  integrationBranch: "main",
  productionBranch: null,
  protectedBranches: [],
  regenerableFiles: [],
  symlinks: [".env", ".env.local", "node_modules"],
  buildOutputDirs: ["dist", "build", ".next"],
};

/**
 * The repo's actual current branch, so `init` doesn't blindly assume "main"
 * — plenty of real repos still default to "master" (or something else
 * entirely), and a generated config pointing at a branch that doesn't exist
 * is exactly the kind of out-of-the-box friction this tool exists to avoid.
 * Returns null (letting the caller fall back to DEFAULTS) if there's no
 * commit yet or HEAD is detached.
 */
export function detectCurrentBranch(cwd: string = process.cwd()): string | null {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

export function findRepoRoot(cwd: string = process.cwd()): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function candidatePaths(root: string): string[] {
  return [join(root, "lanekeeper.config.mjs"), join(root, "lanekeeper.config.js")];
}

export function configPath(cwd: string = process.cwd()): string | null {
  const root = findRepoRoot(cwd);
  if (!root) return null;
  return candidatePaths(root).find((p) => existsSync(p)) ?? null;
}

export function hasConfig(cwd: string = process.cwd()): boolean {
  return configPath(cwd) !== null;
}

/** Load lanekeeper.config.(m)js from the current repo, merged over DEFAULTS. */
export async function loadConfig(cwd: string = process.cwd()): Promise<LaneKeeperConfig> {
  const p = configPath(cwd);
  if (!p) return { ...DEFAULTS };
  const mod = (await import(pathToFileURL(p).href)) as { default?: Partial<LaneKeeperConfig> };
  return { ...DEFAULTS, ...(mod.default ?? {}) };
}
