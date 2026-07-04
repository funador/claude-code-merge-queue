// localmerge.config.mjs — lives at your repo root. `localmerge init` writes a
// copy of this for you; edit the values below for your project.
//
// Worktree isolation is Claude Code's job (native `--worktree` /
// `isolation: "worktree"`) — this file is what the WorktreeCreate hook
// (see hooks/claude-settings.example.json) reads to name and shape the lane
// it creates, and what everything downstream (build queue, landing queue,
// preview) reads too.

/** @type {import("localmerge").LocalMergeConfig} */
export default {
  // Lane branches: lane/1, lane/2, ...
  branchPrefix: "lane/",

  // Sibling worktree dirs: ../<your-repo>-lane-1, -lane-2, ...
  worktreeSuffix: "-lane-",

  // Lane 1 gets this port, lane 2 gets portBase + 2, and so on — handy if
  // each lane also runs its own throwaway dev server.
  portBase: 3000,

  // The branch `localmerge land` rebases onto and pushes to. Agents land
  // here continuously and autonomously — see the CLAUDE.md workflow section
  // `localmerge init` writes.
  integrationBranch: "main",

  // Set this if you run a two-stage model: agents land on integrationBranch,
  // a human ships to productionBranch on their own schedule with
  // `localmerge promote`. null (the default) means integrationBranch IS
  // production — no separate promotion step. Example: integrationBranch
  // "dev", productionBranch "main". Automatically protected by the pre-push
  // hook when set — you don't need to also list it below.
  productionBranch: null,

  // Extra branches the pre-push hook refuses a *direct* push to, beyond
  // integrationBranch and productionBranch. Most repos need nothing here.
  protectedBranches: [],

  // Files your build tool rewrites on its own that should never block a
  // rebase or a fast-forward. Next.js projects typically want
  // ["next-env.d.ts"] here at minimum — add to this list the first time a
  // regenerated file blocks a landing, and never think about it again.
  regenerableFiles: [],

  // Git-ignored paths symlinked into every new lane so it needs no fresh
  // install and no copy of your secrets.
  symlinks: [".env", ".env.local", "node_modules"],

  // Build-output dirs `localmerge preview` never copies onto your dev
  // checkout. preview is framework-agnostic (it's an rsync, not a build
  // step) — this is the one place your framework's name shows up. Add
  // ".output" for Nuxt, ".svelte-kit" for SvelteKit, etc.
  buildOutputDirs: ["dist", "build", ".next"],

  // The command that actually gates a landing — your lint/typecheck/test/
  // build. `localmerge init` tries to detect this from package.json
  // (check:push, check, ci, or test, in that order) and fills it in for
  // you. null means nothing runs, which is only allowed if checksRequired
  // is also false — see below.
  checkCommand: "npm run check",

  // true (the default): a null checkCommand FAILS every push rather than
  // landing unverified code. Set to false yourself to deliberately run
  // with no checks — a real state for a repo with nothing to test yet, but
  // one that should be a visible, committed choice, not a silent default.
  checksRequired: true,
};
