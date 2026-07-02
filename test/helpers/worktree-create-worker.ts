// Spawned as a real child process by worktree-create.test.ts — runs the
// exact same hook entrypoint Claude Code invokes, reading the {cwd} payload
// from stdin and printing the created worktree's path to stdout. A separate
// process (not an in-process call) because the property under test is that
// concurrent invocations never claim the same lane — `git worktree add`'s
// own atomicity is what's actually being exercised.
import { runWorktreeCreateHook } from "../../src/hooks/worktree-create.js";

await runWorktreeCreateHook();
