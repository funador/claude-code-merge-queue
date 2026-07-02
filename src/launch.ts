/**
 * launch.ts — one keystroke, one isolated lane.
 *
 * Run from a repo's MAIN checkout: claims the lowest free lane number,
 * creates (or reuses) a git worktree on its own branch, symlinks in the
 * git-ignored bits your agent needs (env files, node_modules, ...) so a new
 * lane never needs a fresh install, and execs your agent inside it.
 *
 * Run from anywhere else — a lane worktree already, a repo with no
 * lanekeeper.config, or no git repo at all — and it just launches your agent
 * normally. Lane Keeper only touches repos that opted in by having a config
 * file at their root. A tool that silently changes behavior in every git
 * repo you `cd` into is not a tool people keep installed.
 *
 * Lane claims are tied to this process's PID. If the process dies before it
 * releases cleanly — a killed terminal, `kill -9`, a crash — the claim isn't
 * cleaned up by a trap or a timeout. It's just checked for liveness the next
 * time anyone tries to claim a lane, and reclaimed if the holder is dead.
 * Same pattern as the FIFO lock in queue-lock.ts: no timeouts to tune,
 * nothing to leak permanently, self-healing by construction.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, basename, resolve } from "node:path";
import { loadConfig, hasConfig } from "./lib/config.js";

interface GitResult {
  ok: boolean;
  out: string;
}

function tryGit(args: string[], cwd?: string): GitResult {
  try {
    return { ok: true, out: execFileSync("git", args, { cwd, encoding: "utf8" }).trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function launchPlain(agentCommand: string, args: string[]): Promise<never> {
  const child = spawn(agentCommand, args, { stdio: "inherit" });
  const code = await new Promise<number>((res) => child.on("exit", (c) => res(c ?? 0)));
  process.exit(code);
}

export async function launch(args: string[]): Promise<void> {
  const top = tryGit(["rev-parse", "--show-toplevel"]);
  if (!top.ok) return launchPlain("claude", args);

  const common = tryGit(["rev-parse", "--git-common-dir"]);
  if (!common.ok) return launchPlain("claude", args);
  const commonAbs = resolve(top.out, common.out);
  const mainTop = dirname(commonAbs); // parent of .git == the main worktree

  if (!hasConfig(mainTop)) return launchPlain("claude", args);
  const cfg = await loadConfig(mainTop);

  // Already inside a lane worktree — don't nest.
  if (top.out !== mainTop) return launchPlain(cfg.agentCommand, args);

  const lanesDir = join(commonAbs, "lanekeeper-lanes");
  mkdirSync(lanesDir, { recursive: true });

  // Atomically claim the lowest free lane. mkdirSync is atomic at the OS
  // level — two simultaneous launches can never grab the same lane.
  let lane = 0;
  let claimDir: string | null = null;
  for (;;) {
    lane += 1;
    const dir = join(lanesDir, `lane-${lane}`);
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(process.pid));
      claimDir = dir;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pidFile = join(dir, "pid");
      let holderPid = 0;
      try {
        holderPid = Number(readFileSync(pidFile, "utf8").trim());
      } catch {
        /* no pid file yet — another launch is mid-claim, try the next lane */
      }
      if (!holderPid || !alive(holderPid)) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* someone else already reclaimed it */
        }
        lane -= 1; // retry this same lane number
      }
    }
  }
  const claimedDir = claimDir; // narrowed: non-null once the loop above breaks

  const releaseLane = () => {
    try {
      rmSync(claimedDir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  };

  try {
    const port = cfg.portBase + lane;
    const branch = `${cfg.branchPrefix}${lane}`;
    const wt = join(dirname(mainTop), `${basename(mainTop)}${cfg.worktreeSuffix}${lane}`);

    if (!existsSync(wt)) {
      const branchExists = tryGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], mainTop).ok;
      if (branchExists) {
        tryGit(["worktree", "add", wt, branch], mainTop);
      } else {
        tryGit(["fetch", "origin", cfg.integrationBranch, "--quiet"], mainTop);
        const remoteRef = `refs/remotes/origin/${cfg.integrationBranch}`;
        const haveRemote = tryGit(["show-ref", "--verify", "--quiet", remoteRef], mainTop).ok;
        if (haveRemote) {
          tryGit(["worktree", "add", wt, "-b", branch, `origin/${cfg.integrationBranch}`], mainTop);
        } else {
          tryGit(["worktree", "add", wt, "-b", branch], mainTop);
        }
      }
    }

    if (!existsSync(wt)) {
      console.error(`lanekeeper launch: could not create worktree ${wt} — launching in ${mainTop} instead (NOT isolated).`);
      process.chdir(mainTop);
      return launchPlain(cfg.agentCommand, args);
    }

    // Share the git-ignored bits from main so the lane needs no fresh
    // install and no copy of your secrets. If your repo has a git hook
    // runtime that also lives in a gitignored, install-time-generated
    // directory (Husky's .husky/_ is the classic one), add that path to
    // `symlinks` too — otherwise your hooks silently no-op in every lane,
    // because a symlinked node_modules never runs npm's `prepare` step.
    for (const rel of cfg.symlinks) {
      const src = join(mainTop, rel);
      const dest = join(wt, rel);
      if (!existsSync(src) || existsSync(dest)) continue;
      try {
        mkdirSync(dirname(dest), { recursive: true });
        symlinkSync(src, dest);
      } catch {
        /* best-effort — a missing symlink degrades to "run npm install", not a hard failure */
      }
    }

    console.log(`🛟  lane ${lane} → ${wt}  (branch ${branch}, port ${port})`);
    const child = spawn(cfg.agentCommand, args, {
      cwd: wt,
      stdio: "inherit",
      env: { ...process.env, LANEKEEPER_LANE: String(lane), LANEKEEPER_PORT: String(port) },
    });
    const code = await new Promise<number>((res) => child.on("exit", (c) => res(c ?? 0)));
    process.exitCode = code;
  } finally {
    // Runs on any normal exit path, including the child dying from a signal
    // the terminal delivered directly to it. If THIS process is itself
    // killed before this runs, the lane isn't leaked — it's reclaimed by the
    // liveness check the next time anyone claims a lane. See the file header.
    releaseLane();
  }
}
