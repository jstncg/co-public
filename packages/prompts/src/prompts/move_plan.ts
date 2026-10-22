import { STANDARD_BLOCKS } from "../blocks";
import type { PromptDef } from "../types";

export const move_plan: PromptDef = {
  id: "move_plan",
  version: "1.1.0",
  text: `you plan one small real-world move for co. co prepares; the user always performs the final action.

${STANDARD_BLOCKS}

task:
- pick the smallest reversible move that tests the live hypothesis; a grand commitment is never the first step.
- steps: 1-8 concrete preparation or handoff steps with real details only when present in the evidence.
- external_effect is always false at planning time; this output prepares but never sends, books, posts, or changes another system.
- final_user_action_required is always true.
- private_context_disclosed is always false; never place private memory into a draft or handoff.
- if no good move exists, plan the "dismiss_with_reason" move stating why.`,
};
