import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Regression coverage for the catalog-authority fix (2026-09-18):
// createVirtualAutoCombo() previously fell back to static providerInfo.models[0]
// whenever conn.defaultModel was unset, WITHOUT ever consulting the connection's
// synced active catalog — letting a model already removed from the live catalog
// (known example: Cerebras zai-glm-4.7, providerInfo.models[0] in the static
// registry) keep resurfacing as a Smart Auto candidate. The fix: once a
// connection has a non-empty synced catalog, that catalog is authoritative;
// static registry metadata only bootstraps a connection that has never synced.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-catalog-authority-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;

process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const virtualFactory = await import("../../open-sse/services/autoCombo/virtualFactory.ts");
const accountFallback = await import("../../open-sse/services/accountFallback.ts");
const modelQuarantine = await import("../../open-sse/services/modelQuarantine.ts");

type VirtualComboResult = Awaited<ReturnType<typeof virtualFactory.createVirtualAutoCombo>>;

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

  if (ORIGINAL_DATA_DIR === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  }
});

function modelOf(combo: VirtualComboResult, connectionId: string): string | undefined {
  return combo.models.find((m) => m.connectionId === connectionId)?.model;
}

test("synced catalog is authoritative: candidate comes from the synced catalog, not the static registry", async () => {
  const conn = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
    // no defaultModel set
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", conn.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B" },
  ]);

  const combo = await virtualFactory.createVirtualAutoCombo(undefined);
  assert.equal(modelOf(combo, conn.id), "cerebras/gpt-oss-120b");
});

test("stale static-registry ghost model is excluded once a non-empty synced catalog exists", async () => {
  const conn = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
    // no defaultModel -- legacy behavior would fall back to the registry's
    // first model (zai-glm-4.7 for cerebras).
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", conn.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B" },
  ]);

  const combo = await virtualFactory.createVirtualAutoCombo(undefined);
  const selected = modelOf(combo, conn.id);
  assert.notEqual(selected, "cerebras/zai-glm-4.7");
  assert.equal(selected, "cerebras/gpt-oss-120b");
});

test("a stale defaultModel absent from the synced catalog falls back to the synced catalog, not the static registry", async () => {
  const conn = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
    defaultModel: "zai-glm-4.7", // valid at connection-creation time, since retired upstream
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", conn.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B" },
  ]);

  const combo = await virtualFactory.createVirtualAutoCombo(undefined);
  assert.equal(modelOf(combo, conn.id), "cerebras/gpt-oss-120b");
});

test("a valid defaultModel still present in the synced catalog is retained", async () => {
  const conn = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
    defaultModel: "gemma-4-31b",
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", conn.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B" },
    { id: "gemma-4-31b", name: "Gemma 4 31B" },
  ]);

  const combo = await virtualFactory.createVirtualAutoCombo(undefined);
  assert.equal(modelOf(combo, conn.id), "cerebras/gemma-4-31b");
});

test("a never-synced connection keeps the exact legacy static-registry bootstrap behavior", async () => {
  const connWithDefault = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name: "OpenAI (default set)",
    apiKey: "test-key-1",
    defaultModel: "gpt-4o-mini",
  });
  const connNoDefault = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras (no sync, no default)",
    apiKey: "test-key-2",
  });

  const combo = await virtualFactory.createVirtualAutoCombo(undefined);
  assert.equal(modelOf(combo, connWithDefault.id), "openai/gpt-4o-mini");
  // Legacy behavior for an unsynced connection: static registry's first model.
  assert.equal(modelOf(combo, connNoDefault.id), "cerebras/zai-glm-4.7");
});

test("an explicitly-empty synced-catalog row is treated exactly like never-synced (falls back, does not drop the connection)", async () => {
  const conn = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
  });
  // replaceSyncedAvailableModelsForConnection([]) deletes the row (never
  // stores an empty array), so write an explicit empty-array row directly to
  // prove the "row exists but is empty" case is handled identically to "no
  // row at all" -- not as a third, undefined state.
  const db = core.getDbInstance();
  db.prepare(
    "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('syncedAvailableModels', ?, '[]')"
  ).run(`cerebras:${conn.id}`);

  const stored = await modelsDb.getSyncedAvailableModelsForConnection("cerebras", conn.id);
  assert.equal(stored.length, 0);

  const combo = await virtualFactory.createVirtualAutoCombo(undefined);
  // Falls back to legacy static-registry bootstrap -- connection is NOT
  // dropped from the pool just because its synced catalog is empty.
  assert.equal(modelOf(combo, conn.id), "cerebras/zai-glm-4.7");
});

test("durable quarantine still applies to the catalog-authoritative candidate", async () => {
  const conn = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", conn.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B" },
  ]);

  const combo = await virtualFactory.createVirtualAutoCombo(undefined);
  const selected = modelOf(combo, conn.id);
  assert.equal(selected, "cerebras/gpt-oss-120b");

  // The candidate pool building itself does not filter by quarantine (that's
  // combo.ts's job via isModelLocked, unchanged by this fix) -- but the exact
  // identity this fix now selects must be the same identity quarantine keys
  // off, so downstream enforcement still composes correctly.
  assert.equal(accountFallback.isModelLocked("cerebras", conn.id, "gpt-oss-120b"), false);
  modelQuarantine.quarantineModel("cerebras", conn.id, "gpt-oss-120b", {
    reason: "model_not_found",
    source: "test",
  });
  assert.equal(accountFallback.isModelLocked("cerebras", conn.id, "gpt-oss-120b"), true);
});

test("transient lock still applies to the catalog-authoritative candidate", async () => {
  const conn = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", conn.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B" },
  ]);

  const combo = await virtualFactory.createVirtualAutoCombo(undefined);
  const selected = modelOf(combo, conn.id);
  assert.equal(selected, "cerebras/gpt-oss-120b");

  assert.equal(accountFallback.isModelLocked("cerebras", conn.id, "gpt-oss-120b"), false);
  accountFallback.lockModel("cerebras", conn.id, "gpt-oss-120b", "test_lock", 60_000);
  assert.equal(accountFallback.isModelLocked("cerebras", conn.id, "gpt-oss-120b"), true);
});

test("the combo/model-string shape authorization consumes is unchanged by the catalog-authority fix", async () => {
  // apiKeyPolicy's checkKeyModelAccess/matchesComboAccessRule (SR-GATE-1) key
  // off plain "provider/model" strings and the provider-id candidatePool
  // array -- both produced here. This proves the fix doesn't change that
  // interface shape (full SR-GATE-1 authorization-suite regression is run
  // separately, not re-implemented in this file).
  const conn = await providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
  });
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", conn.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B" },
  ]);

  const combo = await virtualFactory.createVirtualAutoCombo(undefined);
  const model = combo.models.find((m) => m.connectionId === conn.id);
  assert.ok(model);
  assert.match(model!.model, /^[a-z0-9_-]+\/[a-zA-Z0-9_.-]+$/);
  assert.equal(model!.providerId, "cerebras");
  assert.ok(combo.candidatePool.includes("cerebras"));
  assert.equal(typeof combo.id, "string");
  assert.equal(typeof combo.name, "string");
});
