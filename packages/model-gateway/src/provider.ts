/**
 * ModelProvider — provider-neutral interface per goal.md §22.1.
 * inputs are COMPILED task context (§22.5): the current artifact + selected evidence +
 * relevant standards + authority rules. never the whole life.
 */
import { z } from "zod";
import type {
  ArtifactExtraction,
  ImmediateResponse,
  MemoryUpdate,
  PatternCandidate,
  RadarAssessment,
  MovePlan,
  OutcomeUpdate,
  SourceType,
  Coverage,
  MoveType,
  WorldEventType,
} from "@co/contracts";
import { WhyQuestion as WhyQuestionSchema } from "@co/contracts";

export type WhyQuestion = z.infer<typeof WhyQuestionSchema>;
export type Register = "direct" | "warm" | "neutral";

/** one piece of cited evidence — ids are db uuids so outputs can reference receipts. */
export interface EvidenceItem {
  id: string;
  kind: "artifact" | "observation" | "annotation" | "outcome";
  statement: string;
  occurred_at?: string; // iso8601
  source_type?: SourceType;
}

export interface AuthorityRules {
  requires_user_final_action: true; // v1 invariant
  allowed_move_types: MoveType[];
}

/** compiled context for one artifact (§22.5) — the base unit most calls carry. */
export interface ArtifactInput {
  source_type: SourceType;
  coverage: Coverage; // what co actually has — prompts forbid inventing access beyond this
  raw_text?: string;
  transcript?: string;
  metadata?: Record<string, string | number | boolean | null>; // title/publisher/url/duration…
  user_note?: string;
  why_annotation?: string;
  thread_summary?: string;
  evidence?: EvidenceItem[];
  standards?: string[]; // relevant standards only, pre-selected
  authority?: AuthorityRules;
}

export interface ImmediateResponseInput {
  artifact: ArtifactInput;
  extraction: ArtifactExtraction;
  register: Register;
}

export interface WhyQuestionInput {
  artifact: ArtifactInput;
  extraction: ArtifactExtraction;
}

export interface MemoryUpdateInput {
  artifact: ArtifactInput;
  extraction: ArtifactExtraction;
  existing_observations: EvidenceItem[]; // candidates for invalidation, cited by id
  active_threads: { title: string; summary?: string }[];
}

export interface PatternInput {
  evidence: EvidenceItem[];
  contradicting_evidence?: EvidenceItem[];
  thread_summary?: string;
  known_patterns?: string[]; // already-stated patterns — duplicates must be rejected
}

export interface RadarRankInput {
  watch: {
    display_name: string;
    entity_type: string;
    relationship_note?: string;
    desired_event_types: WorldEventType[];
    excluded_event_types: WorldEventType[];
  };
  event: {
    event_type: WorldEventType;
    title: string;
    summary?: string;
    source_url: string;
    source_published_at?: string;
  };
  user_evidence: EvidenceItem[]; // explicit evidence only — why_user must cite from here
  previously_sent_summaries?: string[]; // redundancy check
}

export interface MoveInput {
  origin: "artifact" | "pattern" | "radar";
  context: string; // compiled description of what prompted the move
  desired_move_type?: MoveType;
  evidence: EvidenceItem[];
  authority: AuthorityRules;
}

export interface OutcomeInput {
  move: { move_type: MoveType; title: string };
  outcome: {
    action_taken?: string;
    result?: string;
    value_rating?: string;
    surprise_rating?: string;
    social_response?: string;
    would_repeat?: boolean;
  };
  hypotheses: { id: string; statement: string; confidence: number }[];
}

export interface WebSearchInput {
  query: string; // MUST be a sanitized query from the query compiler — never raw personal context
  date_window?: { from?: string; to?: string };
  site_constraints?: string[];
  max_results?: number;
}
export interface WebSearchSource {
  url: string;
  title: string;
  snippet?: string;
  published_at?: string;
}
export interface WebSearchResult {
  sources: WebSearchSource[]; // visible, citable receipts — mandatory in ui
  summary?: string | undefined;
}

export interface ModelProvider {
  extractArtifact(input: ArtifactInput): Promise<ArtifactExtraction>;
  generateImmediateResponse(input: ImmediateResponseInput): Promise<ImmediateResponse>;
  proposeWhyQuestion(input: WhyQuestionInput): Promise<WhyQuestion>;
  updateMemory(input: MemoryUpdateInput): Promise<MemoryUpdate>;
  proposePatterns(input: PatternInput): Promise<PatternCandidate[]>;
  rankRadar(input: RadarRankInput): Promise<RadarAssessment>;
  planMove(input: MoveInput): Promise<MovePlan>;
  evaluateOutcome(input: OutcomeInput): Promise<OutcomeUpdate>;
  embed(texts: string[]): Promise<number[][]>;
  webSearch?(input: WebSearchInput): Promise<WebSearchResult>;
}
