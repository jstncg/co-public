import type { ArtifactExtraction, EvidenceSegment, ImmediateResponse, PatternCandidate, SignalCompilation } from "@co/contracts";

export type ArtifactInput = {
  artifactId: string;
  sourceType: string;
  sourceCoverage: "full_media" | "image" | "text" | "url_only" | "unavailable";
  normalizedText: string | null;
  canonicalUrl: string | null;
  userNote: string | null;
  imageDataUrl?: string;
  evidenceSegments?: EvidenceSegment[];
};

export type ImmediateResponseInput = ArtifactInput & {
  extraction: ArtifactExtraction;
  explicitRequest: "summary" | "react" | "save" | "none";
};

export type ModelCallMeta = {
  provider: string;
  model: string;
  promptVersion: string;
  schemaVersion: string;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  uncertaintyCount: number;
};

export type ModelResult<T> = { value: T; meta: ModelCallMeta };

export type PatternCandidateInput = {
  evidence: Array<{ artifactId: string; statement: string; observationType: string; capturedAt: string }>;
};

export type SignalCompilationInput = ArtifactInput & {
  evidenceSegments: EvidenceSegment[];
};

export interface ModelProvider {
  transcribeAudio(data: Uint8Array, mimeType: string): Promise<ModelResult<string>>;
  embedText(text: string): Promise<ModelResult<number[]>>;
  extractArtifact(input: ArtifactInput): Promise<ModelResult<ArtifactExtraction>>;
  generateImmediateResponse(input: ImmediateResponseInput): Promise<ModelResult<ImmediateResponse>>;
  generatePatternCandidate(input: PatternCandidateInput): Promise<ModelResult<PatternCandidate>>;
  compileSignals?(input: SignalCompilationInput): Promise<ModelResult<SignalCompilation>>;
}
