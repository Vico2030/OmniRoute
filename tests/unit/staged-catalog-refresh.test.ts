import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Regression coverage for the staged/atomic catalog-refresh pipeline
// (2026-09-18, construction + test only — not wired into the live
// sync-models route). Builds on the catalog-authority fix committed in
// e840aeaab05a35d2b8f89b915abe2b3bfd6d9eb9.

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-staged-refresh-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_API_KEY_SECRET = process.env.API_KEY_SECRET;

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "staged-catalog-refresh-test-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const modelQuarantine = await import("../../open-sse/services/modelQuarantine.ts");
const staged = await import("../../src/lib/providerModels/stagedCatalogRefresh.ts");

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
  if (ORIGINAL_API_KEY_SECRET === undefined) {
    delete process.env.API_KEY_SECRET;
  } else {
    process.env.API_KEY_SECRET = ORIGINAL_API_KEY_SECRET;
  }
});

async function makeConnection(defaultModel?: string) {
  return providersDb.createProviderConnection({
    provider: "cerebras",
    authType: "apikey",
    name: "Cerebras",
    apiKey: "test-key",
    ...(defaultModel ? { defaultModel } : {}),
  });
}

// 1. failed fetch leaves live catalog untouched
test("failed/malformed fetch payload leaves the live catalog untouched", async () => {
  const conn = await makeConnection();
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", conn.id, [
    { id: "existing-model", name: "Existing" },
  ]);

  const result = await staged.runStagedCatalogRefresh("cerebras", conn.id, "not-an-array");

  assert.equal(result.validation.valid, false);
  assert.equal(result.published, false);
  const live = await modelsDb.getSyncedAvailableModelsForConnection("cerebras", conn.id);
  assert.deepEqual(
    live.map((m) => m.id),
    ["existing-model"]
  );
});

// 2. malformed staged catalog rejected
test("a payload whose entries all fail normalization is rejected, not staged", async () => {
  const conn = await makeConnection();
  const outcome = staged.stageCatalog("cerebras", conn.id, [{ notAnId: true }, { alsoBad: 1 }]);
  assert.equal(outcome.staged, false);
  assert.equal(staged.getStagedCatalog("cerebras", conn.id), null);
});

// 3. valid staged catalog publishes
test("a valid staged catalog with no authorization impact publishes automatically", async () => {
  const conn = await makeConnection();
  const result = await staged.runStagedCatalogRefresh("cerebras", conn.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B" },
  ]);

  assert.equal(result.published, true);
  const live = await modelsDb.getSyncedAvailableModelsForConnection("cerebras", conn.id);
  assert.deepEqual(
    live.map((m) => m.id),
    ["gpt-oss-120b"]
  );
  // Staging is cleaned up after a successful publish.
  assert.equal(staged.getStagedCatalog("cerebras", conn.id), null);
});

// 4. previous-good live catalog remains until publish
test("staging a catalog does not change the live catalog until publish is called", async () => {
  const conn = await makeConnection();
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", conn.id, [
    { id: "old-model", name: "Old" },
  ]);

  const stageOutcome = staged.stageCatalog("cerebras", conn.id, [{ id: "new-model", name: "New" }]);
  assert.equal(stageOutcome.staged, true);

  const live = await modelsDb.getSyncedAvailableModelsForConnection("cerebras", conn.id);
  assert.deepEqual(
    live.map((m) => m.id),
    ["old-model"]
  );
  const stagedEntry = staged.getStagedCatalog("cerebras", conn.id);
  assert.deepEqual(
    stagedEntry?.models.map((m) => m.id),
    ["new-model"]
  );
});

// explicit empty-upstream-catalog semantics, distinguished from malformed rejection
test("a genuinely empty upstream catalog is staged (not rejected) and distinguished from malformed input", async () => {
  const conn = await makeConnection();
  const outcome = staged.stageCatalog("cerebras", conn.id, []);
  assert.equal(outcome.staged, true);
  if (outcome.staged) {
    assert.equal(outcome.entry.fetchStatus, "empty");
    assert.deepEqual(outcome.entry.models, []);
  }
});

// 5. explicit allowedModels impact detected
test("removing a model referenced by an api_keys allowedModels grant is detected and blocks auto-publish", async () => {
  const conn = await makeConnection();
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", conn.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B" },
  ]);
  const apiKey = await apiKeysDb.createApiKey("test-key-holder", "machine-1");
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, {
    allowedModels: ["cerebras/gpt-oss-120b"],
  });

  const result = await staged.runStagedCatalogRefresh("cerebras", conn.id, [
    { id: "gemma-4-31b", name: "Gemma 4 31B" },
  ]);

  assert.equal(result.published, false);
  assert.equal(result.publishReason, "authorization_impact_requires_explicit_override");
  assert.equal(result.authorizationImpact.length, 1);
  assert.equal(result.authorizationImpact[0].modelStr, "cerebras/gpt-oss-120b");
  assert.equal(result.authorizationImpact[0].referencedByApiKeys[0].id, apiKey.id);

  // Live catalog is unchanged -- fail closed, no silent break.
  const live = await modelsDb.getSyncedAvailableModelsForConnection("cerebras", conn.id);
  assert.deepEqual(
    live.map((m) => m.id),
    ["gpt-oss-120b"]
  );

  // Explicit override path still requires the operator to opt in -- never automatic.
  const forced = await staged.runStagedCatalogRefresh(
    "cerebras",
    conn.id,
    [{ id: "gemma-4-31b", name: "Gemma 4 31B" }],
    { forcePublishDespiteImpact: true }
  );
  assert.equal(forced.published, true);
});

// 6. stored Combo impact detected
test("removing a model referenced by a stored Combo is detected", async () => {
  const conn = await makeConnection();
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", conn.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B" },
  ]);
  const combo = await combosDb.createCombo({
    name: "test-combo",
    models: [{ model: "cerebras/gpt-oss-120b", weight: 1 }],
  });

  const result = await staged.runStagedCatalogRefresh("cerebras", conn.id, [
    { id: "gemma-4-31b", name: "Gemma 4 31B" },
  ]);

  assert.equal(result.published, false);
  assert.equal(result.authorizationImpact[0].referencedByCombos[0].id, combo.id);
});

// 7. no api_keys mutation
test("the pipeline never mutates api_keys, even when impact is detected or forced", async () => {
  const conn = await makeConnection();
  await modelsDb.replaceSyncedAvailableModelsForConnection("cerebras", conn.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B" },
  ]);
  const apiKey = await apiKeysDb.createApiKey("test-key-holder", "machine-1");
  await apiKeysDb.updateApiKeyPermissions(apiKey.id, {
    allowedModels: ["cerebras/gpt-oss-120b"],
  });
  const before = await apiKeysDb.getApiKeyById(apiKey.id);

  await staged.runStagedCatalogRefresh("cerebras", conn.id, [{ id: "gemma-4-31b", name: "G" }]);
  await staged.runStagedCatalogRefresh("cerebras", conn.id, [{ id: "gemma-4-31b", name: "G" }], {
    forcePublishDespiteImpact: true,
  });

  const after = await apiKeysDb.getApiKeyById(apiKey.id);
  assert.deepEqual(after?.allowedModels, before?.allowedModels);
});

// 8. ghost-model fix composes with staged catalog
test("shadow routing comparison reflects the catalog-authority fix: a stale registry ghost model never appears staged", async () => {
  const conn = await makeConnection(); // no defaultModel -> legacy would use zai-glm-4.7
  const comparison = await staged.compareShadowRouting("cerebras", conn.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B" },
  ]);
  assert.equal(comparison.stagedSelectedModel, "cerebras/gpt-oss-120b");
  assert.notEqual(comparison.stagedSelectedModel, "cerebras/zai-glm-4.7");
});

// 9. quarantine composes correctly
test("shadow routing comparison surfaces quarantine interaction for a staged candidate", async () => {
  const conn = await makeConnection();
  modelQuarantine.quarantineModel("cerebras", conn.id, "gpt-oss-120b", {
    reason: "model_not_found",
    source: "test",
  });

  const comparison = await staged.compareShadowRouting("cerebras", conn.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B" },
  ]);

  assert.equal(comparison.quarantineInteractions.length, 1);
  assert.equal(comparison.quarantineInteractions[0].modelStr, "cerebras/gpt-oss-120b");
  assert.equal(comparison.quarantineInteractions[0].quarantined, true);
});

// 10. unsynced bootstrap behavior preserved
test("a connection with no live and no staged catalog still resolves via legacy static-registry bootstrap in the shadow comparison", async () => {
  const conn = await makeConnection(); // never synced
  const comparison = await staged.compareShadowRouting("cerebras", conn.id, []);
  // Staged side gets an explicit empty catalog patch for THIS connection; the
  // live side (no sync, no default) still falls back to the registry per the
  // unchanged legacy-bootstrap branch in virtualFactory.ts.
  assert.equal(comparison.liveSelectedModel, "cerebras/zai-glm-4.7");
});

// 11. rollback backup created before publish
test("a rollback backup identifier is captured before the live write is attempted", async () => {
  const conn = await makeConnection();
  const calls: string[] = [];
  const fakeDeps = {
    stageCatalog: staged.stageCatalog,
    getSyncedAvailableModelsForConnection: modelsDb.getSyncedAvailableModelsForConnection,
    replaceSyncedAvailableModelsForConnection: async (
      ...args: Parameters<typeof modelsDb.replaceSyncedAvailableModelsForConnection>
    ) => {
      calls.push("write");
      return modelsDb.replaceSyncedAvailableModelsForConnection(...args);
    },
    clearStagedCatalog: staged.clearStagedCatalog,
    backupDbFile: (reason: string) => {
      calls.push("backup");
      return { filename: "fake-backup.sqlite", size: 4096 };
    },
    checkAuthorizationImpact: staged.checkAuthorizationImpact,
    compareShadowRouting: staged.compareShadowRouting,
  };

  const result = await staged.runStagedCatalogRefresh(
    "cerebras",
    conn.id,
    [{ id: "gpt-oss-120b", name: "GPT OSS 120B" }],
    {},
    fakeDeps
  );

  assert.equal(result.published, true);
  assert.deepEqual(result.backup, { filename: "fake-backup.sqlite", size: 4096 });
  assert.deepEqual(calls, ["backup", "write"]);
});

// 12. unrelated connection refresh failure isolated
test("one connection's failed publish does not affect an unrelated connection's successful publish", async () => {
  const connA = await makeConnection();
  const connB = await makeConnection();

  const failingDeps = {
    stageCatalog: staged.stageCatalog,
    getSyncedAvailableModelsForConnection: modelsDb.getSyncedAvailableModelsForConnection,
    replaceSyncedAvailableModelsForConnection: async () => {
      throw new Error("simulated write failure");
    },
    clearStagedCatalog: staged.clearStagedCatalog,
    backupDbFile: () => ({ filename: "fake-backup.sqlite", size: 4096 }),
    checkAuthorizationImpact: staged.checkAuthorizationImpact,
    compareShadowRouting: staged.compareShadowRouting,
  };

  const resultA = await staged.runStagedCatalogRefresh(
    "cerebras",
    connA.id,
    [{ id: "gpt-oss-120b", name: "GPT OSS 120B" }],
    {},
    failingDeps
  );
  const resultB = await staged.runStagedCatalogRefresh("cerebras", connB.id, [
    { id: "gemma-4-31b", name: "Gemma 4 31B" },
  ]);

  assert.equal(resultA.published, false);
  assert.equal(resultB.published, true);
  const liveB = await modelsDb.getSyncedAvailableModelsForConnection("cerebras", connB.id);
  assert.deepEqual(
    liveB.map((m) => m.id),
    ["gemma-4-31b"]
  );
});

// 13. staging cleanup after successful publish
test("the staging entry is removed after a successful publish", async () => {
  const conn = await makeConnection();
  staged.stageCatalog("cerebras", conn.id, [{ id: "gpt-oss-120b", name: "GPT OSS 120B" }]);
  assert.ok(staged.getStagedCatalog("cerebras", conn.id));

  await staged.runStagedCatalogRefresh("cerebras", conn.id, [
    { id: "gpt-oss-120b", name: "GPT OSS 120B" },
  ]);

  assert.equal(staged.getStagedCatalog("cerebras", conn.id), null);
});

// 14. failed publish preserves rollback evidence
test("a failed publish still preserves the rollback backup identifier and does NOT clear staging", async () => {
  const conn = await makeConnection();
  const failingDeps = {
    stageCatalog: staged.stageCatalog,
    getSyncedAvailableModelsForConnection: modelsDb.getSyncedAvailableModelsForConnection,
    replaceSyncedAvailableModelsForConnection: async () => {
      throw new Error("simulated write failure");
    },
    clearStagedCatalog: staged.clearStagedCatalog,
    backupDbFile: () => ({ filename: "fake-backup.sqlite", size: 4096 }),
    checkAuthorizationImpact: staged.checkAuthorizationImpact,
    compareShadowRouting: staged.compareShadowRouting,
  };

  const result = await staged.runStagedCatalogRefresh(
    "cerebras",
    conn.id,
    [{ id: "gpt-oss-120b", name: "GPT OSS 120B" }],
    {},
    failingDeps
  );

  assert.equal(result.published, false);
  assert.ok(result.publishReason?.startsWith("publish_failed"));
  assert.deepEqual(result.backup, { filename: "fake-backup.sqlite", size: 4096 });
  // Staging was never cleared -- retry/inspection remains possible.
  assert.ok(staged.getStagedCatalog("cerebras", conn.id));
});
