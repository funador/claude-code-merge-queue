import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createLane } from "../src/hooks/worktree-create.js";
import { DEFAULTS } from "../src/lib/config.js";

const WORKER = fileURLToPath(new URL("./helpers/worktree-create-worker.ts", import.meta.url));

function makeScratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lanekeeper-wt-test-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir });
  return dir;
}

function cleanupRepoAndLanes(mainTop: string): void {
  rmSync(mainTop, { recursive: true, force: true });
  // Worktrees are created as SIBLINGS of mainTop, not inside it — sweep any
  // "<name>-lane-N" directories left next to the (now-deleted) repo.
  const parent = dirname(mainTop);
  const prefix = `${basename(mainTop)}${DEFAULTS.worktreeSuffix}`;
  if (existsSync(parent)) {
    for (const entry of readdirSync(parent)) {
      if (entry.startsWith(prefix)) {
        rmSync(join(parent, entry), { recursive: true, force: true });
      }
    }
  }
}

test("createLane claims sequential lane numbers and creates real worktrees", () => {
  const mainTop = makeScratchRepo();
  try {
    const first = createLane(mainTop, DEFAULTS);
    const second = createLane(mainTop, DEFAULTS);

    assert.equal(first.lane, 1);
    assert.equal(second.lane, 2);
    assert.notEqual(first.wt, second.wt);
    assert.ok(existsSync(first.wt), "first lane's worktree should exist on disk");
    assert.ok(existsSync(second.wt), "second lane's worktree should exist on disk");

    const branches = execFileSync("git", ["branch", "--list"], { cwd: mainTop, encoding: "utf8" });
    assert.match(branches, /lane\/1/);
    assert.match(branches, /lane\/2/);
  } finally {
    cleanupRepoAndLanes(mainTop);
  }
});

test("createLane bases a new lane on the main checkout's own HEAD, not a stale origin/integrationBranch", () => {
  const mainTop = makeScratchRepo();
  const remote = mkdtempSync(join(tmpdir(), "lanekeeper-wt-remote-"));
  try {
    execFileSync("git", ["init", "-q", "--bare", remote]);
    execFileSync("git", ["branch", "-M", "main"], { cwd: mainTop });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: mainTop });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: mainTop });

    // A commit made locally but never pushed — e.g. `lanekeeper init`'s own
    // wiring commit, right after Quickstart, before anyone has pushed it.
    execFileSync("node", ["-e", "require('fs').writeFileSync('lanekeeper.config.mjs', 'x')"], { cwd: mainTop });
    execFileSync("git", ["add", "-A"], { cwd: mainTop });
    execFileSync("git", ["commit", "-q", "-m", "local-only wiring commit"], { cwd: mainTop });

    const { wt } = createLane(mainTop, { ...DEFAULTS, integrationBranch: "main" });
    assert.ok(existsSync(join(wt, "lanekeeper.config.mjs")), "new lane must inherit the unpushed local commit, not fall back to stale origin/main");
  } finally {
    cleanupRepoAndLanes(mainTop);
    rmSync(remote, { recursive: true, force: true });
  }
});

test("concurrent WorktreeCreate hook invocations never collide on the same lane", async () => {
  const mainTop = makeScratchRepo();
  try {
    const N = 4;
    const children = Array.from({ length: N }, () =>
      spawn("node", ["--import", "tsx", WORKER], { stdio: ["pipe", "pipe", "inherit"] }),
    );
    for (const child of children) {
      child.stdin.end(JSON.stringify({ cwd: mainTop }));
    }

    const results = await Promise.all(
      children.map(
        (child) =>
          new Promise<{ code: number; stdout: string }>((resolve) => {
            let stdout = "";
            child.stdout.on("data", (d) => (stdout += d));
            child.on("exit", (code) => resolve({ code: code ?? 1, stdout: stdout.trim() }));
          }),
      ),
    );

    for (const r of results) {
      assert.equal(r.code, 0, `worker should exit 0, got ${r.code}`);
    }
    const paths = results.map((r) => r.stdout);
    assert.equal(new Set(paths).size, N, `all ${N} claimed lanes should be distinct paths, got: ${paths.join(", ")}`);
    for (const p of paths) {
      assert.ok(existsSync(p), `claimed worktree ${p} should exist on disk`);
    }
  } finally {
    cleanupRepoAndLanes(mainTop);
  }
});
