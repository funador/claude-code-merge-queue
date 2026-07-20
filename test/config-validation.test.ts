import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, DEFAULTS } from "../src/lib/config.js";

test("DEFAULTS is itself valid", () => {
  assert.deepEqual(validateConfig(DEFAULTS), []);
});

test("rejects a negative portBase", () => {
  const problems = validateConfig({ ...DEFAULTS, portBase: -5 });
  assert.ok(problems.some((p) => /portBase/.test(p)));
});

test("rejects an empty integrationBranch", () => {
  const problems = validateConfig({ ...DEFAULTS, integrationBranch: "" });
  assert.ok(problems.some((p) => /integrationBranch/.test(p)));
});

test("rejects productionBranch equal to integrationBranch", () => {
  const problems = validateConfig({ ...DEFAULTS, integrationBranch: "main", productionBranch: "main" });
  assert.ok(problems.some((p) => /no-op two-stage/.test(p)));
});

test("rejects integrationBranch also listed in protectedBranches", () => {
  const problems = validateConfig({ ...DEFAULTS, integrationBranch: "dev", protectedBranches: ["dev"] });
  assert.ok(problems.some((p) => /protectedBranches contains integrationBranch/.test(p)));
});

test("rejects a non-array symlinks field", () => {
  // @ts-expect-error deliberately malformed for the test
  const problems = validateConfig({ ...DEFAULTS, symlinks: "node_modules" });
  assert.ok(problems.some((p) => /symlinks/.test(p)));
});

test("rejects a non-boolean checksRequired", () => {
  // @ts-expect-error deliberately malformed for the test
  const problems = validateConfig({ ...DEFAULTS, checksRequired: "yes" });
  assert.ok(problems.some((p) => /checksRequired/.test(p)));
});

test("rejects a non-boolean autoLand", () => {
  // @ts-expect-error deliberately malformed for the test
  const problems = validateConfig({ ...DEFAULTS, autoLand: "yes" });
  assert.ok(problems.some((p) => /autoLand/.test(p)));
});

test("accepts a valid two-stage config", () => {
  const problems = validateConfig({
    ...DEFAULTS,
    integrationBranch: "dev",
    productionBranch: "main",
    checkCommand: "npm run check",
  });
  assert.deepEqual(problems, []);
});
