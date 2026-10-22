import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicProvider, OpenAIProvider, ProviderRegistry, providerRequestCostEstimate } from "../src/providers.ts";
import type { ProviderAdapter, ProviderRequest } from "../src/types.ts";

const tool = {
  name: "calendar.list", description: "List events", risk: "read" as const, tags: ["calendar"], idempotent: true,
  inputSchema: { type: "object" as const, properties: { date: { type: "string" } }, additionalProperties: false },
};

test("OpenAI adapter preserves encrypted reasoning state and uses portable non-strict tools", async () => {
  const originalFetch = globalThis.fetch;
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test";
  let sent: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      id: "resp_1",
      output: [
        { type: "reasoning", id: "rs_new", encrypted_content: "sealed" },
        { type: "message", content: [{ type: "output_text", text: "done" }] },
      ],
      usage: { input_tokens: 10, output_tokens: 4, output_tokens_details: { reasoning_tokens: 2 } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const request: ProviderRequest = {
      route: { provider: "openai", model: "gpt-5.6-terra", maxOutputTokens: 500, reasoningEffort: "medium" },
      system: "stable instructions\n\nRUNTIME CONTEXT\n- now", tenantId: "tenant", tools: [tool],
      messages: [{ id: "m", role: "assistant", createdAt: new Date().toISOString(), parts: [
        { type: "provider_state", provider: "openai", data: { type: "reasoning", id: "rs_old", encrypted_content: "prior" } },
        { type: "text", text: "earlier" },
        { type: "reaction", reaction: "emphasize", targetMessageId: "provider-message-1" },
      ] }],
    };
    const result = await new OpenAIProvider().complete(request);
    assert.equal((sent.tools as Array<{ strict?: boolean }>)[0]?.strict, false);
    assert.deepEqual(sent.include, ["reasoning.encrypted_content"]);
    assert.equal((sent.input as Array<{ type?: string }>)[0]?.type, "reasoning");
    assert.match(String((sent.input as Array<{ content?: string }>)[2]?.content), /reacted emphasize.*provider-message-1/i);
    assert.equal(result.stateParts?.[0]?.data.encrypted_content, "sealed");
    assert.equal(result.text, "done");
  } finally {
    globalThis.fetch = originalFetch;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
  }
});

test("provider adapters reject malformed tool arguments instead of silently executing an empty object", async () => {
  const originalFetch = globalThis.fetch;
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test";
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "resp_bad_args", status: "completed",
    output: [{ type: "function_call", call_id: "call_bad", name: "calendar.list", arguments: "{not-json" }],
    usage: { input_tokens: 1, output_tokens: 1 },
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const request: ProviderRequest = {
      route: { provider: "openai", model: "gpt-5.6-terra", maxOutputTokens: 500, reasoningEffort: "medium" },
      system: "system", tenantId: "tenant", tools: [tool], messages: [],
    };
    await assert.rejects(new OpenAIProvider().complete(request),
      (error: unknown) => error instanceof Error && /malformed response.*tool arguments/i.test(error.message));
  } finally {
    globalThis.fetch = originalFetch;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
  }
});

test("Anthropic adapter uses current adaptive thinking and retains signed thinking blocks", async () => {
  const originalFetch = globalThis.fetch;
  const priorKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test";
  let sent: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const offered = sent.tools as Array<{ name: string }>;
    return new Response(JSON.stringify({
      id: "msg_1",
      content: [{ type: "thinking", thinking: "summary", signature: "signed" },
        { type: "tool_use", id: "call_1", name: offered[0]?.name, input: { date: "today" } }, { type: "text", text: "done" }],
      usage: { input_tokens: 7, output_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const request: ProviderRequest = {
      route: { provider: "anthropic", model: "claude-sonnet-5", maxOutputTokens: 500, reasoningEffort: "medium" },
      system: "stable instructions\n\nRUNTIME CONTEXT\n- now", tenantId: "tenant", tools: [tool],
      messages: [{ id: "m", role: "assistant", createdAt: new Date().toISOString(), parts: [
        { type: "provider_state", provider: "anthropic", data: { type: "thinking", thinking: "earlier", signature: "old-signature" } },
        { type: "text", text: "earlier answer" },
        { type: "reaction", reaction: "love", targetMessageId: "provider-message-2" },
      ] }],
    };
    const result = await new AnthropicProvider().complete(request);
    assert.deepEqual(sent.thinking, { type: "adaptive" });
    assert.deepEqual(sent.output_config, { effort: "medium" });
    assert.match((sent.tools as Array<{ name: string }>)[0]!.name, /^[a-zA-Z0-9_-]{1,128}$/);
    const system = sent.system as Array<{ text: string; cache_control?: { type: string } }>;
    assert.equal(system[0]?.text, "stable instructions");
    assert.deepEqual(system[0]?.cache_control, { type: "ephemeral" });
    assert.match(system[1]?.text ?? "", /RUNTIME CONTEXT/);
    const content = ((sent.messages as Array<{ content: Array<{ type?: string }> }>)[0]?.content) ?? [];
    assert.equal(content[0]?.type, "thinking");
    assert.match(String((content[2] as { text?: string } | undefined)?.text), /reacted love.*provider-message-2/i);
    assert.equal(result.stateParts?.[0]?.data.signature, "signed");
    assert.equal(result.toolCalls[0]?.name, "calendar.list");
    assert.equal(result.text, "done");
  } finally {
    globalThis.fetch = originalFetch;
    if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorKey;
  }
});

test("provider-neutral cost ceilings reject before execution and report operator-priced estimates", async () => {
  let calls = 0;
  const adapter: ProviderAdapter = {
    name: "openai-compatible",
    complete: async () => {
      calls += 1;
      return { text: "bounded", toolCalls: [], usage: { inputTokens: 100, outputTokens: 20, reasoningTokens: 0 } };
    },
  };
  const registry = new ProviderRegistry([adapter]);
  const request: ProviderRequest = {
    route: {
      provider: "openai-compatible", model: "priced-fixture", baseUrl: "https://fixture.invalid/v1",
      maxOutputTokens: 500, reasoningEffort: "none",
      costCeiling: { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15, maxRequestUsd: 0.001 },
    },
    system: "A bounded request", messages: [], tools: [tool], tenantId: "tenant",
  };
  const estimate = providerRequestCostEstimate(request);
  assert.ok(estimate);
  assert.equal(estimate.inputTokenUpperBound > Buffer.byteLength(request.system), true);
  assert.equal(estimate.outputTokenUpperBound, 500);
  await assert.rejects(registry.resolve(request.route).adapter.complete(request), /rejected before execution.*exceeds.*route ceiling/i);
  assert.equal(calls, 0, "a rejected cost envelope cannot spend a provider call");

  const admitted = { ...request, route: { ...request.route, costCeiling: { ...request.route.costCeiling!, maxRequestUsd: 1 } } };
  const response = await registry.resolve(admitted.route).adapter.complete(admitted);
  assert.equal(calls, 1);
  assert.deepEqual(response.cost, {
    estimatedUsd: 0.0006,
    preflightUpperBoundUsd: providerRequestCostEstimate(admitted)?.upperBoundUsd,
    requestCeilingUsd: 1,
  });
});

test("subscription CLI routes refuse fake dollar ceilings below the adapter", async () => {
  let calls = 0;
  const adapter: ProviderAdapter = {
    name: "codex-cli",
    complete: async () => {
      calls += 1;
      return { text: "not reached", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    },
  };
  const route = {
    provider: "codex-cli" as const, model: "default", maxOutputTokens: 500, reasoningEffort: "none" as const,
    costCeiling: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1, maxRequestUsd: 1 },
  };
  const request: ProviderRequest = { route, system: "test", messages: [], tools: [], tenantId: "tenant" };
  await assert.rejects(new ProviderRegistry([adapter]).resolve(route).adapter.complete(request), /cannot enforce a dollar request ceiling/i);
  assert.equal(calls, 0);
});

test("cost-capped adapters reject unmetered or envelope-breaking responses after the call", async () => {
  for (const usage of [
    { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    { inputTokens: 1, outputTokens: 501, reasoningTokens: 0 },
  ]) {
    let calls = 0;
    const adapter: ProviderAdapter = {
      name: "openai-compatible",
      complete: async () => {
        calls += 1;
        return { text: "untrusted", toolCalls: [], usage };
      },
    };
    const route = {
      provider: "openai-compatible" as const, model: "fixture", baseUrl: "https://fixture.invalid/v1",
      maxOutputTokens: 500, reasoningEffort: "none" as const,
      costCeiling: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1, maxRequestUsd: 1 },
    };
    await assert.rejects(new ProviderRegistry([adapter]).resolve(route).adapter.complete({
      route, system: "test", messages: [], tools: [], tenantId: "tenant",
    }), /usage required|outside its admitted cost envelope/i);
    assert.equal(calls, 1, "post-response validation cannot undo the remote request but must reject its claim");
  }
});
