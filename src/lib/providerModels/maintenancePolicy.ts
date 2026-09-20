/**
 * Provider maintenance policy manifests (weekly self-maintenance, 2026-09-20).
 *
 * The staged catalog-refresh lifecycle (stagedCatalogRefresh.ts) is common to
 * every provider -- this module is the ONLY place a provider's own quirks are
 * expressed, as configuration/data, not bespoke pipeline code. A manifest
 * says which freshly-discovered models are even ELIGIBLE to enter this
 * connection's synced catalog; the common lifecycle still owns everything
 * downstream of that (staging, diff, authorization-impact, shadow-routing,
 * atomic publish).
 *
 * Models a policy excludes are simply never added to the candidate list handed
 * to the staged pipeline -- they are not quarantined (no failure evidence
 * exists for them) and are not treated as an authorization-impact "removal"
 * unless they were previously synced, in which case ordinary diff/removal
 * handling applies to them exactly like any other model no longer present.
 *
 * Onboarding a future provider (Part 6): add one entry here (or rely on the
 * default passthrough below if it needs no special filtering) -- nothing else
 * in the scheduler, route, or staged-refresh pipeline needs to change.
 */

/** Raw, untyped upstream model entry -- shape varies by provider before
 *  normalization; tolerate any id-like field rather than assume one. */
export type MaintenanceCandidateModel = Record<string, unknown>;

export interface ProviderMaintenancePolicy {
  provider: string;
  /** Human-readable rationale, surfaced in evidence/reporting. */
  description: string;
  /** True if a freshly-discovered model may enter this connection's synced
   *  catalog at all. Applied identically for manual and scheduled triggers. */
  isEligible(model: MaintenanceCandidateModel): boolean;
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Mirrors the tolerant id-extraction already used by
 *  sync-models/route.ts::normalizeModelForComparison and
 *  models.ts::normalizeSyncedAvailableModel -- a raw upstream entry may carry
 *  its identifier under `id` or `model`. A model with no recognizable id
 *  string is left unclassifiable and passes through -- the common lifecycle's
 *  own normalization step is what ultimately decides whether it's usable. */
function extractModelId(model: MaintenanceCandidateModel): string | null {
  return toNonEmptyString(model.id) || toNonEmptyString(model.model);
}

function passthrough(): ProviderMaintenancePolicy["isEligible"] {
  return () => true;
}

/**
 * OpenAI's own `/v1/models` listing is a large, heterogeneous, ungoverned
 * mix of chat models alongside audio/image/embedding/moderation/legacy-base
 * models that were never meant to become Smart Auto chat-routing candidates.
 * OpenAI's API does not annotate model capability in that listing, so this
 * is an id-pattern exclusion -- documented and testable, not a hardcoded
 * cleanup of specific stale ids (those are still handled by the common
 * diff/lifecycle, same as every other provider).
 */
const OPENAI_NON_CHAT_PATTERN =
  /^(whisper|tts|dall-e|davinci|babbage|ada|curie|text-embedding|text-moderation|omni-moderation|text-search|text-similarity|code-search|gpt-image|sora)(-|$)/i;

function openaiIsEligible(model: MaintenanceCandidateModel): boolean {
  const id = extractModelId(model);
  return id === null || !OPENAI_NON_CHAT_PATTERN.test(id);
}

/**
 * NVIDIA's NIM catalog (build.nvidia.com-compatible `/v1/models`) mixes chat
 * LLMs with embedding/reranking/vision-only/ASR/OCR containers under the same
 * listing. Same rationale as OpenAI: id-pattern exclusion of known non-chat
 * families, not a hand-maintained id blocklist -- new chat models are picked
 * up automatically; new non-chat families matching these prefixes are not
 * blindly turned into routing candidates.
 */
const NVIDIA_NON_CHAT_PATTERN =
  /(embed|rerank|riva|asr|tts|parakeet|canary-|nemoretriever|ocr|clip|vision-only)/i;

function nvidiaIsEligible(model: MaintenanceCandidateModel): boolean {
  const id = extractModelId(model);
  return id === null || !NVIDIA_NON_CHAT_PATTERN.test(id);
}

export const PROVIDER_MAINTENANCE_POLICIES: Record<string, ProviderMaintenancePolicy> = {
  gemini: {
    provider: "gemini",
    description:
      "Preserve already-proven behavior: no additional filtering beyond the existing lifecycle. This connection is the only one with autoSync live in production today.",
    isEligible: passthrough(),
  },
  anthropic: {
    provider: "anthropic",
    description:
      "Live /v1/models is treated as authoritative; the common staged lifecycle (diff/authorization-impact/shadow-routing/atomic-publish) is sufficient on its own -- no bespoke eligibility filter needed.",
    isEligible: passthrough(),
  },
  openai: {
    provider: "openai",
    description:
      "Excludes documented non-chat model families (audio, image, embedding, moderation, legacy completion bases) by id pattern so a large, heterogeneous catalog cannot silently turn a non-chat endpoint into a routing candidate. Everything else passes through to the common lifecycle unchanged.",
    isEligible: openaiIsEligible,
  },
  groq: {
    provider: "groq",
    description:
      "Groq's own /models listing already reflects only currently-served models; stale/retired ids are handled by the common diff+catalog-authority lifecycle, not a hardcoded cleanup list. No bespoke eligibility filter needed.",
    isEligible: passthrough(),
  },
  cerebras: {
    provider: "cerebras",
    description:
      "Small, free catalog; legacy stale ids (e.g. a model removed from the live catalog but still referenced by static registry metadata) are handled by the catalog-authority fix and the common diff/lifecycle, not a bespoke filter here.",
    isEligible: passthrough(),
  },
  nvidia: {
    provider: "nvidia",
    description:
      "Excludes documented non-chat NIM container families (embedding, reranking, ASR/TTS, OCR/vision-only) by id pattern so a large catalog cannot blindly route every discovered container as a chat candidate. Everything else passes through to the common lifecycle unchanged.",
    isEligible: nvidiaIsEligible,
  },
};

/** Unknown/future providers default to passthrough -- see Part 6 (future provider shell). */
export function getProviderMaintenancePolicy(provider: string): ProviderMaintenancePolicy {
  return (
    PROVIDER_MAINTENANCE_POLICIES[provider] ?? {
      provider,
      description: "No policy manifest defined for this provider -- default passthrough.",
      isEligible: passthrough(),
    }
  );
}

export interface MaintenancePolicyResult<T extends MaintenanceCandidateModel> {
  eligible: T[];
  excluded: T[];
}

/** Splits a freshly-discovered model list into eligible/excluded per the
 *  provider's own manifest. Never mutates the input array. */
export function applyMaintenancePolicy<T extends MaintenanceCandidateModel>(
  provider: string,
  models: T[]
): MaintenancePolicyResult<T> {
  const policy = getProviderMaintenancePolicy(provider);
  const eligible: T[] = [];
  const excluded: T[] = [];
  for (const model of models) {
    (policy.isEligible(model) ? eligible : excluded).push(model);
  }
  return { eligible, excluded };
}
