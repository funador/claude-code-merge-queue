/**
 * The rest of `init`'s job: safely wire the WorktreeCreate hook into
 * `.claude/settings.json` and the pre-push hook into `.husky/pre-push`,
 * instead of leaving them as "copy this file yourself" — the exact kind of
 * manual step that undercuts a tool whose whole point is fewer manual steps.
 *
 * Both merges are additive and idempotent: creating the file if it's
 * missing, adding just our entry without touching anything else if the
 * file already exists, and doing nothing (safely) if our entry's already
 * there. Neither ever overwrites content that isn't ours.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_COMMAND = "npx lanekeeper hook worktree-create";
const PRE_PUSH_MARKER = "lanekeeper check-push";

export type WireResult = "created" | "merged" | "already-wired" | "unparseable" | "no-husky";

interface ClaudeSettings {
  hooks?: {
    WorktreeCreate?: Array<{ hooks: Array<{ type: string; command: string }> }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function wireClaudeSettings(root: string): WireResult {
  const dir = join(root, ".claude");
  const path = join(dir, "settings.json");

  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    const settings: ClaudeSettings = {
      hooks: { WorktreeCreate: [{ hooks: [{ type: "command", command: HOOK_COMMAND }] }] },
    };
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
    return "created";
  }

  let settings: ClaudeSettings;
  try {
    settings = JSON.parse(readFileSync(path, "utf8")) as ClaudeSettings;
  } catch {
    return "unparseable"; // leave it alone — don't guess at broken JSON
  }

  settings.hooks ??= {};
  settings.hooks.WorktreeCreate ??= [];
  const alreadyWired = settings.hooks.WorktreeCreate.some((group) => group.hooks?.some((h) => h.command?.includes(HOOK_COMMAND)));
  if (alreadyWired) return "already-wired";

  settings.hooks.WorktreeCreate.push({ hooks: [{ type: "command", command: HOOK_COMMAND }] });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  return "merged";
}

function shippedPrePushTemplate(): string {
  // dist/lib/wire-hooks.js -> ../../hooks/pre-push at the package root.
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "..", "..", "hooks", "pre-push"), "utf8");
}

// The template file is written to stand alone (shebang + comments explaining
// itself to a human reading it fresh). Appending it whole into an *existing*
// hook file would duplicate the shebang mid-script and leave behind prose
// like "copy this file to .husky/pre-push" that's nonsensical once it's
// already there. So strip the shebang and the leading comment block, and
// append only the functional part — the same source of truth, no second
// copy to drift out of sync.
function functionalSnippet(template: string): string {
  const lines = template.split("\n");
  let i = 0;
  if (lines[0]?.startsWith("#!")) i++;
  for (; i < lines.length; i++) {
    const trimmed = lines[i]?.trim() ?? "";
    if (trimmed !== "" && !trimmed.startsWith("#")) break;
  }
  return lines.slice(i).join("\n").trimEnd() + "\n";
}

export function wireHuskyPrePush(root: string): WireResult {
  const huskyDir = join(root, ".husky");
  if (!existsSync(huskyDir)) return "no-husky";

  const path = join(huskyDir, "pre-push");
  const template = shippedPrePushTemplate();

  if (!existsSync(path)) {
    writeFileSync(path, template);
    chmodSync(path, 0o755);
    return "created";
  }

  const existing = readFileSync(path, "utf8");
  if (existing.includes(PRE_PUSH_MARKER)) return "already-wired";

  const marker = "# --- Lane Keeper (appended by `lanekeeper init`) — see node_modules/lane-keeper/hooks/pre-push for the full comments ---";
  appendFileSync(path, `\n${marker}\n${functionalSnippet(template)}`);
  chmodSync(path, 0o755);
  return "merged";
}
