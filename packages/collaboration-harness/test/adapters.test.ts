import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { AnthropicHarnessAdapter, OpenAIHarnessAdapter } from "../src/adapters";
import type { AdapterRequest } from "../src/types";

const evidenceId = randomUUID();
const output = {
  summary: "A cited result.",
  findings: [{
    statement: "The evidence contains one supported fact.",
    confidence: 0.9,
    citations: [{ evidence_type: "artifact" as const, evidence_id: evidenceId }],
  }],
  disagreements: [],
  proposed_next_tasks: [],
};

function request(provider: "openai" | "anthropic"): AdapterRequest {
  return {
    runObjective: "Return one cited finding.",
    role: {
      id: "reader",
      name: "Reader",
      objective: "Read the evidence.",
      instructions: "",
      model: {
        provider,
        model: "configured-model",
        max_output_tokens: 500,
        reasoning_effort: "medium",
        timeout_ms: 10_000,
      },
      depends_on: [],
    },
    evidence: [{ evidence_type: "artifact", evidence_id: evidenceId, text: "Primary evidence." }],
    dependencies: [],
    model: {
      provider,
      model: "configured-model",
      max_output_tokens: 500,
      reasoning_effort: "medium",
      timeout_ms: 10_000,
    },
    signal: new AbortController().signal,
  };
}

describe("provider adapters", () => {
  it("uses OpenAI input counting, strict parsing, store=false, and provider usage", async () => {
    const count = vi.fn(async () => ({ input_tokens: 123, object: "response.input_tokens" }));
    const parse = vi.fn(async (_body: Record<string, unknown>, _options?: unknown) => ({
      id: "response-1",
      model: "configured-model",
      output_parsed: output,
      usage: {
        input_tokens: 123,
        output_tokens: 45,
        input_tokens_details: { cached_tokens: 20 },
      },
    }));
    const client = { responses: { inputTokens: { count }, parse } } as unknown as OpenAI;
    const adapter = new OpenAIHarnessAdapter("test-key", client);
    const input = request("openai");
    expect(await adapter.estimateInputTokens(input)).toBe(123);
    const completed = await adapter.complete(input);
    expect(parse.mock.calls[0]?.[0]).toMatchObject({
      model: "configured-model",
      store: false,
      max_output_tokens: 500,
    });
    expect(completed.usage).toEqual({
      input_tokens: 123,
      output_tokens: 45,
      cached_input_tokens: 20,
    });
  });

  it("uses Anthropic count_tokens and structured output_config without provider state", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/count_tokens")) {
        return Response.json({ input_tokens: 87 });
      }
      return Response.json({
        id: "message-1",
        model: "configured-model",
        stop_reason: "end_turn",
        content: [{ type: "text", text: JSON.stringify(output) }],
        usage: { input_tokens: 87, output_tokens: 33, cache_read_input_tokens: 10 },
      });
    }) as typeof fetch;
    const adapter = new AnthropicHarnessAdapter("test-key", fetchImpl);
    const input = request("anthropic");
    expect(await adapter.estimateInputTokens(input)).toBe(87);
    const completed = await adapter.complete(input);
    const messageCall = vi.mocked(fetchImpl).mock.calls.find(([url]) => String(url).endsWith("/v1/messages"));
    const body = JSON.parse(String(messageCall?.[1]?.body)) as Record<string, any>;
    expect(body).toMatchObject({
      model: "configured-model",
      max_tokens: 500,
      output_config: {
        effort: "medium",
        format: { type: "json_schema" },
      },
    });
    expect(completed.usage).toEqual({
      input_tokens: 87,
      output_tokens: 33,
      cached_input_tokens: 10,
    });
  });
});
