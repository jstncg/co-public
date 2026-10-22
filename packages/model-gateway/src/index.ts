export type {
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
  WebSearchSource,
  EvidenceItem,
  AuthorityRules,
  Register,
  WhyQuestion,
} from "./provider";
export { OpenAIProvider, ValidationError, OpenAIRequestError, compileArtifactContext, type OpenAIEnv } from "./openai";
export { MockProvider } from "./mock";
// merged 2026-07-27: NOT the same class. Both trees wrote a mock provider, but each returns canned
// outputs shaped for its own pipeline — aliasing them made codex's processing tests fail_safe.
export { MockModelProvider } from "./mock-model-provider";
export { loadPricingTable, estimateCost, makeCostRecord, type ModelCostRecord, type PricingTable, type CostSink } from "./costs";

import type { ModelProvider } from "./provider";
import { OpenAIProvider, type OpenAIEnv } from "./openai";
import { MockProvider } from "./mock";
import type { CostSink } from "./costs";

/** mock when OPENAI_API_KEY absent — demo/test mode is always available. */
export function makeProvider(
  env: Record<string, string | undefined> = process.env,
  opts: { onCost?: CostSink; fetchImpl?: typeof fetch } = {},
): ModelProvider {
  if (!env.OPENAI_API_KEY) return new MockProvider();
  for (const key of ["MODEL_FAST", "MODEL_REASONING", "MODEL_EMBEDDING"] as const) {
    if (!env[key]) throw new Error(`${key} env var required when OPENAI_API_KEY is set (model names are never hardcoded)`);
  }
  return new OpenAIProvider(env as unknown as OpenAIEnv, opts);
}

// merged 2026-07-27: codex modules pulled into this package need exporting too.
export * from "./factory";
// 2026-07-29: two ModelProvider interfaces exist (mine: provider.ts, codex's: types.ts) for two
// different pipelines. The wildcard export made TS pick one silently. Codex's is now explicit:
export type { ModelProvider as PipelineModelProvider, ModelResult, ArtifactInput as PipelineArtifactInput, ImmediateResponseInput as PipelineImmediateResponseInput, PatternCandidateInput as PipelinePatternCandidateInput, SignalCompilationInput as PipelineSignalCompilationInput } from "./types";
export * from "./web-search";

// 2026-07-29: codex's full provider (transcribeAudio/embedText/patternCandidate) is its own
// module — the alias-to-mine broke the factory at build time. Same lesson as the mock split.
export { OpenAIModelProvider } from "./openai-model-provider";
