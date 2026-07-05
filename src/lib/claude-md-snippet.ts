/**
 * The actual "baked into Claude" mechanism — not a hook, not magic. Claude
 * Code reads CLAUDE.md automatically at the start of every session and
 * follows it as standing instructions. So instead of expecting a human to
 * remember to type `claude-code-merge-queue land` after every change, this snippet tells
 * the agent itself to do it — the same way a real production setup that
 * runs several parallel Claude Code agents keeps its own human out of the
 * loop for anything except the final promotion to production.
 *
 * `claude-code-merge-queue init` writes this into CLAUDE.md (creating it if missing,
 * appending — once, idempotently, via MARKER — if one already exists) so
 * every session in the repo picks it up with zero extra setup per agent.
 */
import type { ClaudeCodeMergeQueueConfig } from "./config.js";

export const MARKER = "<!-- claude-code-merge-queue:workflow -->";

export function claudeMdSnippet(cfg: ClaudeCodeMergeQueueConfig): string {
  const promoteBlock = cfg.productionBranch
    ? `- **\`${cfg.productionBranch}\` is production, and it is not your call.** Only a human runs \`claude-code-merge-queue promote\` (${cfg.integrationBranch} → ${cfg.productionBranch}), on their own schedule. Never run it yourself, never suggest running it as part of "finishing" a task — landing on \`${cfg.integrationBranch}\` is the finish line for you.`
    : `- There's no separate production branch configured — \`${cfg.integrationBranch}\` already is it. Landing is the whole deal.`;

  return `${MARKER}
## Claude Code Merge Queue workflow

This repo uses [Claude Code Merge Queue](https://github.com/funador/claude-code-merge-queue) to run parallel Claude Code agents without them racing each other. It's not a suggestion — follow it by default, every session, without being asked:

- **You're probably already in a lane.** If you were started with \`claude --worktree <name>\`, Claude Code Merge Queue's \`WorktreeCreate\` hook already isolated you into your own git worktree and branch. Just work.
- **Land the moment your change is green — don't ask first.** Run \`claude-code-merge-queue land\` yourself once tests/build/lint pass. This is pre-authorized, standard workflow, not a decision that needs sign-off. It rebases onto \`${cfg.integrationBranch}\`, pushes through the FIFO landing queue, and syncs the dev checkout — that whole sequence is "done," not "pushed to a branch and waiting."
- **Never push \`${cfg.integrationBranch}\` directly.** \`git push origin HEAD:${cfg.integrationBranch}\` is rejected by the pre-push hook anyway — always go through \`claude-code-merge-queue land\`.
- **A failed \`claude-code-merge-queue land\` is not a stopping point — landed is the only "done."** A rebase conflict aborts safely and leaves your working tree clean; that's expected, not an error to report and hand back. Resolve the conflicting diff yourself the same way you'd fix any other bug, \`git add\` the result, \`git rebase --continue\`, then re-run \`claude-code-merge-queue land\` — repeat until it actually lands. Don't say a change is finished, complete, or ready while it's still sitting unlanded in your lane; \`checkCommand\` still gates the real push regardless of how many attempts it took, so a wrong resolution gets caught there, not by a human reading it first.
- **Use \`claude-code-merge-queue build-lock -- <cmd>\` for anything heavy** (a full build, a slow test suite) so parallel lanes take turns instead of thrashing the machine together.
${promoteBlock}
`;
}
