/**
 * lanekeeper.config.ts (or .js — plain JS is fine too) is the only thing
 * that changes between repos. Every command in here reads its knobs from
 * here instead of hardcoding a branch name, a repo name, or a command —
 * that's the difference between "a tool we wrote for one repo" and "a tool
 * anyone can point at theirs."
 *
 * `lanekeeper init` writes a starter config into the repo you run it from.
 * Its presence at the repo root is also the opt-in signal `launch` looks
 * for — no config file, no auto-isolation. A tool that silently changes
 * behavior in every git repo you happen to `cd` into is a worse tool than
 * one that requires you to ask for it once.
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface LaneKeeperConfig {
  /** The command your agent launches with: "claude", "codex", "cursor-agent", ... */
  agentCommand: string;
  /** Lane branches are named "<branchPrefix><n>" — lane/1, lane/2, ... */
  branchPrefix: string;
  /** Sibling worktree dirs are named "<repo><worktreeSuffix><n>" — ../myapp-lane-1. */
  worktreeSuffix: string;
  /** First lane's dev-server port. Lane n gets portBase + n. */
  portBase: number;
  /** The shared branch `lanekeeper land` rebases onto and pushes to. */
  integrationBranch: string;
  /**
   * Branches the pre-push hook refuses a *direct* push to, on top of
   * integrationBranch (which is always protected). Use this for a
   * production branch your integration branch promotes to separately —
   * e.g. ["main"] if integrationBranch is "dev".
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
  agentCommand: "claude",
  branchPrefix: "lane/",
  worktreeSuffix: "-lane-",
  portBase: 3000,
  integrationBranch: "main",
  protectedBranches: [],
  regenerableFiles: [],
  symlinks: [".env", ".env.local", "node_modules"],
  buildOutputDirs: ["dist", "build", ".next"],
};

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
