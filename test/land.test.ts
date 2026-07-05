// `land()` calls process.exit() directly, so it can only be exercised by
// spawning the real CLI binary as a child process — matching the pattern
// already used for check-push-cli.test.ts and init.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(fileURLToPath(import.meta.url), "..", "..", "dist", "bin", "claude-code-merge-queue.js");
const WORKER = fileURLToPath(new URL("./helpers/lock-worker-in-dir.ts", import.meta.url));

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function waitExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((res) => child.on("exit", (code) => res(code ?? 1)));
}

async function pollUntil(check: () => boolean, description: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for: ${description}`);
}

function makeRepoWithLane(): { base: string; lane: string } {
  const base = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-land-"));
  const remote = join(base, "remote.git");
  const mainTop = join(base, "main");
  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  execFileSync("git", ["clone", "--quiet", remote, mainTop]);
  git(mainTop, ["config", "user.email", "test@test.com"]);
  git(mainTop, ["config", "user.name", "Test"]);
  git(mainTop, ["checkout", "-q", "-b", "dev"]);
  writeFileSync(
    join(mainTop, "claude-code-merge-queue.config.mjs"),
    `export default { branchPrefix: "lane/", worktreeSuffix: "-lane-", portBase: 3000, integrationBranch: "dev", productionBranch: null, protectedBranches: [], regenerableFiles: ["generated.txt"], symlinks: [], buildOutputDirs: [], checkCommand: null, checksRequired: false };\n`,
  );
  // Committed (not just written) so a later modification shows up as a
  // tracked, `git checkout --`-able change — a brand-new untracked file
  // doesn't behave the same way `next-env.d.ts` does in real repos.
  writeFileSync(join(mainTop, "generated.txt"), "build output v1\n");
  writeFileSync(join(mainTop, "file.txt"), "v1\n");
  git(mainTop, ["add", "-A"]);
  git(mainTop, ["commit", "-q", "-m", "init"]);
  git(mainTop, ["push", "-q", "-u", "origin", "dev"]);

  const lane = join(base, "lane-1");
  git(mainTop, ["worktree", "add", lane, "-b", "lane/1"]);
  return { base, lane };
}

test("land discards a regenerable file that gets re-dirtied while waiting for the landing queue lock", async () => {
  // The exact bug this closes: land only ever checked for stray regenerable
  // dirt ONCE, before joining the queue. A build tool re-touching that same
  // file during the (possibly long) wait for the lock — the whole point of
  // the queue existing at all — went uncaught, so the rebase that runs the
  // moment the lock is actually acquired failed on a "conflict" that was
  // really just the identical harmless noise land is supposed to discard.
  //
  // Both waits below are polled for real evidence, not guessed timeouts:
  // the holder's own "start" event, and land's own "waiting for the queue"
  // log line. A sleep-based version of this test passed even against the
  // unfixed code, because a lucky race let `land` finish before the dirt
  // was even written — proving nothing.
  const { base, lane } = makeRepoWithLane();
  const resultsFile = join(base, "lock-results.ndjson");
  let holder: ReturnType<typeof spawn> | undefined;
  let landProcess: ReturnType<typeof spawn> | undefined;
  try {
    writeFileSync(join(lane, "lane-work.txt"), "real change\n");
    git(lane, ["add", "-A"]);
    git(lane, ["commit", "-q", "-m", "lane work"]);

    // Hold the real "land" queue lock from a separate process, targeting
    // this same repo, so it resolves to the identical cross-worktree queue.
    holder = spawn("node", ["--import", "tsx", WORKER, lane, "land", resultsFile, "2000"], {
      stdio: "ignore",
    });
    await pollUntil(
      () => existsSync(resultsFile) && readFileSync(resultsFile, "utf8").includes('"start"'),
      "the holder process to actually acquire the lock",
    );

    let landOutput = "";
    landProcess = spawn("node", [CLI, "land"], { cwd: lane });
    landProcess.stdout?.on("data", (d: Buffer) => (landOutput += d.toString()));
    landProcess.stderr?.on("data", (d: Buffer) => (landOutput += d.toString()));
    await pollUntil(() => /land-queue/.test(landOutput), "land to actually be queued, waiting on the holder");

    // land is now genuinely blocked in the queue — regenerate the
    // configured regenerable file while it waits.
    writeFileSync(join(lane, "generated.txt"), "build output v2\n");

    const exitCode = await waitExit(landProcess);
    assert.equal(exitCode, 0, `land should succeed by discarding the re-dirtied regenerable file, not fail on a false conflict.\n--- land output ---\n${landOutput}`);

    // Query the bare remote directly rather than the main checkout's
    // origin/dev — that's just a local tracking ref and only updates on a
    // fetch this test never asked for.
    const devLog = execFileSync("git", ["--git-dir", join(base, "remote.git"), "log", "dev", "--oneline"], { encoding: "utf8" });
    assert.match(devLog, /lane work/, "the lane's real commit must have actually landed");
  } finally {
    holder?.kill();
    landProcess?.kill();
    rmSync(base, { recursive: true, force: true });
  }
});
