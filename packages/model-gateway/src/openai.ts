/**
 * OpenAI Responses API implementation (goal.md §22.2).
 * every call: store:false · strict structured outputs derived from @co/contracts ·
 * response re-validated through the zod contract · cost record emitted per call.
 * model names come ONLY from env. goal.md §0.3: verify API shapes against live docs before production.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  ArtifactExtraction,
  ImmediateResponse,
  WhyQuestion,
  MemoryUpdate,
  PatternCandidate,
  RadarAssessment,
  MovePlan,
  OutcomeUpdate,
} from "@co/contracts";
import { getPrompt, type PromptId } from "@co/prompts";
import type {
  ModelProvider,
  ArtifactInput,
  ImmediateResponseInput,
  WhyQuestionInput,
  MemoryUpdateInput,
  PatternInput,
  RadarRankInput,
  MoveInput,
  OutcomeInput,
  WebSearchInput,
  WebSearchResult,
} from "./provider";
import { loadPricingTable, makeCostRecord, type CostSink, type PricingTable } from "./costs";

export class ValidationError extends Error {
  constructor(public task: string, public issues: unknown, public raw: string) {
    super(`model output for ${task} failed contract validation`);
    this.name = "ValidationError";
  }
}

export class OpenAIRequestError extends Error {
  constructor(public status: number, public body: string) {
    super(`openai request failed: ${status}`);
    this.name = "OpenAIRequestError";
  }
}

export interface OpenAIEnv {
  OPENAI_API_KEY: string;
  MODEL_FAST: string;
  MODEL_REASONING: string;
  MODEL_VISION?: string;
  MODEL_SEARCH?: string;
  MODEL_EMBEDDING: string;
  MODEL_TRANSCRIPTION?: string;
  MODEL_MODERATION?: string; // reserved (§22.1); no moderation call sites in v1 yet
  MODEL_PRICING_JSON?: string;
}

const API_BASE = "https://api.openai.com/v1";

/** strict structured outputs require additionalProperties:false and all keys required on every object. */
function toStrictJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const js = zodToJsonSchema(schema as never, { $refStrategy: "none", target: "jsonSchema7" });  // multi-zod d.ts friction, see P1 dedupe
  return strictify(js as Record<string, unknown>);
}

function strictify(node: unknown): Record<string, unknown> {
  if (node === null || typeof node !== "object") return node as Record<string, unknown>;
  if (Array.isArray(node)) return node.map(strictify) as unknown as Record<string, unknown>;
  const obj = { ...(node as Record<string, unknown>) };
  if (obj.type === "object" && obj.properties && typeof obj.properties === "object") {
    obj.additionalProperties = false;
    obj.required = Object.keys(obj.properties as Record<string, unknown>);
  }
  for (const key of Object.keys(obj)) obj[key] = strictify(obj[key]);
  return obj;
}

function fence(tag: string, content: string): string {
  return `<${tag}>\n${content}\n</${tag}>`;
}

/** compiled context per §22.5 — artifact content always fenced as untrusted data. */
export function compileArtifactContext(a: ArtifactInput): string {
  const parts: string[] = [`source_type: ${a.source_type}`, `coverage: ${a.coverage}`];
  if (a.metadata) parts.push(`metadata: ${JSON.stringify(a.metadata)}`);
  const body = [a.raw_text, a.transcript && `transcript:\n${a.transcript}`].filter(Boolean).join("\n\n");
  parts.push(fence("artifact", body || "(no text content available)"));
  if (a.user_note) parts.push(fence("user_note", a.user_note));
  if (a.why_annotation) parts.push(fence("user_why", a.why_annotation));
  if (a.thread_summary) parts.push(`relevant thread: ${a.thread_summary}`);
  if (a.evidence?.length) parts.push(`evidence:\n${a.evidence.map((e) => `- [${e.id}] (${e.kind}) ${e.statement}`).join("\n")}`);
  if (a.standards?.length) parts.push(`relevant standards:\n${a.standards.map((s) => `- ${s}`).join("\n")}`);
  if (a.authority) parts.push(`authority: user takes final action; allowed moves: ${a.authority.allowed_move_types.join(", ")}`);
  return parts.join("\n\n");
}

export class OpenAIProvider implements ModelProvider {
  private pricing: PricingTable;
  private fetchImpl: typeof fetch;

  constructor(
    private env: OpenAIEnv,
    private opts: { fetchImpl?: typeof fetch; onCost?: CostSink } = {},
  ) {
    this.pricing = loadPricingTable(env as unknown as Record<string, string | undefined>);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async post(path: string, body: unknown): Promise<{ json: Record<string, unknown>; latency_ms: number }> {
    const started = Date.now();
    const res = await this.fetchImpl(`${API_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const latency_ms = Date.now() - started;
    if (!res.ok) throw new OpenAIRequestError(res.status, await res.text());
    return { json: (await res.json()) as Record<string, unknown>, latency_ms };
  }

  private emitCost(task: string, model: string, usage: unknown, latency_ms: number): void {
    const u = (usage ?? {}) as Record<string, number>;
    this.opts.onCost?.({
      task,
      ...makeCostRecord({
        provider: "openai",
        model,
        input_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        latency_ms,
        pricing: this.pricing,
      }),
    });
  }

  /** extract assistant text from a Responses API result. VERIFY: output item shape against live docs. */
  private outputText(json: Record<string, unknown>): string {
    if (typeof json.output_text === "string" && json.output_text.length > 0) return json.output_text;
    const output = (json.output ?? []) as Array<Record<string, unknown>>;
    for (const item of output) {
      if (item.type !== "message") continue;
      for (const c of (item.content ?? []) as Array<Record<string, unknown>>) {
        if (c.type === "output_text" && typeof c.text === "string") return c.text;
      }
    }
    throw new ValidationError("output_text", "no output_text in response", JSON.stringify(json).slice(0, 2000));
  }

  /** shared path: versioned prompt + strict schema + parse through the zod contract. */
  private async runStructured<T>(opts: {
    task: string;
    model: string;
    promptId: PromptId;
    context: string;
    schema: z.ZodType<T>;
    schemaName: string;
  }): Promise<T> {
    const prompt = getPrompt(opts.promptId);
    const body = {
      model: opts.model,
      store: false, // provider state is never canonical memory (§22.2)
      instructions: prompt.text,
      input: [{ role: "user", content: [{ type: "input_text", text: opts.context }] }],
      // VERIFY: Responses API structured-output field is text.format {type:"json_schema", name, strict, schema} per current docs.
      text: { format: { type: "json_schema", name: opts.schemaName, strict: true, schema: toStrictJsonSchema(opts.schema) } },
    };
    const { json, latency_ms } = await this.post("/responses", body);
    this.emitCost(opts.task, opts.model, json.usage, latency_ms);
    const raw = this.outputText(json);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ValidationError(opts.task, "output is not valid json", raw);
    }
    const result = opts.schema.safeParse(parsed);
    if (!result.success) throw new ValidationError(opts.task, result.error.issues, raw);
    return result.data;
  }

  async extractArtifact(input: ArtifactInput): Promise<ArtifactExtraction> {
    // small model for extraction (§25.6). VISION model when image coverage requires it.
    const model = input.coverage === "image" && this.env.MODEL_VISION ? this.env.MODEL_VISION : this.env.MODEL_FAST;
    return this.runStructured({
      task: "artifact_extraction",
      model,
      promptId: "artifact_extraction",
      context: compileArtifactContext(input),
      schema: ArtifactExtraction,
      schemaName: "artifact_extraction",
    });
  }

  async generateImmediateResponse(input: ImmediateResponseInput): Promise<ImmediateResponse> {
    const context = [
      `register: ${input.register}`,
      `extraction: ${JSON.stringify(input.extraction)}`,
      compileArtifactContext(input.artifact),
    ].join("\n\n");
    return this.runStructured({
      task: "immediate_response",
      model: this.env.MODEL_FAST,
      promptId: "immediate_response",
      context,
      schema: ImmediateResponse,
      schemaName: "immediate_response",
    });
  }

  async proposeWhyQuestion(input: WhyQuestionInput): Promise<z.infer<typeof WhyQuestion>> {
    return this.runStructured({
      task: "why_question",
      model: this.env.MODEL_FAST,
      promptId: "why_question",
      context: [`extraction: ${JSON.stringify(input.extraction)}`, compileArtifactContext(input.artifact)].join("\n\n"),
      schema: WhyQuestion,
      schemaName: "why_question",
    });
  }

  async updateMemory(input: MemoryUpdateInput): Promise<MemoryUpdate> {
    const context = [
      compileArtifactContext(input.artifact),
      `extraction: ${JSON.stringify(input.extraction)}`,
      `existing observations (invalidation candidates):\n${input.existing_observations.map((o) => `- [${o.id}] ${o.statement}`).join("\n") || "- none"}`,
      `active threads:\n${input.active_threads.map((t) => `- ${t.title}${t.summary ? `: ${t.summary}` : ""}`).join("\n") || "- none"}`,
    ].join("\n\n");
    return this.runStructured({
      task: "memory_update",
      model: this.env.MODEL_REASONING,
      promptId: "memory_update",
      context,
      schema: MemoryUpdate,
      schemaName: "memory_update",
    });
  }

  async proposePatterns(input: PatternInput): Promise<PatternCandidate[]> {
    const context = [
      `supporting-candidate evidence:\n${input.evidence.map((e) => `- [${e.id}] (${e.kind}, ${e.occurred_at ?? "undated"}, ${e.source_type ?? "unknown"}) ${e.statement}`).join("\n")}`,
      `contradicting evidence:\n${input.contradicting_evidence?.map((e) => `- [${e.id}] ${e.statement}`).join("\n") || "- none"}`,
      input.thread_summary ? `thread: ${input.thread_summary}` : "",
      `patterns the user already stated:\n${input.known_patterns?.map((p) => `- ${p}`).join("\n") || "- none"}`,
    ].filter(Boolean).join("\n\n");
    // structured outputs require a top-level object; unwrap after validation.
    const wrapped = await this.runStructured({
      task: "pattern_candidate",
      model: this.env.MODEL_REASONING,
      promptId: "pattern_candidate",
      context,
      schema: z.object({ candidates: z.array(PatternCandidate) }),
      schemaName: "pattern_candidates",
    });
    return wrapped.candidates;
  }

  async rankRadar(input: RadarRankInput): Promise<RadarAssessment> {
    const context = [
      `watch entity: ${input.watch.display_name} (${input.watch.entity_type})`,
      input.watch.relationship_note ? `user's stated relationship: ${input.watch.relationship_note}` : "",
      `desired event types: ${input.watch.desired_event_types.join(", ") || "any"}`,
      `excluded event types: ${input.watch.excluded_event_types.join(", ") || "none"}`,
      `event: [${input.event.event_type}] ${input.event.title}${input.event.summary ? ` — ${input.event.summary}` : ""}`,
      `source: ${input.event.source_url}${input.event.source_published_at ? ` (${input.event.source_published_at})` : ""}`,
      `explicit user evidence (why_user must cite from here):\n${input.user_evidence.map((e) => `- [${e.id}] ${e.statement}`).join("\n") || "- none"}`,
      `previously sent:\n${input.previously_sent_summaries?.map((s) => `- ${s}`).join("\n") || "- none"}`,
    ].filter(Boolean).join("\n");
    return this.runStructured({
      task: "radar_assessment",
      model: this.env.MODEL_REASONING,
      promptId: "radar_assessment",
      context,
      schema: RadarAssessment,
      schemaName: "radar_assessment",
    });
  }

  async planMove(input: MoveInput): Promise<MovePlan> {
    const context = [
      `origin: ${input.origin}`,
      `context: ${input.context}`,
      input.desired_move_type ? `requested move type: ${input.desired_move_type}` : "",
      `evidence:\n${input.evidence.map((e) => `- [${e.id}] ${e.statement}`).join("\n") || "- none"}`,
      `authority: user takes the final action; allowed: ${input.authority.allowed_move_types.join(", ")}`,
    ].filter(Boolean).join("\n");
    return this.runStructured({
      task: "move_plan",
      model: this.env.MODEL_FAST,
      promptId: "move_plan",
      context,
      schema: MovePlan,
      schemaName: "move_plan",
    });
  }

  async evaluateOutcome(input: OutcomeInput): Promise<OutcomeUpdate> {
    const context = [
      `move: [${input.move.move_type}] ${input.move.title}`,
      `outcome: ${JSON.stringify(input.outcome)}`,
      `live hypotheses:\n${input.hypotheses.map((h) => `- [${h.id}] (${h.confidence}) ${h.statement}`).join("\n") || "- none"}`,
    ].join("\n");
    return this.runStructured({
      task: "outcome_update",
      model: this.env.MODEL_REASONING,
      promptId: "outcome_update",
      context,
      schema: OutcomeUpdate,
      schemaName: "outcome_update",
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const { json, latency_ms } = await this.post("/embeddings", { model: this.env.MODEL_EMBEDDING, input: texts });
    this.emitCost("embed", this.env.MODEL_EMBEDDING, json.usage, latency_ms);
    const data = (json.data ?? []) as Array<{ index: number; embedding: number[] }>;
    if (data.length !== texts.length) throw new ValidationError("embed", "embedding count mismatch", JSON.stringify(json).slice(0, 500));
    return [...data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }

  /** sanitized queries only — the caller must use the source-adapters query compiler (§15.8). */
  async webSearch(input: WebSearchInput): Promise<WebSearchResult> {
    const model = this.env.MODEL_SEARCH ?? this.env.MODEL_FAST;
    const qualifiers = [
      input.site_constraints?.length ? `sites: ${input.site_constraints.join(", ")}` : "",
      input.date_window?.from ? `after: ${input.date_window.from}` : "",
      input.date_window?.to ? `before: ${input.date_window.to}` : "",
    ].filter(Boolean).join("; ");
    const body = {
      model,
      store: false,
      // VERIFY: web search tool type name ("web_search") and annotation shape against live Responses API docs.
      tools: [{ type: "web_search" }],
      input: `search the public web and summarize with citations: ${input.query}${qualifiers ? ` (${qualifiers})` : ""}`,
    };
    const { json, latency_ms } = await this.post("/responses", body);
    this.emitCost("web_search", model, json.usage, latency_ms);
    const sources: WebSearchResult["sources"] = [];
    for (const item of (json.output ?? []) as Array<Record<string, unknown>>) {
      if (item.type !== "message") continue;
      for (const c of (item.content ?? []) as Array<Record<string, unknown>>) {
        for (const a of (c.annotations ?? []) as Array<Record<string, unknown>>) {
          if (a.type === "url_citation" && typeof a.url === "string") {
            sources.push({ url: a.url, title: typeof a.title === "string" ? a.title : a.url });
          }
        }
      }
    }
    let summary: string | undefined;
    try {
      summary = this.outputText(json);
    } catch {
      summary = undefined;
    }
    return { sources, summary };
  }
}

