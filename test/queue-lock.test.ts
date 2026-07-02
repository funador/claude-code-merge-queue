// These spawn real child processes rather than calling createQueueLock()
// in-process, on purpose: the guarantee under test is cross-process mutual
// exclusion and crash recovery, and asserting against an in-process mock
// would only prove the code agrees with itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = fileURLToPath(new URL("./helpers/lock-worker.ts", import.meta.url));

function spawnWorker(queueName: string, resultsFile: string, holdMs: number) {
  return spawn("node", ["--import", "tsx", WORKER, queueName, resultsFile, String(holdMs)], {
    stdio: "inherit",
  });
}

function waitExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((res) => child.on("exit", (code) => res(code ?? 0)));
}

function readEvents(resultsFile: string): { pid: number; event: "start" | "end"; t: number }[] {
  return readFileSync(resultsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

test("mutual exclusion: four concurrent workers never overlap while holding the lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lanekeeper-lock-test-"));
  const resultsFile = join(dir, "results.ndjson");
  const queueName = `test-mutex-${process.pid}-${Date.now()}`;

  const workers = [0, 1, 2, 3].map(() => spawnWorker(queueName, resultsFile, 150));
  await Promise.all(workers.map(waitExit));

  const events = readEvents(resultsFile);
  const intervals = new Map<number, { start: number; end: number }>();
  for (const e of events) {
    const cur = intervals.get(e.pid) ?? { start: 0, end: 0 };
    cur[e.event === "start" ? "start" : "end"] = e.t;
    intervals.set(e.pid, cur);
  }
  assert.equal(intervals.size, 4, "expected all four workers to record start+end");

  const sorted = [...intervals.values()].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    assert.ok(cur.start >= prev.end, `worker holding [${prev.start},${prev.end}] overlapped worker starting at ${cur.start}`);
  }

  rmSync(dir, { recursive: true, force: true });
});

test("crash safety: a killed holder is reclaimed, not a permanent deadlock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lanekeeper-lock-test-"));
  const resultsFile = join(dir, "results.ndjson");
  const queueName = `test-crash-${process.pid}-${Date.now()}`;

  // Worker A holds the lock for far longer than the test's patience — it
  // should never release it gracefully. It gets SIGKILLed instead.
  const holder = spawnWorker(queueName, resultsFile, 60_000);

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(resultsFile) && readFileSync(resultsFile, "utf8").includes('"start"')) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(existsSync(resultsFile) && readFileSync(resultsFile, "utf8").includes('"start"'), "holder never acquired the lock");

  execSync(`kill -9 ${holder.pid}`);

  // Worker B should still be able to acquire the SAME queue — if the lock
  // weren't reclaimed via PID-liveness, this would hang until the test
  // runner's own timeout, not queue-lock's (there is no queue-lock timeout).
  const second = spawnWorker(queueName, resultsFile, 10);
  const code = await waitExit(second);
  assert.equal(code, 0, "second worker should acquire and finish cleanly after the holder was killed");

  const events = readEvents(resultsFile).filter((e) => e.pid === second.pid);
  assert.equal(events.length, 2, "second worker should have recorded both start and end");

  rmSync(dir, { recursive: true, force: true });
});
