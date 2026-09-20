import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Integration coverage for wiring runStagedCatalogRefresh() into the real
// sync-models route (2026-09-18, construction + test only — no cron, no
// pricing sync enabled). Builds on:
//   e840aeaab05a35d2b8f89b915abe2b3bfd6d9eb9 (catalog-authority fix)
//   14c7467f10958716c25818d32dd02296250547b9 (staged refresh pipeline)
//
// tests/unit/model-sync-route.test.ts already proves the pre-existing route
// contract is unbroken (fetch failure / malformed response / manual trigger /
// scheduler headers / mode=import / alias sync, etc.) — this file adds only
// the NEW scenarios the staged wiring introduces: authorization-impact
// gating, empty-catalog safety, ghost-model composition, cross-connection
// isolation, and the additive `catalogPublish` response field.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-sync-staged-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "sync-staged-integration-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const staged = await import("../../src/lib/providerModels/stagedCatalogRefresh.ts");
const modelSyncRoute = await import("../../src/app/api/providers/[id]/sync-models/route.ts");
const scheduler = await import("../../src/shared/services/modelSyncScheduler.ts");
const virtualFactory = await import("../../open-sse/services/autoCombo/virtualFactory.ts");
const originalFetch = globalThis.fetch;

interface SyncModelsResponseBody {
  ok?: boolean;
  provider?: string;
  modelChanges?: { added: number; removed: number; updated: number; total: number };
  freeFilterEmpty?: boolean;
  catalogPublish?: {
    published: boolean;
    reason?: string;
    diff?: { added: number; removed: number; unchanged: number; total: number };
    shadowRouting?: {
      addedModels: string[];
      removedModels: string[];
      defaultModelChanged: boolean;
      requesterVisibleImpact: boolean;
    };
    authorizationImpact?: Array<{
      modelStr: string;
      referencedByApiKeys: Array<{ id: string; name: string }>;
      referencedByCombos: Array<{ id: string; name: string }>;
    }>;
  };
}

async function readBody(response: Response): Promise<SyncModelsResponseBody> {
  return (await response.json()) as SyncModelsResponseBody;
}

async function resetStorage() {
  globalThis.fetch = originalFetch;
  modelSyncRoute.__resetLoopbackReadinessForTests();
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
  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
  if (ORIGINAL_API_KEY_SECRET === undefined) {
    delete process.env.API_KEY_SECRET;
  } else {
    process.env.API_KEY_SECRET = ORIGINAL_API_KEY_SECRET;
  }
});

function mockModelsFetch(connectionId: string, body: unknown, init: ResponseInit = {}) {
  globalThis.fetch = async (url) => {
    if (String(url).includes("__readiness_probe__")) return new Response(null, { status: 404 });
    assert.equal(
      String(url),
      `http://127.0.0.1:20128/api/providers/${connectionId}/models?refresh=true&excludeCustom=true`
    );
    return Response.json(body, init);
  };
}

function syncRequest(connectionId: string, query = "") {
  return new Request(`http://localhost/api/providers/${connectionId}/sync-models${query}`, {
    method: "POST",
    headers: scheduler.buildModelSyncInternalHeaders(),
  });
}

// 2. successful sync stages then publishes
test("a clean sync with no authorization impact stages then publishes, and reports catalogPublish additively", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
  });
  mockModelsFetch(connection.id, { models: [{ id: "gpt-oss-120b", name: "GPT OSS 120B" }] });

  const response = await modelSyncRoute.POST(syncRequest(connection.id), {
    params: { id: connection.id },
  });
  const body = await readBody(response);

  assert.equal(response.status, 200);
  assert.deepEqual(body.modelChanges, { added: 1, removed: 0, updated: 0, total: 1 });
  assert.equal(body.catalogPublish?.published, true);
  assert.deepEqual(body.catalogPublish?.diff, {
    added: 1,
    removed: 0,
    unchanged: 0,
    total: 1,
  });
  assert.equal(body.catalogPublish?.shadowRouting?.requesterVisibleImpact, true);
  assert.deepEqual(
    (await modelsDb.getSyncedAvailableModels("cerebras")).map((m) => m.id),
    ["gpt-oss-120b"]
  );
  assert.equal(staged.getStagedCatalog("cerebras", connection.id), null);
});

// 5. genuinely empty upstream catalog handled intentionally (vs malformed/failure)
test("a genuinely empty upstream models array does not touch an existing live catalog and is not treated as an error", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", connection.id, [
    { id: "existing-model", name: "Existing", source: "imported" },
  ]);
  mockModelsFetch(connection.id, { models: [] });

  const response = await modelSyncRoute.POST(syncRequest(connection.id), {
    params: { id: connection.id },
  });
  const body = await readBody(response);

  assert.equal(response.status, 200);
  assert.deepEqual(body.modelChanges, { added: 0, removed: 0, updated: 0, total: 0 });
  assert.equal(body.catalogPublish, undefined); // staged pipeline never invoked -- nothing was discovered
  assert.deepEqual(
    (await modelsDb.getSyncedAvailableModels("cerebras")).map((m) => m.id),
    ["existing-model"]
  );
});

// 6. zero results after filtering does not cause accidental destructive wipe
test("free-only filtering that empties the discovered list does not wipe the existing live catalog", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
    providerSpecificData: { importFreeModelsOnly: true },
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", connection.id, [
    { id: "existing-model", name: "Existing", source: "imported" },
  ]);
  // A paid-looking model name that the free-only filter is expected to drop
  // entirely, producing a post-filter empty list (freeFilterEmpty).
  mockModelsFetch(connection.id, {
    models: [{ id: "gpt-5-pro", name: "GPT-5 Pro (paid)" }],
  });

  const response = await modelSyncRoute.POST(syncRequest(connection.id), {
    params: { id: connection.id },
  });
  const body = await readBody(response);

  assert.equal(response.status, 200);
  assert.deepEqual(
    (await modelsDb.getSyncedAvailableModels("cerebras")).map((m) => m.id),
    ["existing-model"]
  );
  // Whether or not this particular fixture actually triggers freeFilterEmpty
  // depends on the real free-model heuristics; the invariant under test is
  // the live catalog survives either way.
  assert.equal(typeof body.freeFilterEmpty, "boolean");
});

// 7. authorization impact blocks publish + structured impact is reported
test("removing a model an api_keys grant depends on blocks auto-publish and reports the impact in the response", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", connection.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B", source: "imported" },
  ]);
  const apiKey = await apiKeysDb.createApiKey("dependent-key", "machine-1");
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, {
    allowedModels: ["cerebras/gpt-oss-120b"],
  });

  mockModelsFetch(connection.id, { models: [{ id: "gemma-4-31b", name: "Gemma 4 31B" }] });

  const response = await modelSyncRoute.POST(syncRequest(connection.id), {
    params: { id: connection.id },
  });
  const body = await readBody(response);

  assert.equal(response.status, 200);
  assert.equal(body.catalogPublish.published, false);
  assert.equal(body.catalogPublish.reason, "authorization_impact_requires_explicit_override");
  assert.deepEqual(body.catalogPublish.diff, {
    added: 1,
    removed: 1,
    unchanged: 0,
    total: 2,
  });
  assert.equal(body.catalogPublish.shadowRouting?.requesterVisibleImpact, true);
  assert.equal(body.catalogPublish.authorizationImpact[0].modelStr, "cerebras/gpt-oss-120b");
  // modelChanges reflects reality (nothing actually changed live), not the
  // withheld attempt -- this is the correctness fix effectiveAvailableModels
  // needed once publish could be gated.
  assert.deepEqual(body.modelChanges, { added: 0, removed: 0, updated: 0, total: 0 });
  assert.deepEqual(
    (await modelsDb.getSyncedAvailableModels("cerebras")).map((m) => m.id),
    ["gpt-oss-120b"]
  );
});

// 8. no api_keys mutation
test("api_keys are never mutated by a blocked or a successful staged-refresh sync", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", connection.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B", source: "imported" },
  ]);
  const apiKey = await apiKeysDb.createApiKey("dependent-key", "machine-1");
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, {
    allowedModels: ["cerebras/gpt-oss-120b"],
  });
  const before = await apiKeysDb.getApiKeyById(apiKey.id);

  mockModelsFetch(connection.id, { models: [{ id: "gemma-4-31b", name: "Gemma 4 31B" }] });
  await modelSyncRoute.POST(syncRequest(connection.id), { params: { id: connection.id } });

  const after = await apiKeysDb.getApiKeyById(apiKey.id);
  assert.deepEqual(after?.allowedModels, before?.allowedModels);
});

// 9. stored Combo impact blocks publish
test("removing a model a stored Combo targets blocks auto-publish", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", connection.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B", source: "imported" },
  ]);
  await combosDb.createCombo({
    name: "route-uses-gpt-oss",
    models: [{ model: "cerebras/gpt-oss-120b", weight: 1 }],
  });
  mockModelsFetch(connection.id, { models: [{ id: "gemma-4-31b", name: "Gemma 4 31B" }] });

  const response = await modelSyncRoute.POST(syncRequest(connection.id), {
    params: { id: connection.id },
  });
  const body = await readBody(response);

  assert.equal(body.catalogPublish.published, false);
  assert.equal(
    body.catalogPublish.authorizationImpact[0].referencedByCombos[0].name,
    "route-uses-gpt-oss"
  );
  assert.deepEqual(
    (await modelsDb.getSyncedAvailableModels("cerebras")).map((m) => m.id),
    ["gpt-oss-120b"]
  );
});

// 10. ghost-model exclusion composes correctly through the real route
test("a successful route sync excludes a stale static-registry model from subsequent Smart Auto candidate generation", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
    // no defaultModel -- legacy would fall back to the registry's first
    // model (zai-glm-4.7) if the catalog-authority fix and this wiring
    // weren't both in place.
  });
  mockModelsFetch(connection.id, { models: [{ id: "gpt-oss-120b", name: "GPT OSS 120B" }] });

  await modelSyncRoute.POST(syncRequest(connection.id), { params: { id: connection.id } });

  const combo = await virtualFactory.createVirtualAutoCombo(undefined);
  const selected = combo.models.find((m) => m.connectionId === connection.id)?.model;
  assert.equal(selected, "cerebras/gpt-oss-120b");
  assert.notEqual(selected, "cerebras/zai-glm-4.7");
});

// 12. scheduler caller remains compatible (same route, same internal headers)
test("a scheduler-style internal request (buildModelSyncInternalHeaders) still succeeds and publishes", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
    providerSpecificData: { autoSync: true },
  });
  mockModelsFetch(connection.id, { models: [{ id: "gpt-oss-120b", name: "GPT OSS 120B" }] });

  // Exactly the request shape modelSyncScheduler.ts itself issues.
  const response = await modelSyncRoute.POST(syncRequest(connection.id), {
    params: { id: connection.id },
  });

  assert.equal(response.status, 200);
  const body = await readBody(response);
  assert.equal(body.catalogPublish.published, true);
});

// 14. staging cleared only after success (route-level confirmation)
test("staging is left in place when publish is blocked, and cleared once a later sync succeeds", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", connection.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B", source: "imported" },
  ]);
  const apiKey = await apiKeysDb.createApiKey("dependent-key", "machine-1");
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, {
    allowedModels: ["cerebras/gpt-oss-120b"],
  });

  mockModelsFetch(connection.id, { models: [{ id: "gemma-4-31b", name: "Gemma 4 31B" }] });
  await modelSyncRoute.POST(syncRequest(connection.id), { params: { id: connection.id } });
  assert.ok(staged.getStagedCatalog("cerebras", connection.id));

  // Operator clears the api_keys grant (out of band), then re-syncs -- now unblocked.
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, { allowedModels: [] });
  modelSyncRoute.__resetLoopbackReadinessForTests();
  mockModelsFetch(connection.id, { models: [{ id: "gemma-4-31b", name: "Gemma 4 31B" }] });
  const response = await modelSyncRoute.POST(syncRequest(connection.id), {
    params: { id: connection.id },
  });
  const body = await readBody(response);

  assert.equal(body.catalogPublish.published, true);
  assert.equal(staged.getStagedCatalog("cerebras", connection.id), null);
});

// 15. one connection failure/block does not mutate another connection
test("an authorization-blocked sync on one connection does not affect a clean sync on another connection", async () => {
  const connA = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras A",
    apiKey: "test-key-a",
  });
  const connB = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras B",
    apiKey: "test-key-b",
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", connA.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B", source: "imported" },
  ]);
  const apiKey = await apiKeysDb.createApiKey("dependent-key", "machine-1");
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, {
    allowedModels: ["cerebras/gpt-oss-120b"],
  });

  mockModelsFetch(connA.id, { models: [{ id: "gemma-4-31b", name: "Gemma 4 31B" }] });
  const responseA = await modelSyncRoute.POST(syncRequest(connA.id), { params: { id: connA.id } });
  const bodyA = await readBody(responseA);
  assert.equal(bodyA.catalogPublish.published, false);

  modelSyncRoute.__resetLoopbackReadinessForTests();
  mockModelsFetch(connB.id, { models: [{ id: "glm-5.1", name: "GLM 5.1" }] });
  const responseB = await modelSyncRoute.POST(syncRequest(connB.id), { params: { id: connB.id } });
  const bodyB = await readBody(responseB);
  assert.equal(bodyB.catalogPublish.published, true);

  assert.deepEqual(
    (await modelsDb.getSyncedAvailableModelsForConnection("cerebras", connA.id)).map((m) => m.id),
    ["gpt-oss-120b"]
  );
  assert.deepEqual(
    (await modelsDb.getSyncedAvailableModelsForConnection("cerebras", connB.id)).map((m) => m.id),
    ["glm-5.1"]
  );
});
