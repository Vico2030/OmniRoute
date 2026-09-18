/**
 * Durable model quarantine — storage-layer proof (OmniRoute Autonomous Supply
 * Maintenance mission, 2026-09-17). Covers identity scoping, restart survival,
 * and the isModelLocked() enforcement wire, independent of the Autopilot/HTTP
 * layer (see tests/unit/serial/provider-health-autopilot-quarantine.test.ts for
 * the governed-action path).
 *
 * Hermetic DB: writes real rows into the `key_value` table (namespace
 * `modelQuarantine`). Point DATA_DIR at a throwaway dir before any import that
 * opens the SQLite handle, mirroring synced-model-hide-persist-3782.test.ts.
 */
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-test-model-quarantine-"));
process.env.DATA_DIR = tmpDir;

const {
  quarantineModel,
  clearModelQuarantine,
  getModelQuarantine,
  isModelQuarantined,
  getAllModelQuarantines,
  clearAllModelQuarantines,
} = await import("../../../open-sse/services/modelQuarantine.ts");
const { isModelLocked, lockModel, clearAllModelLockouts } =
  await import("../../../open-sse/services/accountFallback.ts");
const { resetDbInstance } = await import("../../../src/lib/db/core.ts");

const PROVIDER = "quarantine-test-provider";

before(() => {
  resetDbInstance();
});

beforeEach(() => {
  clearAllModelQuarantines();
  clearAllModelLockouts();
});

after(() => {
  clearAllModelQuarantines();
  clearAllModelLockouts();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("quarantining a model records reason, evidence, timestamp, and source", () => {
  const entry = quarantineModel(PROVIDER, "conn-a", "dead-model", {
    reason: "model_not_found",
    evidence: { failureCount: 3 },
    source: "test",
  });
  assert.equal(entry.reason, "model_not_found");
  assert.equal(entry.source, "test");
  assert.ok(entry.quarantinedAt);
  assert.deepEqual(entry.evidence, { failureCount: 3 });

  const stored = getModelQuarantine(PROVIDER, "conn-a", "dead-model");
  assert.ok(stored);
  assert.equal(stored?.reason, "model_not_found");
});

test("quarantine is scoped to provider+connection+model — siblings and other connections stay eligible", () => {
  quarantineModel(PROVIDER, "conn-a", "dead-model", { reason: "model_not_found", source: "test" });

  assert.equal(isModelQuarantined(PROVIDER, "conn-a", "dead-model"), true);
  // Sibling model on the same connection is unaffected.
  assert.equal(isModelQuarantined(PROVIDER, "conn-a", "healthy-sibling"), false);
  // Same model id on a different connection is unaffected.
  assert.equal(isModelQuarantined(PROVIDER, "conn-b", "dead-model"), false);
  // Different provider entirely is unaffected.
  assert.equal(isModelQuarantined("other-provider", "conn-a", "dead-model"), false);
});

test("isModelLocked() (the exact gate Smart Auto's combo.ts consults) excludes a quarantined model", () => {
  assert.equal(isModelLocked(PROVIDER, "conn-a", "dead-model"), false);
  quarantineModel(PROVIDER, "conn-a", "dead-model", { reason: "model_not_found", source: "test" });
  assert.equal(isModelLocked(PROVIDER, "conn-a", "dead-model"), true);
  // Sibling and other-connection candidates remain selectable through the same gate.
  assert.equal(isModelLocked(PROVIDER, "conn-a", "healthy-sibling"), false);
  assert.equal(isModelLocked(PROVIDER, "conn-b", "dead-model"), false);
});

test("existing transient lock behavior is unchanged by the quarantine addition", () => {
  assert.equal(isModelLocked(PROVIDER, "conn-a", "rate-limited-model"), false);
  lockModel(PROVIDER, "conn-a", "rate-limited-model", "rate_limit_exceeded", 5_000);
  assert.equal(isModelLocked(PROVIDER, "conn-a", "rate-limited-model"), true);
  // A transient lock does NOT create a durable quarantine row.
  assert.equal(isModelQuarantined(PROVIDER, "conn-a", "rate-limited-model"), false);
});

test("durable quarantine survives a fresh DB handle (process-restart proxy)", () => {
  quarantineModel(PROVIDER, "conn-a", "dead-model", { reason: "model_not_found", source: "test" });
  assert.equal(isModelQuarantined(PROVIDER, "conn-a", "dead-model"), true);

  // Simulate a process restart: drop the in-process DB handle and reopen it
  // against the SAME on-disk file. A transient in-memory lock (accountFallback.ts's
  // modelLockouts Map) would NOT survive this — the durable quarantine must.
  resetDbInstance();

  assert.equal(isModelQuarantined(PROVIDER, "conn-a", "dead-model"), true);
  assert.equal(isModelLocked(PROVIDER, "conn-a", "dead-model"), true);
});

test("clearing a quarantine restores eligibility (manual override / rollback)", () => {
  quarantineModel(PROVIDER, "conn-a", "dead-model", { reason: "model_not_found", source: "test" });
  assert.equal(isModelLocked(PROVIDER, "conn-a", "dead-model"), true);

  const removed = clearModelQuarantine(PROVIDER, "conn-a", "dead-model");
  assert.equal(removed, true);
  assert.equal(isModelQuarantined(PROVIDER, "conn-a", "dead-model"), false);
  assert.equal(isModelLocked(PROVIDER, "conn-a", "dead-model"), false);

  // Clearing something that was never quarantined is a safe no-op, not an error.
  assert.equal(clearModelQuarantine(PROVIDER, "conn-a", "already-clear"), false);
});

test("getAllModelQuarantines lists durable entries for dashboard reporting", () => {
  quarantineModel(PROVIDER, "conn-a", "dead-model", { reason: "model_not_found", source: "test" });
  quarantineModel(PROVIDER, "conn-b", "another-dead-model", {
    reason: "model_not_found",
    source: "test",
  });
  const all = getAllModelQuarantines();
  assert.equal(all.length, 2);
  assert.ok(all.some((entry) => entry.connectionId === "conn-a" && entry.model === "dead-model"));
  assert.ok(
    all.some((entry) => entry.connectionId === "conn-b" && entry.model === "another-dead-model")
  );
});
