/**
 * The actual "baked into Claude" mechanism — not a hook, not magic. Claude
 * Code reads CLAUDE.md automatically at the start of every session and
 * follows it as standing instructions. So instead of expecting a human to
 * remember to type `claude-code-merge-queue land` after every change, this snippet tells
 * the agent itself to do it.
 *
 * It's a MARKER..END_MARKER delimited block. `claude-code-merge-queue init` writes it
 * into CLAUDE.md (creating the file if missing, appending once if a CLAUDE.md
 * exists without the block) and — because it's delimited at both ends —
 * regenerates it *in place* on any later run. Kept deliberately terse: this is
 * injected into someone else's CLAUDE.md, so every line is a cost. All branch
 * names come from cfg (integrationBranch/productionBranch) — nothing hardcoded.
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeCodeMergeQueueConfig } from "./config.js";

export const MARKER = "<!-- claude-code-merge-queue:workflow -->";

/**
 * Closing marker. Detection keys off END_MARKER_PREFIX so a future descriptive
 * tail wouldn't break the delimiter; the generator emits it bare to save a line.
 */
export const END_MARKER_PREFIX = "<!-- claude-code-merge-queue:workflow:end";
export const END_MARKER = `${END_MARKER_PREFIX} -->`;

export function claudeMdSnippet(cfg: ClaudeCodeMergeQueueConfig): string {
  const landBullet = cfg.autoLand
    ? `- **Land when green, don't ask.** Checks pass + committed → run \`claude-code-merge-queue land\` yourself (pre-authorized). Landed is done, not "pushed and waiting."`
    : `- **When green, propose the land — don't land unprompted.** Checks pass + committed → tell the human it's ready, and run \`claude-code-merge-queue land\` only once they say go. Landed is done, not "pushed and waiting."`;

  const promoteBlock = cfg.productionBranch
    ? `- **\`${cfg.productionBranch}\` is production — not your call.** Only a human runs \`claude-code-merge-queue promote\` (${cfg.integrationBranch} → ${cfg.productionBranch}); landing on \`${cfg.integrationBranch}\` is your finish line.`
    : `- **No separate production branch — \`${cfg.integrationBranch}\` is it; landing is the whole deal.**`;

  return `${MARKER}
## Claude Code Merge Queue workflow
<!-- Generated block — do not hand-edit. \`claude-code-merge-queue init\` regenerates everything between the markers; put your own notes outside them. -->

Parallel Claude Code lanes, no races — follow every session, unprompted:

${landBullet}
- **A failed land isn't done** — fix the rebase conflict (\`git add\`, \`git rebase --continue\`), re-run \`land\` until it lands.
- **Orphaned lane** (a \`⚠\` sibling with no session): ask the human, never delete. \`claude-code-merge-queue reconcile\` lists them.
${promoteBlock}
${END_MARKER}
`;
}

export type RemoveSnippetResult = "removed" | "not-found" | "mismatch" | "no-file";

/**
 * The reverse of `init`'s CLAUDE.md write. Deliberately exact-match only —
 * CLAUDE.md is hand-curated, high-trust prose a human reads and relies on,
 * so this refuses to guess at boundaries the way a heading-based or
 * marker-to-EOF strip would have to. It only acts when the live-regenerated
 * snippet (from the CURRENT config) appears verbatim in one of the two exact
 * shapes `init` can produce:
 *   - the file IS the snippet (created fresh by init, nothing else in it) —
 *     delete the file entirely rather than leave a bare header behind;
 *   - the snippet was appended to a pre-existing file — strip exactly that
 *     trailing substring, leaving everything before it untouched.
 * Anything else (hand-edited since, or init ran under a different config
 * than the one passed here) comes back "mismatch" — left completely alone
 * for a human to remove by hand.
 */
export function removeClaudeMdSnippet(root: string, cfg: ClaudeCodeMergeQueueConfig): RemoveSnippetResult {
  const path = join(root, "CLAUDE.md");
  if (!existsSync(path)) return "no-file";

  const content = readFileSync(path, "utf8");
  if (!content.includes(MARKER)) return "not-found";

  const snippet = claudeMdSnippet(cfg);
  const createdTemplate = `# Project instructions for Claude Code\n\n${snippet}`;

  if (content === createdTemplate) {
    rmSync(path);
    return "removed";
  }

  const appended = `\n${snippet}`;
  if (content.endsWith(appended)) {
    writeFileSync(path, content.slice(0, -appended.length).trimEnd() + "\n");
    return "removed";
  }

  return "mismatch";
}

/**
 * Regenerate the marker-delimited managed block in place. Replaces everything
 * from the opening MARKER through the end of the closing marker's HTML comment
 * with `snippet`, leaving all content before and after the block untouched.
 * This is what lets `init` re-sync a repo to the installed version without a
 * human editing CLAUDE.md by hand.
 *
 * Returns the updated content, or `null` when the block isn't a well-formed
 * delimited region (missing either marker, or the closing marker's `-->`) — in
 * which case the caller leaves the file alone rather than guessing boundaries.
 */
export function replaceClaudeMdSnippet(content: string, snippet: string): string | null {
  const start = content.indexOf(MARKER);
  if (start === -1) return null;
  const endMarkerAt = content.indexOf(END_MARKER_PREFIX, start);
  if (endMarkerAt === -1) return null;
  const close = content.indexOf("-->", endMarkerAt);
  if (close === -1) return null;
  const end = close + "-->".length;
  return content.slice(0, start) + snippet.trimEnd() + content.slice(end);
}
