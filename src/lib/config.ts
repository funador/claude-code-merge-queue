/**
 * claude-code-merge-queue.config.ts (or .js — plain JS is fine too) is the only thing
 * that changes between repos. Every command in here reads its knobs from
 * here instead of hardcoding a branch name, a repo name, or a command —
 * that's the difference between "a tool we wrote for one repo" and "a tool
 * anyone can point at theirs."
 *
 * `claude-code-merge-queue init` writes a starter config into the repo you run it from.
 * Worktree isolation itself is Claude Code's job now (native `--worktree` /
 * `isolation: worktree`) — this config is read by the WorktreeCreate hook
 * that plugs Claude Code Merge Queue's lane numbering into that, and by everything
 * downstream of it (the build queue, the landing queue, preview).
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface ClaudeCodeMergeQueueConfig {
  /** Lane branches are named "<branchPrefix><n>" — lane/1, lane/2, ... */
  branchPrefix: string;
  /** Sibling worktree dirs are named "<repo><worktreeSuffix><n>" — ../myapp-lane-1. */
  worktreeSuffix: string;
  /** First lane's dev-server port. Lane n gets portBase + n. */
  portBase: number;
  /** The shared branch `claude-code-merge-queue land` rebases onto and pushes to. */
  integrationBranch: string;
  /**
   * The production branch, if you run a two-stage model (agents land on
   * `integrationBranch`; a human promotes that to `productionBranch` on
   * their own schedule via `claude-code-merge-queue promote`). `null` means
   * `integrationBranch` IS production — no separate promotion step, and
   * `claude-code-merge-queue promote` is a no-op. When set, this branch is automatically
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
   * UNTRACKED paths that are throwaway session litter (a `scratchpad/` of run
   * logs, a temp working dir) rather than real work — safe to delete when
   * reclaiming a lane whose branch already landed and that no live session is
   * in. `git worktree remove` refuses on ANY untracked file, and a
   * regenerable-file discard can't help (untracked files were never committed,
   * so there's nothing to `git checkout` them back to) — so without this, one
   * stray `scratchpad/` pins an otherwise fully-landed, abandoned lane on disk
   * forever. Listing a path here is the standing authorization to `git clean`
   * it during that reclaim; anything NOT listed still blocks pruning and gets
   * surfaced as real uncommitted work. Empty by default — nothing untracked is
   * ever deleted until you name it here. A trailing "/" (or not) both match a
   * dir and everything under it.
   */
  disposableUntracked: string[];
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
  /**
   * The command `claude-code-merge-queue check-push` runs (in addition to the branch
   * protections) before a landing is allowed through — your lint/typecheck/
   * test/build, whatever "green" means for this repo. `null` means nothing
   * runs. That's a real, dangerous state for a tool whose whole pitch is
   * "tested before merge," so it's only silent if `checksRequired` is
   * explicitly set to `false` too — otherwise a null checkCommand FAILS the
   * push rather than landing something nobody verified.
   */
  checkCommand: string | null;
  /**
   * When true (the default) and `checkCommand` is null, `check-push` fails
   * the push instead of landing unverified code. Set to `false` yourself to
   * deliberately run with no checks — a real repo state (nothing to test
   * yet), but one that should be a visible, committed, code-reviewable
   * choice, not a silent default.
   */
  checksRequired: boolean;
}

export const DEFAULTS: ClaudeCodeMergeQueueConfig = {
  branchPrefix: "lane/",
  worktreeSuffix: "-lane-",
  portBase: 3000,
  integrationBranch: "main",
  productionBranch: null,
  protectedBranches: [],
  regenerableFiles: [],
  disposableUntracked: [],
  symlinks: [".env", ".env.local", "node_modules"],
  buildOutputDirs: ["dist", "build", ".next"],
  checkCommand: null,
  checksRequired: true,
};

/**
 * Fail loud on a malformed config instead of silently misbehaving three
 * commands later. Returns a list of human-readable problems — empty means
 * valid.
 */
export function validateConfig(cfg: ClaudeCodeMergeQueueConfig): string[] {
  const problems: string[] = [];
  const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

  if (!nonEmptyString(cfg.branchPrefix)) problems.push("branchPrefix must be a non-empty string.");
  if (!nonEmptyString(cfg.worktreeSuffix)) problems.push("worktreeSuffix must be a non-empty string.");
  if (typeof cfg.portBase !== "number" || !Number.isInteger(cfg.portBase) || cfg.portBase <= 0) {
    problems.push("portBase must be a positive integer.");
  }
  if (!nonEmptyString(cfg.integrationBranch)) problems.push("integrationBranch must be a non-empty string.");
  if (cfg.productionBranch !== null && !nonEmptyString(cfg.productionBranch)) {
    problems.push("productionBranch must be null or a non-empty string.");
  }
  if (cfg.productionBranch !== null && cfg.productionBranch === cfg.integrationBranch) {
    problems.push("productionBranch and integrationBranch are the same branch — that's a no-op two-stage model. Set productionBranch to null instead.");
  }
  if (!Array.isArray(cfg.protectedBranches) || !cfg.protectedBranches.every(nonEmptyString)) {
    problems.push("protectedBranches must be an array of non-empty strings.");
  } else if (cfg.protectedBranches.includes(cfg.integrationBranch)) {
    problems.push("protectedBranches contains integrationBranch — that branch is where claude-code-merge-queue land pushes; it can't also be blocked.");
  }
  if (!Array.isArray(cfg.regenerableFiles) || !cfg.regenerableFiles.every((v) => typeof v === "string")) {
    problems.push("regenerableFiles must be an array of strings.");
  }
  if (!Array.isArray(cfg.disposableUntracked) || !cfg.disposableUntracked.every((v) => typeof v === "string")) {
    problems.push("disposableUntracked must be an array of strings.");
  }
  if (!Array.isArray(cfg.symlinks) || !cfg.symlinks.every((v) => typeof v === "string")) {
    problems.push("symlinks must be an array of strings.");
  }
  if (!Array.isArray(cfg.buildOutputDirs) || !cfg.buildOutputDirs.every((v) => typeof v === "string")) {
    problems.push("buildOutputDirs must be an array of strings.");
  }
  if (cfg.checkCommand !== null && !nonEmptyString(cfg.checkCommand)) {
    problems.push("checkCommand must be null or a non-empty string.");
  }
  if (typeof cfg.checksRequired !== "boolean") {
    problems.push("checksRequired must be a boolean.");
  }
  return problems;
}

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
  return [join(root, "claude-code-merge-queue.config.mjs"), join(root, "claude-code-merge-queue.config.js")];
}

export function configPath(cwd: string = process.cwd()): string | null {
  const root = findRepoRoot(cwd);
  if (!root) return null;
  return candidatePaths(root).find((p) => existsSync(p)) ?? null;
}

export function hasConfig(cwd: string = process.cwd()): boolean {
  return configPath(cwd) !== null;
}

/**
 * Load claude-code-merge-queue.config.(m)js from the current repo, merged over DEFAULTS.
 * Throws with every problem listed if the merged config is invalid — a
 * config that's silently wrong is worse than a command that refuses to run.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<ClaudeCodeMergeQueueConfig> {
  const p = configPath(cwd);
  if (!p) return { ...DEFAULTS };
  const mod = (await import(pathToFileURL(p).href)) as { default?: Partial<ClaudeCodeMergeQueueConfig> };
  const cfg = { ...DEFAULTS, ...(mod.default ?? {}) };
  const problems = validateConfig(cfg);
  if (problems.length > 0) {
    throw new Error(`Invalid claude-code-merge-queue.config at ${p}:\n${problems.map((p2) => `  - ${p2}`).join("\n")}`);
  }
  return cfg;
}
