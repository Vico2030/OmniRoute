/**
 * Durable model-quarantine eligibility — the 2026-09-18b correction.
 *
 * Root cause fixed here: the first implementation (2026-09-17) tied
 * quarantine_model eligibility to accountFallback.ts's transient, ≤2-minute
 * in-memory lock (BACKOFF_CONFIG.max). A model proven permanently dead by
 * repeated durable call_logs history could fail its own execution precheck
 * simply because nothing had retried it in the last couple of minutes —
 * exactly the real incident this suite is named after (Cerebras zai-glm-4.7,
 * Groq llama-3.3-70b-versatile).
 *
 * This suite proves the corrected behavior: eligibility now comes from
 * durableModelEligibility.ts's own call_logs query, independent of whether
 * any transient lock is currently active. It does not replace
 * provider-health-autopilot-quarantine.test.ts (2026-09-17) — that file's
 * own tests (dryRun, clear_model_quarantine, stale-hash rejection, sibling/
 * connection isolation) still exercise the same governed action shape and
 * are re-run unchanged as part of this mission's regression proof.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { makeManagementSessionRequest } from "../../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-durable-quarantine-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_INITIAL_PASSWORD = process.env.INITIAL_PASSWORD;

process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../../src/lib/db/core.ts");
const settingsDb = await import("../../../src/lib/db/settings.ts");
const providersDb = await import("../../../src/lib/db/providers.ts");
const autopilot = await import("../../../src/lib/monitoring/providerHealthAutopilot.ts");
const durableEligibility = await import("../../../src/lib/monitoring/durableModelEligibility.ts");
const actionsRoute =
  await import("../../../src/app/api/providers/health-autopilot/actions/route.ts");
const accountFallback = await import("@omniroute/open-sse/services/accountFallback");
const modelQuarantine = await import("@omniroute/open-sse/services/modelQuarantine");

const PROVIDER = "durable-quarantine-test-provider";

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function enableManagementAuth() {
  process.env.INITIAL_PASSWORD = "durable-quarantine-password";
  await settingsDb.updateSettings({ requireLogin: true, password: "" });
}

async function createActiveConnection(
  provider = PROVIDER,
  name = "durable-quarantine-key",
  apiKey = "test-key"
) {
  // Connections are deduped by (provider, name) AND, separately, by
  // decrypted apiKey VALUE (#3023) -- a shared name OR a shared key value
  // across calls returns the SAME row, not a second one. Callers that need
  // two genuinely distinct connections must pass distinct names AND
  // distinct apiKey values.
  return providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name,
    apiKey,
    isActive: true,
    testStatus: "active",
  }) as Promise<Record<string, unknown>>;
}

function insertCallLog(
  provider: string,
  connectionId: string,
  model: string,
  status: number,
  timestamp: string
) {
  const db = core.getDbInstance();
  db.prepare(
    `INSERT INTO call_logs (id, timestamp, status, model, provider, connection_id) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(randomUUID(), timestamp, status, model, provider, connectionId);
}

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
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

// ── 1, 3: durable evidence eligible with NO active transient lock ──────

test("repeated durable model_not_found evidence is eligible even with no active transient lockout", async () => {
  const connection = await createActiveConnection();
  const connectionId = String(connection.id);
  insertCallLog(PROVIDER, connectionId, "dead-model", 404, isoMinutesAgo(120));
  insertCallLog(PROVIDER, connectionId, "dead-model", 404, isoMinutesAgo(60));

  // The transient lock is untouched by this scenario — confirm it's genuinely absent.
  assert.equal(accountFallback.isModelLocked(PROVIDER, connectionId, "dead-model"), false);

  const report = await autopilot.buildProviderHealthAutopilotReport({
    provider: PROVIDER,
    includeHealthy: true,
  });
  assert.ok(findAction(report, "quarantine_model", "dead-model"));
});

// ── 4: single failure insufficient ──────────────────────────────────────

test("a single durable model_not_found failure is insufficient", async () => {
  const connection = await createActiveConnection();
  insertCallLog(PROVIDER, String(connection.id), "maybe-dead-model", 404, isoMinutesAgo(30));

  const report = await autopilot.buildProviderHealthAutopilotReport({
    provider: PROVIDER,
    includeHealthy: true,
  });
  assert.equal(findAction(report, "quarantine_model", "maybe-dead-model"), null);
});

// ── 5: a success since the first failure prevents false permanent classification ─

test("a successful completion after the failures prevents eligibility", async () => {
  const connection = await createActiveConnection();
  const connectionId = String(connection.id);
  const model = "recovered-model";
  insertCallLog(PROVIDER, connectionId, model, 404, isoMinutesAgo(120));
  insertCallLog(PROVIDER, connectionId, model, 404, isoMinutesAgo(90));
  insertCallLog(PROVIDER, connectionId, model, 200, isoMinutesAgo(10)); // recovered since

  const eligibility = durableEligibility.checkDurableModelEligibility(
    PROVIDER,
    connectionId,
    model
  );
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.successCountSinceFirstFailure, 1);
});

test("a success BEFORE the failures started does not block eligibility", async () => {
  const connection = await createActiveConnection();
  const connectionId = String(connection.id);
  const model = "went-bad-model";
  insertCallLog(PROVIDER, connectionId, model, 200, isoMinutesAgo(180)); // healthy, earlier
  insertCallLog(PROVIDER, connectionId, model, 404, isoMinutesAgo(120));
  insertCallLog(PROVIDER, connectionId, model, 404, isoMinutesAgo(60));

  const eligibility = durableEligibility.checkDurableModelEligibility(
    PROVIDER,
    connectionId,
    model
  );
  assert.equal(eligibility.eligible, true);
});

// ── 6, 7, 8: transient/capacity/rate statuses never qualify ────────────

test("429 (rate limit / quota exhaustion) does not qualify, even repeated", async () => {
  const connection = await createActiveConnection();
  const connectionId = String(connection.id);
  insertCallLog(PROVIDER, connectionId, "rate-limited-model", 429, isoMinutesAgo(60));
  insertCallLog(PROVIDER, connectionId, "rate-limited-model", 429, isoMinutesAgo(30));

  const report = await autopilot.buildProviderHealthAutopilotReport({
    provider: PROVIDER,
    includeHealthy: true,
  });
  assert.equal(findAction(report, "quarantine_model", "rate-limited-model"), null);
});

test("timeout/server_error/capacity statuses (5xx) do not qualify", async () => {
  const connection = await createActiveConnection();
  const connectionId = String(connection.id);
  for (const status of [500, 503, 504]) {
    insertCallLog(PROVIDER, connectionId, "flaky-model", status, isoMinutesAgo(60));
  }
  const eligibility = durableEligibility.checkDurableModelEligibility(
    PROVIDER,
    connectionId,
    "flaky-model"
  );
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.qualifyingFailureCount, 0);
});

// ── 9, 10: identity isolation ───────────────────────────────────────────

test("sibling model on the same connection is unaffected", async () => {
  const connection = await createActiveConnection();
  const connectionId = String(connection.id);
  insertCallLog(PROVIDER, connectionId, "dead-model", 404, isoMinutesAgo(120));
  insertCallLog(PROVIDER, connectionId, "dead-model", 404, isoMinutesAgo(60));

  const report = await autopilot.buildProviderHealthAutopilotReport({
    provider: PROVIDER,
    includeHealthy: true,
  });
  assert.ok(findAction(report, "quarantine_model", "dead-model"));
  assert.equal(findAction(report, "quarantine_model", "healthy-sibling"), null);
});

test("the same model on a different connection is unaffected", async () => {
  const connectionA = await createActiveConnection(
    PROVIDER,
    "durable-quarantine-key-a",
    "test-key-a"
  );
  const connectionB = await createActiveConnection(
    PROVIDER,
    "durable-quarantine-key-b",
    "test-key-b"
  );
  insertCallLog(PROVIDER, String(connectionA.id), "dead-model", 404, isoMinutesAgo(120));
  insertCallLog(PROVIDER, String(connectionA.id), "dead-model", 404, isoMinutesAgo(60));

  const eligibleA = durableEligibility.checkDurableModelEligibility(
    PROVIDER,
    String(connectionA.id),
    "dead-model"
  );
  const eligibleB = durableEligibility.checkDurableModelEligibility(
    PROVIDER,
    String(connectionB.id),
    "dead-model"
  );
  assert.equal(eligibleA.eligible, true);
  assert.equal(eligibleB.eligible, false);
});

// ── 2: survives a fresh DB handle (process-restart proxy) ───────────────

test("eligibility survives a fresh DB handle (process-restart proxy)", async () => {
  const connection = await createActiveConnection();
  const connectionId = String(connection.id);
  insertCallLog(PROVIDER, connectionId, "dead-model", 404, isoMinutesAgo(120));
  insertCallLog(PROVIDER, connectionId, "dead-model", 404, isoMinutesAgo(60));

  const before = durableEligibility.checkDurableModelEligibility(
    PROVIDER,
    connectionId,
    "dead-model"
  );
  assert.equal(before.eligible, true);

  core.resetDbInstance(); // same on-disk file, fresh handle — simulates a restart

  const after = durableEligibility.checkDurableModelEligibility(
    PROVIDER,
    connectionId,
    "dead-model"
  );
  assert.equal(after.eligible, true);
});

test("evidence fingerprint is stable across repeated calls when nothing changed", async () => {
  const connection = await createActiveConnection();
  const connectionId = String(connection.id);
  insertCallLog(PROVIDER, connectionId, "dead-model", 404, isoMinutesAgo(120));
  insertCallLog(PROVIDER, connectionId, "dead-model", 404, isoMinutesAgo(60));

  const first = durableEligibility.checkDurableModelEligibility(
    PROVIDER,
    connectionId,
    "dead-model"
  );
  const second = durableEligibility.checkDurableModelEligibility(
    PROVIDER,
    connectionId,
    "dead-model"
  );
  assert.equal(first.evidenceFingerprint, second.evidenceFingerprint);
});

// ── 11: stale evidence rejects (preconditionsHash changes with new evidence) ─

test("preconditionsHash reflects durable evidence and rejects once that evidence changes", async () => {
  const connection = await createActiveConnection();
  const connectionId = String(connection.id);
  insertCallLog(PROVIDER, connectionId, "dead-model", 404, isoMinutesAgo(120));
  insertCallLog(PROVIDER, connectionId, "dead-model", 404, isoMinutesAgo(60));

  const report = await autopilot.buildProviderHealthAutopilotReport({
    provider: PROVIDER,
    includeHealthy: true,
  });
  const action = findAction(report, "quarantine_model", "dead-model");
  assert.ok(action);
  const staleHash = action!.preconditionsHash;

  // New durable evidence arrives (a THIRD failure) -- the evidence fingerprint,
  // and therefore preconditionsHash, must change.
  insertCallLog(PROVIDER, connectionId, "dead-model", 404, isoMinutesAgo(1));

  const response = await postAction({
    type: "quarantine_model",
    target: action!.target,
    preconditionsHash: staleHash,
    confirm: true,
  });
  assert.equal(response.status, 409);
  assert.equal(modelQuarantine.isModelQuarantined(PROVIDER, connectionId, "dead-model"), false);
});

// ── 12, 13, 14: dryRun / apply / clear — same governed-action shape ─────

test("quarantine_model dryRun performs no mutation (durable-evidence path)", async () => {
  const connection = await createActiveConnection();
  const connectionId = String(connection.id);
  insertCallLog(PROVIDER, connectionId, "dead-model", 404, isoMinutesAgo(120));
  insertCallLog(PROVIDER, connectionId, "dead-model", 404, isoMinutesAgo(60));

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
  assert.equal(modelQuarantine.isModelQuarantined(PROVIDER, connectionId, "dead-model"), false);
});

test("quarantine_model applies and writes durable state from durable evidence, and clear_model_quarantine reverses it", async () => {
  const connection = await createActiveConnection();
  const connectionId = String(connection.id);
  insertCallLog(PROVIDER, connectionId, "dead-model", 404, isoMinutesAgo(120));
  insertCallLog(PROVIDER, connectionId, "dead-model", 404, isoMinutesAgo(60));

  const report = await autopilot.buildProviderHealthAutopilotReport({
    provider: PROVIDER,
    includeHealthy: true,
  });
  const action = findAction(report, "quarantine_model", "dead-model");
  assert.ok(action);

  const applyResponse = await postAction({
    type: action!.type,
    target: action!.target,
    preconditionsHash: action!.preconditionsHash,
    confirm: true,
  });
  assert.equal(applyResponse.status, 200);
  const applyBody = await applyResponse.json();
  assert.equal(applyBody.success, true);
  assert.equal(accountFallback.isModelLocked(PROVIDER, connectionId, "dead-model"), true);
  assert.equal(accountFallback.isModelLocked(PROVIDER, connectionId, "healthy-sibling"), false);

  // Survives a fresh DB handle too (durable, not just in-memory).
  core.resetDbInstance();
  assert.equal(modelQuarantine.isModelQuarantined(PROVIDER, connectionId, "dead-model"), true);

  const clearReport = await autopilot.buildProviderHealthAutopilotReport({
    provider: PROVIDER,
    includeHealthy: true,
  });
  const clearAction = findAction(clearReport, "clear_model_quarantine", "dead-model");
  assert.ok(clearAction);
  const clearResponse = await postAction({
    type: clearAction!.type,
    target: clearAction!.target,
    preconditionsHash: clearAction!.preconditionsHash,
    confirm: true,
  });
  assert.equal(clearResponse.status, 200);
  assert.equal(accountFallback.isModelLocked(PROVIDER, connectionId, "dead-model"), false);
});
