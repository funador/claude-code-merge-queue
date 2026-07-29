<p align="center">
  <img src="assets/banner.svg" alt="Claude Code Merge Queue — the local, zero-cost merge queue for parallel Claude Code agents" width="100%" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/claude-code-merge-queue"><img alt="npm version" src="https://img.shields.io/npm/v/claude-code-merge-queue.svg"></a>
  <a href="https://www.npmjs.com/package/claude-code-merge-queue"><img alt="npm downloads" src="https://img.shields.io/npm/dm/claude-code-merge-queue.svg"></a>
  <a href="https://github.com/funador/claude-code-merge-queue/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/funador/claude-code-merge-queue/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-3178c6.svg">
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18-339933.svg">
  <img alt="Runtime deps" src="https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg">
</p>

# Claude Code Merge Queue 🚦

**The local, zero-cost merge queue for parallel Claude Code agents.** Several
agents land, build, and test at the same time — this serializes it so push
races, redundant heavy builds, and shared-resource test flakiness can't happen.

## ⚡ Quickstart

```bash
npm install --save-dev claude-code-merge-queue   # or: pnpm add -D / yarn add -D / bun add -d
npx claude-code-merge-queue init
```

## Contents

- [⚙️ Configuration](#️-configuration)
- [🆚 vs. GitHub's Merge Queue](#-vs-githubs-merge-queue)
- [🧰 What's in the box](#-whats-in-the-box)
- [🚨 The emergency hatch](#-the-emergency-hatch)
- [🔍 Know the limits](#-know-the-limits)
- [📄 License](#-license)

<p align="center">
  <img src="assets/demo-terminal.svg" alt="Terminal demo: npm install --save-dev claude-code-merge-queue, then npx claude-code-merge-queue init — writes the config, CLAUDE.md, the WorktreeCreate hook, and land/sync/promote/preview scripts" width="100%" />
</p>

**Commit what it wrote**, then `claude --worktree <name>` to spin up an
isolated lane — Claude Code Merge Queue's hook and CLAUDE.md take it from
there. (No `checkCommand` detected in package.json? Every push is
**blocked** until you set one — see 🧰 What's in the box below. That's on
purpose.) You show up to run `claude-code-merge-queue promote` when you
actually want to ship. 🚀

## ⚙️ Configuration

Everything lives in one file — see
[`examples/claude-code-merge-queue.config.mjs`](examples/claude-code-merge-queue.config.mjs) for every
field with comments. The short version:

```js
export default {
  branchPrefix: "lane/",               // lane/1, lane/2, ...
  worktreeSuffix: "-lane-",            // ../your-repo-lane-1
  portBase: 3000,                      // lane n gets portBase + n
  integrationBranch: "main",           // where agents land — see below
  productionBranch: null,              // set this for a two-stage model — see below
  protectedBranches: [],               // extra branches beyond the two above; most repos need none
  regenerableFiles: [],                // files a build tool rewrites — never block a rebase on these
  symlinks: [".env", ".env.local", "node_modules"],
  buildOutputDirs: ["dist", "build", ".next"], // preview never copies these onto your checkout
  checkCommand: "npm run check",       // what actually gates a landing — see below
  checksRequired: true,                // false = deliberately run with none; see below
};
```

A malformed config (empty branch names, a negative port, `productionBranch`
equal to `integrationBranch`, ...) fails loud with every problem listed,
the moment any command loads it — not a mysterious failure three steps
later.

## 🆚 vs. GitHub's Merge Queue

| | GitHub Merge Queue | Claude Code Merge Queue |
|---|---|---|
| Private repo | **Enterprise Cloud only** | Any plan, any repo |
| Cost per landing | GitHub Actions minutes, every queue attempt | $0 — runs on your own machine |
| Requires | A pull request | Nothing — direct rebase + push |

Same idea — serialize landings, test before merge, keep history clean — run
locally instead of in someone else's billed cloud.

## 🧰 What's in the box

| Command | What it does |
|---|---|
| `claude-code-merge-queue hook worktree-create` | A Claude Code `WorktreeCreate` hook. Plugs Claude Code Merge Queue's numbered lanes into Claude's *native* worktree creation. |
| `claude-code-merge-queue build-lock -- <cmd>` | Runs `<cmd>` — your build — serialized across every lane, machine-wide. |
| `claude-code-merge-queue land` | Rebases and pushes your lane onto the integration branch through a FIFO queue, so two lanes are never mid-push at once. Agents run this themselves. |
| `claude-code-merge-queue sync` | Fast-forwards your main checkout so a dev server actually sees what just landed — and re-installs dependencies if the lockfile changed. |
| `claude-code-merge-queue promote` | Ships the integration branch to production. **Human-only** — never in an agent's instructions, never automated. |
| `claude-code-merge-queue preview` | Instantly mirrors a lane's live working tree — uncommitted changes included — onto the main checkout, so you can look at it without a build. |
| `claude-code-merge-queue port` | Prints a lane's dev-server port, derived from its own directory name. |
| `claude-code-merge-queue prune` | Removes already-landed sibling lane worktrees on demand. |

A pre-push hook makes `land` non-optional: a direct `git push` straight to
the integration branch is rejected, with the actual command to run
instead, and the same hook runs `checkCommand` before allowing a landing
through — no checkCommand configured means every push fails by default.
There's a way out for every block (see 🚨 The emergency hatch), but it
takes naming the specific branch, not a generic flag.

Tests that hit a shared resource (a database, a queue) can use the
ephemeral-resource pattern in `src/lib/ephemeral.ts` — concurrent lanes get
their own throwaway copy, cleaned up automatically even after a crash.

Two library exports for scripts that need to coordinate lanes around
something the CLI doesn't cover: `claude-code-merge-queue/queue-lock` (the
same cross-worktree FIFO mutex `build-lock`/`land` use, under your own
name) and `claude-code-merge-queue/retry` (retry-with-backoff for
transient failures under concurrent load). See [`examples/`](examples/)
for usage.

### 📝 What `init` writes

- **`claude-code-merge-queue.config.mjs`** — `integrationBranch` and `checkCommand` auto-detected.
- **`CLAUDE.md`** (or appends to yours) — tells Claude Code to land its own
  work once green, without being asked.
- **`.claude/settings.json`** — the `WorktreeCreate` hook wired in, without
  touching anything else already there.
- **`.husky/pre-push`** — created or appended to, *if* you already have
  Husky. If you don't, `init` tells you rather than silently writing to
  the untracked `.git/hooks/pre-push`.
- **`package.json` scripts** — `land`, `sync`, `promote`, `preview`,
  `preview:restore`, skipping any you've already defined yourself.
- **`claude-code-merge-queue-preflight.mjs`** — a self-contained safety net
  that runs before `land`/`sync`, so a stale branch fails with a real
  diagnosis instead of a bare `command not found`.

## 🚨 The emergency hatch

Every blocked push — the integration branch, `productionBranch`, anything
in `protectedBranches` — has a real way through it. One env var, no
prompts, no second factor to remember:

```bash
CLAUDE_CODE_MERGE_QUEUE_EMERGENCY_PUSH=1 git push origin HEAD:main
```

This is a convention, not a hard guarantee: it stops mistakes and stray
pushes, not an adversarial agent that sets the var itself.

## 🔍 Know the limits

- **No human reviews any of this before it lands.** `checkCommand` passing
  is the only gate — a real test suite or `echo ok` look identical to this
  tool. `promote` is a release decision ("ship this already-tested work
  now"), not a code read. If you want a human on every change, this is
  missing that step on purpose.
- **Locks are crash-safe by PID liveness, not a timeout.** Claim a
  resource, tag it with your process ID; `kill -9` anything mid-claim and
  the next process notices the PID is dead and reclaims it — no stale
  locks, no timeout to tune. The `WorktreeCreate` hook applies the same
  idea to a one-shot script: the claim IS the worktree, and `git worktree
  add` failing on an already-taken path is the atomicity guard.
- **One machine, not a fleet.** The FIFO queue lives in local temp storage —
  it doesn't coordinate across laptops. Two machines landing at once just
  get git's ordinary non-fast-forward rejection (safe, not corrupting).
- **Not a security boundary.** Every guardrail here stops mistakes and
  convention drift, not a truly adversarial agent. Shell access always
  means `git push --no-verify`, deleting the hook, or editing the config on
  purpose — nothing local-only can stop that.
- **The `WorktreeCreate` hook is the youngest piece of this stack** — Claude
  Code shipped it Feb 2026. Losing it degrades gracefully: fall back to
  `git worktree add` by hand and you still keep the build queue, landing
  queue, preview, and ephemeral-resource pieces, none of which depend on it.
- **A slow `checkCommand` is a real throughput ceiling.** The FIFO lock
  holds for its entire duration — one landing at a time, machine-wide. A
  3–4 minute suite caps you well under 20 landings/hour, before any queue
  wait.
- **Rebase conflicts abort, they never guess.** `git rebase --abort` on any
  conflict, working tree left clean. Normally "you" here is the agent, not
  a human — CLAUDE.md tells it to resolve the conflict and re-run `land`.
- **Auto-pruning checks for a live Claude Code session, via `lsof`.** A
  merged branch alone isn't enough — a brand-new, zero-commit lane is
  *trivially* "merged" too, so pruning also refuses to touch a worktree
  with a live Claude Code process in it. Missing `lsof` fails closed —
  never removes if liveness is unknown.
- **The `WorktreeCreate` hook needs the host project's own real install.**
  It runs via `npx claude-code-merge-queue hook worktree-create` (no
  `node_modules/.bin` on PATH for a raw hook), and npx silently falls back
  to an ephemeral, unpinned copy if it can't resolve the package locally.
  The hook refuses to run at all from npx's ephemeral cache, so a broken
  install fails loud immediately instead of limping along on a mismatched
  stand-in.

## 📄 License

MIT. Fork it, rename it, argue with the config shape — that's the point.
