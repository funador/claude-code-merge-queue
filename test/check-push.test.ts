import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPush, parseRefUpdates } from "../src/lib/check-push.js";

const cfg = { integrationBranch: "dev", productionBranch: "main" as string | null, protectedBranches: ["staging"] };

function refLine(remoteRef: string): string {
  return `refs/heads/local abc123 ${remoteRef} def456`;
}

test("blocks a direct push to the integration branch without MERGEQUEUE_LANDING", () => {
  const result = checkPush(parseRefUpdates(refLine("refs/heads/dev")), cfg, {});
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /mergequeue land/);
});

test("allows a push to the integration branch when MERGEQUEUE_LANDING=1", () => {
  const result = checkPush(parseRefUpdates(refLine("refs/heads/dev")), cfg, { MERGEQUEUE_LANDING: "1" });
  assert.equal(result.ok, true);
});

test("blocks a direct push to productionBranch even though it's not in protectedBranches", () => {
  const result = checkPush(parseRefUpdates(refLine("refs/heads/main")), cfg, {});
  assert.equal(result.ok, false);
  assert.match(result.message ?? "", /main/);
});

test("blocks a direct push to an explicit protectedBranches entry", () => {
  const result = checkPush(parseRefUpdates(refLine("refs/heads/staging")), cfg, {});
  assert.equal(result.ok, false);
});

test("allows a push to a protected branch when MERGEQUEUE_EMERGENCY_PUSH=1", () => {
  const result = checkPush(parseRefUpdates(refLine("refs/heads/main")), cfg, { MERGEQUEUE_EMERGENCY_PUSH: "1" });
  assert.equal(result.ok, true);
});

test("allows a push to the integration branch when MERGEQUEUE_EMERGENCY_PUSH=1", () => {
  const result = checkPush(parseRefUpdates(refLine("refs/heads/dev")), cfg, { MERGEQUEUE_EMERGENCY_PUSH: "1" });
  assert.equal(result.ok, true);
});

test("blocks a protected-branch push when MERGEQUEUE_EMERGENCY_PUSH isn't exactly \"1\"", () => {
  const result = checkPush(parseRefUpdates(refLine("refs/heads/main")), cfg, { MERGEQUEUE_EMERGENCY_PUSH: "true" });
  assert.equal(result.ok, false);
});

test("allows a push to an unrelated branch", () => {
  const result = checkPush(parseRefUpdates(refLine("refs/heads/some-other-branch")), cfg, {});
  assert.equal(result.ok, true);
});

test("no-op when productionBranch is null", () => {
  const result = checkPush(parseRefUpdates(refLine("refs/heads/main")), { ...cfg, productionBranch: null }, {});
  assert.equal(result.ok, true);
});
