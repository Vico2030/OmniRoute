/**
 * Staged / atomic model-catalog refresh pipeline (2026-09-18, construction +
 * test only — NOT wired into the live sync-models route yet).
 *
 * Hardens the "after fetch" half of the catalog-refresh path:
 *   FETCH (existing, untouched — sync-models/route.ts::fetchProviderModelsForSync)
 *   → NORMALIZE (reused: src/lib/db/models.ts::normalizeSyncedAvailableModels)
 *   → STAGE → VALIDATE → DIFF → POLICY CHECK → SHADOW ROUTING COMPARISON
 *   → ATOMIC PUBLISH (reused: replaceSyncedAvailableModelsForConnection(),
 *     which already backs up via backupDbFile("pre-write") before writing)
 *   → OBSERVE (the returned StagedRefreshResult)
 *
 * The live `syncedAvailableModels` row for a connection is never written
 * until publish. A failure at any stage before publish leaves it untouched —
 * proven by the accompanying test file, not merely asserted here.
 *
 * Explicitly reused, not reimplemented: the synced-catalog store and its
 * empty-array-deletes-row semantics (models.ts), the catalog-authority fix's
 * candidate generation (virtualFactory.ts::createVirtualAutoCombo, via its
 * additive `overrides` param), durable quarantine (modelQuarantine.ts), and
 * the DB backup mechanism (backup.ts::backupDbFile, already called inside
 * replaceSyncedAvailableModelsForConnection — not called a second time here).
 *
 * Deliberately NOT reused: sync-models/route.ts's own private
 * summarizeModelChanges() — importing from an app-router route file into a
 * lib module would invert the intended src/lib -> src/app dependency
 * direction. diffModelSets() below is a small, standalone reimplementation
 * of the same idea (added/removed/updated id sets) kept local to this module.
 *
 * refreshSerializer.ts was inspected per the read-first list but is NOT
 * reused here: it serializes OAuth token-refresh network calls within a
 * provider's Auth0 rotation group (openai/codex/claude/etc.) — a different
 * problem from catalog-refresh concurrency. This module operates on one
 * (providerId, connectionId) pair per call; per-connection isolation (test
 * #12) falls out naturally from that scoping, with no shared lock needed.
 */
import {
  getSyncedAvailableModelsForConnection,
  replaceSyncedAvailableModelsForConnection,
  normalizeSyncedAvailableModels,
  type SyncedAvailableModel,
} from "@/lib/db/models";
import { getKeyValue } from "@/lib/db/models/shared";
import { getDbInstance } from "@/lib/db/core";
import { backupDbFile } from "@/lib/db/backup";
import { getApiKeys } from "@/lib/db/apiKeys";
import { getCombos } from "@/lib/db/combos";
import {
  createVirtualAutoCombo,
  type SyncedCatalogOverride,
} from "@omniroute/open-sse/services/autoCombo/virtualFactory.ts";
import { isModelQuarantined } from "@omniroute/open-sse/services/modelQuarantine.ts";

const STAGING_NAMESPACE = "syncedAvailableModelsStaging";

function stagingKey(providerId: string, connectionId: string): string {
  return `${providerId}:${connectionId}`;
}

export interface StagedCatalogEntry {
  providerId: string;
  connectionId: string;
  models: SyncedAvailableModel[];
  /** "empty" means the upstream provider genuinely returned zero models —
   *  distinct from a rejected/invalid fetch, which never reaches staging. */
  fetchStatus: "ok" | "empty";
  stagedAt: string;
}

export type StageOutcome =
  { staged: true; entry: StagedCatalogEntry } | { staged: false; reason: string };

/**
 * STAGE + VALIDATE. Writes to the staging namespace only — never touches the
 * live `syncedAvailableModels` row. Rejects malformed payloads outright
 * (nothing is staged) rather than silently coercing them.
 */
export function stageCatalog(
  providerId: string,
  connectionId: string,
  rawFetchedModels: unknown
): StageOutcome {
  if (!Array.isArray(rawFetchedModels)) {
    return { staged: false, reason: "fetched models payload is not an array" };
  }
  const models = normalizeSyncedAvailableModels(rawFetchedModels);
  if (rawFetchedModels.length > 0 && models.length === 0) {
    return { staged: false, reason: "no valid models survived normalization" };
  }

  const entry: StagedCatalogEntry = {
    providerId,
    connectionId,
    models,
    fetchStatus: models.length === 0 ? "empty" : "ok",
    stagedAt: new Date().toISOString(),
  };

  const db = getDbInstance();
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    STAGING_NAMESPACE,
    stagingKey(providerId, connectionId),
    JSON.stringify(entry)
  );
  return { staged: true, entry };
}

export function getStagedCatalog(
  providerId: string,
  connectionId: string
): StagedCatalogEntry | null {
  const db = getDbInstance();
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(STAGING_NAMESPACE, stagingKey(providerId, connectionId));
  const value = getKeyValue(row).value;
  if (!value) return null;
  try {
    return JSON.parse(value) as StagedCatalogEntry;
  } catch {
    return null;
  }
}

export function clearStagedCatalog(providerId: string, connectionId: string): boolean {
  const db = getDbInstance();
  const result = db
    .prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?")
    .run(STAGING_NAMESPACE, stagingKey(providerId, connectionId));
  return result.changes > 0;
}

/** DIFF — pure id-set comparison, independent of route.ts's private summarizeModelChanges(). */
export interface CatalogDiff {
  addedIds: string[];
  removedIds: string[];
  unchangedIds: string[];
  summary: { added: number; removed: number; unchanged: number; total: number };
}

export function diffModelSets(
  previous: SyncedAvailableModel[],
  next: SyncedAvailableModel[]
): CatalogDiff {
  const previousIds = new Set(previous.map((m) => m.id));
  const nextIds = new Set(next.map((m) => m.id));
  const addedIds = [...nextIds].filter((id) => !previousIds.has(id));
  const removedIds = [...previousIds].filter((id) => !nextIds.has(id));
  const unchangedIds = [...nextIds].filter((id) => previousIds.has(id));
  return {
    addedIds,
    removedIds,
    unchangedIds,
    summary: {
      added: addedIds.length,
      removed: removedIds.length,
      unchanged: unchangedIds.length,
      total: addedIds.length + removedIds.length,
    },
  };
}

/** POLICY CHECK — read-only. Never writes to api_keys or combos. */
export interface AuthorizationImpactEntry {
  modelStr: string;
  referencedByApiKeys: Array<{ id: string; name: string }>;
  referencedByCombos: Array<{ id: string; name: string }>;
}

function comboReferencesModel(combo: Record<string, unknown>, modelStr: string): boolean {
  return (
    Array.isArray(combo.models) &&
    combo.models.some(
      (target) =>
        target &&
        typeof target === "object" &&
        (target as Record<string, unknown>).model === modelStr
    )
  );
}

export async function checkAuthorizationImpact(
  providerId: string,
  removedModelIds: string[]
): Promise<AuthorizationImpactEntry[]> {
  if (removedModelIds.length === 0) return [];
  const removedModelStrs = removedModelIds.map((id) => `${providerId}/${id}`);
  const [apiKeys, combos] = await Promise.all([getApiKeys(), getCombos()]);

  const impacts: AuthorizationImpactEntry[] = [];
  for (const modelStr of removedModelStrs) {
    const referencedByApiKeys = apiKeys
      .filter(
        (key) =>
          Array.isArray((key as Record<string, unknown>).allowedModels) &&
          ((key as Record<string, unknown>).allowedModels as string[]).includes(modelStr)
      )
      .map((key) => ({
        id: String((key as Record<string, unknown>).id ?? ""),
        name: String((key as Record<string, unknown>).name ?? ""),
      }));
    const referencedByCombos = combos
      .filter((combo) => comboReferencesModel(combo as Record<string, unknown>, modelStr))
      .map((combo) => ({
        id: String((combo as Record<string, unknown>).id ?? ""),
        name: String((combo as Record<string, unknown>).name ?? ""),
      }));

    if (referencedByApiKeys.length > 0 || referencedByCombos.length > 0) {
      impacts.push({ modelStr, referencedByApiKeys, referencedByCombos });
    }
  }
  return impacts;
}

/** SHADOW ROUTING COMPARISON — reuses createVirtualAutoCombo() unmodified in
 *  its default (live) form, and via its additive `overrides` param for the
 *  staged form. Neither call writes to the live catalog. */
export interface ShadowRoutingComparison {
  addedModels: string[];
  removedModels: string[];
  defaultModelChanged: boolean;
  liveSelectedModel: string | null;
  stagedSelectedModel: string | null;
  quarantineInteractions: Array<{ modelStr: string; quarantined: boolean }>;
  requesterVisibleImpact: boolean;
}

export async function compareShadowRouting(
  providerId: string,
  connectionId: string,
  stagedModels: SyncedAvailableModel[]
): Promise<ShadowRoutingComparison> {
  const patch: SyncedCatalogOverride = {
    patch: new Map([[providerId, { [connectionId]: stagedModels }]]),
  };
  const [liveCombo, stagedCombo] = await Promise.all([
    createVirtualAutoCombo(undefined),
    createVirtualAutoCombo(undefined, undefined, patch),
  ]);

  const liveSelectedModel =
    liveCombo.models.find((m) => m.connectionId === connectionId)?.model ?? null;
  const stagedSelectedModel =
    stagedCombo.models.find((m) => m.connectionId === connectionId)?.model ?? null;

  const liveSet = new Set(liveCombo.models.map((m) => m.model));
  const stagedSet = new Set(stagedCombo.models.map((m) => m.model));
  const addedModels = [...stagedSet].filter((m) => !liveSet.has(m));
  const removedModels = [...liveSet].filter((m) => !stagedSet.has(m));

  const quarantineInteractions = stagedModels.map((m) => ({
    modelStr: `${providerId}/${m.id}`,
    quarantined: isModelQuarantined(providerId, connectionId, m.id),
  }));

  return {
    addedModels,
    removedModels,
    defaultModelChanged: liveSelectedModel !== stagedSelectedModel,
    liveSelectedModel,
    stagedSelectedModel,
    quarantineInteractions,
    requesterVisibleImpact: addedModels.length > 0 || removedModels.length > 0,
  };
}

type Dependencies = {
  stageCatalog: typeof stageCatalog;
  getSyncedAvailableModelsForConnection: typeof getSyncedAvailableModelsForConnection;
  replaceSyncedAvailableModelsForConnection: typeof replaceSyncedAvailableModelsForConnection;
  clearStagedCatalog: typeof clearStagedCatalog;
  backupDbFile: typeof backupDbFile;
  checkAuthorizationImpact: typeof checkAuthorizationImpact;
  compareShadowRouting: typeof compareShadowRouting;
};

const DEFAULT_DEPENDENCIES: Dependencies = {
  stageCatalog,
  getSyncedAvailableModelsForConnection,
  replaceSyncedAvailableModelsForConnection,
  clearStagedCatalog,
  backupDbFile,
  checkAuthorizationImpact,
  compareShadowRouting,
};

export interface StagedRefreshResult {
  providerId: string;
  connectionId: string;
  validation: { valid: boolean; reason?: string };
  diff: CatalogDiff["summary"];
  authorizationImpact: AuthorizationImpactEntry[];
  shadowRouting: ShadowRoutingComparison | null;
  published: boolean;
  publishReason?: string;
  backup: { filename: string; size: number } | null;
  previousModels: SyncedAvailableModel[];
}

/**
 * Full pipeline for one already-fetched (provider, connection) pair.
 * `forcePublishDespiteImpact` is the only way past a detected authorization
 * impact — there is no automatic override; authorization itself (api_keys,
 * combos) is never written by this function either way.
 */
export async function runStagedCatalogRefresh(
  providerId: string,
  connectionId: string,
  rawFetchedModels: unknown,
  options: { forcePublishDespiteImpact?: boolean } = {},
  deps: Dependencies = DEFAULT_DEPENDENCIES
): Promise<StagedRefreshResult> {
  const previousModels = await deps.getSyncedAvailableModelsForConnection(providerId, connectionId);

  const stageResult = deps.stageCatalog(providerId, connectionId, rawFetchedModels);
  if (!stageResult.staged) {
    return {
      providerId,
      connectionId,
      validation: { valid: false, reason: stageResult.reason },
      diff: { added: 0, removed: 0, unchanged: 0, total: 0 },
      authorizationImpact: [],
      shadowRouting: null,
      published: false,
      publishReason: "validation_failed",
      backup: null,
      previousModels,
    };
  }

  const stagedModels = stageResult.entry.models;
  const diff = diffModelSets(previousModels, stagedModels);
  const authorizationImpact = await deps.checkAuthorizationImpact(providerId, diff.removedIds);
  const shadowRouting = await deps.compareShadowRouting(providerId, connectionId, stagedModels);

  // Empty-catalog safety: a genuinely empty upstream fetch (fetchStatus
  // "empty", not a rejected/malformed one -- those never reach here) must
  // never silently wipe an existing non-empty live catalog. Direct callers
  // of this pipeline don't get the sync-models route's own
  // `discoveredModels.length > 0` outer guard, so this is the pipeline's own
  // fail-closed default for that case -- same governed override as
  // authorization impact, not a separate mechanism.
  const isEmptyOverwrite = stageResult.entry.fetchStatus === "empty" && previousModels.length > 0;
  if (isEmptyOverwrite && !options.forcePublishDespiteImpact) {
    return {
      providerId,
      connectionId,
      validation: { valid: true },
      diff: diff.summary,
      authorizationImpact,
      shadowRouting,
      published: false,
      publishReason: "empty_catalog_requires_explicit_override",
      backup: null,
      previousModels,
    };
  }

  if (authorizationImpact.length > 0 && !options.forcePublishDespiteImpact) {
    return {
      providerId,
      connectionId,
      validation: { valid: true },
      diff: diff.summary,
      authorizationImpact,
      shadowRouting,
      published: false,
      publishReason: "authorization_impact_requires_explicit_override",
      backup: null,
      previousModels,
    };
  }

  let backup: { filename: string; size: number } | null = null;
  try {
    // Belt-and-suspenders: replaceSyncedAvailableModelsForConnection() already
    // calls backupDbFile("pre-write") internally before its own write, but
    // capturing it here too means a rollback identifier is retained even if
    // that call's own internal backup is throttled/skipped — and it lets a
    // failed publish (below) still report a backup taken just before it.
    backup = deps.backupDbFile("pre-write");
    await deps.replaceSyncedAvailableModelsForConnection(providerId, connectionId, stagedModels);
    deps.clearStagedCatalog(providerId, connectionId);
    return {
      providerId,
      connectionId,
      validation: { valid: true },
      diff: diff.summary,
      authorizationImpact,
      shadowRouting,
      published: true,
      backup,
      previousModels,
    };
  } catch (err) {
    return {
      providerId,
      connectionId,
      validation: { valid: true },
      diff: diff.summary,
      authorizationImpact,
      shadowRouting,
      published: false,
      publishReason: `publish_failed: ${err instanceof Error ? err.message : String(err)}`,
      backup,
      previousModels,
    };
  }
}
