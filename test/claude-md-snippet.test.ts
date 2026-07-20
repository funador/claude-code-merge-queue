import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeMdSnippet, removeClaudeMdSnippet, replaceClaudeMdSnippet, MARKER, END_MARKER_PREFIX } from "../src/lib/claude-md-snippet.js";
import { DEFAULTS } from "../src/lib/config.js";

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "claude-code-merge-queue-md-"));
}

test("claudeMdSnippet tells the agent a failed land isn't done — re-run until it lands", () => {
  const snippet = claudeMdSnippet(DEFAULTS);
  assert.match(snippet, /A failed land isn't done/i);
  assert.match(snippet, /re-run `land` until it lands/i);
});

test("claudeMdSnippet tells the agent to surface an orphaned lane to the human, never delete it", () => {
  const snippet = claudeMdSnippet(DEFAULTS);
  assert.match(snippet, /Orphaned lane/i);
  assert.match(snippet, /never delete/i);
  assert.match(snippet, /claude-code-merge-queue reconcile/);
});

test("claudeMdSnippet includes the marker for idempotent re-appending", () => {
  assert.ok(claudeMdSnippet(DEFAULTS).startsWith(MARKER));
});

test("claudeMdSnippet warns the agent off hand-editing the managed section", () => {
  const snippet = claudeMdSnippet(DEFAULTS);
  assert.match(snippet, /do not hand-edit/i);
  assert.match(snippet, /regenerates everything between the markers/i);
});

test("claudeMdSnippet is delimited by an opening and a closing marker, in order", () => {
  const snippet = claudeMdSnippet(DEFAULTS);
  assert.ok(snippet.startsWith(MARKER));
  assert.ok(snippet.includes(END_MARKER_PREFIX));
  assert.ok(snippet.indexOf(MARKER) < snippet.indexOf(END_MARKER_PREFIX));
});

test("claudeMdSnippet names branches from config, never hardcoded", () => {
  const snippet = claudeMdSnippet({ ...DEFAULTS, integrationBranch: "trunk", productionBranch: "release" });
  assert.match(snippet, /`trunk`/);
  assert.match(snippet, /`release`/);
  // the old hardcoded dev/main must not leak in for a repo that uses neither
  assert.doesNotMatch(snippet, /\bdev\b/);
  assert.doesNotMatch(snippet, /\bmain\b/);
});

test("claudeMdSnippet reflects autoLand — autonomous vs propose-and-wait", () => {
  const auto = claudeMdSnippet({ ...DEFAULTS, autoLand: true });
  assert.match(auto, /Land when green, don't ask/i);

  const gated = claudeMdSnippet({ ...DEFAULTS, autoLand: false });
  assert.match(gated, /propose the land/i);
  assert.match(gated, /only once they say go/i);
  assert.doesNotMatch(gated, /don't ask/i);
});

test("replaceClaudeMdSnippet regenerates the delimited block in place, preserving content around it", () => {
  const before = "# My project\n\nHand-written rules above.\n\n";
  const after = "\n\nHand-written rules BELOW the block.\n";
  const stale = claudeMdSnippet({ ...DEFAULTS, integrationBranch: "trunk" });
  const fresh = claudeMdSnippet(DEFAULTS);
  const updated = replaceClaudeMdSnippet(before + stale + after, fresh);
  assert.ok(updated !== null);
  assert.ok(updated!.startsWith(before), "content before the block is preserved");
  assert.ok(updated!.endsWith(after), "content after the block is preserved");
  assert.ok(updated!.includes(fresh.trimEnd()), "the fresh block is present");
  assert.ok(!updated!.includes("trunk"), "the stale block was fully replaced");
});

test("replaceClaudeMdSnippet returns null for a legacy block with no closing marker", () => {
  const legacy = `${MARKER}\n## Claude Code Merge Queue workflow\n\n- old bullet\n`;
  assert.equal(replaceClaudeMdSnippet(legacy, claudeMdSnippet(DEFAULTS)), null);
});

test("claudeMdSnippet warns off promote only when a productionBranch is configured", () => {
  const withProd = claudeMdSnippet({ ...DEFAULTS, productionBranch: "main" });
  assert.match(withProd, /is production — not your call/i);

  const withoutProd = claudeMdSnippet({ ...DEFAULTS, productionBranch: null });
  assert.match(withoutProd, /landing is the whole deal/i);
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
    const handEdited = snippet.replace("ask the human", "ask the human (I added this line myself)");
    writeFileSync(join(dir, "CLAUDE.md"), `# Project instructions for Claude Code\n\n${handEdited}`);
    assert.equal(removeClaudeMdSnippet(dir, DEFAULTS), "mismatch");
    assert.match(readFileSync(join(dir, "CLAUDE.md"), "utf8"), /I added this line myself/, "must leave the hand-edited content untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
