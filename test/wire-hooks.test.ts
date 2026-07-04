import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wireClaudeSettings, wireHuskyPrePush, ensureHooksPath, wirePackageJsonScripts } from "../src/lib/wire-hooks.js";

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "localmerge-wire-"));
}

function scratchGitRepo(): string {
  const dir = scratchDir();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

test("wireClaudeSettings creates .claude/settings.json from scratch", () => {
  const dir = scratchDir();
  try {
    assert.equal(wireClaudeSettings(dir), "created");
    const written = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    assert.equal(written.hooks.WorktreeCreate[0].hooks[0].command, "npx localmerge hook worktree-create");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wireClaudeSettings merges into an existing settings.json without dropping other hooks", () => {
  const dir = scratchDir();
  try {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }] } }),
    );
    assert.equal(wireClaudeSettings(dir), "merged");
    const written = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    assert.equal(written.hooks.PreToolUse[0].hooks[0].command, "echo hi", "existing hook must survive");
    assert.equal(written.hooks.WorktreeCreate[0].hooks[0].command, "npx localmerge hook worktree-create");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wireClaudeSettings is idempotent", () => {
  const dir = scratchDir();
  try {
    wireClaudeSettings(dir);
    assert.equal(wireClaudeSettings(dir), "already-wired");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wireClaudeSettings leaves unparseable JSON untouched", () => {
  const dir = scratchDir();
  try {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "settings.json"), "{ not valid json");
    assert.equal(wireClaudeSettings(dir), "unparseable");
    assert.equal(readFileSync(join(dir, ".claude", "settings.json"), "utf8"), "{ not valid json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wireHuskyPrePush does nothing when there's no .husky directory", () => {
  const dir = scratchDir();
  try {
    assert.equal(wireHuskyPrePush(dir), "no-husky");
    assert.ok(!existsSync(join(dir, ".husky")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wireHuskyPrePush creates pre-push when .husky exists but the hook doesn't", () => {
  const dir = scratchDir();
  try {
    mkdirSync(join(dir, ".husky"));
    assert.equal(wireHuskyPrePush(dir), "created");
    assert.match(readFileSync(join(dir, ".husky", "pre-push"), "utf8"), /localmerge check-push/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wireHuskyPrePush appends to an existing custom pre-push without dropping it", () => {
  const dir = scratchDir();
  try {
    mkdirSync(join(dir, ".husky"));
    writeFileSync(join(dir, ".husky", "pre-push"), "#!/usr/bin/env sh\necho custom logic\n");
    assert.equal(wireHuskyPrePush(dir), "merged");
    const content = readFileSync(join(dir, ".husky", "pre-push"), "utf8");
    assert.match(content, /echo custom logic/);
    assert.match(content, /localmerge check-push/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wireHuskyPrePush's appended block has no duplicate shebang or self-referential 'copy this file' prose", () => {
  const dir = scratchDir();
  try {
    mkdirSync(join(dir, ".husky"));
    writeFileSync(join(dir, ".husky", "pre-push"), "#!/usr/bin/env sh\necho custom logic\n");
    wireHuskyPrePush(dir);
    const content = readFileSync(join(dir, ".husky", "pre-push"), "utf8");
    const shebangCount = content.split("\n").filter((l) => l.startsWith("#!")).length;
    assert.equal(shebangCount, 1, "only the file's own original shebang should be present");
    assert.doesNotMatch(content, /Copy this file to \.husky/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wireHuskyPrePush is idempotent", () => {
  const dir = scratchDir();
  try {
    mkdirSync(join(dir, ".husky"));
    wireHuskyPrePush(dir);
    assert.equal(wireHuskyPrePush(dir), "already-wired");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureHooksPath sets core.hooksPath when unset — the fresh-clone case where a .husky/pre-push file would otherwise be silently inert", () => {
  const dir = scratchGitRepo();
  try {
    assert.equal(ensureHooksPath(dir), "set");
    assert.equal(execFileSync("git", ["config", "core.hooksPath"], { cwd: dir, encoding: "utf8" }).trim(), ".husky");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureHooksPath is idempotent once set", () => {
  const dir = scratchGitRepo();
  try {
    ensureHooksPath(dir);
    assert.equal(ensureHooksPath(dir), "already-set");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureHooksPath recognizes Husky v9's .husky/_ convention as already correct, not a custom path", () => {
  const dir = scratchGitRepo();
  try {
    execFileSync("git", ["config", "core.hooksPath", ".husky/_"], { cwd: dir });
    assert.equal(ensureHooksPath(dir), "already-set");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureHooksPath leaves a deliberate custom hooksPath alone", () => {
  const dir = scratchGitRepo();
  try {
    execFileSync("git", ["config", "core.hooksPath", "custom-hooks-dir"], { cwd: dir });
    assert.equal(ensureHooksPath(dir), "custom-path");
    assert.equal(execFileSync("git", ["config", "core.hooksPath"], { cwd: dir, encoding: "utf8" }).trim(), "custom-hooks-dir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wirePackageJsonScripts adds all five scripts to a fresh package.json", () => {
  const dir = scratchDir();
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    const { result, added } = wirePackageJsonScripts(dir);
    assert.equal(result, "added");
    assert.deepEqual(added.sort(), ["land", "preview", "preview:restore", "promote", "sync"].sort());
    const written = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(written.scripts.land, "localmerge land");
    assert.equal(written.scripts.sync, "localmerge sync");
    assert.equal(written.scripts.promote, "localmerge promote");
    assert.equal(written.scripts.preview, "localmerge preview");
    assert.equal(written.scripts["preview:restore"], "localmerge preview --restore");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wirePackageJsonScripts never overwrites a script you've already customized", () => {
  const dir = scratchDir();
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { land: "npm run lint && localmerge land" } }));
    const { result, added } = wirePackageJsonScripts(dir);
    assert.equal(result, "added");
    assert.ok(!added.includes("land"), "must not report an already-customized script as added");
    assert.deepEqual(added.sort(), ["preview", "preview:restore", "promote", "sync"].sort());
    const written = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(written.scripts.land, "npm run lint && localmerge land", "custom script must survive untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wirePackageJsonScripts is idempotent", () => {
  const dir = scratchDir();
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    wirePackageJsonScripts(dir);
    assert.deepEqual(wirePackageJsonScripts(dir), { result: "already-wired", added: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wirePackageJsonScripts reports no-package-json instead of creating one from scratch", () => {
  const dir = scratchDir();
  try {
    assert.deepEqual(wirePackageJsonScripts(dir), { result: "no-package-json", added: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wirePackageJsonScripts leaves unparseable package.json untouched", () => {
  const dir = scratchDir();
  try {
    writeFileSync(join(dir, "package.json"), "{ not valid json");
    assert.deepEqual(wirePackageJsonScripts(dir), { result: "unparseable", added: [] });
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), "{ not valid json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
