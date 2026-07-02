<p align="center">
  <img src="assets/banner.svg" alt="LaneKeeper — the local, zero-cost merge queue for parallel Claude Code agents" width="100%" />
</p>

<p align="center">
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.x-3178c6.svg">
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18-339933.svg">
  <img alt="Runtime deps" src="https://img.shields.io/badge/runtime%20deps-0-brightgreen.svg">
</p>

# LaneKeeper 🛟

**The local, zero-cost merge queue for parallel Claude Code agents.**

*Honesty check: this repo — code, tests, docs, all of it — was built with
Claude Code. The commits aren't co-authored (they should have been), so
this line does the disclosing instead.*

Claude Code already isolates your agents — `--worktree` (or `isolation:
"worktree"` on a subagent) gives every session its own git worktree, natively,
no setup. That part's solved. LaneKeeper is the part that comes after: what
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

| | GitHub Merge Queue | LaneKeeper |
|---|---|---|
| Private repo | **Enterprise Cloud only** | Any plan, any repo |
| Cost per landing | GitHub Actions minutes, every queue attempt | $0 — runs on your own machine |
| Requires | A pull request | Nothing — direct rebase + push |

Same idea — serialize landings, test before merge, keep history clean — run
locally instead of in someone else's billed cloud. 💸

## 🧰 What's in the box

| Command | What it does |
|---|---|
| `lanekeeper hook worktree-create` | A Claude Code `WorktreeCreate` hook. Plugs LaneKeeper's numbered lanes into Claude's *native* worktree creation — doesn't reinvent it. |
| `lanekeeper build-lock -- <cmd>` | Runs `<cmd>` — your build — serialized across every lane, machine-wide. |
| `lanekeeper land` | Rebases and pushes your lane onto the integration branch through a FIFO queue, so two lanes are never mid-push at once. Agents run this themselves — see below. |
| `lanekeeper sync` | Fast-forwards your main checkout so a dev server actually sees what just landed. |
| `lanekeeper promote` | Ships the integration branch to production. **Human-only** — never in an agent's instructions, never automated. |
| `lanekeeper preview` | Instantly mirrors a lane's live working tree — uncommitted changes included — onto the main checkout, so you can look at it without a build. |
| `lanekeeper port` | Prints a lane's dev-server port, derived from its own directory name. |

Plus 🔒 a pre-push hook that makes `land` non-optional: a direct `git push`
straight to the integration branch gets bounced, full stop. Not a lint
warning. Not a Slack reminder. Rejected — with the actual command to run
instead. The same hook also runs your actual checks (`checkCommand` —
lint/typecheck/test/build) before allowing a landing through at all; a
config with no checkCommand set **fails every push by default** rather than
landing unverified code silently.

Every one of those blocks has a real, deliberate way out — see "The
emergency hatch" below — but it takes two matching, specific pieces of
intent, not one flag.

And 🧪 a documented extension point (`src/lib/ephemeral.ts` +
`examples/ephemeral-tmp-dir.example.ts`) for the thing every setup guide
skips: if your tests hit a shared resource — a database, a queue, anything
stateful — concurrent lanes need their own throwaway copy of it, and a
crashed run's copy needs to clean itself up without anyone noticing it died.

## ⚡ Quickstart

```bash
npm install --save-dev lanekeeper   # or: pnpm add -D / yarn add -D / bun add -d
npx lanekeeper init
```

This does the whole setup, not just the config file:

- **`lanekeeper.config.mjs`** — `integrationBranch` auto-detected from your
  current branch, `checkCommand` auto-detected from package.json
  (`check:push` / `check` / `ci` / `test`, first match wins).
- **`CLAUDE.md`** (or appends to yours if you already have one) — the part
  that makes the whole thing hands-off. Claude Code reads it automatically,
  every session, and it tells the agent to land its own work once green,
  without being asked. See "The hands-off part" below.
- **`.claude/settings.json`** — the `WorktreeCreate` hook wired in (created,
  or merged into your existing settings without touching anything else
  already there).
- **`.husky/pre-push`** — created or appended to, *if* you already have
  Husky. If you don't, `init` tells you so instead of silently writing to
  the untracked, not-shared-with-your-team `.git/hooks/pre-push`.

**Commit everything it wrote.** Then add to `package.json`:
```json
"scripts": {
  "land": "lanekeeper land",
  "sync": "lanekeeper sync",
  "promote": "lanekeeper promote",
  "preview": "lanekeeper preview",
  "preview:restore": "lanekeeper preview --restore"
}
```

If `init` couldn't detect a `checkCommand` (no matching script in
package.json), every push is **blocked** until you set one — see 🧰 What's
in the box above. That's on purpose.

From here on: `claude --worktree <name>` to spin up an isolated lane —
LaneKeeper's hook takes it from there, and CLAUDE.md tells the agent the rest.
You show up to run `lanekeeper promote` when you actually want to ship. 🚀

## ⚙️ Configuration

Everything lives in one file — see
[`examples/lanekeeper.config.mjs`](examples/lanekeeper.config.mjs) for every
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

Nothing here is hardcoded to any framework or branch model. 🧩 A malformed
config (empty branch names, a negative port, `productionBranch` equal to
`integrationBranch`, ...) fails loud with every problem listed, the moment
any command loads it — not a mysterious failure three steps later.

## 🚨 The emergency hatch

Every blocked push — the integration branch, `productionBranch`, anything
in `protectedBranches` — has a real way through it. It's meant to be used
rarely and on purpose, so it asks for two separate, specific things instead
of one flag an agent could set just as easily as a human:

```bash
LANEKEEPER_EMERGENCY_PUSH=1 git push origin HEAD:main
```

That alone isn't enough — you'll be prompted, right there in your terminal,
to **type the exact branch name** to confirm. No terminal attached (CI, a
script)? Provide the second factor yourself instead:

```bash
LANEKEEPER_EMERGENCY_PUSH=1 LANEKEEPER_EMERGENCY_PUSH_CONFIRM=main git push origin HEAD:main
```

No confirmation, no tty, no match — it fails **closed**, not open. This is
the one place in LaneKeeper that's honestly a convention, not a hard
guarantee: the env vars stop mistakes and stray pushes, not a truly
adversarial agent that decides to set them itself. Worth knowing, not worth
pretending isn't true.

## 🙌 The hands-off part

Tests are the reviewer. Not a human, at any point in this pipeline — and
that's a deliberate, named tradeoff, not an oversight.

- **`checkCommand` gates landing.** Nothing reaches `integrationBranch`
  without passing it. This is the first, and for most changes the *only*,
  correctness check anything gets.
- **`lanekeeper promote` is a release decision, not a code review.**
  Running it means "this batch of already-landed, already-tested work
  should ship now" — not "I read the diff and it looks right." If your own
  CI provider also runs checks against the production branch (most real
  setups have this — a deploy gate, an E2E suite, whatever), that's a
  *second automated* checkpoint, still not a human one.
- **When something gets through anyway, the fix is a test, not a
  reviewer.** If a bug lands, the answer isn't "a human should have caught
  that" — it's "what check would have caught it, and why didn't it exist
  yet." Every miss becomes a permanent guardrail instead of a one-off
  catch, which is the only version of this that scales past however many
  diffs one person can actually read.

This isn't for every team. If what you actually want is a human looking at
every change before it ships, this tool will feel like it's missing a
step — because it is, on purpose. It's built for the case where you trust
the agent's *output conditional on the checks being real*, and the checks
being non-optional (see 🧰 above) is what makes that trust earned rather
than assumed.

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

## 🔍 Know the limits

Things a sharp reader should already know before they ask:

- **One machine, not a fleet.** The FIFO queue lives in local temp storage —
  it doesn't coordinate across laptops. Two machines landing at the same
  moment just get git's own ordinary non-fast-forward rejection (safe, not
  corrupting — the loser re-fetches and retries, same as any team without a
  queue does today). This solves the one-machine problem completely; it was
  never trying to solve the distributed one.
- **Not a security boundary.** Every guardrail here stops mistakes and
  convention drift — a fast, confident, forgetful agent — not a truly
  adversarial one. An agent with shell access can always `git push
  --no-verify`, delete the hook, or edit the config on purpose. If your
  threat model includes an agent actively trying to get around this, none
  of this helps, and nothing local-only ever could.
- **Guarantees a check ran — not that the check is good.** LaneKeeper
  enforces that `checkCommand` exists and passed. It has no way to know if
  that's a real test suite or `echo ok`. "Tests are the reviewer" is only
  as true as what's actually in them.
- **The `WorktreeCreate` hook is the youngest piece of this stack** — Claude
  Code shipped it Feb 2026. Losing it degrades gracefully: fall back to
  `git worktree add` by hand and you still keep the build queue, landing
  queue, preview, and ephemeral-resource pieces, none of which depend on it.
- **A slow `checkCommand` is a real throughput ceiling, not a free lunch.**
  The FIFO lock holds for its entire duration — one landing at a time,
  machine-wide. A 3–4 minute suite caps you well under 20 landings/hour
  flat-out, before any queue wait.
- **Rebase conflicts abort, they never guess.** `git rebase --abort` on any
  conflict, working tree left clean — it never auto-resolves or silently
  picks a side. In the normal flow that "you" is the agent, not a human:
  CLAUDE.md tells it to resolve the conflict itself and re-run `land`, the
  same way it'd fix any other bug — `checkCommand` still gates the result
  either way, so a bad resolution gets caught there.

## 🧬 Where this came from

This is the extracted, generalized shape of tooling built to run several
parallel Claude Code agents on one real production codebase without them
tripping over each other — a build queue, a landing queue enforced by a git
hook, instant previews, and the ephemeral-resource pattern for tests, all
sitting on top of Claude Code's own native worktree isolation. The names
have been filed off; the mechanics haven't.

## 📄 License

MIT. Fork it, rename it, argue with the config shape — that's the point.
