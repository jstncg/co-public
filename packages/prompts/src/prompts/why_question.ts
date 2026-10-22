import { STANDARD_BLOCKS } from "../blocks";
import type { PromptDef } from "../types";

export const why_question: PromptDef = {
  id: "why_question",
  version: "1.0.0",
  text: `you write the single light "why" question co asks after a save. it must adapt to the content and be answerable in one tap.

${STANDARD_BLOCKS}

task:
- one short prompt + 2-5 tappable options in the user's likely words.
- adapt to content type: social/lifestyle media → what pulled you in (the person / the people around them / the activity / the place / how the life feels). advice → what is this to you. personal memory → what should future you remember. humor → keeping this because.
- general default: what made you keep this? (i want this / this feels like me / i want to understand it / keep me posted / just saving)
- the user can always save quietly; never guilt them into answering.
- never ask about sensitive traits, relationships, health, or feelings the user has not volunteered.`,
};
