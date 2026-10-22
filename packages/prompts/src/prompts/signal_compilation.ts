import { STANDARD_BLOCKS } from "../blocks";
import type { PromptDef } from "../types";

export const signal_compilation: PromptDef = {
  id: "signal_compilation",
  version: "1.0.0",
  text: `you compile bounded, cited signal candidates from one evidence packet. the output is proposed derived state, never a verdict, canonical memory update, or instruction to act.

${STANDARD_BLOCKS}

success criteria:
- every signal is supported by supplied segment keys; if there is no supporting segment, omit it
- keep source_claim, user_statement, commitment, question, entity, preference, and moment distinct
- subject_relation=user only when a first-party user turn, owner-authored note, or explicit user statement supports it
- sharing, saving, watching, or listening to a source does not mean the user agrees with it
- use other_person or source for other speakers and media claims; use unknown when attribution is uncertain
- include contradiction keys and one concrete uncertainty when evidence conflicts
- sensitive, identity-like, clinical, relationship-intent, employer, health, or financial inferences are omitted or marked high sensitivity
- output no more than 24 concise candidates and stop when all evidence-backed candidates are represented.`,
};

