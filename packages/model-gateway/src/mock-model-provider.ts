import { artifactExtractionSchema, immediateResponseSchema, patternCandidateSchema, signalCompilationSchema } from "@co/contracts";
import { promptVersions } from "@co/prompts";
import type { ArtifactInput, ImmediateResponseInput, ModelProvider, ModelResult, PatternCandidateInput, SignalCompilationInput } from "./types";

const meta = (promptVersion: string, schemaVersion: string, uncertaintyCount: number) => ({
  provider: "mock",
  model: "deterministic-v1",
  promptVersion,
  schemaVersion,
  latencyMs: 0,
  inputTokens: null,
  outputTokens: null,
  uncertaintyCount,
});

export class MockModelProvider implements ModelProvider {
  async transcribeAudio(_data: Uint8Array, _mimeType: string): Promise<ModelResult<string>> {
    return { value: "[deterministic mock audio transcript]", meta: meta("audio-transcription.v1", "transcript.v1", 0) };
  }

  async embedText(text: string): Promise<ModelResult<number[]>> {
    const value = Array<number>(1536).fill(0);
    for (const [index, byte] of new TextEncoder().encode(text).entries()) value[(index * 31 + byte) % value.length]! += byte / 255;
    const magnitude = Math.sqrt(value.reduce((sum, item) => sum + item * item, 0)) || 1;
    return { value: value.map((item) => item / magnitude), meta: meta("embedding.v1", "embedding-1536.v1", 0) };
  }

  async extractArtifact(input: ArtifactInput) {
    const inaccessible = input.sourceCoverage === "url_only" || input.sourceCoverage === "unavailable";
    const value = artifactExtractionSchema.parse({
      source_summary: inaccessible
        ? input.canonicalUrl ? "A link was saved; the media itself was not supplied." : "The artifact was saved without accessible content."
        : (input.normalizedText ?? "An image was supplied for analysis.").slice(0, 800),
      entities: [], places: [], products: [], claims: [], content_mood: null,
      possible_user_intents: input.userNote ? ["remember the user's stated note"] : [],
      media_access_confidence: inaccessible ? 0 : 1,
      uncertainties: inaccessible ? [{ field: "media", reason: "The host supplied no inspectable media." }] : [],
    });
    return { value, meta: meta(promptVersions.artifactExtraction, "artifact-extraction.v1", value.uncertainties.length) };
  }

  async generateImmediateResponse(input: ImmediateResponseInput) {
    const inaccessible = input.sourceCoverage === "url_only" || input.sourceCoverage === "unavailable";
    const value = immediateResponseSchema.parse(inaccessible ? {
      mode: "remember",
      response: "saved. i have the link, but the app didn’t give me the media itself.",
      why_question: { prompt: "what caught you?", options: ["the person", "the people around them", "the activity", "how the life feels", "save quietly"] },
      suggested_actions: [], confidence: 1, should_wait_for_user: true,
    } : {
      mode: input.explicitRequest === "summary" ? "understand" : input.explicitRequest === "react" ? "react" : "remember",
      response: input.explicitRequest === "summary" ? input.extraction.source_summary
        : input.explicitRequest === "react" ? "saved. this one earned the laugh."
        : "saved. i’ll remember what was here and what you say mattered.",
      why_question: input.explicitRequest === "react"
        ? { prompt: "keeping this because:", options: ["actually funny", "painfully accurate", "send to someone", "no reason", "save quietly"] }
        : { prompt: "what made you keep this?", options: ["i want this", "this feels like me", "i want to understand it", "keep me posted", "just saving"] },
      suggested_actions: [], confidence: 0.8, should_wait_for_user: true,
    });
    return { value, meta: meta(promptVersions.immediateResponse, "immediate-response.v1", inaccessible ? 1 : 0) };
  }

  async generatePatternCandidate(input: PatternCandidateInput) {
    const evidence = input.evidence.slice(0, 3);
    const value = patternCandidateSchema.parse({
      statement: "Across these moments, a recurring condition may be worth testing.",
      supporting_evidence_ids: evidence.map((item) => item.artifactId),
      contradicting_evidence_ids: [],
      alternative_explanations: ["The moments may reflect temporary novelty rather than a durable direction."],
      confidence: 0.65,
      novelty: 0.5,
      actionability: 0.7,
      sensitivity: "low",
      door_hypothesis: "Try one small reversible version and record what changes.",
      why_now: null,
    });
    return { value, meta: meta(promptVersions.patternCandidate, "pattern-candidate.v1", 1) };
  }

  async compileSignals(input: SignalCompilationInput) {
    const signals = input.evidenceSegments.slice(0, 12).map((segment) => {
      const firstParty = segment.speaker_relation === "user";
      return {
        signal_type: firstParty ? "user_statement" as const : "source_claim" as const,
        subject_relation: firstParty ? "user" as const : segment.speaker_relation === "other_person" ? "other_person" as const : "source" as const,
        statement: segment.text.slice(0, 500),
        confidence: segment.confidence,
        supporting_segment_keys: [segment.segment_key],
        contradicting_segment_keys: [],
        uncertainty: segment.speaker_relation === "unknown" ? "Speaker attribution is unknown." : null,
        sensitivity: "low" as const,
      };
    });
    const value = signalCompilationSchema.parse({ signals });
    return { value, meta: meta(promptVersions.signalCompilation, "signal-compilation.v1", value.signals.filter((signal) => signal.uncertainty).length) };
  }
}
