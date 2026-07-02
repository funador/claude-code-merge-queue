/**
 * The extension point for per-run ephemeral test resources — a throwaway
 * database branch, a scratch bucket, a sandboxed queue, whatever your test
 * suite needs that would otherwise race across concurrent lanes.
 *
 * This file is deliberately NOT wired to any specific provider. Everyone's
 * test setup is different (Neon, a local Postgres with template databases, a
 * Docker container per run, nothing at all) and shipping one company's
 * choice as the default would make this less useful, not more. What's
 * shipped instead is the *shape* — the same claim → use → release, and the
 * same PID-liveness self-heal, that queue-lock.ts and launch.ts already use
 * for the lock and the lane. One pattern, three places, so a crashed run
 * never needs a human to notice and clean up after it.
 *
 * See examples/ephemeral-tmp-dir.example.ts for a complete, runnable
 * implementation (a scratch directory per run, no external service) — copy
 * its shape when you wire this to your own database or resource provider.
 */
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface EphemeralResourceProvider<T> {
  /** Create one resource for this run and return whatever callers need to use it. */
  create(): Promise<T>;
  /** Tear down a resource this same process created. */
  destroy(handle: T): Promise<void>;
  /**
   * Tear down a resource some OTHER (now-dead) process created and never got
   * to destroy — a crash, a SIGKILL, a CI runner that got cancelled. Given
   * only what was recorded at claim time (see ClaimRegistry below).
   */
  destroyOrphan(claim: Claim): Promise<void>;
}

export interface Claim {
  id: string;
  pid: number;
  createdAt: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A tiny on-disk registry of "what's claimed, by which PID." Not a database
 * — just enough bookkeeping to answer "is this orphaned?" the same way
 * queue-lock.ts answers it for locks: check whether the claiming PID is
 * still alive, with no timeout to tune.
 */
export class ClaimRegistry {
  private readonly dir: string;

  constructor(registryDir: string) {
    this.dir = registryDir;
    mkdirSync(this.dir, { recursive: true });
  }

  record(claim: Claim): void {
    writeFileSync(join(this.dir, claim.id), JSON.stringify(claim));
  }

  release(id: string): void {
    try {
      unlinkSync(join(this.dir, id));
    } catch {
      /* already gone */
    }
  }

  /** Every claim whose owning PID is no longer alive — safe to destroy. */
  orphans(): Claim[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const found: Claim[] = [];
    for (const name of names) {
      try {
        const claim = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as Claim;
        if (!alive(claim.pid)) found.push(claim);
      } catch {
        /* unreadable claim file — leave it, don't guess */
      }
    }
    return found;
  }
}

/**
 * Run `fn` against a freshly created resource, prune any orphans left by a
 * previous crashed run first, and always release the claim — including on
 * a thrown error. If THIS process is killed before the `finally` runs, the
 * resource isn't leaked forever: the next call to `withEphemeralResource`
 * (in the next test run, from any lane) prunes it via `orphans()` before
 * creating its own.
 */
export async function withEphemeralResource<T>(
  provider: EphemeralResourceProvider<T>,
  registry: ClaimRegistry,
  fn: (resource: T) => Promise<void>,
): Promise<void> {
  for (const orphan of registry.orphans()) {
    await provider.destroyOrphan(orphan);
    registry.release(orphan.id);
  }

  const id = `${Date.now()}-${process.pid}`;
  const claim: Claim = { id, pid: process.pid, createdAt: Date.now() };
  registry.record(claim);

  const resource = await provider.create();
  try {
    await fn(resource);
  } finally {
    await provider.destroy(resource);
    registry.release(id);
  }
}
