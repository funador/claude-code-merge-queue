// Spawns the actual CLI bin entrypoint as a real child process (not
// buildLock() called in-process, and not through an extra wrapper script)
// and signals THAT process directly — the fix under test spans TWO layers
// (the bin entrypoint's global SIGHUP ignore, and build-lock.ts no longer
// forwarding SIGHUP to its child), and both only apply to a process actually
// running the bin. An earlier draft of this test signaled an unrelated
// wrapper process instead of the bin itself and consequently proved nothing.
//
// Born from a real incident: build-lock.ts used to forward SIGHUP into the
// wrapped build's process group as an abort — but SIGHUP also fires from a
// merely-backgrounded process's controlling session/terminal going away (not
// a deliberate kill), which killed several real, in-progress, otherwise-green
// `land` runs for no reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../src/bin/claude-code-merge-queue.ts", import.meta.url));

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((res) => child.on("exit", (code) => res(code)));
}

function spawnBuildLock(markerFile: string, holdMs: number) {
  return spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      BIN,
      "build-lock",
      "--",
      `node -e "setTimeout(() => require('fs').writeFileSync('${markerFile}', 'done'), ${holdMs})"`,
    ],
    { stdio: "inherit" },
  );
}

test("build-lock survives a SIGHUP mid-build — only SIGINT/SIGTERM abort it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-build-lock-test-"));
  const markerFile = join(dir, "done-marker");
  const holdMs = 800;

  const child = spawnBuildLock(markerFile, holdMs);

  // Give it time to acquire the lock and start the wrapped command, then hit
  // it with a real SIGHUP well before the wrapped command's own delay elapses.
  await sleep(300);
  child.kill("SIGHUP");

  const code = await waitExit(child);

  assert.equal(code, 0, "build-lock's own process should exit cleanly, not be torn down by SIGHUP");
  assert.ok(existsSync(markerFile), "the wrapped command must have been allowed to actually finish — SIGHUP must not abort it");

  rmSync(dir, { recursive: true, force: true });
});

test("build-lock still aborts the wrapped command on SIGTERM (genuine stop signal, unaffected by the SIGHUP fix)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-build-lock-test-"));
  const markerFile = join(dir, "done-marker");
  const holdMs = 5000; // long enough that it can only exist if SIGTERM failed to abort it

  const child = spawnBuildLock(markerFile, holdMs);

  await sleep(300);
  child.kill("SIGTERM");

  await waitExit(child);

  assert.ok(!existsSync(markerFile), "SIGTERM must still cascade-kill the wrapped command — this is a genuine stop signal, not the SIGHUP bug");

  rmSync(dir, { recursive: true, force: true });
});
