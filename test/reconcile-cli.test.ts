import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(fileURLToPath(import.meta.url), "..", "..", "dist", "bin", "claude-code-merge-queue.js");

function scratchRepoWithConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-reconcile-cli-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(
    join(dir, "claude-code-merge-queue.config.mjs"),
    `export default { branchPrefix: "lane/", worktreeSuffix: "-lane-", portBase: 3000, integrationBranch: "main", productionBranch: null, protectedBranches: [], regenerableFiles: [], symlinks: [], buildOutputDirs: [], disposableUntracked: [], checkCommand: "exit 0", checksRequired: true };\n`,
  );
  return dir;
}

test("reconcile in a repo with no sibling lanes reports nothing stranded — and touches nothing", () => {
  const dir = scratchRepoWithConfig();
  try {
    const out = execFileSync("node", [CLI, "reconcile"], { cwd: dir, encoding: "utf8" });
    assert.match(out, /no stranded lanes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcile without a config exits cleanly (nothing to do), never errors out", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-reconcile-noconfig-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  try {
    // No claude-code-merge-queue.config.mjs — reconcile notes it (on stderr, like
    // `prune`) and exits 0. The contract is the clean exit: execFileSync throws on
    // any non-zero code, so a plain "doesn't throw" is the real assertion here.
    assert.doesNotThrow(() =>
      execFileSync("node", [CLI, "reconcile"], { cwd: dir, encoding: "utf8", stdio: "pipe" }),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
