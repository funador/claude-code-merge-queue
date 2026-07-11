import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeMdSnippet, removeClaudeMdSnippet, MARKER } from "../src/lib/claude-md-snippet.js";
import { DEFAULTS } from "../src/lib/config.js";

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "claude-code-merge-queue-md-"));
}

test("claudeMdSnippet tells the agent a failed land is not a stopping point — landed is the only done", () => {
  const snippet = claudeMdSnippet(DEFAULTS);
  assert.match(snippet, /not a stopping point — landed is the only "done\."/i);
  assert.match(snippet, /repeat until it actually lands/);
  assert.match(snippet, /Don't say a change is finished, complete, or ready while it's still sitting unlanded/);
});

test("claudeMdSnippet tells the agent to commit before landing — the most common self-inflicted failure", () => {
  const snippet = claudeMdSnippet(DEFAULTS);
  assert.match(snippet, /Commit before you land/i);
  assert.match(snippet, /pushes \*?committed\*? work, not your working tree/i);
});

test("claudeMdSnippet tells the agent to surface an orphaned lane to the human, never silently discard it", () => {
  const snippet = claudeMdSnippet(DEFAULTS);
  assert.match(snippet, /orphaned lane is a question for the human/i);
  assert.match(snippet, /never quietly delete it/i);
  assert.match(snippet, /claude-code-merge-queue reconcile/);
});

test("claudeMdSnippet includes the marker for idempotent re-appending", () => {
  assert.ok(claudeMdSnippet(DEFAULTS).startsWith(MARKER));
});

test("claudeMdSnippet warns off promote only when a productionBranch is configured", () => {
  const withProd = claudeMdSnippet({ ...DEFAULTS, productionBranch: "main" });
  assert.match(withProd, /is production, and it is not your call/);

  const withoutProd = claudeMdSnippet({ ...DEFAULTS, productionBranch: null });
  assert.match(withoutProd, /Landing is the whole deal/);
});

// --- removeClaudeMdSnippet (uninstall) --------------------------------------

test("removeClaudeMdSnippet deletes the file entirely when init created it fresh — nothing else was ever in it", () => {
  const dir = scratchDir();
  try {
    const snippet = claudeMdSnippet(DEFAULTS);
    writeFileSync(join(dir, "CLAUDE.md"), `# Project instructions for Claude Code\n\n${snippet}`);
    assert.equal(removeClaudeMdSnippet(dir, DEFAULTS), "removed");
    assert.ok(!existsSync(join(dir, "CLAUDE.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeClaudeMdSnippet strips only the appended block from a pre-existing CLAUDE.md, restoring the original byte-for-byte", () => {
  const dir = scratchDir();
  try {
    const original = "# My project\n\nSome hand-written rules here.\n";
    writeFileSync(join(dir, "CLAUDE.md"), original);
    const snippet = claudeMdSnippet(DEFAULTS);
    writeFileSync(join(dir, "CLAUDE.md"), original + `\n${snippet}`);
    assert.equal(removeClaudeMdSnippet(dir, DEFAULTS), "removed");
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeClaudeMdSnippet reports no-file / not-found instead of guessing when there's nothing of ours", () => {
  const dir = scratchDir();
  try {
    assert.equal(removeClaudeMdSnippet(dir, DEFAULTS), "no-file");
    writeFileSync(join(dir, "CLAUDE.md"), "# My project\n\nNo Claude Code Merge Queue section here.\n");
    assert.equal(removeClaudeMdSnippet(dir, DEFAULTS), "not-found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeClaudeMdSnippet refuses to touch a section that's been hand-edited since init wrote it", () => {
  const dir = scratchDir();
  try {
    const snippet = claudeMdSnippet(DEFAULTS);
    const handEdited = snippet.replace("Just work.", "Just work. (I added this line myself.)");
    writeFileSync(join(dir, "CLAUDE.md"), `# Project instructions for Claude Code\n\n${handEdited}`);
    assert.equal(removeClaudeMdSnippet(dir, DEFAULTS), "mismatch");
    assert.match(readFileSync(join(dir, "CLAUDE.md"), "utf8"), /I added this line myself/, "must leave the hand-edited content untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
