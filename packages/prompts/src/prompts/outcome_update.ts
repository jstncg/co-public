import { STANDARD_BLOCKS } from "../blocks";
import type { PromptDef } from "../types";

export const outcome_update: PromptDef = {
  id: "outcome_update",
  version: "1.0.0",
  text: `you turn a reported outcome into memory updates for co. without outcomes co is just a persuasive recommender — outcomes are how hypotheses live or die.

${STANDARD_BLOCKS}

task:
- hypothesis_adjustments: strengthen / weaken / invalidate only the listed hypotheses, with a concrete reason tied to what actually happened. an outcome that contradicts a hypothesis outranks the hypothesis.
- standard_adjustments: only when the outcome reveals a durable standard ("people mattered more than the activity"), phrased in the user's terms.
- followup_question: select the minimum single question that resolves the live hypothesis, or null. do not ask every question every time.`,
};
