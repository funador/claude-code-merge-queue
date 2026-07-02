/**
 * preview.ts — instantly preview a lane's working tree on the ONE shared dev
 * server, no build, no deploy.
 *
 * A hosted preview deployment is too slow for "let me glance at this." A dev
 * server is just files on disk being watched by your framework's bundler —
 * so this copies a lane's working tree (including uncommitted changes,
 * exactly what's being iterated on) straight onto the MAIN checkout. The
 * bundler picks up the change and hot-reloads in seconds.
 *
 *   lanekeeper preview            from a lane worktree — swap the dev server
 *                                 to show THIS lane's current working tree.
 *   lanekeeper preview --restore  from anywhere — put the dev server back on
 *                                 the integration branch's real HEAD.
 *
 * Safety:
 *   - Refuses to start a new preview if the MAIN checkout isn't clean (a
 *     previous preview wasn't restored, or it has real local changes) —
 *     never silently overwrites unknown state.
 *   - Additive only (no rsync --delete): a file the lane DELETED won't show
 *     up deleted in the preview. Deleting untracked files in a live checkout
 *     with no git record to recover them isn't a risk worth taking for a
 *     "quick look" tool — this only ever adds or modifies files.
 *   - Exact restore, not a guessed `git clean`: every newly-created
 *     untracked path introduced by the swap is recorded in a manifest up
 *     front, and restore removes precisely those paths, then
 *     `git checkout -- .` to revert every modified TRACKED file to HEAD.
 *   - Never touches .git, node_modules, build output, or env files in the
 *     target — only the source tree itself moves.
 */
import { execSync, execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMainCheckout } from "./lib/main-checkout.js";

const DIM = "\x1b[2m", RESET = "\x1b[0m", RED = "\x1b[31m", GREEN = "\x1b[32m";

const EXCLUDES = [".git", "node_modules", "dist", "build", ".next", ".env", ".env.local"];

interface Manifest {
  branch: string;
  addedPaths: string[];
}

function gitStatus(dir: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" });
}

function restore(target: string, manifestPath: string): void {
  if (!existsSync(manifestPath)) {
    console.log(`${DIM}preview: no active preview to restore.${RESET}`);
    return;
  }
  const { addedPaths } = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  console.log(`${DIM}reverting tracked-file changes on the dev checkout…${RESET}`);
  execFileSync("git", ["checkout", "--", "."], { cwd: target, stdio: "inherit" });
  for (const p of addedPaths) {
    rmSync(join(target, p), { recursive: true, force: true });
  }
  unlinkSync(manifestPath);
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: target, encoding: "utf8" }).trim();
  console.log(`${GREEN}✓ dev server restored to HEAD @ ${head}.${RESET}`);
}

function preview(source: string, target: string, manifestPath: string): void {
  if (source === target) {
    console.error("lanekeeper preview: refusing to run from the dev-server checkout itself — run this from a lane worktree.");
    process.exit(1);
  }
  if (existsSync(manifestPath)) {
    console.error(`${RED}preview: a preview is already active on the dev server.${RESET} Run 'lanekeeper preview --restore' first.`);
    process.exit(1);
  }
  const before = gitStatus(target);
  if (before.trim() !== "") {
    console.error(`${RED}preview: the dev-server checkout isn't clean — refusing to swap over unknown local changes.${RESET}`);
    console.error(before);
    process.exit(1);
  }

  const branch = execFileSync("git", ["-C", source, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  console.log(`${DIM}copying ${branch}'s working tree onto the dev server…${RESET}`);
  const rsyncArgs = ["-a", ...EXCLUDES.flatMap((e) => ["--exclude", e]), `${source}/`, `${target}/`];
  const rsync = spawnSync("rsync", rsyncArgs, { stdio: "inherit" });
  if (rsync.status !== 0) {
    console.error(`${RED}preview: rsync failed.${RESET}`);
    process.exit(1);
  }

  const after = gitStatus(target);
  const addedPaths = after
    .split("\n")
    .filter((l) => l.startsWith("??"))
    .map((l) => l.slice(3).trim());
  writeFileSync(manifestPath, JSON.stringify({ branch, addedPaths } satisfies Manifest, null, 2));

  console.log(`${GREEN}✓ dev server now showing ${branch}.${RESET} Refresh the browser.`);
  console.log(`${DIM}Run 'lanekeeper preview --restore' when done.${RESET}`);
}

export function runPreview(args: string[]): void {
  const source = process.cwd();
  const target = resolveMainCheckout(source);
  const manifestPath = join(tmpdir(), `lanekeeper-preview-manifest-${createHash("sha1").update(target).digest("hex").slice(0, 12)}.json`);

  // Fail fast and legibly if rsync isn't available, rather than a cryptic
  // spawn ENOENT partway through copying files.
  try {
    execSync("command -v rsync", { stdio: "ignore" });
  } catch {
    console.error("lanekeeper preview: rsync is required and wasn't found on PATH.");
    process.exit(1);
  }

  if (args.includes("--restore")) {
    restore(target, manifestPath);
  } else {
    preview(source, target, manifestPath);
  }
}
