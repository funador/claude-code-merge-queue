// Spawned as a real child process by queue-lock.test.ts — waits on a queue
// lock already held by another process, with a tiny stuckWarnAfterMs so the
// test doesn't have to wait out the real 5-minute default. Appends every
// onWait call that carries a holderElapsedMs (the stuck-holder warning path)
// to a shared results file, then records once it finally acquires the lock.
import { appendFileSync } from "node:fs";
import { createQueueLock } from "../../src/lib/queue-lock.js";

const [, , queueName, resultsFile, stuckWarnAfterMsRaw] = process.argv;
const stuckWarnAfterMs = Number(stuckWarnAfterMsRaw);

const lock = createQueueLock(queueName!);
await lock.acquire({
  label: `waiter-${process.pid}`,
  stuckWarnAfterMs,
  onWait: ({ holderElapsedMs }) => {
    if (holderElapsedMs !== undefined) {
      appendFileSync(resultsFile!, JSON.stringify({ event: "stuck-warn", holderElapsedMs }) + "\n");
    }
  },
});
appendFileSync(resultsFile!, JSON.stringify({ event: "acquired" }) + "\n");
lock.release();
