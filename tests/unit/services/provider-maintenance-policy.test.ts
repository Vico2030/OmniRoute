import test from "node:test";
import assert from "node:assert/strict";
import {
  applyMaintenancePolicy,
  getProviderMaintenancePolicy,
  PROVIDER_MAINTENANCE_POLICIES,
} from "../../../src/lib/providerModels/maintenancePolicy.ts";

const KNOWN_PROVIDERS = ["gemini", "anthropic", "openai", "groq", "cerebras", "nvidia"];

test("a policy manifest is defined for all six current providers", () => {
  for (const provider of KNOWN_PROVIDERS) {
    assert.ok(PROVIDER_MAINTENANCE_POLICIES[provider], `expected a manifest for ${provider}`);
    assert.equal(PROVIDER_MAINTENANCE_POLICIES[provider].provider, provider);
    assert.equal(typeof PROVIDER_MAINTENANCE_POLICIES[provider].description, "string");
    assert.ok(PROVIDER_MAINTENANCE_POLICIES[provider].description.length > 0);
  }
});

test("an unknown/future provider defaults to passthrough (Part 6 onboarding shell)", () => {
  const policy = getProviderMaintenancePolicy("deepseek");
  assert.equal(policy.provider, "deepseek");
  assert.equal(policy.isEligible({ id: "deepseek-chat" }), true);
  assert.equal(policy.isEligible({ id: "anything-at-all" }), true);
});

for (const provider of ["gemini", "anthropic", "groq", "cerebras"]) {
  test(`${provider} policy is passthrough -- relies entirely on the common lifecycle`, () => {
    const { eligible, excluded } = applyMaintenancePolicy(provider, [
      { id: "some-chat-model" },
      { id: "totally-unexpected-id" },
    ]);
    assert.equal(eligible.length, 2);
    assert.equal(excluded.length, 0);
  });
}

test("openai policy excludes documented non-chat model families by id pattern", () => {
  const { eligible, excluded } = applyMaintenancePolicy("openai", [
    { id: "gpt-4o" },
    { id: "gpt-4o-mini" },
    { id: "o3-mini" },
    { id: "whisper-1" },
    { id: "tts-1-hd" },
    { id: "dall-e-3" },
    { id: "text-embedding-3-large" },
    { id: "omni-moderation-latest" },
    { id: "davinci-002" },
    { id: "babbage-002" },
  ]);
  assert.deepEqual(
    eligible.map((m) => m.id),
    ["gpt-4o", "gpt-4o-mini", "o3-mini"]
  );
  assert.deepEqual(
    excluded.map((m) => m.id),
    [
      "whisper-1",
      "tts-1-hd",
      "dall-e-3",
      "text-embedding-3-large",
      "omni-moderation-latest",
      "davinci-002",
      "babbage-002",
    ]
  );
});

test("openai policy does not exclude a chat model whose id happens to be unrecognized (fails open, not closed)", () => {
  const { eligible } = applyMaintenancePolicy("openai", [{ id: "gpt-6-preview" }]);
  assert.equal(eligible.length, 1);
});

test("nvidia policy excludes documented non-chat NIM container families by id pattern", () => {
  const { eligible, excluded } = applyMaintenancePolicy("nvidia", [
    { id: "nvidia/nemotron-3-super-120b-a12b" },
    { id: "meta/llama-3.3-70b-instruct" },
    { id: "nvidia/nv-embed-v2" },
    { id: "nvidia/nv-rerankqa-mistral-4b-v3" },
    { id: "nvidia/riva-asr" },
    { id: "nvidia/parakeet-ctc-1.1b" },
  ]);
  assert.deepEqual(
    eligible.map((m) => m.id),
    ["nvidia/nemotron-3-super-120b-a12b", "meta/llama-3.3-70b-instruct"]
  );
  assert.equal(excluded.length, 4);
});

test("a model with no recognizable id string passes through unclassified rather than being silently dropped", () => {
  const { eligible } = applyMaintenancePolicy("openai", [{ displayName: "no id or model field" }]);
  assert.equal(eligible.length, 1);
});

test("policy application never mutates the input array", () => {
  const input = [{ id: "gpt-4o" }, { id: "whisper-1" }];
  const snapshot = JSON.parse(JSON.stringify(input));
  applyMaintenancePolicy("openai", input);
  assert.deepEqual(input, snapshot);
});
