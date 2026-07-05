import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sync } from "../src/sync.js";
import { DEFAULTS } from "../src/lib/config.js";

/**
 * A fake `npm` on PATH that just records it ran, instead of doing a real
 * (slow, network-dependent) install. Returns the marker file path — assert
 * against its contents, or its absence, to prove install ran or didn't.
 */
function fakePackageManagerBin(exitCode = 0): { binDir: string; marker: string } {
  const binDir = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-fakebin-"));
  const marker = join(binDir, "install-ran.txt");
  writeFileSync(join(binDir, "npm"), `#!/bin/sh\necho "$@" >> "${marker}"\nexit ${exitCode}\n`);
  chmodSync(join(binDir, "npm"), 0o755);
  return { binDir, marker };
}

function pushLockfileChange(remote: string, filename: string, message: string): void {
  const other = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-sync-other-"));
  execFileSync("git", ["clone", "--quiet", remote, other]);
  git(other, ["config", "user.email", "test@test.com"]);
  git(other, ["config", "user.name", "Test"]);
  writeFileSync(join(other, filename), "v2\n");
  git(other, ["add", "-A"]);
  git(other, ["commit", "-q", "-m", message]);
  git(other, ["push", "-q", "origin", "main"]);
  rmSync(other, { recursive: true, force: true });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepoWithRemote(branch = "main"): { dir: string; remote: string } {
  const base = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-sync-"));
  const remote = join(base, "remote.git");
  const dir = join(base, "checkout");
  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  execFileSync("git", ["clone", "--quiet", remote, dir]);
  git(dir, ["config", "user.email", "test@test.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["checkout", "-q", "-b", branch]);
  writeFileSync(join(dir, "file.txt"), "v1\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  git(dir, ["push", "-q", "-u", "origin", branch]);
  return { dir, remote };
}

test("sync refuses to act when the checkout isn't on integrationBranch", async () => {
  const { dir } = makeRepoWithRemote();
  const cwd = process.cwd();
  try {
    git(dir, ["checkout", "-q", "-b", "lane/1"]);
    writeFileSync(join(dir, "file.txt"), "lane change\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "lane work"]);
    const before = git(dir, ["rev-parse", "HEAD"]).trim();

    process.chdir(dir);
    let stderr = "";
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      stderr += args.join(" ");
    };
    const code = await sync();
    console.error = origError;

    assert.equal(code, 0);
    assert.match(stderr, /not the configured integrationBranch/);
    assert.equal(git(dir, ["rev-parse", "HEAD"]).trim(), before, "HEAD must not move");
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync fast-forwards the main checkout when it's on integrationBranch and behind", async () => {
  const { dir, remote } = makeRepoWithRemote();
  const cwd = process.cwd();
  try {
    // A second clone lands a new commit onto origin/main, simulating another lane landing.
    const other = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-sync-other-"));
    execFileSync("git", ["clone", "--quiet", remote, other]);
    git(other, ["config", "user.email", "test@test.com"]);
    git(other, ["config", "user.name", "Test"]);
    writeFileSync(join(other, "file.txt"), "v2\n");
    git(other, ["add", "-A"]);
    git(other, ["commit", "-q", "-m", "landed elsewhere"]);
    git(other, ["push", "-q", "origin", "main"]);
    const remoteHead = git(other, ["rev-parse", "HEAD"]).trim();
    rmSync(other, { recursive: true, force: true });

    process.chdir(dir);
    const code = await sync();
    assert.equal(code, 0);
    assert.equal(git(dir, ["rev-parse", "HEAD"]).trim(), remoteHead);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bare sync() falls back to DEFAULTS when MAIN has no config yet — and can wrongly refuse a real integrationBranch that isn't literally \"main\"", async () => {
  // The exact bootstrap gap: the main checkout doesn't have
  // claude-code-merge-queue.config.mjs yet (this push just introduced it, and sync is
  // what's supposed to bring it over) — a bare sync() has no way to know
  // the real integrationBranch is "dev", not DEFAULTS' "main".
  const { dir } = makeRepoWithRemote("dev");
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    let stderr = "";
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      stderr += args.join(" ");
    };
    const code = await sync();
    console.error = origError;

    assert.equal(code, 0);
    assert.match(stderr, /not the configured integrationBranch \('main'\)/, "falls back to DEFAULTS.integrationBranch, not the project's real one");
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync(providedCfg) uses the caller's already-loaded config instead of re-deriving from MAIN — fixes the bootstrap gap above", async () => {
  const { dir, remote } = makeRepoWithRemote("dev");
  const cwd = process.cwd();
  try {
    const other = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-sync-other-"));
    execFileSync("git", ["clone", "--quiet", remote, other]);
    git(other, ["config", "user.email", "test@test.com"]);
    git(other, ["config", "user.name", "Test"]);
    // The bare remote's own HEAD symref reflects git's global default branch
    // (main/master), not "dev" — explicitly track it rather than relying on
    // clone to have checked it out.
    git(other, ["checkout", "-q", "-b", "dev", "origin/dev"]);
    writeFileSync(join(other, "file.txt"), "v2\n");
    git(other, ["add", "-A"]);
    git(other, ["commit", "-q", "-m", "landed elsewhere"]);
    git(other, ["push", "-q", "origin", "dev"]);
    const remoteHead = git(other, ["rev-parse", "HEAD"]).trim();
    rmSync(other, { recursive: true, force: true });

    process.chdir(dir);
    const code = await sync({ ...DEFAULTS, integrationBranch: "dev" });
    assert.equal(code, 0);
    assert.equal(git(dir, ["rev-parse", "HEAD"]).trim(), remoteHead, "should have fast-forwarded using the provided config, not DEFAULTS");
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sync runs an install when the fast-forwarded range changed package-lock.json — the shared node_modules every lane symlinks would otherwise go stale", async () => {
  const { dir, remote } = makeRepoWithRemote();
  const cwd = process.cwd();
  const { binDir, marker } = fakePackageManagerBin();
  const originalPath = process.env.PATH;
  try {
    pushLockfileChange(remote, "package-lock.json", "bump a dep");

    process.chdir(dir);
    process.env.PATH = `${binDir}:${originalPath}`;
    const code = await sync();
    assert.equal(code, 0);
    assert.ok(existsSync(marker), "expected npm install to have run");
    assert.equal(readFileSync(marker, "utf8").trim(), "install");
  } finally {
    process.env.PATH = originalPath;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("sync skips the install when the fast-forwarded range left the lockfile untouched", async () => {
  const { dir, remote } = makeRepoWithRemote();
  const cwd = process.cwd();
  const { binDir, marker } = fakePackageManagerBin();
  const originalPath = process.env.PATH;
  try {
    pushLockfileChange(remote, "file.txt", "unrelated change");

    process.chdir(dir);
    process.env.PATH = `${binDir}:${originalPath}`;
    const code = await sync();
    assert.equal(code, 0);
    assert.ok(!existsSync(marker), "install should not have run — lockfile didn't change");
  } finally {
    process.env.PATH = originalPath;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("sync skips the install when a dependency was renamed — the shared node_modules would otherwise break every lane still on the old name", async () => {
  const { dir, remote } = makeRepoWithRemote();
  const cwd = process.cwd();
  const { binDir, marker } = fakePackageManagerBin();
  const originalPath = process.env.PATH;
  try {
    // Base commit has a real package.json so the "before" side of the diff
    // has something to lose a key from.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ devDependencies: { "old-name": "^1.0.0" } }));
    writeFileSync(join(dir, "package-lock.json"), "v1\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "add package.json"]);
    git(dir, ["push", "-q", "origin", "main"]);

    const other = mkdtempSync(join(tmpdir(), "claude-code-merge-queue-sync-other-"));
    execFileSync("git", ["clone", "--quiet", remote, other]);
    git(other, ["config", "user.email", "test@test.com"]);
    git(other, ["config", "user.name", "Test"]);
    writeFileSync(join(other, "package.json"), JSON.stringify({ devDependencies: { "new-name": "^1.0.0" } }));
    writeFileSync(join(other, "package-lock.json"), "v2\n");
    git(other, ["add", "-A"]);
    git(other, ["commit", "-q", "-m", "rename old-name to new-name"]);
    git(other, ["push", "-q", "origin", "main"]);
    rmSync(other, { recursive: true, force: true });

    process.chdir(dir);
    process.env.PATH = `${binDir}:${originalPath}`;
    let stderr = "";
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      stderr += args.join(" ");
    };
    const code = await sync();
    console.error = origError;

    assert.equal(code, 0);
    assert.ok(!existsSync(marker), "install should NOT have run — a removed dependency key needs a human");
    assert.match(stderr, /dropped old-name/);
  } finally {
    process.env.PATH = originalPath;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("sync still reports success (git state IS correctly fast-forwarded) even if the install itself fails, but says so", async () => {
  const { dir, remote } = makeRepoWithRemote();
  const cwd = process.cwd();
  const { binDir } = fakePackageManagerBin(1);
  const originalPath = process.env.PATH;
  try {
    pushLockfileChange(remote, "package-lock.json", "bump a dep");

    process.chdir(dir);
    process.env.PATH = `${binDir}:${originalPath}`;
    let stderr = "";
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      stderr += args.join(" ");
    };
    const code = await sync();
    console.error = origError;

    assert.equal(code, 0);
    assert.match(stderr, /install.*failed/i);
  } finally {
    process.env.PATH = originalPath;
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});
