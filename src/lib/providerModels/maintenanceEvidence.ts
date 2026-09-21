/**
 * Weekly provider-maintenance evidence store (2026-09-20).
 *
 * Persists the outcome of the LAST maintenance run per (provider,
 * connectionId) -- reuses the existing key_value table and
 * "<providerId>:<connectionId>" key convention already established by
 * modelQuarantine.ts, rather than a new table. This is the "OBSERVE /
 * EVIDENCE" stage of the common maintenance contract: it records the result
 * sync-models/route.ts's own catalogPublish response already computes
 * (diff, authorization impact, publish outcome) so an operator can see, per
 * provider, what the last scheduled or manual run actually did -- without
 * grepping container logs, which the scheduler alone never persisted.
 */
import { getDbInstance } from "@/lib/db/core";
import { getKeyValue } from "@/lib/db/models/shared";

const NAMESPACE = "modelMaintenanceEvidence";

export type MaintenanceOutcome =
  | "published"
  | "blocked_authorization_impact"
  | "blocked_empty_catalog"
  | "validation_failed"
  | "fetch_failed"
  | "publish_failed";

export interface MaintenanceEvidenceEntry {
  provider: string;
  connectionId: string;
  ranAt: string;
  outcome: MaintenanceOutcome;
  httpStatus?: number;
  diff?: { added: number; removed: number; unchanged: number; total: number };
  authorizationImpactCount?: number;
  policyExcludedCount?: number;
  reason?: string;
}

function stagingKey(provider: string, connectionId: string): string {
  return `${provider}:${connectionId}`;
}

export function recordMaintenanceEvidence(entry: MaintenanceEvidenceEntry): void {
  const db = getDbInstance();
  db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
    NAMESPACE,
    stagingKey(entry.provider, entry.connectionId),
    JSON.stringify(entry)
  );
}

export function getMaintenanceEvidence(
  provider: string,
  connectionId: string
): MaintenanceEvidenceEntry | null {
  const db = getDbInstance();
  const row = db
    .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, stagingKey(provider, connectionId));
  const value = getKeyValue(row).value;
  if (!value) return null;
  try {
    return JSON.parse(value) as MaintenanceEvidenceEntry;
  } catch {
    return null;
  }
}

/** For dashboard/reporting -- every provider's most recent recorded run. */
export function getAllMaintenanceEvidence(): MaintenanceEvidenceEntry[] {
  const db = getDbInstance();
  const rows = db
    .prepare("SELECT value FROM key_value WHERE namespace = ?")
    .all(NAMESPACE) as unknown[];
  const entries: MaintenanceEvidenceEntry[] = [];
  for (const row of rows) {
    const value = getKeyValue(row).value;
    if (!value) continue;
    try {
      entries.push(JSON.parse(value) as MaintenanceEvidenceEntry);
    } catch {
      /* ignore malformed row */
    }
  }
  return entries;
}

/** Test-only: wipe all recorded evidence. Mirrors clearAllModelLockouts()/clearAllModelQuarantines(). */
export function clearAllMaintenanceEvidence(): void {
  const db = getDbInstance();
  db.prepare("DELETE FROM key_value WHERE namespace = ?").run(NAMESPACE);
}
