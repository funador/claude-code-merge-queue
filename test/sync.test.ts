import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sync } from "../src/sync.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepoWithRemote(): { dir: string; remote: string } {
  const base = mkdtempSync(join(tmpdir(), "lanekeeper-sync-"));
  const remote = join(base, "remote.git");
  const dir = join(base, "checkout");
  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  execFileSync("git", ["clone", "--quiet", remote, dir]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["checkout", "-q", "-b", "main"]);
  writeFileSync(join(dir, "file.txt"), "v1\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  git(dir, ["push", "-q", "-u", "origin", "main"]);
  return { dir, remote };
}

test("sync refuses to act when the checkout isn't on integrationBranch", async () => {
  const { dir } = makeRepoWithRemote();
  const cwd = process.cwd();
  try {
    git(dir, ["checkout", "-q", "-b", "lane/1"]);
    writeFileSync(join(dir, "file.txt"), "lane change\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "lane work"]);
    const before = git(dir, ["rev-parse", "HEAD"]).trim();

    process.chdir(dir);
    let stderr = "";
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      stderr += args.join(" ");
    };
    const code = await sync();
    console.error = origError;

    assert.equal(code, 0);
    assert.match(stderr, /not the configured integrationBranch/);
    assert.equal(git(dir, ["rev-parse", "HEAD"]).trim(), before, "HEAD must not move");
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync fast-forwards the main checkout when it's on integrationBranch and behind", async () => {
  const { dir, remote } = makeRepoWithRemote();
  const cwd = process.cwd();
  try {
    // A second clone lands a new commit onto origin/main, simulating another lane landing.
    const other = mkdtempSync(join(tmpdir(), "lanekeeper-sync-other-"));
    execFileSync("git", ["clone", "--quiet", remote, other]);
    git(other, ["config", "user.email", "test@test.com"]);
    git(other, ["config", "user.name", "Test"]);
    writeFileSync(join(other, "file.txt"), "v2\n");
    git(other, ["add", "-A"]);
    git(other, ["commit", "-q", "-m", "landed elsewhere"]);
    git(other, ["push", "-q", "origin", "main"]);
    const remoteHead = git(other, ["rev-parse", "HEAD"]).trim();
    rmSync(other, { recursive: true, force: true });

    process.chdir(dir);
    const code = await sync();
    assert.equal(code, 0);
    assert.equal(git(dir, ["rev-parse", "HEAD"]).trim(), remoteHead);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
