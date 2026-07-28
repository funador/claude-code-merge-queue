// Spawns the actual CLI bin entrypoint as a real child process (not
// buildLock() called in-process, and not through an extra wrapper script)
// and signals THAT process directly — the fix under test spans TWO layers
// (the bin entrypoint's global SIGHUP ignore, and build-lock.ts no longer
// forwarding SIGHUP to its child), and both only apply to a process actually
// running the bin. An earlier draft of this test signaled an unrelated
// wrapper process instead of the bin itself and consequently proved nothing.
//
// No fixed delays anywhere: readiness is the "lock acquired" line build-lock
// itself prints plus the wrapped child's own start marker, and the wrapped
// child's LIFETIME is driven by a release file the test writes explicitly —
// never a guessed "surely long enough by then" duration. (A first draft used
// `sleep(300)` before signaling; it passed locally but failed on a colder CI
// runner where tsx's transpile + module resolution hadn't finished registering
// the SIGHUP handler yet — exactly the class of flake a real deadline, not a
// timer, avoids.) The only polling here is a tight setImmediate loop, which
// is a mechanical granularity, not a behavioral threshold — same category as
// queue-lock.ts's own POLL_MS.
//
// Born from a real incident: build-lock.ts used to forward SIGHUP into the
// wrapped build's process group as an abort — but SIGHUP also fires from a
// merely-backgrounded process's controlling session/terminal going away (not
// a deliberate kill), which killed several real, in-progress, otherwise-green
// `land` runs for no reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../src/bin/claude-code-merge-queue.ts", import.meta.url));

function waitExit(child: ChildProcess): Promise<number | null> {
  return new Promise((res) => child.on("exit", (code) => res(code)));
}

/** Resolves once `child`'s stdout has emitted a chunk containing `substring`. */
function waitForStdout(child: ChildProcess, substring: string): Promise<void> {
  return new Promise((resolve) => {
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes(substring)) {
        child.stdout?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
  });
}

/** Tight existence poll — a mechanical wait for a real event, not a timeout. */
function waitForFile(path: string): Promise<void> {
  return new Promise((resolve) => {
    (function poll() {
      if (existsSync(path)) resolve();
      else setImmediate(poll);
    })();
  });
}

/**
 * The wrapped command: writes `startedFile` the instant it runs (so the test
 * knows it's actually mid-flight, not just that build-lock decided to spawn
 * it), then polls for `releaseFile` and writes `doneFile` once released. The
 * test controls the wrapped process's entire lifetime by creating/never
 * creating releaseFile — no timer anywhere in this chain.
 */
function spawnBuildLock(startedFile: string, releaseFile: string, doneFile: string): ChildProcess {
  const wrapped =
    `node -e "require('fs').writeFileSync('${startedFile}','1');` +
    `(function poll(){if(require('fs').existsSync('${releaseFile}')){require('fs').writeFileSync('${doneFile}','1');}` +
    `else{setImmediate(poll);}})()"`;
  return spawn(process.execPath, ["--import", "tsx", BIN, "build-lock", "--", wrapped], {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("build-lock survives a SIGHUP mid-build — only SIGINT/SIGTERM abort it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-build-lock-test-"));
  const startedFile = join(dir, "started");
  const releaseFile = join(dir, "release");
  const doneFile = join(dir, "done");

  const child = spawnBuildLock(startedFile, releaseFile, doneFile);
  await waitForStdout(child, "lock acquired");
  await waitForFile(startedFile); // the wrapped command is genuinely running now

  child.kill("SIGHUP");
  writeFileSync(releaseFile, "1"); // let the wrapped command finish, if it's still alive to notice

  const code = await waitExit(child);

  assert.equal(code, 0, "build-lock's own process should exit cleanly, not be torn down by SIGHUP");
  assert.ok(existsSync(doneFile), "the wrapped command must have been allowed to actually finish — SIGHUP must not abort it");

  rmSync(dir, { recursive: true, force: true });
});

test("build-lock still aborts the wrapped command on SIGTERM (genuine stop signal, unaffected by the SIGHUP fix)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-build-lock-test-"));
  const startedFile = join(dir, "started");
  const releaseFile = join(dir, "release"); // deliberately never written — if the process survives, it hangs waiting, and waitExit would never resolve
  const doneFile = join(dir, "done");

  const child = spawnBuildLock(startedFile, releaseFile, doneFile);
  await waitForStdout(child, "lock acquired");
  await waitForFile(startedFile);

  child.kill("SIGTERM");
  await waitExit(child);

  assert.ok(!existsSync(doneFile), "SIGTERM must still cascade-kill the wrapped command — this is a genuine stop signal, not the SIGHUP bug");

  rmSync(dir, { recursive: true, force: true });
});
