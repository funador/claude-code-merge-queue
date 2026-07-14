import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { recordLandRun, readLandMetrics, type LandRunRecord } from "../src/lib/land-metrics.js";

const CLI = resolve(fileURLToPath(import.meta.url), "..", "..", "dist", "bin", "claude-code-merge-queue.js");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makePlainRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-land-metrics-"));
  git(dir, ["init", "--quiet"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

function sampleRecord(overrides: Partial<LandRunRecord> = {}): LandRunRecord {
  return {
    ts: new Date().toISOString(),
    lane: "lane-1",
    branch: "sol/lane-1",
    commit: "abc123",
    outcome: "landed",
    totalMs: 1000,
    phases: { queueWaitMs: 0, fetchMs: 10, rebaseMs: 20, reinstallMs: null, pushMs: 900, syncMs: 50 },
    ...overrides,
  };
}

test("recordLandRun + readLandMetrics round-trips a run", (t) => {
  const dir = makePlainRepo();
  const cwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  recordLandRun(sampleRecord());
  const entries = readLandMetrics();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].lane, "lane-1");
  assert.equal(entries[0].outcome, "landed");
  assert.equal(entries[0].phases.pushMs, 900);
});

test("caps the rolling log at the last 100 runs, dropping the oldest first", (t) => {
  const dir = makePlainRepo();
  const cwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  for (let i = 0; i < 105; i++) {
    recordLandRun(sampleRecord({ commit: `commit-${i}` }));
  }
  const entries = readLandMetrics();
  assert.equal(entries.length, 100);
  assert.equal(entries[0].commit, "commit-5", "oldest 5 runs should have been dropped");
  assert.equal(entries[99].commit, "commit-104", "the most recent run is last");
});

test("readLandMetrics returns an empty array when nothing has been recorded yet", (t) => {
  const dir = makePlainRepo();
  const cwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  assert.deepEqual(readLandMetrics(), []);
});

test("readLandMetrics tolerates a corrupt metrics file instead of throwing", (t) => {
  const dir = makePlainRepo();
  const cwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  const metricsDir = join(dir, ".git", "claude-code-merge-queue");
  execFileSync("mkdir", ["-p", metricsDir]);
  writeFileSync(join(metricsDir, "land-metrics.json"), "{not valid json");

  assert.deepEqual(readLandMetrics(), []);
});

test("a real `land` run records a 'landed' entry with phase timings and the pushed commit", async () => {
  const base = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-land-metrics-e2e-"));
  try {
    const remote = join(base, "remote.git");
    const mainTop = join(base, "main");
    execFileSync("git", ["init", "--quiet", "--bare", remote]);
    execFileSync("git", ["clone", "--quiet", remote, mainTop]);
    git(mainTop, ["config", "user.email", "test@test.com"]);
    git(mainTop, ["config", "user.name", "Test"]);
    git(mainTop, ["checkout", "-q", "-b", "dev"]);
    writeFileSync(
      join(mainTop, "claude-code-merge-queue.config.mjs"),
      `export default { branchPrefix: "lane/", worktreeSuffix: "-lane-", portBase: 3000, integrationBranch: "dev", productionBranch: null, protectedBranches: [], regenerableFiles: [], symlinks: [], buildOutputDirs: [], checkCommand: null, checksRequired: false };\n`,
    );
    writeFileSync(join(mainTop, "file.txt"), "v1\n");
    git(mainTop, ["add", "-A"]);
    git(mainTop, ["commit", "-q", "-m", "init"]);
    git(mainTop, ["push", "-q", "-u", "origin", "dev"]);

    const lane = join(base, "lane-1");
    git(mainTop, ["worktree", "add", lane, "-b", "lane/1"]);
    writeFileSync(join(lane, "file.txt"), "v2\n");
    git(lane, ["add", "-A"]);
    git(lane, ["commit", "-q", "-m", "real work"]);
    const expectedCommit = git(lane, ["rev-parse", "HEAD"]).trim();

    const code: number = await new Promise((res) => {
      const child = spawn("node", [CLI, "land"], { cwd: lane, stdio: "ignore" });
      child.on("exit", (c) => res(c ?? 1));
    });
    assert.equal(code, 0, "land should succeed against a trivial, check-free config");

    const metricsFile = join(mainTop, ".git", "claude-code-merge-queue", "land-metrics.json");
    assert.ok(existsSync(metricsFile), "land should have written a metrics entry");
    const entries = JSON.parse(readFileSync(metricsFile, "utf8")) as LandRunRecord[];
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry.outcome, "landed");
    assert.equal(entry.commit, expectedCommit);
    assert.ok(entry.totalMs >= 0);
    assert.ok(entry.phases.pushMs >= 0);
    assert.equal(entry.phases.reinstallMs, null, "no lockfile churn in this rebase — reinstall should be skipped");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
