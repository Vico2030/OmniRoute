/**
 * Durable model quarantine — the missing wire identified by the
 * OmniRoute Autonomous Supply Maintenance / Health Autopilot reconciliation
 * (2026-09-17): providerHealthMatrix.ts already computes durable per-model
 * health from call_logs, but nothing promoted that evidence into an
 * enforcement decision that survives a process restart. accountFallback.ts's
 * own lockModel()/isModelLocked() is correctly scoped (provider:connectionId:model)
 * but is transient, in-memory-only, capped at BACKOFF_CONFIG.max (2 minutes) for
 * ordinary failures — fine for rate limits, wrong for a permanently
 * retired/account-inaccessible model, which just gets retried forever.
 *
 * This module adds ONLY a durable, reversible exclusion at the exact same
 * identity as the transient lock, reusing the existing `key_value` table
 * (the same namespace pattern already used for `syncedAvailableModels` /
 * `customModels` in src/lib/db/models.ts) rather than a new table. It has no
 * cache and no boot-time hydration step — each call reads/writes the DB row
 * directly, so there is no separate-module-graph staleness risk (the known
 * pitfall documented in open-sse/services/modelDeprecation.ts for anything
 * hydrated via instrumentation-node.ts). Enforcement is wired into the single
 * existing gate, accountFallback.ts's isModelLocked() — no new candidate-filter
 * path, so every existing caller (combo.ts, 4 call sites) picks this up for free.
 */
import { getDbInstance } from "@/lib/db/core";
import { getKeyValue } from "@/lib/db/models/shared";
import { getModelLockKey } from "./modelLockKey.ts";

const NAMESPACE = "modelQuarantine";

/** Reasons a durable quarantine may be recorded under (Phase 4 promotion rule).
 *  Deliberately excludes transient reasons (429, timeout, quota_exhausted,
 *  outage) — those stay on the existing short-lived lockModel() cooldown. */
export type ModelQuarantineReason =
  "model_not_found" | "model_not_supported" | "access_denied" | "manual";

export interface ModelQuarantineEntry {
  provider: string;
  connectionId: string;
  model: string;
  reason: ModelQuarantineReason;
  evidence: Record<string, unknown>;
  quarantinedAt: string;
  source: string;
}

function parseEntry(value: string | null): ModelQuarantineEntry | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as ModelQuarantineEntry;
  } catch {
    return null;
  }
}

/**
 * Durably exclude one (provider, connectionId, model) from Smart Auto
 * candidate selection until explicitly cleared. Sibling models on the same
 * connection, and this model on any other connection, are unaffected.
 */
export function quarantineModel(
  provider: string,
  connectionId: string,
  model: string,
  input: { reason: ModelQuarantineReason; evidence?: Record<string, unknown>; source: string }
): ModelQuarantineEntry {
  const db = getDbInstance();
  const key = getModelLockKey(provider, connectionId, model);
  const entry: ModelQuarantineEntry = {
    provider,
    connectionId,
    model,
    reason: input.reason,
    evidence: input.evidence ?? {},
    quarantinedAt: new Date().toISOString(),
    source: input.source,
  };
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    NAMESPACE,
    key,
    JSON.stringify(entry)
  );
  return entry;
}

/** Manual/override recovery path (Phase 5). Returns true if a quarantine was removed. */
export function clearModelQuarantine(
  provider: string,
  connectionId: string,
  model: string | null | undefined
): boolean {
  if (!model) return false;
  const db = getDbInstance();
  const key = getModelLockKey(provider, connectionId, model);
  const result = db
    .prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?")
    .run(NAMESPACE, key);
  return result.changes > 0;
}

export function getModelQuarantine(
  provider: string,
  connectionId: string,
  model: string | null | undefined
): ModelQuarantineEntry | null {
  if (!model) return null;
  const db = getDbInstance();
  const key = getModelLockKey(provider, connectionId, model);
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, key);
  return parseEntry(getKeyValue(row).value);
}

/** The enforcement predicate consulted by accountFallback.ts's isModelLocked(). */
export function isModelQuarantined(
  provider: string,
  connectionId: string,
  model: string | null | undefined
): boolean {
  return getModelQuarantine(provider, connectionId, model) !== null;
}

/** For dashboard/Autopilot reporting — mirrors accountFallback.ts's getAllModelLockouts(). */
export function getAllModelQuarantines(): ModelQuarantineEntry[] {
  const db = getDbInstance();
  const rows = db
    .prepare("SELECT value FROM key_value WHERE namespace = ?")
    .all(NAMESPACE) as unknown[];
  const entries: ModelQuarantineEntry[] = [];
  for (const row of rows) {
    const entry = parseEntry(getKeyValue(row).value);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Test-only: wipe all durable quarantines. Mirrors clearAllModelLockouts(). */
export function clearAllModelQuarantines(): void {
  const db = getDbInstance();
  db.prepare("DELETE FROM key_value WHERE namespace = ?").run(NAMESPACE);
}
