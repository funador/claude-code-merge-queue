// Like lock-worker.ts, but for locking against a SPECIFIC target repo (a
// throwaway temp fixture) rather than whatever repo the test runner itself
// happens to be sitting in. `node --import tsx` resolves the `tsx` package
// relative to its OWN cwd at startup — a bare temp fixture has no
// node_modules of its own for that to find, so this process has to start
// somewhere tsx IS resolvable (the caller's default cwd) and move itself
// into the real target directory before touching the queue lock at all,
// since createQueueLock() resolves which queue it's locking from cwd too.
import { appendFileSync } from "node:fs";
import { createQueueLock } from "../../src/lib/queue-lock.js";

const [, , targetDir, queueName, resultsFile, holdMsRaw] = process.argv;
process.chdir(targetDir!);
const holdMs = Number(holdMsRaw);

const lock = createQueueLock(queueName!);
await lock.acquire({ label: `worker-${process.pid}` });
appendFileSync(resultsFile!, JSON.stringify({ pid: process.pid, event: "start", t: Date.now() }) + "\n");
await new Promise((r) => setTimeout(r, holdMs));
appendFileSync(resultsFile!, JSON.stringify({ pid: process.pid, event: "end", t: Date.now() }) + "\n");
lock.release();
