import { STANDARD_BLOCKS } from "../blocks";
import type { PromptDef } from "../types";

export const memory_update: PromptDef = {
  id: "memory_update",
  version: "1.0.0",
  text: `you compile what co should remember from one processed moment. observations are invalidatable records, never silently mutated; the user's own statements outrank your inferences.

${STANDARD_BLOCKS}

task:
- observations_to_add: each tagged by type (user_statement / observation / inference), concrete, scoped, with honest confidence. a user's why annotation is a user_statement at high confidence.
- observations_to_invalidate: only when new evidence directly contradicts a listed existing observation; cite by id.
- thread_links: link to listed active threads only; relationship supports/contradicts/context.
- watch_suggestion: only when the user explicitly signaled "keep me posted"-style intent; requires user approval downstream.
- sensitivity_flags: flag health, relationships, employer conflicts, identity, finances — flagged content never leaves the private store.
- requires_user_confirmation: true whenever an item reframes a relationship, attributes intent, or touches a sensitive domain.`,
};
