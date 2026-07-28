/**
 * build-lock.ts — wrap any command so only ONE runs at a time, machine-wide,
 * across every lane of this repo.
 *
 * A full production build is CPU/RAM-heavy. Run one per lane and four
 * parallel agents will thrash a laptop into a death spiral. This doesn't
 * make builds faster — it makes them take turns, via the same cross-worktree
 * FIFO lock everything else in this repo shares (queue-lock.ts).
 *
 *   Usage:  claude-code-merge-queue build-lock -- <shell command>
 *
 * Crash-safe with no timeouts: a lock whose holder PID has died is reclaimed
 * deterministically, so a killed build can't wedge the queue for anyone
 * else. That's also why the child is spawned detached — SIGKILLing this
 * process still leaves an orphaned build running unless something can reach
 * its whole process group, so a caller that wants to hard-kill a build (a CI
 * runner enforcing a deadline, say) needs a group to signal, not just a PID.
 *
 * Only SIGINT/SIGTERM cascade-kill the child's process group — genuine
 * "someone wants this to stop" signals. SIGHUP does NOT: the CLI bin
 * entrypoint ignores it globally (see claude-code-merge-queue.ts), because a
 * long-running backgrounded build (an AI agent runs this detached from its
 * own turn) can receive a stray SIGHUP purely from its controlling
 * session/terminal going away, which has nothing to do with anyone wanting
 * to abort the build — treating it as an abort request killed real,
 * in-progress, otherwise-green work for no reason.
 */
import { spawn } from "node:child_process";
import { createQueueLock } from "./lib/queue-lock.js";

export async function buildLock(commandParts: string[]): Promise<void> {
  const command = commandParts.join(" ").trim();
  if (!command) {
    console.error("claude-code-merge-queue build-lock: no command given. Usage: claude-code-merge-queue build-lock -- <command>");
    process.exit(2);
  }

  const lock = createQueueLock("build");

  await lock.acquire({
    label: command,
    onWait: ({ ahead, holder }) => {
      if (ahead > 0) {
        console.log(`\x1b[2m[build-queue] ${lock.lane}: waiting — ${ahead} build${ahead === 1 ? "" : "s"} ahead…\x1b[0m`);
      } else if (holder) {
        console.log(`\x1b[2m[build-queue] ${lock.lane}: next up — waiting for the running build to finish…\x1b[0m`);
      }
    },
  });

  console.log(`\x1b[2m[build-queue] ${lock.lane}: lock acquired — building…\x1b[0m`);

  const child = spawn(command, { shell: true, stdio: "inherit", detached: true });

  // SIGHUP deliberately excluded — see the file header. Only a genuine
  // operator/CI-initiated stop (Ctrl-C, or a deadline-enforcing SIGTERM)
  // should cascade-kill the wrapped build.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      try {
        // detached:true made the child its own process-group leader, so a
        // negative pid signals the whole tree, not just the shell wrapper.
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        /* noop */
      }
      lock.release();
      process.exit(130);
    });
  }

  child.on("exit", (code, signal) => {
    lock.release();
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  });
  child.on("error", (err) => {
    console.error(`claude-code-merge-queue build-lock: failed to start command: ${err.message}`);
    lock.release();
    process.exit(1);
  });
}
