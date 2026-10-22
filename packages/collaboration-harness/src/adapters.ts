import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { harnessAgentOutputSchema, harnessUsageSchema } from "@co/contracts";
import { z } from "zod";
import { compileAgentPrompt } from "./prompt";
import type { AdapterRequest, AdapterResult, HarnessModelAdapter } from "./types";

function conservativeTokenCeiling(text: string) {
  // A provider count endpoint is preferred. UTF-8 bytes plus framing overhead is a
  // deliberately high fallback so a count outage cannot turn into budget overspend.
  return Math.max(1, Buffer.byteLength(text, "utf8") + 256);
}

function timedSignal(parent: AbortSignal, timeoutMs: number) {
  return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
}

export class OpenAIHarnessAdapter implements HarnessModelAdapter {
  readonly provider = "openai" as const;
  readonly #client: OpenAI;

  constructor(apiKey: string, client?: OpenAI) {
    this.#client = client ?? new OpenAI({ apiKey });
  }

  async estimateInputTokens(request: Omit<AdapterRequest, "signal">) {
    const prompt = compileAgentPrompt(request);
    try {
      const counted = await this.#client.responses.inputTokens.count({
        model: request.model.model,
        input: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        text: { format: zodTextFormat(harnessAgentOutputSchema as never, "harness_agent_output") },
      });
      return counted.input_tokens;
    } catch {
      return conservativeTokenCeiling(prompt.system) + conservativeTokenCeiling(prompt.user);
    }
  }

  async complete(request: AdapterRequest): Promise<AdapterResult> {
    const prompt = compileAgentPrompt(request);
    const reasoning = request.model.reasoning_effort && request.model.reasoning_effort !== "none"
      ? { effort: request.model.reasoning_effort }
      : request.model.reasoning_effort === "none"
        ? { effort: "none" as const }
        : undefined;
    const response = await this.#client.responses.parse({
      model: request.model.model,
      store: false,
      input: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      max_output_tokens: request.model.max_output_tokens,
      ...(reasoning ? { reasoning } : {}),
      text: { format: zodTextFormat(harnessAgentOutputSchema as never, "harness_agent_output") },
    }, { signal: timedSignal(request.signal, request.model.timeout_ms) });
    return {
      output: harnessAgentOutputSchema.parse(response.output_parsed),
      usage: harnessUsageSchema.parse({
        input_tokens: response.usage?.input_tokens ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
        cached_input_tokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
      }),
      provider_request_id: response.id,
      model: response.model,
    };
  }
}

type AnthropicMessageResponse = {
  id?: string;
  model?: string;
  stop_reason?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
};

export class AnthropicHarnessAdapter implements HarnessModelAdapter {
  readonly provider = "anthropic" as const;

  constructor(
    readonly apiKey: string,
    readonly fetchImpl: typeof fetch = fetch,
    readonly baseUrl = "https://api.anthropic.com",
  ) {}

  #body(request: Omit<AdapterRequest, "signal">) {
    const prompt = compileAgentPrompt(request);
    const schema = z.toJSONSchema(harnessAgentOutputSchema, { target: "draft-7" });
    const effort = request.model.reasoning_effort && request.model.reasoning_effort !== "none"
      ? request.model.reasoning_effort
      : undefined;
    return {
      model: request.model.model,
      max_tokens: request.model.max_output_tokens,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      output_config: {
        ...(effort ? { effort } : {}),
        format: { type: "json_schema", schema },
      },
    };
  }

  async estimateInputTokens(request: Omit<AdapterRequest, "signal">) {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(this.#body(request)),
    });
    if (!response.ok) {
      const prompt = compileAgentPrompt(request);
      return conservativeTokenCeiling(prompt.system) + conservativeTokenCeiling(prompt.user);
    }
    const body = await response.json() as { input_tokens?: number };
    return body.input_tokens ?? 0;
  }

  async complete(request: AdapterRequest): Promise<AdapterResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(this.#body(request)),
      signal: timedSignal(request.signal, request.model.timeout_ms),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`anthropic request failed: ${response.status} ${raw.slice(0, 500)}`);
    const message = JSON.parse(raw) as AnthropicMessageResponse;
    if (message.stop_reason === "refusal") throw new Error("anthropic request refused");
    const text = message.content?.find((block) => block.type === "text")?.text;
    if (!text) throw new Error("anthropic response contained no structured text");
    return {
      output: harnessAgentOutputSchema.parse(JSON.parse(text)),
      usage: harnessUsageSchema.parse({
        input_tokens: message.usage?.input_tokens ?? 0,
        output_tokens: message.usage?.output_tokens ?? 0,
        cached_input_tokens: message.usage?.cache_read_input_tokens ?? 0,
      }),
      provider_request_id: message.id ?? null,
      model: message.model ?? request.model.model,
    };
  }
}

export class AdapterRegistry {
  readonly #adapters = new Map<string, HarnessModelAdapter>();

  register(adapter: HarnessModelAdapter) {
    this.#adapters.set(adapter.provider, adapter);
    return this;
  }

  resolve(provider: string) {
    const adapter = this.#adapters.get(provider);
    if (!adapter) throw new Error(`no harness adapter registered for provider: ${provider}`);
    return adapter;
  }
}

export function adaptersFromEnvironment(environment: Record<string, string | undefined> = process.env) {
  const registry = new AdapterRegistry();
  if (environment.OPENAI_API_KEY) registry.register(new OpenAIHarnessAdapter(environment.OPENAI_API_KEY));
  if (environment.ANTHROPIC_API_KEY) registry.register(new AnthropicHarnessAdapter(environment.ANTHROPIC_API_KEY));
  return registry;
}
