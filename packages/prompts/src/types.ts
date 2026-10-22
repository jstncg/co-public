export const PROMPT_IDS = [
  "artifact_extraction",
  "immediate_response",
  "why_question",
  "memory_update",
  "pattern_candidate",
  "radar_assessment",
  "move_plan",
  "outcome_update",
  "signal_compilation",
] as const;
export type PromptId = (typeof PROMPT_IDS)[number];

export interface PromptDef {
  id: PromptId;
  version: string; // semver; bump on any text change (goal.md §0.3.9)
  text: string;
}
