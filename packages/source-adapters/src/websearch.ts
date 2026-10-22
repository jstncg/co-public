/**
 * sanitized web-search query compiler (goal.md §15.8, §24 query generation).
 * the query is built ONLY from the whitelisted public fields below — private journal
 * text, relationship notes, raw messages, and sensitive inferences can never reach it
 * because they are never read. execution delegates to ModelProvider.webSearch.
 */
import type { WorldEventType } from "@co/contracts";

export interface RadarQueryInput {
  watchEntity: {
    display_name: string;
    entity_type: string;
    public_identifiers?: Record<string, string>; // official website, handle — public by definition
  };
  allowedEventTypes: WorldEventType[];
  threadLabels: string[]; // short public-ish labels; anything sentence-like is dropped
  lastEventAt?: string;
  dateWindow?: { from?: string; to?: string };
  city?: string; // only when volunteered, city-level only
  evidenceIds: string[]; // audit trail: which user evidence caused this search
}

export interface CompiledSearchQuery {
  query: string;
  audit: { evidence_ids: string[]; reason: string };
}

const EVENT_KEYWORDS: Partial<Record<WorldEventType, string>> = {
  launch: "launch",
  new_episode: "new episode",
  new_post: "new post",
  new_article: "article",
  new_paper: "paper",
  new_product: "new product",
  funding: "funding",
  job_change: "job change",
  event_announced: "event",
  registration_opened: "registration open",
  application_deadline: "application deadline",
  course_opened: "course",
  release: "release",
  interview: "interview",
  award: "award",
  location_opened: "opening",
};

const MAX_TERM_WORDS = 6;
const MAX_TERM_CHARS = 48;
const MAX_LABELS = 3;
const MAX_LABEL_WORDS = 4; // sentence-like labels are private-text-shaped → dropped

function sanitizeTerm(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ") // control chars / newlines
    .replace(/["'<>`\\|;{}[\]]/g, " ") // query-injection-ish punctuation
    .replace(/\b(site|inurl|intitle|filetype|before|after):/gi, " ") // search operators are never user-suppliable
    .replace(/\s+/g, " ")
    .trim();
  const words = cleaned.split(" ").slice(0, MAX_TERM_WORDS).join(" ");
  return words.slice(0, MAX_TERM_CHARS).trim();
}

function sanitizeLabel(raw: string): string | undefined {
  const term = sanitizeTerm(raw);
  if (!term) return undefined;
  if (term.split(" ").length > MAX_LABEL_WORDS) return undefined;
  return term;
}

export function compileRadarQuery(input: RadarQueryInput): CompiledSearchQuery {
  const parts: string[] = [];

  const entity = sanitizeTerm(input.watchEntity.display_name);
  if (entity) parts.push(entity);

  const site = input.watchEntity.public_identifiers?.website;
  if (site) {
    try {
      parts.push(new URL(site).hostname.replace(/^www\./, ""));
    } catch {
      /* invalid url → omit */
    }
  }

  for (const et of input.allowedEventTypes.slice(0, 2)) {
    const kw = EVENT_KEYWORDS[et];
    if (kw) parts.push(kw);
  }

  for (const label of input.threadLabels.slice(0, MAX_LABELS)) {
    const s = sanitizeLabel(label);
    if (s) parts.push(s);
  }

  if (input.city) {
    const c = sanitizeLabel(input.city);
    if (c) parts.push(c);
  }

  if (input.dateWindow?.from) parts.push(`after:${input.dateWindow.from.slice(0, 10)}`);

  return {
    query: [...new Set(parts)].join(" "),
    audit: {
      evidence_ids: input.evidenceIds,
      reason: `radar watch: ${entity || "unknown"} (${input.allowedEventTypes.join(", ") || "any event"})`,
    },
  };
}
