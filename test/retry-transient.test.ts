import { test } from "node:test";
import assert from "node:assert/strict";
import { retryTransient, isTransientNetworkError } from "../src/lib/retry-transient.js";

test("retryTransient returns the result on first success without waiting", async () => {
  let calls = 0;
  const result = await retryTransient(async () => {
    calls++;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("retryTransient retries a transient failure and succeeds once the resource wakes up", async () => {
  let calls = 0;
  const result = await retryTransient(
    async () => {
      calls++;
      if (calls < 3) throw new TypeError("fetch failed");
      return "warm";
    },
    { backoffMs: 1 },
  );
  assert.equal(result, "warm");
  assert.equal(calls, 3);
});

test("retryTransient gives up and rethrows once attempts are exhausted", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retryTransient(
        async () => {
          calls++;
          throw new TypeError("fetch failed");
        },
        { attempts: 3, backoffMs: 1 },
      ),
    /fetch failed/,
  );
  assert.equal(calls, 3);
});

test("retryTransient does not retry a non-transient error — it fails fast", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retryTransient(async () => {
        calls++;
        throw new Error("duplicate key value violates unique constraint");
      }),
    /duplicate key/,
  );
  assert.equal(calls, 1);
});

test("retryTransient honors a caller-supplied isTransient predicate", async () => {
  let calls = 0;
  const result = await retryTransient(
    async () => {
      calls++;
      if (calls < 2) throw new Error("custom retryable signal");
      return "done";
    },
    { backoffMs: 1, isTransient: (err) => err instanceof Error && err.message === "custom retryable signal" },
  );
  assert.equal(result, "done");
  assert.equal(calls, 2);
});

test("isTransientNetworkError matches connection-establishment failures", () => {
  assert.ok(isTransientNetworkError(new TypeError("fetch failed")));
  assert.ok(isTransientNetworkError(new Error("connect ECONNRESET")));
  assert.ok(isTransientNetworkError(new Error("connect ECONNREFUSED 127.0.0.1:5432")));
  assert.ok(isTransientNetworkError(Object.assign(new Error("aborted"), { name: "AbortError" })));
});

test("isTransientNetworkError matches a wrapped cause, not just the top-level message", () => {
  const err = new Error("query failed", { cause: new TypeError("fetch failed") });
  assert.ok(isTransientNetworkError(err));
});

test("isTransientNetworkError rejects application/query errors — never retry those blindly", () => {
  assert.ok(!isTransientNetworkError(new Error("duplicate key value violates unique constraint")));
  assert.ok(!isTransientNetworkError(new Error("permission denied for table users")));
  assert.ok(!isTransientNetworkError("not even an Error instance"));
});
