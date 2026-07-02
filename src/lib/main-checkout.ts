/**
 * Resolve the MAIN checkout — the one non-lane checkout your dev server (or
 * CI, or whatever's watching the filesystem) actually runs from — starting
 * from any lane worktree.
 *
 * git-common-dir is ".git" (relative) from the main checkout itself, or an
 * absolute path to <main>/.git from a linked worktree — either way its
 * parent is MAIN. Shared by sync and preview so they agree on the one true
 * answer.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

export function resolveMainCheckout(cwd: string = process.cwd()): string {
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
  }).trim();
  return dirname(resolve(cwd, common));
}
