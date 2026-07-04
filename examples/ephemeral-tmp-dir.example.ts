/**
 * A complete, runnable EphemeralResourceProvider — a scratch directory per
 * test run instead of a database branch, so this example works with zero
 * external services and zero cost. Swap `create`/`destroy`/`destroyOrphan`
 * for calls to your actual provider (a Neon branch-create/delete API, a
 * `CREATE DATABASE ... TEMPLATE ...`, a Docker container) and everything
 * else — the claim registry, the orphan pruning, the finally-block release —
 * carries over unchanged.
 *
 * Run it:  node --import tsx examples/ephemeral-tmp-dir.example.ts
 * Simulate a crash:  node --import tsx examples/ephemeral-tmp-dir.example.ts --crash
 *   then run it again without --crash and watch it prune the orphan first.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimRegistry, withEphemeralResource, type EphemeralResourceProvider } from "../src/lib/ephemeral.js";

const REGISTRY_DIR = join(tmpdir(), "claude-code-local-merge-example-ephemeral-registry");
const RESOURCE_ROOT = join(tmpdir(), "claude-code-local-merge-example-ephemeral-resources");
mkdirSync(RESOURCE_ROOT, { recursive: true });

const tmpDirProvider: EphemeralResourceProvider<string> = {
  async create() {
    const dir = mkdtempSync(join(RESOURCE_ROOT, "run-"));
    console.log(`  created scratch dir: ${dir}`);
    return dir;
  },
  async destroy(dir) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`  destroyed scratch dir: ${dir}`);
  },
  async destroyOrphan(claim) {
    // The claim only tells us WHO made it and WHEN, not which directory it
    // owned — in a real provider you'd store that mapping yourself (e.g. the
    // resource's ID inside the claim record). For this example, orphaned
    // "run-*" directories are swept by age instead.
    console.log(`  pruning orphan left by dead pid ${claim.pid} (claimed at ${new Date(claim.createdAt).toISOString()})`);
    for (const name of readdirSync(RESOURCE_ROOT)) {
      const path = join(RESOURCE_ROOT, name);
      if (existsSync(join(path, ".orphan-sweep-safe"))) {
        rmSync(path, { recursive: true, force: true });
      }
    }
  },
};

const registry = new ClaimRegistry(REGISTRY_DIR);

if (process.argv.includes("--crash")) {
  // Simulate a run that claims a resource and then dies before its finally
  // block runs — no rmSync, no registry.release(). The NEXT run should find
  // and prune this.
  const dir = mkdtempSync(join(RESOURCE_ROOT, "run-"));
  writeFileSync(join(dir, ".orphan-sweep-safe"), "");
  registry.record({ id: `${Date.now()}-${process.pid}`, pid: process.pid, createdAt: Date.now() });
  console.log(`simulated crash: claimed ${dir} and exiting without cleanup (pid ${process.pid})`);
  process.exit(1);
}

await withEphemeralResource(tmpDirProvider, registry, async (dir) => {
  writeFileSync(join(dir, "example.txt"), "this file only exists for the run's lifetime\n");
  console.log(`  running your tests against ${dir}…`);
});

console.log("done — resource was created, used, and torn down; any prior orphan was pruned first.");
