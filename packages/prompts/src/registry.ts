import type { PromptDef, PromptId } from "./types";
import { artifact_extraction } from "./prompts/artifact_extraction";
import { immediate_response } from "./prompts/immediate_response";
import { why_question } from "./prompts/why_question";
import { memory_update } from "./prompts/memory_update";
import { pattern_candidate } from "./prompts/pattern_candidate";
import { radar_assessment } from "./prompts/radar_assessment";
import { move_plan } from "./prompts/move_plan";
import { outcome_update } from "./prompts/outcome_update";
import { signal_compilation } from "./prompts/signal_compilation";

// append-only version history per id; last entry is latest. never edit a shipped version in place.
const REGISTRY: Record<PromptId, PromptDef[]> = {
  artifact_extraction: [artifact_extraction],
  immediate_response: [immediate_response],
  why_question: [why_question],
  memory_update: [memory_update],
  pattern_candidate: [pattern_candidate],
  radar_assessment: [radar_assessment],
  move_plan: [move_plan],
  outcome_update: [outcome_update],
  signal_compilation: [signal_compilation],
};

export function getPrompt(id: PromptId): PromptDef {
  const versions = REGISTRY[id];
  const latest = versions[versions.length - 1];
  if (!latest) throw new Error(`no prompt registered for id: ${id}`);
  return latest;
}

export function getPromptVersion(id: PromptId, version: string): PromptDef {
  const found = REGISTRY[id].find((p) => p.version === version);
  if (!found) throw new Error(`no prompt ${id}@${version}`);
  return found;
}

export function allPrompts(): PromptDef[] {
  return Object.values(REGISTRY).flat();
}
