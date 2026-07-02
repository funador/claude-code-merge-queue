# Lane Keeper

Keep parallel coding agents in their lane.

Run one Claude Code (or Codex, or Cursor, or whatever) at a time in a repo,
and everything just works. Run four at once — which is where this is all
heading, if it isn't already your Tuesday — and you get a very specific,
very predictable flavor of chaos:

- Two agents in the same working tree clobber each other's uncommitted edits
  and fight over the git index.
- Everyone pushes to the same branch, someone loses the race, and the
  rejected push turns into a rebase, which sometimes turns into *another*
  rejected push.
- A full build is heavy. Four of them running at once turn your laptop into
  a space heater.
- Four dev servers means four ports, four caches, and you, tabbing between
  browser windows trying to remember whose work is whose.
- If your tests hit a shared database, concurrent runs race each other's
  resets. The failures look flaky. They are not flaky. They're just honest.

None of that is a skill issue. It's what happens when several fast, confident
processes share one mutable thing with no traffic control. Telling the agents
to "please coordinate" doesn't fix it — an agent (or a teammate in a hurry)
will violate a documented convention exactly once, at exactly the wrong
moment, and mean nothing by it.

So don't ask nicely. Make the collision impossible.

## What's in the box

Five small, boring, load-bearing pieces:

| Command | What it does |
|---|---|
| `lanekeeper launch` | Claims the next free lane, creates (or reuses) its git worktree, and starts your agent inside it. |
| `lanekeeper build-lock -- <cmd>` | Runs `<cmd>` — your build — serialized across every lane, machine-wide. |
| `lanekeeper land` | Rebases and pushes your lane onto the integration branch through a FIFO queue, so two lanes are never mid-push at once. |
| `lanekeeper sync` | Fast-forwards your main checkout so a dev server actually sees what just landed. |
| `lanekeeper preview` | Instantly mirrors a lane's live working tree — uncommitted changes included — onto the main checkout, so you can look at it without a build. |

Plus a pre-push hook that makes `land` non-optional: a direct `git push`
straight to the integration branch gets bounced, full stop. Not a lint
warning. Not a Slack reminder. Rejected, with the actual command to run
instead.

And a documented extension point (`src/lib/ephemeral.ts` +
`examples/ephemeral-tmp-dir.example.ts`) for the thing every setup guide
skips: if your tests hit a shared resource — a database, a queue, anything
stateful — concurrent lanes need their own throwaway copy of it, and a
crashed run's copy needs to clean itself up without anyone noticing it died.

## Quickstart

```bash
npm install --save-dev lane-keeper
npx lanekeeper init
```

That writes `lanekeeper.config.mjs` at your repo root. Its presence is what
turns Lane Keeper on — nothing here touches a repo that hasn't opted in.
Open it, set `integrationBranch`, and add whatever else applies (see
[Configuration](#configuration) below).

Then:

1. Copy `node_modules/lane-keeper/hooks/pre-push` to `.husky/pre-push` (or
   append it to one you already have).
2. Add to `package.json`:
   ```json
   "scripts": {
     "land": "lanekeeper land",
     "sync": "lanekeeper sync",
     "preview": "lanekeeper preview",
     "preview:restore": "lanekeeper preview --restore"
   }
   ```
3. Bind `lanekeeper launch` to however you start your agent — a shell
   function, an alias, whatever your muscle memory already does.

From here on: `lanekeeper launch` from your main checkout to spin up an
isolated lane, do the work, and `lanekeeper land` when it's green. Repeat
with as many lanes as your laptop can stand.

## Configuration

Everything lives in one file — see
[`examples/lanekeeper.config.mjs`](examples/lanekeeper.config.mjs) for every
field with comments. The short version:

```js
export default {
  agentCommand: "claude",       // what you actually run
  branchPrefix: "lane/",        // lane/1, lane/2, ...
  worktreeSuffix: "-lane-",     // ../your-repo-lane-1
  portBase: 3000,               // lane n gets portBase + n
  integrationBranch: "main",    // where `land` pushes
  protectedBranches: [],        // e.g. ["main"] if integrationBranch is "dev"
  regenerableFiles: [],         // files a build tool rewrites — never block a rebase on these
  symlinks: [".env", ".env.local", "node_modules"],
};
```

Nothing here is hardcoded to any framework, branch model, or agent. If your
repo runs a two-stage `dev` → `main` promotion, set `integrationBranch: "dev"`
and `protectedBranches: ["main"]` and the pre-push hook enforces both: lanes
land on `dev` through the queue, and nothing pushes straight to `main` by
accident.

## The one idea underneath all of it

Every piece here is crash-safe the same way, on purpose: claim a resource,
tag the claim with your process ID, and let liveness — not a timeout — decide
when a claim is stale. `queue-lock.ts` does it for the build and landing
queues. `launch.ts` does it for a lane. `ephemeral.ts` does it for whatever
test resource you wire in. Kill -9 any of them mid-claim and the next
process to come along notices the PID is dead and reclaims it. No stale
locks, no "just restart your laptop," no magic number for how long is too
long to wait.

That's really the whole trick. Not "smarter agents" — dumber collisions.
Structurally impossible beats politely requested, every time.

## Where this came from

This is the extracted, generalized shape of tooling built to run several
parallel Claude Code agents on one real production codebase without them
tripping over each other — worktree isolation, a build queue, a landing
queue enforced by a git hook, instant previews, and the ephemeral-resource
pattern for tests. The names have been filed off; the mechanics haven't.

## License

MIT. Fork it, rename it, argue with the config shape — that's the point.
