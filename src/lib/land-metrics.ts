/**
 * A rolling local log of `land` run timings — not correctness-critical, just
 * a debugging aid. When landing suddenly gets slower, this is what answers
 * "since when, and which phase" instead of a guess: each run's queue-wait,
 * fetch, rebase, reinstall, push (which includes the pre-push hook's own
 * checks — usually the dominant cost), and sync durations, plus the commit
 * that was actually pushed, so a spike can be lined up against `git log`.
 *
 * Stored inside the repo's git-common-dir (not the OS temp dir) so it
 * survives a reboot and is shared by every worktree/lane of the repo, the
 * same way the queue locks are keyed — but it's plain JSON, never
 * git-tracked, and capped at MAX_RUNS so it can't grow unbounded.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoKey } from "./queue-lock.js";

const MAX_RUNS = 100;

export type LandOutcome = "landed" | "rebase-conflict" | "push-failed";

export interface LandRunPhases {
  /** Time spent waiting in the FIFO queue before this run got the lock. */
  queueWaitMs: number;
  fetchMs: number;
  rebaseMs: number;
  /** null when the rebase didn't touch a lockfile, so no reinstall ran. */
  reinstallMs: number | null;
  /** Includes the pre-push hook's checks — usually the dominant cost. */
  pushMs: number;
  /** null when the run didn't reach sync (rebase conflict / push failure). */
  syncMs: number | null;
}

export interface LandRunRecord {
  ts: string;
  lane: string;
  branch: string;
  /** HEAD at push time (post-rebase), so a run maps back to a real commit. */
  commit: string | null;
  outcome: LandOutcome;
  totalMs: number;
  phases: LandRunPhases;
}

function metricsPath(): string {
  return join(repoKey(), "claude-code-merge-queue", "land-metrics.json");
}

function readAll(file: string): LandRunRecord[] {
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // corrupt/partial file — never let a debugging log block landing
  }
}

/**
 * Append one run, trimming to the last MAX_RUNS. Called once per `land`
 * invocation, always from inside the same critical section the "land" queue
 * lock already serializes — so there's no cross-lane concurrent-write race
 * to guard against here, just an ordinary read-modify-write.
 */
export function recordLandRun(record: LandRunRecord): void {
  try {
    const file = metricsPath();
    mkdirSync(join(repoKey(), "claude-code-merge-queue"), { recursive: true });
    const entries = readAll(file);
    entries.push(record);
    const trimmed = entries.length > MAX_RUNS ? entries.slice(entries.length - MAX_RUNS) : entries;
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
    renameSync(tmp, file);
  } catch {
    /* best-effort — a debugging log must never fail a real landing */
  }
}

export function readLandMetrics(): LandRunRecord[] {
  return readAll(metricsPath());
}
