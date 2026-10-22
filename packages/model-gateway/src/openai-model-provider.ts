import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { artifactExtractionSchema, immediateResponseSchema, patternCandidateSchema, signalCompilationSchema } from "@co/contracts";
import { artifactExtractionPrompt, getPrompt, immediateResponsePrompt, patternCandidatePrompt, promptVersions } from "@co/prompts";
import type { ArtifactInput, ImmediateResponseInput, ModelProvider, PatternCandidateInput, SignalCompilationInput } from "./types";

export class OpenAIModelProvider implements ModelProvider {
  readonly #client: OpenAI;
  readonly #fastModel: string;
  readonly #visionModel: string;
  readonly #transcriptionModel: string;
  readonly #embeddingModel: string;

  constructor(options: { apiKey: string; fastModel: string; visionModel: string; transcriptionModel: string; embeddingModel: string }) {
    this.#client = new OpenAI({ apiKey: options.apiKey });
    this.#fastModel = options.fastModel;
    this.#visionModel = options.visionModel;
    this.#transcriptionModel = options.transcriptionModel;
    this.#embeddingModel = options.embeddingModel;
  }

  async embedText(text: string) {
    const started = performance.now();
    const response = await this.#client.embeddings.create({ model: this.#embeddingModel, input: text, dimensions: 1536 });
    const value = response.data[0]?.embedding;
    if (!value || value.length !== 1536 || value.some((item) => !Number.isFinite(item))) throw new Error("invalid embedding response");
    return { value, meta: {
      provider: "openai", model: this.#embeddingModel, promptVersion: "embedding.v1",
      schemaVersion: "embedding-1536.v1", latencyMs: Math.round(performance.now() - started),
      inputTokens: response.usage.prompt_tokens, outputTokens: 0, uncertaintyCount: 0,
    }};
  }

  async transcribeAudio(data: Uint8Array, mimeType: string) {
    const started = performance.now();
    const extension = mimeType === "audio/mp4" ? "mp4" : "m4a";
    const response = await this.#client.audio.transcriptions.create({
      model: this.#transcriptionModel,
      file: new File([
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
      ], `capture.${extension}`, { type: mimeType }),
    });
    return { value: response.text, meta: {
      provider: "openai", model: this.#transcriptionModel, promptVersion: "audio-transcription.v1",
      schemaVersion: "transcript.v1", latencyMs: Math.round(performance.now() - started),
      inputTokens: null, outputTokens: null, uncertaintyCount: 0,
    }};
  }

  async extractArtifact(input: ArtifactInput) {
    const started = performance.now();
    const model = input.imageDataUrl ? this.#visionModel : this.#fastModel;
    const userText = JSON.stringify({
      source_type: input.sourceType,
      source_coverage: input.sourceCoverage,
      canonical_url: input.canonicalUrl,
      supplied_text: input.normalizedText,
      user_note: input.userNote,
    });
    const content: OpenAI.Responses.ResponseInputContent[] = [{ type: "input_text", text: userText }];
    if (input.imageDataUrl) content.push({ type: "input_image", image_url: input.imageDataUrl, detail: "auto" });
    const response = await this.#client.responses.parse({
      model,
      store: false,
      input: [{ role: "system", content: artifactExtractionPrompt }, { role: "user", content }],
      text: { format: zodTextFormat(artifactExtractionSchema as never, "artifact_extraction") },
    });
    const value = artifactExtractionSchema.parse(response.output_parsed);
    return { value, meta: {
      provider: "openai", model, promptVersion: promptVersions.artifactExtraction,
      schemaVersion: "artifact-extraction.v1", latencyMs: Math.round(performance.now() - started),
      inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null,
      uncertaintyCount: value.uncertainties.length,
    }};
  }

  async generateImmediateResponse(input: ImmediateResponseInput) {
    const started = performance.now();
    const model = this.#fastModel;
    const response = await this.#client.responses.parse({
      model,
      store: false,
      input: [
        { role: "system", content: immediateResponsePrompt },
        { role: "user", content: JSON.stringify({ source_type: input.sourceType, source_coverage: input.sourceCoverage, canonical_url: input.canonicalUrl, user_note: input.userNote, explicit_request: input.explicitRequest, extraction: input.extraction }) },
      ],
      text: { format: zodTextFormat(immediateResponseSchema as never, "immediate_response") },
    });
    const value = immediateResponseSchema.parse(response.output_parsed);
    return { value, meta: {
      provider: "openai", model, promptVersion: promptVersions.immediateResponse,
      schemaVersion: "immediate-response.v1", latencyMs: Math.round(performance.now() - started),
      inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null,
      uncertaintyCount: input.extraction.uncertainties.length,
    }};
  }

  async generatePatternCandidate(input: PatternCandidateInput) {
    const started = performance.now();
    const response = await this.#client.responses.parse({
      model: this.#fastModel,
      store: false,
      input: [
        { role: "system", content: patternCandidatePrompt },
        { role: "user", content: JSON.stringify(input) },
      ],
      text: { format: zodTextFormat(patternCandidateSchema as never, "pattern_candidate") },
    });
    const value = patternCandidateSchema.parse(response.output_parsed);
    return { value, meta: {
      provider: "openai", model: this.#fastModel, promptVersion: promptVersions.patternCandidate,
      schemaVersion: "pattern-candidate.v1", latencyMs: Math.round(performance.now() - started),
      inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null,
      uncertaintyCount: value.alternative_explanations.length,
    }};
  }

  async compileSignals(input: SignalCompilationInput) {
    const started = performance.now();
    const response = await this.#client.responses.parse({
      model: this.#fastModel,
      store: false,
      input: [
        { role: "system", content: getPrompt("signal_compilation").text },
        {
          role: "user",
          content: JSON.stringify({
            artifact: {
              artifact_id: input.artifactId,
              source_type: input.sourceType,
              source_coverage: input.sourceCoverage,
              canonical_url: input.canonicalUrl,
              user_note: input.userNote,
            },
            segments: input.evidenceSegments,
          }),
        },
      ],
      text: { format: zodTextFormat(signalCompilationSchema as never, "signal_compilation") },
    });
    const value = signalCompilationSchema.parse(response.output_parsed);
    return { value, meta: {
      provider: "openai", model: this.#fastModel, promptVersion: promptVersions.signalCompilation,
      schemaVersion: "signal-compilation.v1", latencyMs: Math.round(performance.now() - started),
      inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null,
      uncertaintyCount: value.signals.filter((signal) => signal.uncertainty !== null).length,
    }};
  }
}
