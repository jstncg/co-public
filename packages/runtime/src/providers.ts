import { id } from "./id.ts";
import { imageData, validateImageRequest } from "./images.ts";
import { ClaudeCodeCliProvider, CodexCliProvider } from "./cli-providers.ts";
import { DependencyError, dependencyNetworkError, retryAfterMilliseconds } from "./dependency-errors.ts";
import { readSecret } from "./secrets.ts";
import type {
  JsonObject,
  JsonValue,
  MessagePart,
  ModelRoute,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  RuntimeMessage,
  ToolCall,
  Usage,
} from "./types.ts";

type UnknownObject = Record<string, unknown>;

function object(value: unknown): UnknownObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownObject : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function malformed(service: string, detail: string): never {
  throw new DependencyError({ service, kind: "malformed_response", message: `${service} returned a malformed response: ${detail}`, retryable: true });
}

function jsonArguments(service: string, value: unknown): JsonObject {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== "string") malformed(service, "tool arguments are not an object or JSON object string");
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
    return malformed(service, "tool arguments did not decode to an object");
  } catch {
    return malformed(service, "tool arguments are invalid JSON");
  }
}

async function responseJson(service: string, response: Response): Promise<unknown> {
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    throw dependencyNetworkError(service, error);
  }
  let body: unknown;
  try {
    if (!raw) throw new Error("empty response body");
    body = JSON.parse(raw);
  } catch {
    if (response.ok) throw new DependencyError({
      service, kind: "malformed_response", message: `${service} returned malformed JSON`, retryable: true, httpStatus: response.status,
    });
    body = { raw: raw.slice(0, 500) };
  }
  if (!response.ok) {
    const error = object(object(body).error);
    const message = string(error.message) || string(object(body).message) || `HTTP ${response.status}`;
    const kind = response.status === 429 ? "rate_limited"
      : response.status === 408 || response.status >= 500 ? "unavailable"
        : response.status === 401 || response.status === 403 ? "authentication"
          : response.status >= 400 && response.status < 500 ? "invalid_request"
            : "unknown";
    const retryAfterMs = retryAfterMilliseconds(response.headers.get("retry-after"));
    throw new DependencyError({
      service, kind, message: `${service} request failed: ${message}`, retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      httpStatus: response.status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  return body;
}

async function providerRequest(service: string, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw dependencyNetworkError(service, error);
  }
  return responseJson(service, response);
}

function apiKey(route: ModelRoute, defaultEnv: string): string {
  const envName = route.apiKeyEnv ?? defaultEnv;
  const key = readSecret(envName);
  if (!key) throw new Error(`Missing provider credential in ${envName}`);
  return key;
}

function usage(inputTokens = 0, outputTokens = 0, reasoningTokens = 0): Usage {
  return { inputTokens, outputTokens, reasoningTokens };
}

const PROVIDER_ENVELOPE_OVERHEAD_TOKENS = 4_096;

export interface ProviderRequestCostEstimate {
  inputTokenUpperBound: number;
  outputTokenUpperBound: number;
  upperBoundUsd: number;
  ceilingUsd: number;
}

/**
 * Conservative, provider-neutral request estimate. JSON's UTF-8 byte length is
 * used as the input-token upper bound, with an additional fixed allowance for
 * provider framing. This deliberately overestimates ordinary BPE tokenization.
 * Vendor pricing is never inferred: the operator must pin it in the route.
 */
export function providerRequestCostEstimate(request: ProviderRequest): ProviderRequestCostEstimate | undefined {
  const cost = request.route.costCeiling;
  if (!cost) return undefined;
  if (request.messages.some((message) => message.parts.some((part) => part.type === "image"))) {
    throw new Error("Image cost ceilings require a model-specific visual-token estimator; byte-based text estimates are not valid");
  }
  const serialized = JSON.stringify({
    provider: request.route.provider,
    model: request.route.model,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
  });
  const inputTokenUpperBound = Buffer.byteLength(serialized, "utf8") + PROVIDER_ENVELOPE_OVERHEAD_TOKENS;
  const outputTokenUpperBound = request.route.maxOutputTokens;
  const upperBoundMicroUsd = Math.ceil(inputTokenUpperBound * cost.inputUsdPerMillionTokens)
    + Math.ceil(outputTokenUpperBound * cost.outputUsdPerMillionTokens);
  return {
    inputTokenUpperBound,
    outputTokenUpperBound,
    upperBoundUsd: upperBoundMicroUsd / 1_000_000,
    ceilingUsd: cost.maxRequestUsd,
  };
}

function estimatedUsageUsd(request: ProviderRequest, response: ProviderResponse): number {
  const cost = request.route.costCeiling;
  if (!cost) return 0;
  const microUsd = Math.ceil(response.usage.inputTokens * cost.inputUsdPerMillionTokens)
    + Math.ceil(response.usage.outputTokens * cost.outputUsdPerMillionTokens);
  return microUsd / 1_000_000;
}

function costBoundAdapter(adapter: ProviderAdapter): ProviderAdapter {
  return {
    name: adapter.name,
    complete: async (request) => {
      const estimate = providerRequestCostEstimate(request);
      if (!estimate) return adapter.complete(request);
      if (request.route.provider === "codex-cli" || request.route.provider === "claude-code-cli") {
        throw new DependencyError({
          service: adapter.name,
          kind: "invalid_request",
          retryable: false,
          message: `${adapter.name} cannot enforce a dollar request ceiling; use its token budget or an API route with operator-pinned pricing`,
        });
      }
      if (estimate.upperBoundUsd > estimate.ceilingUsd) {
        throw new DependencyError({
          service: adapter.name,
          kind: "invalid_request",
          retryable: false,
          message: `${adapter.name} request rejected before execution: conservative $${estimate.upperBoundUsd.toFixed(6)} upper bound exceeds the $${estimate.ceilingUsd.toFixed(6)} route ceiling`,
        });
      }
      const response = await adapter.complete(request);
      const measured = response.usage;
      if (![measured.inputTokens, measured.outputTokens, measured.reasoningTokens]
        .every((tokens) => Number.isSafeInteger(tokens) && tokens >= 0)
        || measured.inputTokens + measured.outputTokens === 0) {
        throw new DependencyError({
          service: adapter.name,
          kind: "malformed_response",
          retryable: false,
          message: `${adapter.name} returned missing or invalid usage required by its configured cost ceiling`,
        });
      }
      const actualEstimate = estimatedUsageUsd(request, response);
      if (measured.inputTokens > estimate.inputTokenUpperBound
        || measured.outputTokens > estimate.outputTokenUpperBound
        || actualEstimate > estimate.ceilingUsd) {
        throw new DependencyError({
          service: adapter.name,
          kind: "malformed_response",
          retryable: false,
          message: `${adapter.name} reported usage outside its admitted cost envelope; the response was not accepted`,
        });
      }
      return {
        ...response,
        cost: {
          estimatedUsd: actualEstimate,
          preflightUpperBoundUsd: estimate.upperBoundUsd,
          requestCeilingUsd: estimate.ceilingUsd,
        },
      };
    },
  };
}

function providerToolMap(request: ProviderRequest): { toProvider: Map<string, string>; toRuntime: Map<string, string> } {
  const toProvider = new Map<string, string>();
  const toRuntime = new Map<string, string>();
  request.tools.forEach((tool, index) => {
    const valid = /^[a-zA-Z0-9_-]{1,128}$/.test(tool.name);
    const slug = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 110);
    const encoded = valid ? tool.name : `tool_${index}_${slug}`;
    if (toRuntime.has(encoded)) throw new Error("Provider tool name collision");
    toProvider.set(tool.name, encoded);
    toRuntime.set(encoded, tool.name);
  });
  return { toProvider, toRuntime };
}

function tools(request: ProviderRequest, names: Map<string, string>): JsonValue[] {
  return request.tools.map((tool) => ({
    type: "function",
    name: names.get(tool.name) ?? tool.name,
    description: tool.description,
    parameters: tool.inputSchema as unknown as JsonValue,
    // Runtime validation remains authoritative. Many portable/MCP schemas do not
    // satisfy OpenAI's stricter all-fields-required schema subset.
    strict: tool.strict ?? false,
  }));
}

function reactionTranscript(reaction: Extract<MessagePart, { type: "reaction" }>): string {
  return `[Co reacted ${reaction.reaction} to the preceding member message; provider target ${reaction.targetMessageId}.]`;
}

function openAiInput(messages: RuntimeMessage[], names: Map<string, string>): JsonValue[] {
  const input: JsonValue[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "text" && part.text) {
        input.push({ role: message.role === "tool" ? "user" : message.role, content: part.text });
      } else if (part.type === "image") {
        if (message.role !== "user") throw new Error("Native images require a user message");
        input.push({ role: "user", content: [{ type: "input_image", image_url: `data:${part.mimeType};base64,${imageData(part)}`, detail: "auto" }] });
      } else if (part.type === "provider_state" && part.provider === "openai") {
        input.push(part.data);
      } else if (part.type === "tool_call") {
        input.push({ type: "function_call", call_id: part.id, name: names.get(part.name) ?? part.name, arguments: JSON.stringify(part.arguments) });
      } else if (part.type === "tool_result") {
        input.push({ type: "function_call_output", call_id: part.toolCallId, output: JSON.stringify(part.output) });
      } else if (part.type === "reaction") {
        input.push({ role: "assistant", content: reactionTranscript(part) });
      }
    }
  }
  return input;
}

export class OpenAIProvider implements ProviderAdapter {
  readonly name = "openai" as const;

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    validateImageRequest(request);
    const route = request.route;
    const names = providerToolMap(request);
    const body: JsonObject = {
      model: route.model,
      instructions: request.system,
      input: openAiInput(request.messages, names.toProvider),
      tools: tools(request, names.toProvider),
      tool_choice: "auto",
      parallel_tool_calls: true,
      max_output_tokens: route.maxOutputTokens,
      store: false,
      include: ["reasoning.encrypted_content"],
      safety_identifier: request.tenantId,
    };
    if (route.reasoningEffort !== "none") body.reasoning = { effort: route.reasoningEffort };
    const raw = await providerRequest("OpenAI", `${route.baseUrl ?? "https://api.openai.com/v1"}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey(route, "OPENAI_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const root = object(raw);
    if (!Array.isArray(root.output)) malformed("OpenAI", "output is missing");
    if (root.status === "incomplete") {
      throw new DependencyError({
        service: "OpenAI", kind: "unavailable", message: `OpenAI returned an incomplete response: ${JSON.stringify(root.incomplete_details ?? {}).slice(0, 300)}`,
        retryable: false,
      });
    }
    const output = array(root.output);
    const text = output.flatMap((item) => array(object(item).content)).filter((part) => string(object(part).type) === "output_text").map((part) => string(object(part).text)).join("").trim();
    const toolCalls: ToolCall[] = output
      .filter((item) => string(object(item).type) === "function_call")
      .map((item) => {
        const call = object(item);
        const name = string(call.name);
        return { id: string(call.call_id) || string(call.id) || id("call"), name: names.toRuntime.get(name) ?? name, arguments: jsonArguments("OpenAI", call.arguments) };
      })
      .filter((call) => call.name);
    const usageRoot = object(root.usage);
    const outputDetails = object(usageRoot.output_tokens_details);
    const stateParts = output
      .filter((item) => string(object(item).type) === "reasoning")
      .map((item) => ({ type: "provider_state" as const, provider: "openai" as const, data: object(item) as JsonObject }));
    return {
      text,
      toolCalls,
      usage: usage(number(usageRoot.input_tokens), number(usageRoot.output_tokens), number(outputDetails.reasoning_tokens)),
      ...(string(root.id) ? { providerResponseId: string(root.id) } : {}),
      ...(stateParts.length ? { stateParts } : {}),
      raw: raw as JsonValue,
    };
  }
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: JsonValue[];
}

function anthropicMessages(messages: RuntimeMessage[], names: Map<string, string>): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  for (const message of messages) {
    const role: AnthropicMessage["role"] = message.role === "assistant" ? "assistant" : "user";
    const content: JsonValue[] = [];
    for (const part of message.parts) {
      if (part.type === "text") content.push({ type: "text", text: part.text });
      else if (part.type === "image") {
        if (message.role !== "user") throw new Error("Native images require a user message");
        content.push({ type: "image", source: { type: "base64", media_type: part.mimeType, data: imageData(part) } });
      }
      else if (part.type === "tool_call") content.push({ type: "tool_use", id: part.id, name: names.get(part.name) ?? part.name, input: part.arguments });
      else if (part.type === "tool_result") content.push({ type: "tool_result", tool_use_id: part.toolCallId, content: JSON.stringify(part.output), is_error: part.isError });
      else if (part.type === "reaction") content.push({ type: "text", text: reactionTranscript(part) });
      else if (part.type === "provider_state" && part.provider === "anthropic" && role === "assistant") content.push(part.data);
    }
    if (!content.length) continue;
    const prior = result.at(-1);
    if (prior?.role === role) prior.content.push(...content);
    else result.push({ role, content });
  }
  return result;
}

function anthropicSystem(system: string): JsonValue {
  const marker = "\n\nRUNTIME CONTEXT\n";
  const index = system.indexOf(marker);
  if (index <= 0) return system;
  return [
    { type: "text", text: system.slice(0, index), cache_control: { type: "ephemeral" } },
    { type: "text", text: system.slice(index) },
  ];
}

export class AnthropicProvider implements ProviderAdapter {
  readonly name = "anthropic" as const;

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    validateImageRequest(request);
    const route = request.route;
    const names = providerToolMap(request);
    const body: JsonObject = {
      model: route.model,
      max_tokens: route.maxOutputTokens,
      system: anthropicSystem(request.system),
      messages: anthropicMessages(request.messages, names.toProvider) as unknown as JsonValue,
      tools: request.tools.map((tool) => ({ name: names.toProvider.get(tool.name) ?? tool.name, description: tool.description, input_schema: tool.inputSchema as unknown as JsonValue })),
    };
    if (route.reasoningEffort !== "none" && /claude-(?:fable|opus|sonnet)-(?:5|4-[678])/.test(route.model)) {
      body.thinking = { type: "adaptive" };
      const is46 = route.model.endsWith("-4-6");
      const effort = route.reasoningEffort === "xhigh" && is46 ? "max" : route.reasoningEffort;
      body.output_config = { effort };
    }
    const raw = await providerRequest("Anthropic", `${route.baseUrl ?? "https://api.anthropic.com/v1"}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey(route, "ANTHROPIC_API_KEY"),
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const root = object(raw);
    if (!Array.isArray(root.content)) malformed("Anthropic", "content is missing");
    if (root.stop_reason === "max_tokens") {
      throw new DependencyError({ service: "Anthropic", kind: "unavailable", message: "Anthropic response stopped at the output-token limit", retryable: false });
    }
    const content = array(root.content);
    const text = content.filter((part) => string(object(part).type) === "text").map((part) => string(object(part).text)).join("\n").trim();
    const toolCalls: ToolCall[] = content
      .filter((part) => string(object(part).type) === "tool_use")
      .map((part) => {
        const call = object(part);
        const name = string(call.name);
        return { id: string(call.id) || id("call"), name: names.toRuntime.get(name) ?? name, arguments: jsonArguments("Anthropic", call.input) };
      })
      .filter((call) => call.name);
    const usageRoot = object(root.usage);
    const stateParts = content
      .filter((part) => {
        const type = string(object(part).type);
        return type === "thinking" || type === "redacted_thinking";
      })
      .map((part) => ({ type: "provider_state" as const, provider: "anthropic" as const, data: object(part) as JsonObject }));
    return {
      text,
      toolCalls,
      usage: usage(number(usageRoot.input_tokens), number(usageRoot.output_tokens)),
      ...(string(root.id) ? { providerResponseId: string(root.id) } : {}),
      ...(stateParts.length ? { stateParts } : {}),
      raw: raw as JsonValue,
    };
  }
}

function chatMessages(messages: RuntimeMessage[], names: Map<string, string>): JsonValue[] {
  const output: JsonValue[] = [];
  for (const message of messages) {
    const text = message.parts.flatMap((part) => part.type === "text" ? [part.text]
      : part.type === "reaction" ? [reactionTranscript(part)] : []).join("\n");
    const calls = message.parts.filter((part): part is Extract<MessagePart, { type: "tool_call" }> => part.type === "tool_call");
    if (message.role === "assistant") {
      output.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: names.get(call.name) ?? call.name, arguments: JSON.stringify(call.arguments) } })) } : {}),
      });
    } else if (message.role === "tool") {
      for (const part of message.parts) if (part.type === "tool_result") output.push({ role: "tool", tool_call_id: part.toolCallId, content: JSON.stringify(part.output) });
    } else {
      const images = message.parts.filter((part) => part.type === "image");
      if (images.length) output.push({ role: "user", content: [
        ...images.map((part) => ({ type: "image_url", image_url: { url: `data:${part.mimeType};base64,${imageData(part)}` } })),
        ...(text ? [{ type: "text", text }] : []),
      ] });
      else if (text) output.push({ role: "user", content: text });
    }
  }
  return output;
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  readonly name = "openai-compatible" as const;

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    validateImageRequest(request);
    const route = request.route;
    const names = providerToolMap(request);
    if (!route.baseUrl) throw new Error("OpenAI-compatible provider requires CO_BASE_URL");
    const key = readSecret(route.apiKeyEnv ?? "OPENAI_API_KEY");
    const raw = await providerRequest("OpenAI-compatible", `${route.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: route.model,
        max_tokens: route.maxOutputTokens,
        messages: [{ role: "system", content: request.system }, ...chatMessages(request.messages, names.toProvider)],
        tools: request.tools.map((tool) => ({ type: "function", function: { name: names.toProvider.get(tool.name) ?? tool.name, description: tool.description, parameters: tool.inputSchema } })),
        tool_choice: "auto",
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const root = object(raw);
    if (!Array.isArray(root.choices) || root.choices.length === 0) malformed("OpenAI-compatible", "choices are missing");
    const choice = object(array(root.choices)[0]);
    if (choice.finish_reason === "length") {
      throw new DependencyError({ service: "OpenAI-compatible", kind: "unavailable", message: "OpenAI-compatible response stopped at the output-token limit", retryable: false });
    }
    const message = object(choice.message);
    const toolCalls = array(message.tool_calls).map((item) => {
      const call = object(item);
      const fn = object(call.function);
      const name = string(fn.name);
      return { id: string(call.id) || id("call"), name: names.toRuntime.get(name) ?? name, arguments: jsonArguments("OpenAI-compatible", fn.arguments) };
    }).filter((call) => call.name);
    const usageRoot = object(root.usage);
    return {
      text: string(message.content).trim(),
      toolCalls,
      usage: usage(number(usageRoot.prompt_tokens), number(usageRoot.completion_tokens)),
      ...(string(root.id) ? { providerResponseId: string(root.id) } : {}),
      raw: raw as JsonValue,
    };
  }
}

export class MockProvider implements ProviderAdapter {
  readonly name = "mock" as const;

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const lastUserIndex = request.messages.findLastIndex((message) => message.role === "user");
    const last = lastUserIndex >= 0 ? request.messages[lastUserIndex] : undefined;
    const text = last?.parts.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join(" ") ?? "";
    if (request.system.includes("follow-through planner")) {
      return {
        text: JSON.stringify({
          disposition: "discard", kind: "none", title: "No warranted follow-through",
          objective: "Avoid manufacturing work when the deterministic provider has no additional judgment.",
          rationale: "The mock provider cannot establish a concrete consequence from the accepted intelligence.",
          memberDelta: "No independently established informational or practical delta is available from this provider.",
          content: "", confidence: 0, novelty: 0, usefulness: 0, urgency: 0,
        }),
        toolCalls: [], usage: usage(Math.max(1, Math.ceil(text.length / 4)), 48),
      };
    }
    const match = text.match(/\[\[tool:([a-zA-Z0-9_.-]+)\s*(\{.*\})?\]\]/s);
    const alreadyCalled = request.messages.slice(lastUserIndex + 1).some((message) => message.parts.some((part) => part.type === "tool_result"));
    if (match && !alreadyCalled) {
      return { text: "", toolCalls: [{ id: id("call"), name: match[1] ?? "", arguments: jsonArguments("Mock", match[2] ?? "{}") }], usage: usage(20, 8) };
    }
    const result = [...request.messages.slice(lastUserIndex + 1)].reverse().find((message) => message.role === "tool")?.parts.find((part) => part.type === "tool_result");
    return {
      text: result?.type === "tool_result" ? `Done. ${JSON.stringify(result.output)}` : `Mock response: ${text}`,
      toolCalls: [],
      usage: usage(Math.max(1, Math.ceil(text.length / 4)), 12),
    };
  }
}

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(adapters: ProviderAdapter[] = [new OpenAIProvider(), new AnthropicProvider(), new OpenAICompatibleProvider(), new CodexCliProvider(), new ClaudeCodeCliProvider(), new MockProvider()]) {
    for (const adapter of adapters) this.adapters.set(adapter.name, costBoundAdapter(adapter));
  }

  withBoundary(boundary: (request: ProviderRequest, next: () => Promise<ProviderResponse>) => Promise<ProviderResponse>): ProviderRegistry {
    const registry = new ProviderRegistry([]);
    for (const [name, adapter] of this.adapters) registry.adapters.set(name, {
      name: adapter.name, complete: (request) => boundary(request, () => adapter.complete(request)),
    });
    return registry;
  }

  resolve(route: ModelRoute): { adapter: ProviderAdapter; route: ModelRoute } {
    let name = route.provider;
    if (name === "auto") {
      if (readSecret("OPENAI_API_KEY")) name = "openai";
      else if (readSecret("ANTHROPIC_API_KEY")) name = "anthropic";
      else name = "mock";
    }
    const adapter = this.adapters.get(name);
    if (!adapter) throw new Error(`No provider adapter registered for ${name}`);
    const model = route.provider === "auto"
      ? name === "openai" ? route.model.startsWith("gpt-") ? route.model : "gpt-5.6-terra"
        : name === "anthropic" ? route.model.startsWith("claude-") ? route.model : "claude-sonnet-5"
          : "mock-1"
      : route.model;
    return { adapter, route: { ...route, provider: name, model } };
  }
}
