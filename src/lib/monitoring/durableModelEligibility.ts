/**
 * Durable model-quarantine eligibility — the correction identified after the
 * first quarantine_model implementation shipped (2026-09-17/18): eligibility
 * was tied to accountFallback.ts's transient, in-memory model lock, which
 * expires in ≤2 minutes (BACKOFF_CONFIG.max). A model proven permanently dead
 * by durable evidence (call_logs) could fail its own execution precheck
 * simply because nothing had retried it in the last couple of minutes.
 *
 * This module answers eligibility from durable evidence instead — reusing
 * the existing call_logs table and the existing provider:connectionId:model
 * identity, exactly the way providerHealthMatrix.ts already reads call_logs
 * for its own per-model classification. It does not replace or duplicate
 * that classification; it is a narrower, single-target query purpose-built
 * for the quarantine-promotion decision, which needs one exact
 * (provider, connectionId, model) answered precisely, not the whole
 * dashboard's aggregate view.
 *
 * The transient lock is UNCHANGED by this module — accountFallback.ts's
 * lockModel()/isModelLocked()/recordModelLockoutFailure() still work exactly
 * as before, still enforced the same way. This module only changes what
 * providerHealthAutopilot.ts consults to decide whether to OFFER the
 * quarantine_model action.
 */
import { createHash } from "crypto";
import { getDbInstance } from "@/lib/db/core";

/** How far back durable evidence is considered. A model that failed twice
 *  within this window, with no successful completion since, qualifies —
 *  regardless of whether anything has retried it more recently than that. */
export const DURABLE_EVIDENCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Fewer than this many qualifying failures is "a single isolated failure,"
 *  explicitly excluded per the promotion rule. */
export const MIN_QUALIFYING_FAILURES = 2;

/**
 * HTTP statuses that structurally indicate the model/resource itself is
 * unavailable for this account — not a transient/capacity/rate condition.
 * Mirrors this codebase's own existing classification exactly: chatCore.ts
 * assigns reason="model_not_found" for status 404 at the transient-lock
 * call site — this module applies the identical signal to durable history
 * instead of a live in-memory lock. Deliberately excludes 429 (rate_limit_
 * exceeded/quota_exhausted), 5xx (server_error/capacity), and connection-wide
 * 401/403 (auth_error) — none of those are ever 404.
 */
const QUALIFYING_FAILURE_STATUSES = new Set([404]);

export type DurableEligibilityReason = "model_not_found";

export interface DurableEligibilityResult {
  eligible: boolean;
  reason: DurableEligibilityReason | null;
  qualifyingFailureCount: number;
  successCountSinceFirstFailure: number;
  totalRequestsInWindow: number;
  windowStart: string;
  windowEnd: string;
  firstQualifyingFailureAt: string | null;
  lastQualifyingFailureAt: string | null;
  /** Stable, non-secret fingerprint of the evidence this decision was based
   *  on — feeds the action's preconditionsHash so a Founder confirmation
   *  fails closed if the durable evidence changes before execution. */
  evidenceFingerprint: string;
}

interface CallLogRow {
  status: number | null;
  timestamp: string;
}

function isSuccessStatus(status: number | null): boolean {
  return status !== null && status >= 200 && status < 400;
}

export function checkDurableModelEligibility(
  provider: string,
  connectionId: string,
  model: string,
  now: number = Date.now()
): DurableEligibilityResult {
  const db = getDbInstance();
  const windowStart = new Date(now - DURABLE_EVIDENCE_WINDOW_MS).toISOString();
  const windowEnd = new Date(now).toISOString();

  const rows = db
    .prepare(
      `SELECT status, timestamp FROM call_logs
       WHERE provider = ? AND connection_id = ?
         AND COALESCE(model, requested_model, 'unknown') = ?
         AND timestamp >= ? AND timestamp <= ?
       ORDER BY timestamp ASC`
    )
    .all(provider, connectionId, model, windowStart, windowEnd) as CallLogRow[];

  const qualifyingFailures = rows.filter(
    (r) => r.status !== null && QUALIFYING_FAILURE_STATUSES.has(r.status)
  );

  const firstQualifyingFailureAt = qualifyingFailures[0]?.timestamp ?? null;
  const lastQualifyingFailureAt =
    qualifyingFailures.length > 0
      ? qualifyingFailures[qualifyingFailures.length - 1].timestamp
      : null;

  // "Zero successful completions ... after/between the qualifying failures":
  // a success BEFORE the model started failing doesn't disqualify it: only a
  // success AT OR AFTER the first qualifying failure is recovery evidence.
  const successesSinceFirstFailure = firstQualifyingFailureAt
    ? rows.filter((r) => isSuccessStatus(r.status) && r.timestamp >= firstQualifyingFailureAt)
        .length
    : 0;

  const eligible =
    qualifyingFailures.length >= MIN_QUALIFYING_FAILURES && successesSinceFirstFailure === 0;

  // Deliberately excludes windowStart/windowEnd: those are wall-clock query
  // bounds derived from `now` and shift on every call, which would make the
  // fingerprint (and therefore preconditionsHash) change spuriously even
  // when the underlying evidence hasn't. The fingerprint must be stable
  // across repeated calls unless the actual historical evidence — the
  // qualifying-failure/success counts and their own real timestamps —
  // genuinely changes.
  const evidenceFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        provider,
        connectionId,
        model,
        qualifyingFailureCount: qualifyingFailures.length,
        successesSinceFirstFailure,
        firstQualifyingFailureAt,
        lastQualifyingFailureAt,
      })
    )
    .digest("hex")
    .slice(0, 16);

  return {
    eligible,
    reason: eligible ? "model_not_found" : null,
    qualifyingFailureCount: qualifyingFailures.length,
    successCountSinceFirstFailure: successesSinceFirstFailure,
    totalRequestsInWindow: rows.length,
    windowStart,
    windowEnd,
    firstQualifyingFailureAt,
    lastQualifyingFailureAt,
    evidenceFingerprint,
  };
}

/**
 * Distinct (connectionId, model) pairs this provider has any call_logs
 * history for within the evidence window — the candidate set
 * providerHealthAutopilot.ts scans per-provider, so it never has to guess
 * at or enumerate every theoretically possible model.
 */
export function listCallLoggedModelsForProvider(
  provider: string,
  now: number = Date.now()
): Array<{ connectionId: string; model: string }> {
  const db = getDbInstance();
  const windowStart = new Date(now - DURABLE_EVIDENCE_WINDOW_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT DISTINCT connection_id as connectionId,
              COALESCE(model, requested_model, 'unknown') as model
       FROM call_logs
       WHERE provider = ? AND connection_id IS NOT NULL AND timestamp >= ?`
    )
    .all(provider, windowStart) as Array<{ connectionId: string; model: string }>;
  return rows.filter((r) => r.connectionId && r.model && r.model !== "unknown");
}
