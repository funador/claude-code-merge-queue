import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(fileURLToPath(import.meta.url), "..", "..", "dist", "bin", "mergequeue.js");

function scratchRepoWithConfig(checkCommand: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mergequeue-checkpush-cli-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(
    join(dir, "mergequeue.config.mjs"),
    `export default { branchPrefix: "lane/", worktreeSuffix: "-lane-", portBase: 3000, integrationBranch: "main", productionBranch: null, protectedBranches: [], regenerableFiles: [], symlinks: [], buildOutputDirs: [], checkCommand: ${JSON.stringify(checkCommand)}, checksRequired: true };\n`,
  );
  return dir;
}

test("check-push with empty stdin (nothing being pushed) exits 0 WITHOUT running checkCommand", () => {
  // checkCommand is set to something that always fails — if it ran, the
  // process would exit non-zero. git invokes pre-push with empty stdin for
  // a push that updates zero refs (e.g. re-pushing an already up-to-date
  // branch); that must be a no-op, not a reason to run real checks.
  const dir = scratchRepoWithConfig("exit 1");
  try {
    const out = execFileSync("node", [CLI, "check-push"], { cwd: dir, input: "", encoding: "utf8" });
    assert.match(out, /nothing being pushed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-push with a real ref update still runs checkCommand", () => {
  const dir = scratchRepoWithConfig("exit 0");
  try {
    const out = execFileSync("node", [CLI, "check-push"], {
      cwd: dir,
      input: "refs/heads/lane/1 abc123 refs/heads/lane/1 def456\n",
      encoding: "utf8",
      env: { ...process.env },
    });
    assert.match(out, /running "exit 0"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
