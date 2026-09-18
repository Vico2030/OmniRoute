/**
 * Durable model quarantine — governed-action proof (OmniRoute Autonomous
 * Supply Maintenance mission, 2026-09-17). Exercises the exact production
 * path a Founder/operator would use: Provider Health Autopilot's
 * quarantine_model / clear_model_quarantine actions, through the real HTTP
 * route, with the same dryRun/preconditionsHash/optimistic-locking pattern
 * already proven by provider-health-autopilot.test.ts for the pre-existing
 * actions. Mirrors that file's fixture/session helpers exactly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-health-quarantine-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;

process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const autopilot = await import("../../../src/lib/monitoring/providerHealthAutopilot.ts");
const actionsRoute =
  await import("../../../src/app/api/providers/health-autopilot/actions/route.ts");
const accountFallback = await import("@omniroute/open-sse/services/accountFallback");
const modelQuarantine = await import("@omniroute/open-sse/services/modelQuarantine");

const PROVIDER = "autopilot-quarantine-test-provider";

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function enableManagementAuth() {
  process.env.INITIAL_PASSWORD = "autopilot-quarantine-password";
  await settingsDb.updateSettings({ requireLogin: true, password: "" });
}

async function createActiveConnection(provider = PROVIDER) {
  return providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: "quarantine-key",
    apiKey: "test-key",
    isActive: true,
    testStatus: "active",
  }) as Promise<Record<string, unknown>>;
}

function insertDurableFailureEvidence(
  provider: string,
  connectionId: string,
  model: string,
  count = 2
) {
  // 2026-09-18b: eligibility now comes from durable call_logs evidence, not
  // the transient lock alone (see provider-health-autopilot-durable-
  // quarantine.test.ts for the dedicated eligibility-rule proofs). Tests in
  // THIS file exercise the governed-action machinery itself (dryRun/stale-
  // hash/apply/clear) and need real qualifying evidence to reach it.
  const db = core.getDbInstance();
  for (let i = 0; i < count; i++) {
    db.prepare(
      `INSERT INTO call_logs (id, timestamp, status, model, provider, connection_id) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      `${connectionId}-${model}-${i}`,
      new Date(Date.now() - (count - i) * 60_000).toISOString(),
      404,
      model,
      provider,
      connectionId
    );
  }
}

function findAction(report: autopilot.ProviderAutopilotReport, type: string, model?: string) {
  for (const providerEntry of report.providers) {
    for (const issue of providerEntry.issues) {
      const action = issue.actions.find(
        (candidate) => candidate.type === type && (!model || candidate.target.model === model)
      );
      if (action) return action;
    }
  }
  return null;
}

async function postAction(body: Record<string, unknown>) {
  return actionsRoute.POST(
    await makeManagementSessionRequest("http://localhost/api/providers/health-autopilot/actions", {
      method: "POST",
      headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" },
      body,
    })
  );
}

test.beforeEach(async () => {
  accountFallback.clearProviderFailure(PROVIDER);
  accountFallback.clearAllModelLockouts();
  modelQuarantine.clearAllModelQuarantines();
  await resetStorage();
  await enableManagementAuth();
});

test.after(async () => {
  accountFallback.clearProviderFailure(PROVIDER);
  accountFallback.clearAllModelLockouts();
  modelQuarantine.clearAllModelQuarantines();
  await resetStorage();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });

  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_INITIAL_PASSWORD === undefined) delete process.env.INITIAL_PASSWORD;
  else process.env.INITIAL_PASSWORD = ORIGINAL_INITIAL_PASSWORD;
});

test("durable model_not_found evidence (with or without a currently-active transient lock) is offered the quarantine_model action", async () => {
  const connection = await createActiveConnection();
  const connectionId = String(connection.id);
  insertDurableFailureEvidence(PROVIDER, connectionId, "dead-model", 2);
  // The transient lock is optional supporting evidence, never required
  // (2026-09-18b) — set here to prove the two coexist without conflict.
  accountFallback.lockModel(PROVIDER, connectionId, "dead-model", "model_not_found", 60_000, {
    failureCount: 2,
  });

  const report = await autopilot.buildProviderHealthAutopilotReport({
    provider: PROVIDER,
    includeHealthy: true,
  });
  assert.ok(findAction(report, "quarantine_model", "dead-model"));
});

test("a transient lock ALONE, with no durable call_logs evidence, no longer offers the quarantine_model action", async () => {
  // The exact defect this mission's own precheck exposed: a model must not
  // depend on an active ≤2-minute transient lock to be quarantine-eligible,
  // and — the flip side — a bare transient lock with zero durable history
  // must not be sufficient either. Durable evidence is now the only source.
  const connection = await createActiveConnection();
  accountFallback.lockModel(
    PROVIDER,
    String(connection.id),
    "transient-only-model",
    "model_not_found",
    60_000,
    {
      failureCount: 5,
    }
  );
  const report = await autopilot.buildProviderHealthAutopilotReport({
    provider: PROVIDER,
    includeHealthy: true,
  });
  assert.equal(findAction(report, "quarantine_model", "transient-only-model"), null);
});

test("a quota_exhausted lockout (transient) is NOT offered the quarantine_model action", async () => {
  const connection = await createActiveConnection();
  accountFallback.lockModel(
    PROVIDER,
    String(connection.id),
    "rate-limited-model",
    "quota_exhausted",
    60_000,
    { failureCount: 5 }
  );

  const report = await autopilot.buildProviderHealthAutopilotReport({
    provider: PROVIDER,
    includeHealthy: true,
  });
  assert.ok(findAction(report, "clear_model_lockout", "rate-limited-model"));
  assert.equal(findAction(report, "quarantine_model", "rate-limited-model"), null);
});

test("a single durable model_not_found failure is NOT yet offered the quarantine_model action", async () => {
  const connection = await createActiveConnection();
  insertDurableFailureEvidence(PROVIDER, String(connection.id), "maybe-dead-model", 1);

  const report = await autopilot.buildProviderHealthAutopilotReport({
    provider: PROVIDER,
    includeHealthy: true,
  });
  assert.equal(findAction(report, "quarantine_model", "maybe-dead-model"), null);
});

test("quarantine_model dryRun performs no mutation", async () => {
  const connection = await createActiveConnection();
  insertDurableFailureEvidence(PROVIDER, String(connection.id), "dead-model", 2);
  const report = await autopilot.buildProviderHealthAutopilotReport({
    provider: PROVIDER,
    includeHealthy: true,
  });
  const action = findAction(report, "quarantine_model", "dead-model");
  assert.ok(action);

  const response = await postAction({
    type: action!.type,
    target: action!.target,
    preconditionsHash: action!.preconditionsHash,
    dryRun: true,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.dryRun, true);
  assert.equal(
    modelQuarantine.isModelQuarantined(PROVIDER, String(connection.id), "dead-model"),
    false
  );
});

test("quarantine_model rejects a stale preconditionsHash", async () => {
  const connection = await createActiveConnection();
  insertDurableFailureEvidence(PROVIDER, String(connection.id), "dead-model", 2);
  const report = await autopilot.buildProviderHealthAutopilotReport({
    provider: PROVIDER,
    includeHealthy: true,
  });
  const action = findAction(report, "quarantine_model", "dead-model");
  assert.ok(action);

  const response = await postAction({
    type: action!.type,
    target: action!.target,
    preconditionsHash: "stale-hash",
    confirm: true,
  });
  assert.equal(response.status, 409);
  assert.equal(
    modelQuarantine.isModelQuarantined(PROVIDER, String(connection.id), "dead-model"),
    false
  );
});

test("quarantine_model applies through the governed action, survives the transient lock clearing, and Smart Auto's own gate excludes it", async () => {
  const connection = await createActiveConnection();
  const connectionId = String(connection.id);
  insertDurableFailureEvidence(PROVIDER, connectionId, "dead-model", 2);

  const report = await autopilot.buildProviderHealthAutopilotReport({
    provider: PROVIDER,
    includeHealthy: true,
  });
  const action = findAction(report, "quarantine_model", "dead-model");
  assert.ok(action);

  const response = await postAction({
    type: action!.type,
    target: action!.target,
    preconditionsHash: action!.preconditionsHash,
    confirm: true,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.changed.quarantined, true);

  // The transient lock (which the promotion evidence came from) clears/expires
  // independently — the durable quarantine must keep excluding the model.
  accountFallback.clearModelLock(PROVIDER, connectionId, "dead-model");
  assert.equal(accountFallback.isModelLocked(PROVIDER, connectionId, "dead-model"), true);

  // Sibling model on the same connection, and the same model on a different
  // connection, remain fully eligible.
  assert.equal(accountFallback.isModelLocked(PROVIDER, connectionId, "healthy-sibling"), false);
  assert.equal(
    accountFallback.isModelLocked(PROVIDER, "some-other-connection", "dead-model"),
    false
  );
});

test("clear_model_quarantine restores eligibility (manual override)", async () => {
  const connection = await createActiveConnection();
  const connectionId = String(connection.id);
  modelQuarantine.quarantineModel(PROVIDER, connectionId, "dead-model", {
    reason: "model_not_found",
    source: "test",
  });
  assert.equal(accountFallback.isModelLocked(PROVIDER, connectionId, "dead-model"), true);

  const report = await autopilot.buildProviderHealthAutopilotReport({
    provider: PROVIDER,
    includeHealthy: true,
  });
  const action = findAction(report, "clear_model_quarantine", "dead-model");
  assert.ok(action);

  const response = await postAction({
    type: action!.type,
    target: action!.target,
    preconditionsHash: action!.preconditionsHash,
    confirm: true,
  });
  assert.equal(response.status, 200);
  assert.equal(accountFallback.isModelLocked(PROVIDER, connectionId, "dead-model"), false);
});
