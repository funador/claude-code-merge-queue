/**
 * The Claude Code WorktreeCreate hook. Claude Code already isolates agents
 * in worktrees natively (`--worktree`, `isolation: "worktree"`) — this hook
 * doesn't compete with that, it plugs into it. A WorktreeCreate hook
 * "replaces default git behavior entirely" (Claude Code's own docs), so
 * this script is responsible for actually creating the worktree; what it
 * adds on top of the native flow is Lane Keeper's numbered-lane convention
 * and a `node_modules` SYMLINK instead of a copy — Claude Code's own
 * `.worktreeinclude` mechanism copies gitignored files in, which is fine
 * for a `.env` file and genuinely expensive for `node_modules`.
 *
 * Per Claude Code's hook contract: print the new worktree's absolute path
 * on stdout and exit 0, or print an error to stderr and exit non-zero to
 * abort creation (WorktreeCreate is the one hook event that can block).
 *
 * There's no long-lived process behind this the way there was behind the
 * old standalone launcher — the hook runs once and exits. So lane claiming
 * can't be PID-liveness-based here; there's no PID to track. Instead the
 * claim IS the worktree: a lane is free iff `<repo><worktreeSuffix><n>`
 * doesn't exist on disk, and `git worktree add` failing on an
 * already-claimed path is the same atomicity guarantee a `mkdir` race gave
 * the old launcher, just delegated to git itself. When Claude Code (or you,
 * or its cleanup sweep) removes a worktree, that lane number is free again
 * automatically — nothing to release by hand.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { loadConfig, hasConfig, DEFAULTS, type LaneKeeperConfig } from "../lib/config.js";

interface HookInput {
  cwd?: string;
}

// Trying a lane number that turns out to already be claimed (the expected,
// routine race with another concurrent hook invocation) is not an error
// worth showing anyone — git's own "fatal: cannot lock ref" on that attempt
// would otherwise leak to the terminal even though the hook recovers and
// succeeds. Force stdout/stderr into pipes explicitly rather than trusting
// the ambient default, so a probing attempt is always silent until we
// decide it's actually fatal.
function tryGit(args: string[], cwd: string): { ok: boolean; out: string } {
  try {
    return {
      ok: true,
      out: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
    };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

export function resolveMainTop(fromCwd: string): string {
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: fromCwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return dirname(join(fromCwd, common));
}

/**
 * Claim the lowest free lane, create its worktree, and symlink the
 * configured git-ignored paths into it. Throws with a human-readable
 * message on failure — the caller turns that into the hook's stderr +
 * non-zero exit.
 */
export function createLane(mainTop: string, cfg: LaneKeeperConfig): { wt: string; branch: string; lane: number } {
  // Clean up administrative entries for worktrees whose directories are
  // already gone (e.g. someone `rm -rf`'d one instead of `git worktree
  // remove`) so reusing that lane number's branch name doesn't fail with
  // "already checked out elsewhere."
  tryGit(["worktree", "prune"], mainTop);

  const repoName = basename(mainTop);
  let lane = 0;
  for (;;) {
    lane += 1;
    const wt = join(dirname(mainTop), `${repoName}${cfg.worktreeSuffix}${lane}`);
    if (existsSync(wt)) continue; // still claimed — try the next lane

    const branch = `${cfg.branchPrefix}${lane}`;
    const branchExists = tryGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], mainTop).ok;

    // Base every new lane on the main checkout's own current HEAD — never on
    // origin/integrationBranch. The main checkout is kept fast-forwarded by
    // `sync` precisely so its local HEAD IS the trusted, up-to-date view;
    // reading origin directly instead can be *behind* local HEAD (a commit
    // made here but not yet pushed) and silently drop it from every new
    // lane. That's not a hypothetical: it breaks the literal Quickstart —
    // `init` writes lanekeeper.config.mjs/CLAUDE.md/.claude locally, and the
    // very first lane created before that commit is pushed anywhere would
    // otherwise come up with none of it.
    let add;
    if (branchExists) {
      add = tryGit(["worktree", "add", wt, branch], mainTop);
    } else {
      add = tryGit(["worktree", "add", wt, "-b", branch], mainTop);
    }

    if (!add.ok) {
      // Someone else claimed this exact lane between our existsSync check
      // and `git worktree add` — the same race a `mkdir` guards against.
      // Try the next one.
      continue;
    }

    for (const rel of cfg.symlinks) {
      const src = join(mainTop, rel);
      const dest = join(wt, rel);
      if (!existsSync(src) || existsSync(dest)) continue;
      try {
        mkdirSync(dirname(dest), { recursive: true });
        symlinkSync(src, dest);
      } catch {
        /* best-effort — a missing symlink degrades to "run npm install," not a hard failure */
      }
    }

    return { wt, branch, lane };
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runWorktreeCreateHook(): Promise<void> {
  let input: HookInput = {};
  try {
    input = JSON.parse(await readStdin()) as HookInput;
  } catch {
    /* no/invalid stdin — fall back to process.cwd() below */
  }
  const fromCwd = input.cwd ?? process.cwd();

  try {
    const mainTop = resolveMainTop(fromCwd);
    const cfg = hasConfig(mainTop) ? await loadConfig(mainTop) : { ...DEFAULTS };
    const { wt } = createLane(mainTop, cfg);
    process.stdout.write(wt + "\n");
    process.exit(0);
  } catch (err) {
    process.stderr.write(`lanekeeper worktree-create hook failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
