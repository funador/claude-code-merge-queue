/**
 * sync.ts — fast-forward the MAIN checkout to its upstream branch.
 *
 * Your dev server (or whatever's watching the filesystem) runs on the MAIN
 * checkout, which tracks the integration branch. Lanes land onto that branch
 * via a push, but the MAIN checkout's working tree only advances on a pull —
 * so it serves stale files until something fast-forwards it. `land` runs
 * this immediately after every successful push, so the dev server picks up
 * landed work with zero manual `git pull`.
 *
 * Safe by construction:
 *   - Fast-forward ONLY. If the checkout has diverged from its upstream, it
 *     warns and leaves it untouched — never a force, never a merge commit.
 *   - Retries transient index.lock contention (two lanes landing near-simultaneously).
 *   - If a fast-forward is blocked only by a locally-modified *regenerable*
 *     file (configured in lanekeeper.config), it discards that file and
 *     retries. Any other dirty file → warn and skip.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { loadConfig } from "./lib/config.js";

const LOCK_RETRIES = 3;

interface GitResult {
  ok: boolean;
  out: string;
}

function git(cwd: string, args: string[], { allowFail = false } = {}): GitResult {
  try {
    return {
      ok: true,
      out: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    };
  } catch (e) {
    if (!allowFail) throw e;
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function sleep(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* tiny synchronous backoff for index.lock */
  }
}

/** Fast-forwards the MAIN checkout. Returns a process exit code; never throws. */
export async function sync(): Promise<number> {
  let MAIN: string;
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim();
    MAIN = dirname(resolve(process.cwd(), common));
  } catch {
    console.error("lanekeeper sync: not inside a git repo — nothing to do.");
    return 0;
  }

  const cfg = await loadConfig(MAIN);
  const regenerable = new Set(cfg.regenerableFiles);

  const branchRes = git(MAIN, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true });
  const branch = branchRes.out.trim();
  if (!branch || branch === "HEAD") {
    console.error("lanekeeper sync: the checkout is detached or unresolved — left untouched.");
    return 0;
  }
  const upstream = `origin/${branch}`;

  const before = git(MAIN, ["rev-parse", "--short", "HEAD"], { allowFail: true }).out.trim();

  git(MAIN, ["fetch", "origin", "--quiet"], { allowFail: true });

  const tryFastForward = () => git(MAIN, ["merge", "--ff-only", upstream], { allowFail: true });

  let res = tryFastForward();

  // Retry transient lock contention (another lane landing at the same instant).
  for (let i = 0; i < LOCK_RETRIES && !res.ok && /index\.lock|Unable to create|another git process/i.test(res.out); i++) {
    sleep(400);
    res = tryFastForward();
  }

  // Blocked by a locally-modified regenerable file? Discard it and retry once.
  if (!res.ok && /would be overwritten by merge/i.test(res.out)) {
    const files = res.out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/would be overwritten|please commit|aborting|^error:/i.test(l));
    const blocking = files.filter((f) => !regenerable.has(f));
    if (blocking.length === 0 && files.length > 0) {
      git(MAIN, ["checkout", "--", ...files], { allowFail: true });
      res = tryFastForward();
    } else {
      console.error(`lanekeeper sync: ${branch} has local changes blocking fast-forward (${blocking.join(", ")}). Left untouched — resolve in the checkout.`);
      return 0;
    }
  }

  if (res.ok) {
    const after = git(MAIN, ["rev-parse", "--short", "HEAD"], { allowFail: true }).out.trim();
    if (before === after) {
      console.log(`lanekeeper sync: ${branch} already current at ${after}.`);
    } else {
      console.log(`lanekeeper sync: fast-forwarded ${branch} ${before} → ${after} — the dev server will pick it up.`);
    }
    return 0;
  }

  if (/Not possible to fast-forward|diverging|non-fast-forward/i.test(res.out)) {
    console.error(`lanekeeper sync: local ${branch} has DIVERGED from ${upstream} (something was committed directly on the checkout). Left untouched — reconcile it manually.`);
    return 0;
  }

  console.error(`lanekeeper sync: could not fast-forward ${branch} — left untouched.\n${res.out.trim()}`);
  return 0;
}
