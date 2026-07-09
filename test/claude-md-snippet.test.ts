import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeMdSnippet, MARKER } from "../src/lib/claude-md-snippet.js";
import { DEFAULTS } from "../src/lib/config.js";

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

test("claudeMdSnippet includes the marker for idempotent re-appending", () => {
  assert.ok(claudeMdSnippet(DEFAULTS).startsWith(MARKER));
});

test("claudeMdSnippet warns off promote only when a productionBranch is configured", () => {
  const withProd = claudeMdSnippet({ ...DEFAULTS, productionBranch: "main" });
  assert.match(withProd, /is production, and it is not your call/);

  const withoutProd = claudeMdSnippet({ ...DEFAULTS, productionBranch: null });
  assert.match(withoutProd, /Landing is the whole deal/);
});
