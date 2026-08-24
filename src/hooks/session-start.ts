/**
 * The Claude Code SessionStart hook. Every new lane's session (and every
 * resumed one — no matcher is wired, so this fires on all of startup/
 * resume/clear/compact/fork) runs this once, giving `reconcile`'s findings
 * a channel that doesn't depend on a human remembering to run it by hand.
 * Without this, a lane whose land failed (or one that was created and never
 * used) is invisible until someone happens to notice extra folders on disk —
 * confirmed: a stranded lane with real unlanded commits sat for ~17 hours,
 * discovered only because the human happened to look in Finder.
 *
 * SessionStart is the one hook event whose plain stdout text on a
 * successful (exit 0) run is injected directly into the new session's
 * context (Claude Code docs: "Claude Code adds plain text your command
 * writes to stdout to Claude's context") — unlike most other hook events,
 * where exit-0 stdout only reaches the debug log and is never shown.
 * That's what makes this the right hook for an ADVISORY, and why
 * WorktreeCreate can't carry the same message itself: its stdout contract
 * is reserved for exactly the new worktree's path (see worktree-create.ts).
 *
 * Silent (zero stdout) whenever there's nothing stranded, or when the repo
 * isn't claude-code-merge-queue-managed at all — a clean fleet, or an
 * unrelated project, produces no extra noise at session start. Never
 * blocks, never touches a lane: same read-only contract as `reconcile`
 * (see findOrphanedLanes in prune-lanes.ts) — this only tells a human,
 * exactly like reconcile and land's post-land surfacing already do.
 */
import { hasConfig, loadConfig, findRepoRoot } from "../lib/config.js";
import { resolveMainCheckout } from "../lib/main-checkout.js";
import { findOrphanedLanes, describeOrphanedLane } from "../lib/prune-lanes.js";

interface HookInput {
  cwd?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Pure formatting, split out for easy unit testing without spawning real git. */
export function formatOrphanedLanesAdvisory(
  orphaned: ReturnType<typeof findOrphanedLanes>,
  integrationBranch: string,
): string | null {
  if (orphaned.length === 0) return null;
  const n = orphaned.length;
  const lines = [
    `claude-code-merge-queue: ${n} sibling lane${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} a decision — none touched:`,
    ...orphaned.map((o) => `  ⚠ ${describeOrphanedLane(o, integrationBranch)}`),
    "",
    "Surface this to the human and ask what to do with each — finish landing it, or discard it. Never silently delete a lane with unlanded commits or uncommitted work.",
  ];
  return lines.join("\n");
}

export async function runSessionStartHook(): Promise<void> {
  let input: HookInput = {};
  try {
    input = JSON.parse(await readStdin()) as HookInput;
  } catch {
    /* no/invalid stdin — fall back to process.cwd() below */
  }
  const fromCwd = input.cwd ?? process.cwd();

  try {
    const root = findRepoRoot(fromCwd);
    if (!root || !hasConfig(root)) {
      process.exit(0);
      return;
    }
    const cfg = await loadConfig(root);
    const mainTop = resolveMainCheckout(fromCwd);
    const orphaned = findOrphanedLanes(mainTop, cfg, fromCwd);
    const advisory = formatOrphanedLanesAdvisory(orphaned, cfg.integrationBranch);
    if (advisory) process.stdout.write(advisory + "\n");
    process.exit(0);
  } catch {
    // Best-effort advisory only — a session start must never fail over this.
    process.exit(0);
  }
}
