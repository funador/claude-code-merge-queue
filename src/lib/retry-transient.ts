/**
 * Retry-with-backoff for transient network failures.
 *
 * A freshly created per-lane ephemeral resource (a Neon branch's compute
 * endpoint waking from autosuspend, a cold container, a service that hasn't
 * finished binding its port) can refuse or reset the first few operations
 * before it's actually ready — and that gets worse, not better, under the
 * concurrent load this package's whole job is to manage: several lanes
 * building/landing/testing at once means several cold starts racing each
 * other at once.
 *
 * This is a single, tested home for a pattern that otherwise gets
 * hand-rolled slightly differently at every call site that hits it (this
 * package's own sync.ts retries index.lock contention; consuming apps'
 * ephemeral-branch scripts retry the provisioning API; their test helpers
 * retry the first query) — one utility instead of N slightly-different
 * copies, each with its own bug surface.
 *
 * ⚠️ CONTRACT: the retried `fn` MUST be idempotent. A retry can fire AFTER the
 * request committed but before its response arrived (a socket dropped
 * mid-response is indistinguishable here from one that never connected — see
 * isTransientNetworkError), so a re-run may hit state its own prior attempt
 * already changed. Non-idempotent writes must guard themselves before using
 * this. Details on both functions below.
 */

export interface RetryTransientOptions {
  /** Total attempts, including the first. Default 4. */
  attempts?: number;
  /** Base backoff in ms; attempt N waits backoffMs * N (400, 800, 1200, …). Default 400. */
  backoffMs?: number;
  /**
   * Decide whether an error is worth retrying. Defaults to
   * `isTransientNetworkError` — transient network-transport failures only,
   * never application/query errors (those won't succeed on retry). Mind the
   * idempotency contract on retryTransient: a transient failure can strike
   * after a write already reached the server, so blindly retrying a
   * non-idempotent write could double it.
   */
  isTransient?: (err: unknown) => boolean;
}

const TRANSIENT_PATTERN =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|network|other side closed/i;

/**
 * True for transient network-transport failures — a refused/reset/timed-out
 * socket, a DNS hiccup, an aborted fetch, a connection dropped mid-flight — as
 * opposed to an error returned BY the far end once it was reached (an
 * application error, a query rejected for its own reasons). The latter won't
 * succeed on retry; the former might, once the resource warms up.
 *
 * ⚠️ A match does NOT mean the request went unprocessed. Several of these —
 * ECONNRESET, EPIPE, "socket hang up", "other side closed", and an aborted
 * fetch — can strike AFTER the server received and even committed the request,
 * when only the RESPONSE was lost. At this layer that is indistinguishable from
 * a request that never arrived. So a retry is safe ONLY when the operation is
 * idempotent: a re-run must be a harmless no-op if the first attempt actually
 * succeeded. A plain INSERT / resource-creation is NOT idempotent — retrying it
 * after a lost-success double-writes or dies on a duplicate key. Make such
 * operations idempotent (upsert / ON CONFLICT DO NOTHING / reconcile by a
 * unique key) BEFORE wrapping them in retryTransient.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  if (TRANSIENT_PATTERN.test(err.message)) return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error && TRANSIENT_PATTERN.test(cause.message);
}

/**
 * Run `fn`, retrying on transient failures with escalating backoff. Rethrows
 * the last error once attempts are exhausted or the error isn't transient.
 *
 * CONTRACT — `fn` MUST be idempotent. Retries fire on transient network
 * failures that can strike after the server processed the request but before
 * its response arrived (see isTransientNetworkError), so a retried `fn` may run
 * against state its own prior attempt already changed. If `fn` performs a
 * non-idempotent write, guard it (upsert / ON CONFLICT DO NOTHING / reconcile
 * by a unique key) so a re-run after a lost-success is a no-op — otherwise this
 * turns a dropped response into a double-write or a duplicate-key crash.
 */
export async function retryTransient<T>(fn: () => Promise<T>, opts: RetryTransientOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const backoffMs = opts.backoffMs ?? 400;
  const isTransient = opts.isTransient ?? isTransientNetworkError;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !isTransient(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
  // Unreachable — the loop always either returns or throws — but keeps
  // TypeScript's control-flow analysis happy without a non-null assertion.
  throw lastErr;
}
