import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Weekly provider self-maintenance (2026-09-20): proves the common staged
// lifecycle (FETCH -> NORMALIZE -> policy filter -> STAGE -> VALIDATE -> DIFF
// -> AUTHORIZATION IMPACT -> SHADOW ROUTING -> ATOMIC PUBLISH -> OBSERVE) is
// wired generically across all six current providers, that the OpenAI/NVIDIA
// policy manifests actually apply through the real route (not just in
// isolated unit tests), and that maintenance evidence is recorded for every
// outcome. tests/unit/sync-models-staged-refresh-integration.test.ts already
// proves the generic pipeline itself end to end using a synthetic provider;
// this file is deliberately about the six REAL provider ids plus the policy
// layer added this mission -- it does not re-prove what that file already
// covers.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-maint-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "provider-maintenance-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const evidence = await import("../../src/lib/providerModels/maintenanceEvidence.ts");
const modelSyncRoute = await import("../../src/app/api/providers/[id]/sync-models/route.ts");
const scheduler = await import("../../src/shared/services/modelSyncScheduler.ts");
const originalFetch = globalThis.fetch;

interface SyncModelsResponseBody {
  modelChanges?: { added: number; removed: number; updated: number; total: number };
  catalogPublish?: {
    published: boolean;
    reason?: string;
    policyExcludedCount?: number;
    authorizationImpact?: Array<{ modelStr: string }>;
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
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_API_KEY_SECRET === undefined) delete process.env.API_KEY_SECRET;
  else process.env.API_KEY_SECRET = ORIGINAL_API_KEY_SECRET;
});

function mockModelsFetch(connectionId: string, body: unknown) {
  globalThis.fetch = async (url) => {
    if (String(url).includes("__readiness_probe__")) return new Response(null, { status: 404 });
    return Response.json(body);
  };
}

function syncRequest(connectionId: string) {
  return new Request(`http://localhost/api/providers/${connectionId}/sync-models`, {
    method: "POST",
    headers: scheduler.buildModelSyncInternalHeaders(),
  });
}

async function makeConnection(provider: string) {
  return providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-test`,
    apiKey: `test-key-${provider}`,
  });
}

// --- OpenAI: full matrix, proves the policy layer applies through the real route ---

test("openai: a sync excludes non-chat models via policy and publishes only the eligible ones (add scenario)", async () => {
  const connection = await makeConnection("openai");
  mockModelsFetch(connection.id, {
    models: [
      { id: "gpt-4o-mini", name: "GPT-4o mini" },
      { id: "whisper-1", name: "Whisper" },
      { id: "text-embedding-3-large", name: "Embedding" },
    ],
  });

  const response = await modelSyncRoute.POST(syncRequest(connection.id), {
    params: { id: connection.id },
  });
  const body = await readBody(response);

  assert.equal(response.status, 200);
  assert.equal(body.catalogPublish?.published, true);
  assert.equal(body.catalogPublish?.policyExcludedCount, 2);
  assert.deepEqual(
    (await modelsDb.getSyncedAvailableModels("openai")).map((m) => m.id),
    ["gpt-4o-mini"]
  );

  const ev = evidence.getMaintenanceEvidence("openai", connection.id);
  assert.equal(ev?.outcome, "published");
  assert.equal(ev?.policyExcludedCount, 2);
});

test("openai: removing a chat model an api_keys grant depends on is blocked (authorization impact)", async () => {
  const connection = await makeConnection("openai");
  await modelsDb.replaceSyncedAvailableModelsForConnection("openai", connection.id, [
    { id: "gpt-4o-mini", name: "GPT-4o mini", source: "imported" },
  ]);
  const apiKey = await apiKeysDb.createApiKey("dependent", "machine-1");
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, { allowedModels: ["openai/gpt-4o-mini"] });

  mockModelsFetch(connection.id, { models: [{ id: "gpt-4o", name: "GPT-4o" }] });
  const response = await modelSyncRoute.POST(syncRequest(connection.id), {
    params: { id: connection.id },
  });
  const body = await readBody(response);

  assert.equal(body.catalogPublish?.published, false);
  assert.equal(body.catalogPublish?.reason, "authorization_impact_requires_explicit_override");
  assert.deepEqual(
    (await modelsDb.getSyncedAvailableModels("openai")).map((m) => m.id),
    ["gpt-4o-mini"]
  );

  const ev = evidence.getMaintenanceEvidence("openai", connection.id);
  assert.equal(ev?.outcome, "blocked_authorization_impact");
});

test("openai: an unchanged catalog is a genuine zero-diff (excluded models never enter the diff at all)", async () => {
  const connection = await makeConnection("openai");
  await modelsDb.replaceSyncedAvailableModelsForConnection("openai", connection.id, [
    { id: "gpt-4o-mini", name: "GPT-4o mini", source: "imported" },
  ]);
  mockModelsFetch(connection.id, {
    models: [
      { id: "gpt-4o-mini", name: "GPT-4o mini" },
      { id: "whisper-1", name: "Whisper" },
    ],
  });

  const response = await modelSyncRoute.POST(syncRequest(connection.id), {
    params: { id: connection.id },
  });
  const body = await readBody(response);

  assert.deepEqual(body.modelChanges, { added: 0, removed: 0, updated: 0, total: 0 });
  assert.equal(body.catalogPublish?.published, true);
  const ev = evidence.getMaintenanceEvidence("openai", connection.id);
  assert.equal(ev?.diff?.total, 0);
});

test("openai: a malformed upstream response never reaches the live catalog and is recorded as fetch_failed", async () => {
  const connection = await makeConnection("openai");
  await modelsDb.replaceSyncedAvailableModelsForConnection("openai", connection.id, [
    { id: "gpt-4o-mini", name: "GPT-4o mini", source: "imported" },
  ]);
  globalThis.fetch = async (url) => {
    if (String(url).includes("__readiness_probe__")) return new Response(null, { status: 404 });
    return new Response("<html>bad gateway</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });
  };

  const response = await modelSyncRoute.POST(syncRequest(connection.id), {
    params: { id: connection.id },
  });

  assert.equal(response.status, 502);
  assert.deepEqual(
    (await modelsDb.getSyncedAvailableModels("openai")).map((m) => m.id),
    ["gpt-4o-mini"]
  );
  const ev = evidence.getMaintenanceEvidence("openai", connection.id);
  assert.equal(ev?.outcome, "fetch_failed");
});

// --- Anthropic: passthrough policy, full matrix using the real provider id ---

test("anthropic: add/remove/rename in one real diff publishes atomically", async () => {
  const connection = await makeConnection("anthropic");
  await modelsDb.replaceSyncedAvailableModelsForConnection("anthropic", connection.id, [
    { id: "claude-opus-4-1-20250805", name: "Claude Opus 4.1", source: "imported" },
    { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", source: "imported" },
  ]);
  mockModelsFetch(connection.id, {
    models: [
      { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
      { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5" },
    ],
  });

  const response = await modelSyncRoute.POST(syncRequest(connection.id), {
    params: { id: connection.id },
  });
  const body = await readBody(response);

  assert.equal(body.catalogPublish?.published, true);
  assert.deepEqual(body.modelChanges, { added: 1, removed: 1, updated: 0, total: 2 });
  assert.deepEqual(
    (await modelsDb.getSyncedAvailableModels("anthropic")).map((m) => m.id).sort(),
    ["claude-fable-5-1", "claude-sonnet-4-5-20250929"]
  );
  const ev = evidence.getMaintenanceEvidence("anthropic", connection.id);
  assert.equal(ev?.outcome, "published");
  assert.deepEqual(ev?.diff, { added: 1, removed: 1, unchanged: 1, total: 2 });
});

test("anthropic: a genuinely empty upstream catalog does not wipe the existing live catalog", async () => {
  const connection = await makeConnection("anthropic");
  await modelsDb.replaceSyncedAvailableModelsForConnection("anthropic", connection.id, [
    { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 4.5", source: "imported" },
  ]);
  mockModelsFetch(connection.id, { models: [] });

  const response = await modelSyncRoute.POST(syncRequest(connection.id), {
    params: { id: connection.id },
  });
  const body = await readBody(response);

  assert.deepEqual(body.modelChanges, { added: 0, removed: 0, updated: 0, total: 0 });
  assert.equal(body.catalogPublish, undefined); // discoveredModels.length === 0 -- outer gate, staged pipeline never invoked
  assert.deepEqual(
    (await modelsDb.getSyncedAvailableModels("anthropic")).map((m) => m.id),
    ["claude-sonnet-4-5-20250929"]
  );
});

// --- Generic wiring smoke pass: gemini, groq, cerebras, nvidia ---

const genericSmokeProviders = [
  { provider: "gemini", model: "gemini-3-flash-preview" },
  { provider: "groq", model: "openai/gpt-oss-20b" },
  { provider: "cerebras", model: "gpt-oss-120b" },
];

for (const { provider, model } of genericSmokeProviders) {
  test(`${provider}: a clean add-scenario sync publishes through the common lifecycle`, async () => {
    const connection = await makeConnection(provider);
    mockModelsFetch(connection.id, { models: [{ id: model, name: model }] });

    const response = await modelSyncRoute.POST(syncRequest(connection.id), {
      params: { id: connection.id },
    });
    const body = await readBody(response);

    assert.equal(response.status, 200);
    assert.equal(body.catalogPublish?.published, true);
    assert.deepEqual(
      (await modelsDb.getSyncedAvailableModels(provider)).map((m) => m.id),
      [model]
    );
    assert.equal(evidence.getMaintenanceEvidence(provider, connection.id)?.outcome, "published");
  });
}

test("nvidia: policy excludes a non-chat NIM container while a real chat model publishes", async () => {
  const connection = await makeConnection("nvidia");
  mockModelsFetch(connection.id, {
    models: [
      { id: "nvidia/nemotron-3-super-120b-a12b", name: "Nemotron 3 Super" },
      { id: "nvidia/nv-embed-v2", name: "NV Embed" },
    ],
  });

  const response = await modelSyncRoute.POST(syncRequest(connection.id), {
    params: { id: connection.id },
  });
  const body = await readBody(response);

  assert.equal(body.catalogPublish?.published, true);
  assert.equal(body.catalogPublish?.policyExcludedCount, 1);
  assert.deepEqual(
    (await modelsDb.getSyncedAvailableModels("nvidia")).map((m) => m.id),
    ["nvidia/nemotron-3-super-120b-a12b"]
  );
});

// --- Cross-provider isolation: one provider's failure never touches another ---

test("one provider's authorization-impact block does not affect a different provider's clean sync", async () => {
  const blockedConn = await makeConnection("openai");
  await modelsDb.replaceSyncedAvailableModelsForConnection("openai", blockedConn.id, [
    { id: "gpt-4o-mini", name: "GPT-4o mini", source: "imported" },
  ]);
  const apiKey = await apiKeysDb.createApiKey("dependent", "machine-1");
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, { allowedModels: ["openai/gpt-4o-mini"] });

  mockModelsFetch(blockedConn.id, { models: [{ id: "gpt-4o", name: "GPT-4o" }] });
  const blockedResponse = await modelSyncRoute.POST(syncRequest(blockedConn.id), {
    params: { id: blockedConn.id },
  });
  assert.equal((await readBody(blockedResponse)).catalogPublish?.published, false);

  modelSyncRoute.__resetLoopbackReadinessForTests();
  const cleanConn = await makeConnection("anthropic");
  mockModelsFetch(cleanConn.id, { models: [{ id: "claude-fable-5-1", name: "Claude Fable 5.1" }] });
  const cleanResponse = await modelSyncRoute.POST(syncRequest(cleanConn.id), {
    params: { id: cleanConn.id },
  });
  assert.equal((await readBody(cleanResponse)).catalogPublish?.published, true);
  assert.deepEqual(
    (await modelsDb.getSyncedAvailableModels("anthropic")).map((m) => m.id),
    ["claude-fable-5-1"]
  );
});
