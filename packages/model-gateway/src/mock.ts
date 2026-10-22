/**
 * MockProvider — deterministic, contract-valid outputs derived only from input.
 * used by tests, seed scripts, and demo mode (no OPENAI_API_KEY).
 */
import { z } from "zod";
import {
  ArtifactExtraction,
  ImmediateResponse,
  WhyQuestion,
  MemoryUpdate,
  PatternCandidate,
  RadarAssessment,
  MovePlan,
  OutcomeUpdate,
  radarTotal,
} from "@co/contracts";
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
  EvidenceItem,
} from "./provider";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STOPWORDS = new Set(["the","and","that","this","with","from","about","have","just","like","not","for","was","are","but","you","your","its"]);

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function clampWords(s: string, max = 80): string {
  const words = s.trim().split(/\s+/);
  return words.length <= max ? s.trim() : words.slice(0, max).join(" ");
}

function firstWords(s: string, n: number): string {
  return s.trim().split(/\s+/).slice(0, n).join(" ");
}

function topToken(items: EvidenceItem[]): string {
  const counts = new Map<string, number>();
  for (const e of items) {
    for (const t of e.statement.toLowerCase().split(/[^a-z]+/)) {
      if (t.length < 4 || STOPWORDS.has(t)) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  let best = "this";
  let bestN = 0;
  for (const [t, n] of counts) if (n > bestN) { best = t; bestN = n; }
  return best;
}

const COVERAGE_CONFIDENCE: Record<string, number> = {
  full_media: 0.95, image: 0.85, text: 0.9, url_only: 0.2, unavailable: 0, unknown: 0.3,
};

export class MockProvider implements ModelProvider {
  constructor(private opts: { embeddingDim?: number } = {}) {}

  async extractArtifact(input: ArtifactInput): Promise<ArtifactExtraction> {
    const text = input.raw_text ?? input.transcript ?? "";
    const entities = [...new Set((text.match(/\b[A-Z][a-z]{2,}\b/g) ?? []).slice(0, 5))];
    const hasText = text.trim().length > 0;
    return ArtifactExtraction.parse({
      source_summary: hasText
        ? `a ${input.source_type} about ${firstWords(text, 12).toLowerCase()}`
        : `a ${input.source_type} with no accessible text (coverage: ${input.coverage})`,
      entities,
      places: [],
      products: [],
      claims: [],
      content_mood: /\b(lol|meme|funny|joke)\b/i.test(text) ? "funny" : null,
      possible_user_intents: input.user_note ? ["stated in note"] : ["understand"],
      media_access_confidence: COVERAGE_CONFIDENCE[input.coverage] ?? 0.3,
      uncertainties: input.coverage === "full_media" || input.coverage === "text" ? [] : [{ field: "media", reason: "media not fully accessible" }],
    });
  }

  async generateImmediateResponse(input: ImmediateResponseInput): Promise<z.infer<typeof ImmediateResponse>> {
    const a = input.artifact;
    if (a.why_annotation) {
      return ImmediateResponse.parse({
        mode: "remember",
        response: clampWords(`saved. ${a.why_annotation.toLowerCase().replace(/\.$/, "")}.`),
        why_question: null,
        suggested_actions: [],
        confidence: 0.9, // user's own words — high, not certain
        should_wait_for_user: false,
      });
    }
    const noContent = !a.raw_text && !a.transcript;
    if (a.coverage === "unavailable" || (a.coverage === "url_only" && noContent) || (a.coverage === "unknown" && noContent)) {
      return ImmediateResponse.parse({
        mode: "quiet",
        response: "saved. i don't have a useful connection yet.",
        why_question: null,
        suggested_actions: [],
        confidence: 0.3,
        should_wait_for_user: false,
      });
    }
    return ImmediateResponse.parse({
      mode: "understand",
      response: clampWords(input.extraction.source_summary),
      why_question: await this.proposeWhyQuestion({ artifact: a, extraction: input.extraction }),
      suggested_actions: [],
      confidence: 0.6,
      should_wait_for_user: true,
    });
  }

  async proposeWhyQuestion(input: WhyQuestionInput): Promise<z.infer<typeof WhyQuestion>> {
    // option sets per goal.md §11 dynamic why-tap
    if (input.extraction.content_mood === "funny") {
      return WhyQuestion.parse({ prompt: "keeping this because:", options: ["actually funny", "painfully accurate", "send to someone", "no reason"] });
    }
    if (input.artifact.source_type === "social_post" || input.artifact.source_type === "short_video") {
      return WhyQuestion.parse({ prompt: "what pulled you in?", options: ["the person", "the people around them", "the activity", "the place", "how the life feels"] });
    }
    return WhyQuestion.parse({ prompt: "what made you keep this?", options: ["i want this", "this feels like me", "i want to understand it", "keep me posted", "just saving"] });
  }

  async updateMemory(input: MemoryUpdateInput): Promise<z.infer<typeof MemoryUpdate>> {
    const observations: z.infer<typeof MemoryUpdate>["observations_to_add"] = [];
    if (input.artifact.why_annotation) {
      observations.push({ observation_type: "user_statement", statement: input.artifact.why_annotation, scope: null, confidence: 0.95 });
    }
    observations.push({ observation_type: "observation", statement: `saved ${input.extraction.source_summary}`, scope: null, confidence: 0.6 });
    const wantsWatch = /\b(keep me posted|stay close|keep watching|follow this)\b/i.test(input.artifact.why_annotation ?? "");
    const firstEntity = input.extraction.entities[0];
    return MemoryUpdate.parse({
      observations_to_add: observations,
      observations_to_invalidate: [],
      thread_links: input.active_threads.slice(0, 1).map((t) => ({ thread_title: t.title, relationship: "supports" as const, confidence: 0.5 })),
      watch_suggestion: wantsWatch && firstEntity ? { display_name: firstEntity, entity_type: "topic", reason: "you asked co to keep you posted" } : null,
      sensitivity_flags: [],
      requires_user_confirmation: false,
    });
  }

  async proposePatterns(input: PatternInput): Promise<z.infer<typeof PatternCandidate>[]> {
    // §13.3 thresholds: >=3 supporting moments across >=2 separate days
    const supporting = input.evidence.filter((e) => UUID_RE.test(e.id));
    const days = new Set(supporting.map((e) => (e.occurred_at ?? "undated").slice(0, 10)));
    if (supporting.length < 3 || days.size < 2) return [];
    const contradicting = (input.contradicting_evidence ?? []).filter((e) => UUID_RE.test(e.id));
    const theme = topToken(supporting);
    if (input.known_patterns?.some((p) => p.toLowerCase().includes(theme))) return []; // already stated, nothing new
    const contradicted = contradicting.length > 0;
    return [
      PatternCandidate.parse({
        statement: `the repeated element across these moments may be ${theme}, not any single item`,
        supporting_evidence_ids: supporting.map((e) => e.id),
        contradicting_evidence_ids: contradicting.map((e) => e.id),
        alternative_explanations: ["the shared element may be the people involved, not the activity itself"],
        confidence: contradicted ? 0.2 : 0.6, // unresolved contradiction keeps this below send threshold
        novelty: 0.5,
        actionability: contradicted ? 0.2 : 0.6,
        sensitivity: "low",
        door_hypothesis: contradicted ? null : `a small, reversible way to test whether ${theme} is the real draw`,
        why_now: null,
      }),
    ];
  }

  async rankRadar(input: RadarRankInput): Promise<z.infer<typeof RadarAssessment>> {
    const { watch, event, user_evidence } = input;
    const excluded = watch.excluded_event_types.includes(event.event_type);
    const desired = watch.desired_event_types.length === 0 || watch.desired_event_types.includes(event.event_type);
    const hasEvidence = user_evidence.length > 0;
    const duplicate = (input.previously_sent_summaries ?? []).some((s) => s.toLowerCase().includes(event.title.toLowerCase()));
    const fit = excluded ? 0 : desired && hasEvidence ? 0.85 : 0.4;
    const assessment = RadarAssessment.parse({
      event_type: event.event_type,
      event_summary: `${event.title}${event.summary ? ` — ${firstWords(event.summary, 20)}` : ""}`,
      source_facts: [`source: ${event.source_url}`, ...(event.source_published_at ? [`published: ${event.source_published_at}`] : [])],
      personal_relevance: fit,
      novelty: duplicate ? 0.05 : 0.7,
      timeliness: event.source_published_at ? 0.8 : 0.4,
      actionability: 0.6,
      source_trust: event.source_url.startsWith("https://") ? 0.7 : 0.4,
      creepiness_risk: hasEvidence ? 0.05 : 0.5, // no explicit evidence → creepy to send
      why_user: hasEvidence
        ? `you asked co to watch ${watch.display_name}, and you said ${user_evidence[0]!.statement.toLowerCase()}`
        : `co has no explicit evidence linking you to ${watch.display_name}`,
      suggested_actions: [{ move_type: "open_source" as const, title: "open the source" }],
      send_recommendation: "discard",
    });
    const total = radarTotal(assessment, duplicate ? 0.5 : 0);
    const send_recommendation = excluded || duplicate || !hasEvidence ? "discard" : total >= 0.5 ? "send" : "inbox_only";
    return RadarAssessment.parse({ ...assessment, send_recommendation });
  }

  async planMove(input: MoveInput): Promise<z.infer<typeof MovePlan>> {
    const move_type = input.desired_move_type ?? "open_source";
    return MovePlan.parse({
      move_type,
      title: `${move_type.replace(/_/g, " ")}: ${firstWords(input.context, 8)}`,
      steps: ["review what co prepared", "adjust anything that doesn't sound like you", "take the action yourself"],
      external_effect: false,
      final_user_action_required: true,
      private_context_disclosed: false,
    });
  }

  async evaluateOutcome(input: OutcomeInput): Promise<z.infer<typeof OutcomeUpdate>> {
    const positive = /\b(yes|valuable|new idea|real conversation|great)\b/i.test(`${input.outcome.result ?? ""} ${input.outcome.value_rating ?? ""}`) || input.outcome.would_repeat === true;
    const negative = /\b(decided against|not useful|no response|nothing)\b/i.test(`${input.outcome.result ?? ""} ${input.outcome.value_rating ?? ""}`) || input.outcome.would_repeat === false;
    return OutcomeUpdate.parse({
      hypothesis_adjustments: input.hypotheses.slice(0, 1).map((h) => ({
        hypothesis_id: h.id,
        direction: positive ? ("strengthen" as const) : negative ? ("weaken" as const) : ("weaken" as const),
        reason: positive ? "the outcome matched what the hypothesis predicted" : "the outcome did not support the hypothesis",
      })),
      standard_adjustments: [],
      followup_question: positive || negative ? null : "did this happen?",
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    const dim = this.opts.embeddingDim ?? 1536;
    return texts.map((t) => {
      const v = new Array<number>(dim);
      let norm = 0;
      for (let i = 0; i < dim; i++) {
        const x = (fnv1a(`${i}:${t}`) / 0xffffffff) * 2 - 1;
        v[i] = x;
        norm += x * x;
      }
      norm = Math.sqrt(norm) || 1;
      return v.map((x) => x / norm);
    });
  }

  async webSearch(_input: WebSearchInput): Promise<WebSearchResult> {
    return { sources: [], summary: "mock provider has no web access" };
  }
}
