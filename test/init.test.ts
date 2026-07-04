import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(fileURLToPath(import.meta.url), "..", "..", "dist", "bin", "mergequeue.js");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function scratchRepo(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mergequeue-init-"));
  git(dir, ["init", "-q", "-b", branch]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "hi\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function runInit(cwd: string): string {
  return execFileSync("node", [CLI, "init"], { cwd, encoding: "utf8" });
}

test("init on a non-default branch name auto-detects it as integrationBranch", () => {
  const dir = scratchRepo("trunk");
  try {
    const out = runInit(dir);
    assert.match(out, /detected current branch "trunk"/);
    const cfg = readFileSync(join(dir, "mergequeue.config.mjs"), "utf8");
    assert.match(cfg, /"integrationBranch": "trunk"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init on detached HEAD warns instead of silently defaulting to main", () => {
  const dir = scratchRepo("trunk");
  try {
    git(dir, ["checkout", "-q", "--detach", "HEAD"]);
    const out = runInit(dir);
    assert.match(out, /Couldn't detect the current branch/);
    const cfg = readFileSync(join(dir, "mergequeue.config.mjs"), "utf8");
    // Still falls back to the DEFAULTS value, but now the user is told so.
    assert.match(cfg, /"integrationBranch": "main"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init wires land/sync/promote/preview scripts into package.json end-to-end, without asking you to do it by hand", () => {
  const dir = scratchRepo("main");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "echo ok" } }));
  try {
    const out = runInit(dir);
    assert.match(out, /added "land", "sync", "promote", "preview", "preview:restore" to package\.json scripts/);
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(pkg.scripts.test, "echo ok", "pre-existing script must survive");
    assert.equal(pkg.scripts.land, "mergequeue land");
    assert.equal(pkg.scripts.sync, "mergequeue sync");
    assert.equal(pkg.scripts.promote, "mergequeue promote");
    assert.equal(pkg.scripts.preview, "mergequeue preview");
    assert.equal(pkg.scripts["preview:restore"], "mergequeue preview --restore");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Next steps only lists files actually written this run — not a static list that includes package.json when there wasn't one", () => {
  const dir = scratchRepo("main"); // no package.json — e.g. a non-Node repo
  try {
    const out = runInit(dir);
    assert.match(out, /Commit what it wrote — mergequeue\.config\.mjs, CLAUDE\.md, \.claude\/settings\.json/);
    assert.doesNotMatch(out, /and package\.json/, "nothing was written to package.json — must not tell you to commit it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Next steps says there's nothing new to commit when a second init run finds everything already wired", () => {
  const dir = scratchRepo("main");
  try {
    runInit(dir);
    const out = runInit(dir);
    assert.match(out, /nothing new to commit/);
    assert.doesNotMatch(out, /^ {2}1\. Commit/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
