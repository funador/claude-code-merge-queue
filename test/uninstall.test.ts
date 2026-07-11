import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(fileURLToPath(import.meta.url), "..", "..", "dist", "bin", "claude-code-merge-queue.js");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-uninstall-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "hi\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

function runCli(cwd: string, args: string[]): string {
  return execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
}

test("uninstall reverses a from-scratch init byte-for-byte: config, CLAUDE.md, and package.json all end up exactly as they started", () => {
  const dir = scratchRepo();
  try {
    const originalReadme = readFileSync(join(dir, "README.md"), "utf8");
    const originalPkg = { name: "x", scripts: { test: "echo ok" } };
    writeFileSync(join(dir, "package.json"), JSON.stringify(originalPkg));

    runCli(dir, ["init"]);
    assert.ok(existsSync(join(dir, "claude-code-merge-queue.config.mjs")));
    assert.ok(existsSync(join(dir, "CLAUDE.md")));
    assert.ok(existsSync(join(dir, ".claude", "settings.json")));
    assert.ok(existsSync(join(dir, "claude-code-merge-queue-preflight.mjs")));
    const wiredPkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(wiredPkg.scripts.reconcile, "claude-code-merge-queue reconcile");

    const out = runCli(dir, ["uninstall"]);
    assert.match(out, /Claude Code Merge Queue is now OFF for this repo/);

    assert.ok(!existsSync(join(dir, "claude-code-merge-queue.config.mjs")), "config must be gone");
    assert.ok(!existsSync(join(dir, "CLAUDE.md")), "CLAUDE.md was created solely for the snippet — must be gone too");
    assert.ok(!existsSync(join(dir, "claude-code-merge-queue-preflight.mjs")));
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), originalReadme, "untouched files must survive the whole round trip");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")), originalPkg, "package.json's content must return to exactly its pre-init form (wiring always re-serializes pretty-printed, so formatting legitimately differs)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall on top of pre-existing files only strips what init added, never the human's own content", () => {
  const dir = scratchRepo();
  try {
    const humanClaudeMd = "# My project\n\nSome hand-written rules here.\n";
    writeFileSync(join(dir, "CLAUDE.md"), humanClaudeMd);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "echo ok" } }));

    runCli(dir, ["init"]);
    runCli(dir, ["uninstall"]);

    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), humanClaudeMd, "pre-existing CLAUDE.md content must survive verbatim");
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(pkg.scripts.test, "echo ok");
    assert.ok(!("land" in pkg.scripts), "wired scripts must be gone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uninstall reports nothing to do on a repo that was never init'd", () => {
  const dir = scratchRepo();
  try {
    const out = runCli(dir, ["uninstall"]);
    assert.match(out, /nothing to remove/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
