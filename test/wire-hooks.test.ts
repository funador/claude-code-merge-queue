import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wireClaudeSettings, wireHuskyPrePush } from "../src/lib/wire-hooks.js";

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "lanekeeper-wire-"));
}

test("wireClaudeSettings creates .claude/settings.json from scratch", () => {
  const dir = scratchDir();
  try {
    assert.equal(wireClaudeSettings(dir), "created");
    const written = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    assert.equal(written.hooks.WorktreeCreate[0].hooks[0].command, "npx lanekeeper hook worktree-create");
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
    assert.equal(written.hooks.WorktreeCreate[0].hooks[0].command, "npx lanekeeper hook worktree-create");
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
    assert.match(readFileSync(join(dir, ".husky", "pre-push"), "utf8"), /lanekeeper check-push/);
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
    assert.match(content, /lanekeeper check-push/);
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
