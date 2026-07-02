import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectCheckCommand, runCheckCommand } from "../src/lib/check-command.js";

test("detectCheckCommand finds nothing without a package.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "lanekeeper-detect-"));
  try {
    assert.equal(detectCheckCommand(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectCheckCommand prefers check:push over test", () => {
  const dir = mkdtempSync(join(tmpdir(), "lanekeeper-detect-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "mocha", "check:push": "node scripts/check.mjs" } }));
    assert.equal(detectCheckCommand(dir), "npm run check:push");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectCheckCommand falls back to test when nothing else is present", () => {
  const dir = mkdtempSync(join(tmpdir(), "lanekeeper-detect-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "mocha" } }));
    assert.equal(detectCheckCommand(dir), "npm run test");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCheckCommand fails when checkCommand is null and checksRequired is true", () => {
  assert.equal(runCheckCommand({ checkCommand: null, checksRequired: true }), 1);
});

test("runCheckCommand succeeds when checkCommand is null and checksRequired is false", () => {
  assert.equal(runCheckCommand({ checkCommand: null, checksRequired: false }), 0);
});

test("runCheckCommand propagates the command's real exit code", () => {
  assert.equal(runCheckCommand({ checkCommand: "exit 0", checksRequired: true }), 0);
  assert.equal(runCheckCommand({ checkCommand: "exit 7", checksRequired: true }), 7);
});
