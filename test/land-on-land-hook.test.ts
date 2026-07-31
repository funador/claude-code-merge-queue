// onLand: fired after a successful land, after the queue lock is released,
// fire-and-forget (never awaited, never fails the land). Same real-git-repo,
// spawn-the-real-CLI pattern as land.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(fileURLToPath(import.meta.url), "..", "..", "dist", "bin", "claude-code-merge-queue.js");

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

function makeRepoWithLane(onLand: string | null): { base: string; lane: string } {
  const base = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-onland-"));
  const remote = join(base, "remote.git");
  const mainTop = join(base, "main");
  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  execFileSync("git", ["clone", "--quiet", remote, mainTop]);
  git(mainTop, ["config", "user.email", "test@test.com"]);
  git(mainTop, ["config", "user.name", "Test"]);
  git(mainTop, ["checkout", "-q", "-b", "dev"]);
  const onLandLiteral = onLand === null ? "null" : JSON.stringify(onLand);
  writeFileSync(
    join(mainTop, "claude-code-merge-queue.config.mjs"),
    `export default { branchPrefix: "lane/", worktreeSuffix: "-lane-", portBase: 3000, integrationBranch: "dev", productionBranch: null, protectedBranches: [], regenerableFiles: [], symlinks: [], buildOutputDirs: [], checkCommand: null, checksRequired: false, onLand: ${onLandLiteral} };\n`,
  );
  writeFileSync(join(mainTop, "file.txt"), "v1\n");
  git(mainTop, ["add", "-A"]);
  git(mainTop, ["commit", "-q", "-m", "init"]);
  git(mainTop, ["push", "-q", "-u", "origin", "dev"]);

  const lane = join(base, "lane-1");
  git(mainTop, ["worktree", "add", lane, "-b", "lane/1"]);
  return { base, lane };
}

test("onLand fires after a successful land, after the lock is released, with the landed SHA/branches in its env", async () => {
  const { base, lane } = makeRepoWithLane(null); // set for real once we know the marker path below
  const marker = join(base, "onland-marker.txt");
  try {
    // A real script FILE, not an inline `node -e "..."` string — nesting a
    // JSON.stringify'd (double-quoted) path inside an already-double-quoted
    // -e argument prematurely closes the outer quote once spawn's shell:true
    // parses it, silently truncating the command. A file + plain quoted args
    // avoids the whole nesting problem.
    const hookScript = join(base, "onland-hook.cjs");
    writeFileSync(
      hookScript,
      "require('fs').writeFileSync(process.argv[2], process.env.CCMQ_LANDED_SHA + '|' + process.env.CCMQ_INTEGRATION_BRANCH + '|' + process.env.CCMQ_LANE_BRANCH);\n",
    );
    const cmd = `node ${JSON.stringify(hookScript)} ${JSON.stringify(marker)}`;
    writeFileSync(
      join(lane, "claude-code-merge-queue.config.mjs"),
      `export default { branchPrefix: "lane/", worktreeSuffix: "-lane-", portBase: 3000, integrationBranch: "dev", productionBranch: null, protectedBranches: [], regenerableFiles: [], symlinks: [], buildOutputDirs: [], checkCommand: null, checksRequired: false, onLand: ${JSON.stringify(cmd)} };\n`,
    );
    git(lane, ["add", "-A"]);
    git(lane, ["commit", "-q", "-m", "wire onLand"]);

    const child = spawn("node", [CLI, "land"], { cwd: lane, stdio: ["ignore", "pipe", "pipe"] });
    const code = await waitExit(child);
    assert.equal(code, 0, "land must succeed");

    const landedSha = execFileSync("git", ["--git-dir", join(base, "remote.git"), "rev-parse", "dev"], { encoding: "utf8" }).trim();

    await pollUntil(() => existsSync(marker), "onLand's marker file to appear (fired detached, after land already exited)");
    const [sha, integrationBranch, laneBranch] = readFileSync(marker, "utf8").split("|");
    assert.equal(sha, landedSha, "CCMQ_LANDED_SHA must be the actual landed commit");
    assert.equal(integrationBranch, "dev");
    assert.equal(laneBranch, "lane/1");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("onLand does NOT fire when the push fails", async () => {
  const { base, lane } = makeRepoWithLane(null);
  const marker = join(base, "onland-marker.txt");
  try {
    const hookScript = join(base, "onland-hook.cjs");
    writeFileSync(hookScript, "require('fs').writeFileSync(process.argv[2], 'fired');\n");
    const cmd = `node ${JSON.stringify(hookScript)} ${JSON.stringify(marker)}`;
    writeFileSync(
      join(lane, "claude-code-merge-queue.config.mjs"),
      `export default { branchPrefix: "lane/", worktreeSuffix: "-lane-", portBase: 3000, integrationBranch: "dev", productionBranch: null, protectedBranches: [], regenerableFiles: [], symlinks: [], buildOutputDirs: [], checkCommand: null, checksRequired: false, onLand: ${JSON.stringify(cmd)} };\n`,
    );
    git(lane, ["add", "-A"]);
    git(lane, ["commit", "-q", "-m", "wire onLand"]);

    // Make the upstream diverge so the rebase conflicts and land never reaches
    // the push at all — the "landed" outcome branch must never run.
    const mainTop = join(base, "main");
    writeFileSync(join(mainTop, "file.txt"), "conflicting upstream change\n");
    git(mainTop, ["add", "-A"]);
    git(mainTop, ["commit", "-q", "-m", "upstream change"]);
    git(mainTop, ["push", "-q"]);
    writeFileSync(join(lane, "file.txt"), "conflicting lane change\n");
    git(lane, ["add", "-A"]);
    git(lane, ["commit", "-q", "-m", "lane change, will conflict"]);

    const child = spawn("node", [CLI, "land"], { cwd: lane, stdio: ["ignore", "pipe", "pipe"] });
    const code = await waitExit(child);
    assert.equal(code, 1, "land must fail on the rebase conflict");

    // Give a wrongly-firing hook a real window to show up before asserting its absence.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(existsSync(marker), false, "onLand must not fire on a failed/conflicted land");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a failing onLand command does not fail the land", async () => {
  const { base, lane } = makeRepoWithLane("exit 1"); // spawn succeeds; the command itself fails
  try {
    const child = spawn("node", [CLI, "land"], { cwd: lane, stdio: ["ignore", "pipe", "pipe"] });
    const code = await waitExit(child);
    assert.equal(code, 0, "a failing onLand command must never fail an otherwise-successful land");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("onLand never holds the landing queue lock — a second lane lands while the first lane's onLand is still \"running\"", async () => {
  const { base, lane } = makeRepoWithLane(null);
  const gate = join(base, "onland-gate"); // absence of this file = onLand blocks "forever" (bounded below)
  try {
    // A slow-but-eventually-terminating command: it's detached/unref'd, so
    // land must not wait on it regardless — this proves that by making a
    // SECOND lane's land complete while the first lane's onLand is still
    // polling for the gate file to appear.
    const hookScript = join(base, "onland-hook.cjs");
    writeFileSync(
      hookScript,
      "const fs=require('fs'); const gate=process.argv[2]; const start=Date.now(); while(!fs.existsSync(gate) && Date.now()-start<3000){}\n",
    );
    const cmd = `node ${JSON.stringify(hookScript)} ${JSON.stringify(gate)}`;
    writeFileSync(
      join(lane, "claude-code-merge-queue.config.mjs"),
      `export default { branchPrefix: "lane/", worktreeSuffix: "-lane-", portBase: 3000, integrationBranch: "dev", productionBranch: null, protectedBranches: [], regenerableFiles: [], symlinks: [], buildOutputDirs: [], checkCommand: null, checksRequired: false, onLand: ${JSON.stringify(cmd)} };\n`,
    );
    git(lane, ["add", "-A"]);
    git(lane, ["commit", "-q", "-m", "wire slow onLand"]);

    const mainTop = join(base, "main");
    const lane2 = join(base, "lane-2");
    git(mainTop, ["worktree", "add", lane2, "-b", "lane/2"]);
    writeFileSync(join(lane2, "lane2-file.txt"), "lane 2 work\n");
    git(lane2, ["add", "-A"]);
    git(lane2, ["commit", "-q", "-m", "lane 2 work"]);

    const child1 = spawn("node", [CLI, "land"], { cwd: lane, stdio: ["ignore", "pipe", "pipe"] });
    const code1 = await waitExit(child1);
    assert.equal(code1, 0, "first land (with the slow onLand) must succeed and exit promptly");

    // If land#1 were (wrongly) waiting on its onLand hook, this second land
    // — issued right after the first process EXITED — would still be stuck
    // behind it, since the gate file doesn't exist yet.
    const child2 = spawn("node", [CLI, "land"], { cwd: lane2, stdio: ["ignore", "pipe", "pipe"] });
    const code2 = await waitExit(child2);
    assert.equal(code2, 0, "second lane must land without waiting on the first lane's still-running onLand");
  } finally {
    writeFileSync(gate, "done"); // release the (now-orphaned) onLand busy-loop so it exits within its own bound
    rmSync(base, { recursive: true, force: true });
  }
});
