/**
 * The Claude Code WorktreeCreate hook. Claude Code already isolates agents
 * in worktrees natively (`--worktree`, `isolation: "worktree"`) — this hook
 * doesn't compete with that, it plugs into it. A WorktreeCreate hook
 * "replaces default git behavior entirely" (Claude Code's own docs), so
 * this script is responsible for actually creating the worktree; what it
 * adds on top of the native flow is Claude Code Merge Queue's numbered-lane convention
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
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join, basename, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, hasConfig, DEFAULTS, type ClaudeCodeMergeQueueConfig } from "../lib/config.js";
import { resolveMainCheckout } from "../lib/main-checkout.js";
import { detectPackageManager } from "../lib/check-command.js";

interface HookInput {
  cwd?: string;
}

// A lane-claim loop with no upper bound is exactly one path-resolution bug
// away from spinning the CPU forever instead of failing loud — which is
// precisely what happened here: an earlier, separate implementation of what
// is now resolveMainCheckout used path.join instead of path.resolve, so
// invoking this hook from INSIDE an already-created linked worktree (where
// git reports an ABSOLUTE git-common-dir, not the relative ".git" a fresh
// checkout reports) produced a nonsense path that never matched an existing
// lane and never let `git worktree add` succeed either — an infinite loop,
// confirmed burning 80%+ CPU indefinitely in production use. Fixing the path
// bug alone doesn't rule out some other future bug in this class; capping
// the loop means any of them fails loud instead of hanging.
const MAX_LANE_ATTEMPTS = 1000;

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


// `dest` is always inside the freshly claimed `wt` (a "<repo><suffix><lane>"
// sibling of `mainTop`), so today src and dest can never actually coincide —
// verified by inspection, not just belief: if they did, the existsSync(src)
// && !existsSync(dest) guard right above the call site would itself skip the
// symlink either way, since equal paths always share the same existence
// status. Still worth a hard, loud assertion right at the one place this
// package ever calls symlinkSync: it's the only thing standing between a
// future refactor of the lane-path math and silently reproducing a
// self-referential symlink on the main checkout (which ELOOPs every read of
// whatever file it targets) for every consumer of this package, not just
// hola. Kept as a small, independently exported/testable predicate rather
// than inlined, since the pathological input can't be produced through
// createLane's own public surface to exercise it end-to-end.
export function assertSymlinkPathsDistinct(src: string, dest: string): void {
  if (src === dest) {
    throw new Error(
      `claude-code-merge-queue: refusing to symlink '${src}' to itself — a lane worktree's ` +
        "path must never equal the main checkout's path. This should be impossible; if it fired, " +
        "the lane-path resolution above this call has regressed.",
    );
  }
}

/**
 * Claim the lowest free lane, create its worktree, and symlink the
 * configured git-ignored paths into it. Throws with a human-readable
 * message on failure — the caller turns that into the hook's stderr +
 * non-zero exit.
 */
export function createLane(mainTop: string, cfg: ClaudeCodeMergeQueueConfig): { wt: string; branch: string; lane: number } {
  // Clean up administrative entries for worktrees whose directories are
  // already gone (e.g. someone `rm -rf`'d one instead of `git worktree
  // remove`) so reusing that lane number's branch name doesn't fail with
  // "already checked out elsewhere."
  tryGit(["worktree", "prune"], mainTop);

  const repoName = basename(mainTop);
  let lane = 0;
  for (;;) {
    lane += 1;
    if (lane > MAX_LANE_ATTEMPTS) {
      throw new Error(`could not claim a lane after ${MAX_LANE_ATTEMPTS} attempts — is mainTop ('${mainTop}') actually the repo root?`);
    }
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
    // `init` writes claude-code-merge-queue.config.mjs/CLAUDE.md/.claude locally, and the
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
      assertSymlinkPathsDistinct(src, dest);
      try {
        mkdirSync(dirname(dest), { recursive: true });
        symlinkSync(src, dest);
      } catch {
        /* best-effort — a missing symlink degrades to "run npm install," not a hard failure */
      }
    }

    if (cfg.installOnCreate) {
      // Detected from the NEW worktree's own checked-out lockfile, not
      // mainTop's — `wt` is a real `git worktree add` checkout of the same
      // commit, so whatever lockfile the repo has committed is already a
      // real file here (this is the alternative to symlinking node_modules,
      // so there's nothing to wait on). Best-effort, matching the symlink
      // loop above: a failed install still leaves the lane usable (git-wise)
      // for someone to fix by hand, so it must never block lane creation the
      // way a `git worktree add` failure does.
      const pm = detectPackageManager(wt);
      try {
        execFileSync(pm, ["install"], { cwd: wt, stdio: ["ignore", "pipe", "pipe"] });
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string };
        process.stderr.write(
          `claude-code-merge-queue: installOnCreate's "${pm} install" failed in ${wt} — the lane was ` +
            `still created, but node_modules may be missing or incomplete. Run "${pm} install" there ` +
            `by hand.\n${err.stdout ?? ""}${err.stderr ?? ""}\n`,
        );
      }
    }

    return { wt, branch, lane };
  }
}

// `.claude/settings.json` invokes this hook via `npx claude-code-merge-queue hook
// worktree-create` rather than a project script, precisely because a raw
// hook command has no `node_modules/.bin` on its PATH the way `npm run`
// does — npx's own directory-walking local resolution is what makes that
// work at all. The problem: npx treats a package it can't resolve locally as
// license to silently fetch an ephemeral, unpinned copy from the registry
// and run *that* instead of failing — which is exactly what happens when the
// host project's own install of claude-code-merge-queue is missing or mid-upgrade (npm
// removes the old version's files before extracting the new one; anything
// that interrupts that leaves precisely this state). That fallback ran
// silently for long enough in production to block two lanes from landing
// before anyone noticed node_modules was broken. Refuse to proceed if this
// module is executing from npx's (or pnpm dlx's — same failure class, same
// registry-fallback trap, verified against a real `pnpm dlx` cache path on
// this machine) ephemeral cache instead of the project's own installed
// copy, so a broken install fails loud immediately instead of limping along
// on a stand-in version nobody asked for.
//
// yarn dlx / bunx aren't covered here yet — their cache-path shapes haven't
// been verified against a real run the way npx's and pnpm dlx's have (see
// the "measure, don't guess" note in the project this shipped from). A
// consumer on yarn/bun still gets `expectsLocalInstall`'s package.json
// check; it just won't catch THIS specific ephemeral-fallback failure mode
// yet. Extend this once verified, the same way pnpm dlx was added.
export function isEphemeralNpxCopy(selfPath: string): boolean {
  return selfPath.includes(`${sep}_npx${sep}`) || selfPath.includes(`${sep}pnpm${sep}dlx${sep}`);
}

// The guard above only makes sense for a host project that's an npm project
// with claude-code-merge-queue as a real dependency — hola, say. A non-Node host repo
// (a Haskell/Lua/Rust/whatever project with no package.json at all) has
// nowhere to install claude-code-merge-queue INTO; npx's ephemeral cache is the only way
// it can ever run claude-code-merge-queue commands, not a fallback masking a broken
// local install. Only expect a local install — and therefore only treat
// ephemeral execution as suspicious — when the host's own package.json
// actually lists claude-code-merge-queue as a dependency. No package.json, or one that
// doesn't mention claude-code-merge-queue: ephemeral execution is completely normal.
export function expectsLocalInstall(mainTop: string): boolean {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(join(mainTop, "package.json"), "utf8")) as typeof pkg;
  } catch {
    return false; // no package.json, or unreadable/invalid — nothing "expected" to be there
  }
  return Boolean(pkg.dependencies?.["claude-code-merge-queue"] || pkg.devDependencies?.["claude-code-merge-queue"]);
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
    const mainTop = resolveMainCheckout(fromCwd);
    if (expectsLocalInstall(mainTop) && isEphemeralNpxCopy(fileURLToPath(import.meta.url))) {
      const pm = detectPackageManager(mainTop);
      throw new Error(
        `running from ${pm === "npm" ? "npx" : `${pm}'s`} ephemeral cache, not this project's own installed ` +
          `dependency — node_modules is missing or broken. Run \`${pm} install\` in the main checkout and try again.`,
      );
    }
    const cfg = hasConfig(mainTop) ? await loadConfig(mainTop) : { ...DEFAULTS };
    const { wt } = createLane(mainTop, cfg);
    process.stdout.write(wt + "\n");
    process.exit(0);
  } catch (err) {
    process.stderr.write(`claude-code-merge-queue worktree-create hook failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
