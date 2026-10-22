import assert from "node:assert/strict";
import test from "node:test";
import { getDistribution } from "../src/distributions.ts";
import { behaviorEvalCases, runBehaviorEvals } from "../src/evals.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { CoRuntime } from "../src/runtime.ts";
import type { ProviderAdapter, ProviderRequest } from "../src/types.ts";
import { testConfig, testHome } from "./helpers.ts";

const co = getDistribution("co");
const donna = getDistribution("donna");

test("Donna distribution encodes tact as evidence, restraint, and authority rather than generic warmth", () => {
  assert.match(donna.systemPrompt, /Praise only when specific evidence supports it/);
  assert.match(donna.systemPrompt, /not an accountability machine/);
  assert.match(donna.systemPrompt, /Silence is correct/);
  assert.match(donna.systemPrompt, /Do not invent psychological reads/);
  assert.match(donna.systemPrompt, /successful tool receipt/);
  assert.match(donna.systemPrompt, /realization rather than a task/);
  assert.match(donna.systemPrompt, /Do not infer agreement from silence/);
  assert.match(donna.systemPrompt, /Never promise future work only in prose/);
  assert.ok(behaviorEvalCases.length >= 14);
});

test("neutral distribution preserves the behavior contract without assuming Donna or the owner's identity", () => {
  assert.doesNotMatch(co.systemPrompt, /Donna/i);
  assert.match(co.systemPrompt, /do not assume the user's identity/i);
  assert.match(co.systemPrompt, /Praise only when specific evidence supports it/);
  assert.match(co.systemPrompt, /not an accountability machine/);
});

test("behavior evals execute both candidate and judge and never silently pass on mock", async () => {
  const home = testHome();
  const requests: ProviderRequest[] = [];
  const scripted: ProviderAdapter = {
    name: "openai-compatible",
    complete: async (request) => {
      requests.push(request);
      const judging = request.system.includes("behavioral regression judge");
      return {
        text: judging ? JSON.stringify({ passed: true, reason: "The targeted failure mode is absent." }) : "I don't have evidence for that claim.",
        toolCalls: [], usage: { inputTokens: 10, outputTokens: 10, reasoningTokens: 0 },
      };
    },
  };
  const config = testConfig(home.path);
  const route = { provider: "openai-compatible" as const, model: "fixture", maxOutputTokens: 512, reasoningEffort: "none" as const };
  config.models.foreground = route;
  config.models.critic = route;
  const runtime = new CoRuntime({ config, providers: new ProviderRegistry([scripted]) });
  try {
    const result = await runBehaviorEvals(runtime);
    assert.equal(result.skipped, false);
    assert.equal(result.results.length, behaviorEvalCases.length);
    assert.equal(result.results.every((item) => item.passed), true);
    assert.equal(requests.length, behaviorEvalCases.length * 2);
    assert.equal(requests.every((request) => request.tools.length === 0), true);
  } finally {
    runtime.close();
    home.cleanup();
  }

  const mockHome = testHome();
  const mockRuntime = new CoRuntime({ config: testConfig(mockHome.path) });
  try {
    const unavailable = await runBehaviorEvals(mockRuntime);
    assert.equal(unavailable.skipped, true);
    assert.match(unavailable.unavailableReason ?? "", /non-mock/);
  } finally {
    mockRuntime.close();
    mockHome.cleanup();
  }
});
