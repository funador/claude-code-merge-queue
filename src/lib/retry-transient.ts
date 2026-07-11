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
 */

export interface RetryTransientOptions {
  /** Total attempts, including the first. Default 4. */
  attempts?: number;
  /** Base backoff in ms; attempt N waits backoffMs * N (400, 800, 1200, …). Default 400. */
  backoffMs?: number;
  /**
   * Decide whether an error is worth retrying. Defaults to
   * `isTransientNetworkError` — connection-establishment failures only, never
   * application/query errors (those won't succeed on retry, and for a write
   * that already reached the server, blindly retrying could double it).
   */
  isTransient?: (err: unknown) => boolean;
}

const TRANSIENT_PATTERN =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|network|other side closed/i;

/**
 * True for errors that indicate the connection itself never came up — a
 * refused/reset/timed-out socket, a DNS hiccup, an aborted fetch — as opposed
 * to an error returned BY the far end once it was actually reached (an
 * application error, a query rejected for its own reasons). Only the former
 * is safe to blindly retry: if the connection never established, nothing on
 * the other side could have processed the request yet.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return true;
  if (TRANSIENT_PATTERN.test(err.message)) return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error && TRANSIENT_PATTERN.test(cause.message);
}

/** Run `fn`, retrying on transient failures with escalating backoff. Rethrows
 *  the last error once attempts are exhausted or the error isn't transient. */
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
