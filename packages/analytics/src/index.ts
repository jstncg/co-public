/**
 * content-free analytics (goal.md §28/§29): event names from the §29 whitelist,
 * props categorical or identifiers only — raw content is rejected in code,
 * throws in dev so violations fail loudly, drops in prod so users never pay for our bugs.
 */
import { PRODUCT_EVENTS, type ProductEventName } from "@co/contracts";

export type AnalyticsValue = string | number | boolean | null;
export type AnalyticsProps = Record<string, AnalyticsValue>;

export interface AnalyticsSink {
  write(event: ProductEventName, props: AnalyticsProps): void | Promise<void>;
}

export class AnalyticsViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalyticsViolationError";
  }
}

const EVENT_SET: ReadonlySet<string> = new Set(PRODUCT_EVENTS);
const MAX_STRING_LENGTH = 80;
const MAX_WORDS = 5;

/** heuristic content detector: long strings or sentence-shaped strings are raw content, not categories. */
export function looksLikeRawContent(value: AnalyticsValue): boolean {
  if (typeof value !== "string") return false;
  if (value.length > MAX_STRING_LENGTH) return true;
  return value.trim().split(/\s+/).length > MAX_WORDS;
}

export interface TrackOptions {
  sink?: AnalyticsSink;
  /** defaults from NODE_ENV: throw in dev, drop in prod */
  mode?: "dev" | "prod";
}

function violation(mode: "dev" | "prod", message: string): false {
  if (mode === "dev") throw new AnalyticsViolationError(message);
  return false; // prod: drop silently — never crash the product over telemetry
}

export function validateEvent(event: string, props: AnalyticsProps, mode: "dev" | "prod"): boolean {
  if (!EVENT_SET.has(event)) return violation(mode, `unknown product event: ${event} (must be one of §29 whitelist)`);
  for (const [key, value] of Object.entries(props)) {
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return violation(mode, `prop ${key} must be a primitive (categorical or id), got ${typeof value}`);
    }
    if (looksLikeRawContent(value)) {
      return violation(mode, `prop ${key} looks like raw content (>${MAX_STRING_LENGTH} chars or >${MAX_WORDS} words) — analytics are content-free`);
    }
  }
  return true;
}

export function track(event: ProductEventName | string, props: AnalyticsProps = {}, opts: TrackOptions = {}): void {
  const mode = opts.mode ?? (process.env.NODE_ENV === "production" ? "prod" : "dev");
  if (!validateEvent(event, props, mode)) return;
  void opts.sink?.write(event as ProductEventName, props);
}

// merged 2026-07-29: codex's analytics module (recordProductEventName, weeklyMetrics, AnalyticsDatabase)
// shared this filename with a disjoint module of mine — the merge's file-list diff saw "same file,
// no conflict" and silently kept mine, which broke codex's events route at BUILD time. The lesson is
// recorded in harness-review: test-green is not build-green. Both modules were always compatible.
export * from "./events";
