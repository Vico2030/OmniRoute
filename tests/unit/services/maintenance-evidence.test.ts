import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-maintenance-evidence-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const evidence = await import("../../../src/lib/providerModels/maintenanceEvidence.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("records and retrieves a maintenance evidence entry", () => {
  evidence.recordMaintenanceEvidence({
    provider: "anthropic",
    connectionId: "conn-1",
    ranAt: "2026-09-20T18:00:00.000Z",
    outcome: "published",
    httpStatus: 200,
    diff: { added: 1, removed: 0, unchanged: 10, total: 1 },
  });

  const entry = evidence.getMaintenanceEvidence("anthropic", "conn-1");
  assert.ok(entry);
  assert.equal(entry.outcome, "published");
  assert.deepEqual(entry.diff, { added: 1, removed: 0, unchanged: 10, total: 1 });
});

test("a later record for the same (provider, connectionId) replaces the prior entry", () => {
  evidence.recordMaintenanceEvidence({
    provider: "openai",
    connectionId: "conn-2",
    ranAt: "2026-09-20T18:00:00.000Z",
    outcome: "blocked_authorization_impact",
    authorizationImpactCount: 1,
  });
  evidence.recordMaintenanceEvidence({
    provider: "openai",
    connectionId: "conn-2",
    ranAt: "2026-09-20T19:00:00.000Z",
    outcome: "published",
  });

  const entry = evidence.getMaintenanceEvidence("openai", "conn-2");
  assert.equal(entry.outcome, "published");
  assert.equal(entry.ranAt, "2026-09-20T19:00:00.000Z");
});

test("different connections for the same provider are tracked independently", () => {
  evidence.recordMaintenanceEvidence({
    provider: "gemini",
    connectionId: "conn-a",
    ranAt: "2026-09-20T18:00:00.000Z",
    outcome: "published",
  });
  evidence.recordMaintenanceEvidence({
    provider: "gemini",
    connectionId: "conn-b",
    ranAt: "2026-09-20T18:00:00.000Z",
    outcome: "fetch_failed",
    httpStatus: 502,
  });

  assert.equal(evidence.getMaintenanceEvidence("gemini", "conn-a").outcome, "published");
  assert.equal(evidence.getMaintenanceEvidence("gemini", "conn-b").outcome, "fetch_failed");
});

test("getAllMaintenanceEvidence returns every recorded entry", () => {
  evidence.recordMaintenanceEvidence({
    provider: "groq",
    connectionId: "conn-1",
    ranAt: "2026-09-20T18:00:00.000Z",
    outcome: "published",
  });
  evidence.recordMaintenanceEvidence({
    provider: "cerebras",
    connectionId: "conn-1",
    ranAt: "2026-09-20T18:00:00.000Z",
    outcome: "published",
  });

  const all = evidence.getAllMaintenanceEvidence();
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((e) => e.provider).sort(),
    ["cerebras", "groq"]
  );
});

test("no evidence recorded yet returns null, not an error", () => {
  assert.equal(evidence.getMaintenanceEvidence("nvidia", "never-run"), null);
});

test("clearAllMaintenanceEvidence wipes every recorded entry", () => {
  evidence.recordMaintenanceEvidence({
    provider: "nvidia",
    connectionId: "conn-1",
    ranAt: "2026-09-20T18:00:00.000Z",
    outcome: "published",
  });
  evidence.clearAllMaintenanceEvidence();
  assert.equal(evidence.getAllMaintenanceEvidence().length, 0);
});
