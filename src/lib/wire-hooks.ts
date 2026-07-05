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
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_COMMAND = "npx claude-code-merge-queue hook worktree-create";
const PRE_PUSH_MARKER = "claude-code-merge-queue check-push";
export const PREFLIGHT_FILENAME = "claude-code-merge-queue-preflight.mjs";

const PACKAGE_SCRIPTS: Record<string, string> = {
  land: "claude-code-merge-queue land",
  sync: "claude-code-merge-queue sync",
  promote: "claude-code-merge-queue promote",
  preview: "claude-code-merge-queue preview",
  "preview:restore": "claude-code-merge-queue preview --restore",
  // npm auto-runs "preland"/"presync" before "land"/"sync" — no wiring
  // needed beyond the script name itself. See wirePreflightScript below for
  // why the check they run has to live in a plain, tool-name-agnostic file
  // instead of just being another `claude-code-merge-queue` subcommand.
  preland: `node ${PREFLIGHT_FILENAME} land`,
  presync: `node ${PREFLIGHT_FILENAME} sync`,
};

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

  const marker = "# --- Claude Code Merge Queue (appended by `claude-code-merge-queue init`) — see node_modules/claude-code-merge-queue/hooks/pre-push for the full comments ---";
  appendFileSync(path, `\n${marker}\n${functionalSnippet(template)}`);
  chmodSync(path, 0o755);
  return "merged";
}

export type HooksPathResult = "set" | "already-set" | "custom-path";

/**
 * A `.husky/pre-push` file on disk enforces nothing on its own — git only
 * runs it if `core.hooksPath` points somewhere that resolves to it, which is
 * normally set as a side effect of the package manager's install step
 * (husky's own `prepare` script). On a freshly cloned repo where nobody's
 * run that install yet — the exact state Quickstart leaves you in right
 * after `init` — the file is silently inert and a direct push sails through
 * uncontested. Since Claude Code Merge Queue is the one promising "pushes are gated now,"
 * it sets this itself instead of depending on a step that may not have
 * happened yet, mirroring exactly what `husky install` itself does.
 *
 * Husky v9 changed its own convention mid-flight: v6–v8 point
 * core.hooksPath directly at `.husky` (hook files run as-is); v9 points it
 * at `.husky/_`, a generated wrapper directory that then execs the real
 * `.husky/<hookname>` file. Both are legitimate, already-correct setups —
 * only treat something OTHER than either as a deliberate custom path worth
 * warning about. `.husky/_` doesn't exist yet on the fresh-clone/no-install
 * case this function exists for, so `.husky` remains the right thing to set
 * when nothing's configured at all; if the project turns out to be v9,
 * husky's own next real install corrects it to `.husky/_`.
 */
export function ensureHooksPath(root: string): HooksPathResult {
  let current: string | null;
  try {
    current = execFileSync("git", ["config", "core.hooksPath"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    current = null; // unset
  }

  if (current === ".husky" || current === ".husky/_") return "already-set";
  if (current) return "custom-path"; // respect an existing deliberate setup — don't override it

  execFileSync("git", ["config", "core.hooksPath", ".husky"], { cwd: root });
  return "set";
}

/**
 * When a landing renames the tool `land`/`sync` invoke (lanekeeper ->
 * claude-code-merge-queue happened once already), any lane that hasn't rebased past that
 * point yet still has package.json scripts calling the OLD name. The shared
 * node_modules those lanes symlink from has already moved to the new name,
 * so `npm run land` fails at the shell level — "lanekeeper: command not
 * found" — before a single line of this tool's own code runs. Nothing
 * inside `claude-code-merge-queue land` can catch that; the binary it would need to run
 * to catch it is the very thing that's missing.
 *
 * That's why this has to be a plain, standalone script committed into the
 * CONSUMER repo rather than another `claude-code-merge-queue` subcommand: it must still
 * work the next time the tool itself gets renamed, so it can never invoke
 * `claude-code-merge-queue` (or import from the `claude-code-merge-queue` package) itself. It only
 * reads the target script's own command out of package.json, checks whether
 * that command's binary actually resolves, and — if not — prints the real
 * cause (a stale branch) instead of a bare, misleading shell error.
 */
export function preflightScriptContent(integrationBranch: string): string {
  return `#!/usr/bin/env node
// Generated by \`claude-code-merge-queue init\` (wirePreflightScript) — do not hand-edit;
// re-run \`claude-code-merge-queue init\` after changing integrationBranch instead.
//
// Runs as "preland"/"presync" (npm's automatic pre<script> hook) before
// "land"/"sync". Deliberately self-contained — no import of claude-code-merge-queue
// itself — so it still catches a stale branch even across a future rename
// of this very tool. See wirePreflightScript in claude-code-merge-queue's source for why.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const target = process.argv[2]; // "land" or "sync"
const INTEGRATION_BRANCH = ${JSON.stringify(integrationBranch)};

let pkg;
try {
  pkg = JSON.parse(readFileSync("package.json", "utf8"));
} catch {
  process.exit(0); // can't read it — not this script's problem to raise
}

const command = pkg.scripts?.[target];
if (!command) process.exit(0);

const bin = command.trim().split(/\\s+/)[0];
try {
  execFileSync("sh", ["-c", \`command -v -- "\${bin}"\`], { stdio: "ignore" });
} catch {
  console.error(\`\\n✋ '\${bin}' isn't resolvable — this branch's package.json looks stale relative to origin/\${INTEGRATION_BRANCH} (the tool it invokes may have been renamed or removed there since this branch was last rebased).\`);
  console.error(\`   Fix: git fetch origin \${INTEGRATION_BRANCH} && git rebase origin/\${INTEGRATION_BRANCH}, then retry.\\n\`);
  process.exit(1);
}
`;
}

export type PreflightWireResult = "created" | "already-exists";

/** Additive/idempotent, same contract as the rest of this file — never overwrites a version you've customized. */
export function wirePreflightScript(root: string, integrationBranch: string): PreflightWireResult {
  const path = join(root, PREFLIGHT_FILENAME);
  if (existsSync(path)) return "already-exists";
  writeFileSync(path, preflightScriptContent(integrationBranch));
  return "created";
}

export type ScriptsWireResult = "added" | "already-wired" | "unparseable" | "no-package-json";

/**
 * The last "copy this yourself" step `init` used to leave on the table:
 * Quickstart told you to hand-add these scripts to package.json instead of
 * just adding them. Same additive/idempotent contract as the rest of this
 * file — only ever fills in scripts that don't exist yet, never overwrites
 * one you've customized (e.g. if `land` already runs something of yours
 * first), and does nothing if they're all already there.
 */
export function wirePackageJsonScripts(root: string): { result: ScriptsWireResult; added: string[] } {
  const path = join(root, "package.json");
  if (!existsSync(path)) return { result: "no-package-json", added: [] };

  let pkg: { scripts?: Record<string, string>; [key: string]: unknown };
  try {
    pkg = JSON.parse(readFileSync(path, "utf8")) as typeof pkg;
  } catch {
    return { result: "unparseable", added: [] };
  }

  pkg.scripts ??= {};
  const added: string[] = [];
  for (const [name, command] of Object.entries(PACKAGE_SCRIPTS)) {
    if (!(name in pkg.scripts)) {
      pkg.scripts[name] = command;
      added.push(name);
    }
  }

  if (added.length === 0) return { result: "already-wired", added: [] };

  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  return { result: "added", added };
}
