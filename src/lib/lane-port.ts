/**
 * A lane's dev-server port, derived from where it's sitting on disk rather
 * than an injected environment variable. Claude Code's WorktreeCreate hook
 * has no mechanism to hand environment variables to the session that runs
 * in the worktree it creates — only the directory path. So instead of
 * betting on a second, less-certain hook (SessionStart + CLAUDE_ENV_FILE)
 * to smuggle a port in, the worktree's own name already carries it: Lane
 * Keeper names worktrees "<repo><worktreeSuffix><n>", so any script running
 * inside one can read its own lane number straight off `process.cwd()`.
 * Self-describing beats injected, when the information's already sitting
 * right there in the path.
 */
import { basename } from "node:path";
import type { ClaudeCodeLocalMergeConfig } from "./config.js";

export function laneNumberFromPath(path: string, cfg: Pick<ClaudeCodeLocalMergeConfig, "worktreeSuffix">): number | null {
  const name = basename(path);
  const idx = name.lastIndexOf(cfg.worktreeSuffix);
  if (idx === -1) return null;
  const n = Number(name.slice(idx + cfg.worktreeSuffix.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function lanePort(path: string, cfg: Pick<ClaudeCodeLocalMergeConfig, "worktreeSuffix" | "portBase">): number | null {
  const lane = laneNumberFromPath(path, cfg);
  return lane === null ? null : cfg.portBase + lane;
}
