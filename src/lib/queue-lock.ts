/**
 * A generic, cross-worktree FIFO lock: the one primitive every other command
 * in this repo is built on. `build-lock` and `land` are the same core idea —
 * "serialize one action, machine-wide" — wearing two different hats.
 *
 * One queue name = one global mutex for this repo, shared by every worktree
 * of it (keyed off git's common dir, so a different clone gets its own queue
 * and two unrelated repos never contend with each other).
 *
 * Design:
 *   - FIFO: each waiter enrolls a timestamped ticket and only competes for
 *     the lock once it owns the oldest still-live ticket. No starvation, no
 *     "whoever polls fastest wins."
 *   - Crash-safe with NO timeouts, so there's no magic staleness threshold to
 *     tune: a lock or ticket whose holder PID is no longer alive is reclaimed
 *     the instant another waiter checks. Kill -9 the holder mid-lock and the
 *     queue heals itself on the next poll.
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  linkSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";

// How often a waiter re-checks whether it's its turn. Not a behavioral cap —
// just poll granularity.
const POLL_MS = 200;

// A held-but-alive lock is never force-released (see tryTakeLock) — reclaiming
// it from a live holder would recreate the exact race this lock exists to
// prevent. But a holder that's alive and genuinely wedged (e.g. a hung network
// call with no timeout) can otherwise block the whole queue silently, with no
// signal beyond a human manually inspecting `ps`. Surface it instead: once a
// holder has sat on the lock this long, keep re-announcing periodically so a
// waiter can go look, without ever acting on the caller's behalf.
const STUCK_HOLDER_WARN_AFTER_MS = 5 * 60 * 1000;

interface LockHolder {
  pid: number;
  lane: string;
  label?: string;
  ts: number;
}

export interface AcquireOptions {
  label?: string;
  onWait?: (info: { ahead: number; holder: LockHolder | null; holderElapsedMs?: number }) => void;
  // Overridable so tests don't have to wait out the real 5 minutes to exercise
  // the stuck-holder path.
  stuckWarnAfterMs?: number;
}

export interface QueueLock {
  acquire(options?: AcquireOptions): Promise<void>;
  release(): void;
  readonly lane: string;
  readonly held: boolean;
}

function repoKey(): string {
  try {
    const commonDir = execSync("git rev-parse --git-common-dir", {
      encoding: "utf8",
    }).trim();
    // Resolve to an absolute, worktree-independent path so every worktree of
    // the same repo hashes to the same queue.
    return execSync(`cd "${commonDir}" && pwd -P`, { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

/**
 * Create a named FIFO lock. Each distinct `queueName` is an independent
 * mutex — "build" and "land" never contend with each other even though
 * they share this exact same code.
 */
export function createQueueLock(queueName: string): QueueLock {
  const QUEUE_DIR = join(
    tmpdir(),
    `claude-code-merge-queue-${queueName}-queue-${createHash("sha1").update(repoKey()).digest("hex").slice(0, 12)}`,
  );
  const TICKETS_DIR = join(QUEUE_DIR, "tickets");
  const LOCK_FILE = join(QUEUE_DIR, "lock");
  mkdirSync(TICKETS_DIR, { recursive: true });

  const lane = basename(process.cwd());
  const ME = process.pid;
  const TICKET_TS = Date.now();
  const TICKET_NAME = `${TICKET_TS}-${ME}`;
  const TICKET_FILE = join(TICKETS_DIR, TICKET_NAME);

  function alive(pid: number): boolean {
    if (!pid || pid === ME) return pid === ME;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but owned by someone else
    }
  }

  function pidOf(name: string): number {
    const dash = name.lastIndexOf("-");
    return dash === -1 ? 0 : Number(name.slice(dash + 1));
  }

  function pruneDeadTickets(): string[] {
    let names: string[];
    try {
      names = readdirSync(TICKETS_DIR);
    } catch {
      return [];
    }
    const live: string[] = [];
    for (const name of names) {
      if (alive(pidOf(name))) {
        live.push(name);
      } else {
        try {
          unlinkSync(join(TICKETS_DIR, name));
        } catch {
          /* someone else cleaned it */
        }
      }
    }
    live.sort((a, b) => {
      const [ta, pa] = a.split("-").map(Number) as [number, number];
      const [tb, pb] = b.split("-").map(Number) as [number, number];
      return ta - tb || pa - pb;
    });
    return live;
  }

  function readLockHolder(): LockHolder | null {
    try {
      return JSON.parse(readFileSync(LOCK_FILE, "utf8")) as LockHolder;
    } catch {
      return null;
    }
  }

  // Atomically take the lock via link() (fails if it already exists). Reclaim
  // a lock whose holder is dead. Returns true iff we now hold it.
  function tryTakeLock(info: LockHolder): boolean {
    const tmp = `${LOCK_FILE}.${ME}.tmp`;
    writeFileSync(tmp, JSON.stringify(info));
    try {
      linkSync(tmp, LOCK_FILE);
      unlinkSync(tmp);
      return true;
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
        /* noop */
      }
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const holder = readLockHolder();
      if (!holder || !alive(holder.pid)) {
        try {
          unlinkSync(LOCK_FILE);
        } catch {
          /* another waiter beat us to it */
        }
      }
      return false;
    }
  }

  let HOLD = false;
  function release(): void {
    if (HOLD) {
      const holder = readLockHolder();
      if (holder && holder.pid === ME) {
        try {
          unlinkSync(LOCK_FILE);
        } catch {
          /* already gone */
        }
      }
      HOLD = false;
    }
    try {
      unlinkSync(TICKET_FILE);
    } catch {
      /* already gone */
    }
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * Wait for and take the lock. `onWait({ahead, holder})` fires whenever the
   * queue position changes, so callers can print progress.
   */
  async function acquire({ label, onWait, stuckWarnAfterMs = STUCK_HOLDER_WARN_AFTER_MS }: AcquireOptions = {}): Promise<void> {
    writeFileSync(TICKET_FILE, JSON.stringify({ pid: ME, lane, label, ts: TICKET_TS }));
    let announced = -1;
    // Counts how many STUCK_HOLDER_WARN_AFTER_MS-sized intervals we've already
    // warned about for the current holder, so a long wait re-announces every
    // interval instead of spamming every poll. `holder.ts` (set when the lock
    // was taken) is the shared clock, not "when this waiter first noticed" —
    // every waiter agrees on the same elapsed time regardless of when it
    // joined the queue.
    let stuckWarnCount = 0;
    for (;;) {
      const queue = pruneDeadTickets();
      const ahead = queue.indexOf(TICKET_NAME); // 0 = our turn
      const holder = readLockHolder();
      const lockFree = !holder || !alive(holder.pid);

      if (ahead <= 0 && lockFree) {
        if (tryTakeLock({ pid: ME, lane, label, ts: Date.now() })) {
          HOLD = true;
          try {
            unlinkSync(TICKET_FILE);
          } catch {
            /* noop */
          }
          return;
        }
      }

      if (ahead > 0 && ahead !== announced) {
        announced = ahead;
        stuckWarnCount = 0;
        onWait?.({ ahead, holder: null });
      } else if (ahead <= 0 && holder && alive(holder.pid)) {
        if (announced !== 0) {
          announced = 0;
          stuckWarnCount = 0;
          onWait?.({ ahead: 0, holder });
        }
        const holderElapsedMs = Date.now() - holder.ts;
        const dueWarns = Math.floor(holderElapsedMs / stuckWarnAfterMs);
        if (dueWarns > stuckWarnCount) {
          stuckWarnCount = dueWarns;
          onWait?.({ ahead: 0, holder, holderElapsedMs });
        }
      }
      await sleep(POLL_MS);
    }
  }

  // Best-effort release on graceful exit. Deliberately NOT registering
  // SIGINT/SIGTERM/SIGHUP handlers here: adding any listener for those
  // signals cancels Node's default "terminate the process" behavior, and
  // this module doesn't own whether/how a caller's process should exit
  // (build-lock.ts needs its OWN signal handler to kill a child's process
  // group first). Correctness doesn't depend on this firing anyway — a
  // lock/ticket left behind by a killed process is reclaimed deterministically
  // by the next acquire() via the PID-liveness check above, same as a SIGKILL.
  process.on("exit", release);

  return {
    acquire,
    release,
    lane,
    get held() {
      return HOLD;
    },
  };
}
