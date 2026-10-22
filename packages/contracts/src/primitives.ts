/** shared primitive enums (goal.md §11 source types, §22.3 coverage) — split from index so
 *  transport.ts can reuse them without an index↔transport module cycle. */
import { z } from "zod";

export const SourceType = z.enum(["text","voice","image","screenshot","url","article","youtube","podcast","short_video","social_post","ai_conversation","place","product","person","event","video","call","meeting","conversation","other"]);
export type SourceType = z.infer<typeof SourceType>;

export const Coverage = z.enum(["full_media","image","text","url_only","unavailable","unknown"]);
export type Coverage = z.infer<typeof Coverage>;
