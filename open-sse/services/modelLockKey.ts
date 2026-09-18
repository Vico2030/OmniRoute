/**
 * Shared provider:connectionId:model lock-key identity.
 *
 * Extracted out of accountFallback.ts so both the transient in-memory lock
 * (accountFallback.ts) and the durable quarantine store (modelQuarantine.ts)
 * key off the exact same canonicalization — otherwise a model quarantined via
 * one provider alias spelling (e.g. "cx") could stay routable via another
 * ("codex"), or via a quota-scoped model alias.
 */
import { resolveProviderId } from "../../src/shared/constants/providers";
import { getCodexModelScope } from "../config/codexQuotaScopes.ts";
import { getQuotaScopedModelForProvider } from "./antigravityQuotaFamily.ts";

const canonicalProviderCache = new Map<string, string>();

export function getCanonicalLockProvider(provider: string): string {
  let canonical = canonicalProviderCache.get(provider);
  if (!canonical) {
    canonical = resolveProviderId(provider);
    canonicalProviderCache.set(provider, canonical);
  }
  return canonical;
}

export function getModelLockKey(provider: string, connectionId: string, model: string): string {
  const canonicalProvider = getCanonicalLockProvider(provider);
  const lockModel =
    canonicalProvider === "codex"
      ? getCodexModelScope(model)
      : getQuotaScopedModelForProvider(canonicalProvider, model) || model;
  return `${canonicalProvider}:${connectionId}:${lockModel}`;
}
