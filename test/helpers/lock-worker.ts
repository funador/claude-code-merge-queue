// Spawned as a real child process by queue-lock.test.ts — acquires a named
// queue lock, holds it for holdMs, and appends its own start/end timestamps
// to a shared results file. Deliberately a *separate process*, not an
// in-process function call: the whole point of queue-lock.ts is
// cross-process mutual exclusion, so the test has to actually exercise that,
// not assert against itself.
import { appendFileSync } from "node:fs";
import { createQueueLock } from "../../src/lib/queue-lock.js";

const [, , queueName, resultsFile, holdMsRaw] = process.argv;
const holdMs = Number(holdMsRaw);

const lock = createQueueLock(queueName!);
await lock.acquire({ label: `worker-${process.pid}` });
appendFileSync(resultsFile!, JSON.stringify({ pid: process.pid, event: "start", t: Date.now() }) + "\n");
await new Promise((r) => setTimeout(r, holdMs));
appendFileSync(resultsFile!, JSON.stringify({ pid: process.pid, event: "end", t: Date.now() }) + "\n");
lock.release();
