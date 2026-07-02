<p align="center">
  <img src="assets/banner.svg" alt="Lane Keeper — keep parallel coding agents in their lane" width="100%" />
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-3178c6.svg">
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18-339933.svg">
  <img alt="Runtime deps" src="https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg">
</p>

# Lane Keeper 🛟

**The local, zero-cost merge queue for parallel Claude Code agents.**

Claude Code already isolates your agents — `--worktree` (or `isolation:
"worktree"` on a subagent) gives every session its own git worktree, natively,
no setup. That part's solved. Lane Keeper is the part that comes after: what
happens when four isolated agents all try to land, build, and test *at the
same time*.

- 🏁 Everyone pushes to the same branch, someone loses the race, and the
  rejected push turns into a rebase, which sometimes turns into *another*
  rejected push.
- 🔥 A full build is heavy. Four of them running at once turn your laptop
  into a space heater.
- 🎲 If your tests hit a shared database, concurrent runs race each other's
  resets. The failures look flaky. They are not flaky. They're just honest.

None of that is a skill issue. It's what happens when several fast,
confident processes share one mutable thing with no traffic control.

Telling the agents to "please coordinate" doesn't fix it. An agent (or a
teammate in a hurry) will violate a documented convention exactly once, at
exactly the wrong moment, and mean nothing by it.

**So don't ask nicely. Make the collision impossible.** 🚦

## 🆚 vs. GitHub's Merge Queue

GitHub already ships a merge queue. Two things it costs you that this doesn't:

| | GitHub Merge Queue | Lane Keeper |
|---|---|---|
| Private repo | **Enterprise Cloud only** | Any plan, any repo |
| Cost per landing | GitHub Actions minutes, every queue attempt | $0 — runs on your own machine |
| Requires | A pull request | Nothing — direct rebase + push |

Same idea — serialize landings, test before merge, keep history clean — run
locally instead of in someone else's billed cloud. 💸

## 🧰 What's in the box

| Command | What it does |
|---|---|
| `lanekeeper hook worktree-create` | A Claude Code `WorktreeCreate` hook. Plugs Lane Keeper's numbered lanes into Claude's *native* worktree creation — doesn't reinvent it. |
| `lanekeeper build-lock -- <cmd>` | Runs `<cmd>` — your build — serialized across every lane, machine-wide. |
| `lanekeeper land` | Rebases and pushes your lane onto the integration branch through a FIFO queue, so two lanes are never mid-push at once. |
| `lanekeeper sync` | Fast-forwards your main checkout so a dev server actually sees what just landed. |
| `lanekeeper preview` | Instantly mirrors a lane's live working tree — uncommitted changes included — onto the main checkout, so you can look at it without a build. |
| `lanekeeper port` | Prints a lane's dev-server port, derived from its own directory name. |

Plus 🔒 a pre-push hook that makes `land` non-optional: a direct `git push`
straight to the integration branch gets bounced, full stop. Not a lint
warning. Not a Slack reminder. Rejected — with the actual command to run
instead.

And 🧪 a documented extension point (`src/lib/ephemeral.ts` +
`examples/ephemeral-tmp-dir.example.ts`) for the thing every setup guide
skips: if your tests hit a shared resource — a database, a queue, anything
stateful — concurrent lanes need their own throwaway copy of it, and a
crashed run's copy needs to clean itself up without anyone noticing it died.

## ⚡ Quickstart

```bash
npm install --save-dev lane-keeper
npx lanekeeper init
```

That writes `lanekeeper.config.mjs` at your repo root and prints the rest of
these steps. **Commit it** — it needs to exist on the branch a new worktree
checks out, or the hook below falls back to defaults.

1. Add the `WorktreeCreate` hook to `.claude/settings.json` — copy
   [`hooks/claude-settings.example.json`](hooks/claude-settings.example.json).
2. Copy `node_modules/lane-keeper/hooks/pre-push` to `.husky/pre-push` (or
   append it to one you already have).
3. Add to `package.json`:
   ```json
   "scripts": {
     "land": "lanekeeper land",
     "sync": "lanekeeper sync",
     "preview": "lanekeeper preview",
     "preview:restore": "lanekeeper preview --restore"
   }
   ```

From here on: `claude --worktree <name>` to spin up an isolated lane —
Lane Keeper's hook takes it from there — do the work, and `lanekeeper land`
when it's green. Repeat with as many lanes as your laptop can stand. 🚀

## ⚙️ Configuration

Everything lives in one file — see
[`examples/lanekeeper.config.mjs`](examples/lanekeeper.config.mjs) for every
field with comments. The short version:

```js
export default {
  branchPrefix: "lane/",               // lane/1, lane/2, ...
  worktreeSuffix: "-lane-",            // ../your-repo-lane-1
  portBase: 3000,                      // lane n gets portBase + n
  integrationBranch: "main",           // where `land` pushes
  protectedBranches: [],               // e.g. ["main"] if integrationBranch is "dev"
  regenerableFiles: [],                // files a build tool rewrites — never block a rebase on these
  symlinks: [".env", ".env.local", "node_modules"],
  buildOutputDirs: ["dist", "build", ".next"], // preview never copies these onto your checkout
};
```

Nothing here is hardcoded to any framework or branch model. 🧩 If your repo
runs a two-stage `dev` → `main` promotion, set `integrationBranch: "dev"` and
`protectedBranches: ["main"]` and the pre-push hook enforces both: lanes
land on `dev` through the queue, and nothing pushes straight to `main` by
accident.

## 🔁 The one idea underneath most of it

The build queue, the landing queue, and the ephemeral-resource pattern are
all crash-safe the **same way**, on purpose:

1. Claim a resource.
2. Tag the claim with your process ID.
3. Let liveness — not a timeout — decide when a claim is stale.

`queue-lock.ts` does it for the build and landing queues. `ephemeral.ts`
does it for whatever test resource you wire in. `Kill -9` any of them
mid-claim, and the next process to come along notices the PID is dead and
reclaims it.

The `WorktreeCreate` hook uses a cousin of the same idea, adapted to the fact
that it's a one-shot script with no long-lived process to check liveness
against: the claim IS the worktree, and `git worktree add` failing on an
already-taken path is the atomicity guard, delegated straight to git instead
of a PID file.

Either way: no stale locks, no "just restart your laptop," no magic number
for how long is too long to wait. ✅ Structurally impossible beats politely
requested, every time.

## 🧬 Where this came from

This is the extracted, generalized shape of tooling built to run several
parallel Claude Code agents on one real production codebase without them
tripping over each other — a build queue, a landing queue enforced by a git
hook, instant previews, and the ephemeral-resource pattern for tests, all
sitting on top of Claude Code's own native worktree isolation. The names
have been filed off; the mechanics haven't.

## 📄 License

MIT. Fork it, rename it, argue with the config shape — that's the point.
