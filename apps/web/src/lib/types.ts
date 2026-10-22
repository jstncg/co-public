// typed stubs for the founder console (goal.md §28.4, §31).
// real data arrives via server routes once the backend exists.
// BLOCKED: supabase project.

export interface WeeklyMetric {
  id: string;
  label: string;
  /** null = not measurable yet (no users, no pipeline) — shown honestly as "—" */
  value: number | null;
  unit: "%" | "count" | "usd" | null;
}

export type ReviewKind = "pattern" | "radar";

export type Decision = "approved" | "edited" | "rejected" | "unsafe";

/** one card in the pattern / radar review queues (goal.md §31 mockup) */
export interface ReviewCandidate {
  id: string;
  kind: ReviewKind;
  /** pseudonymous label — raw identity never renders in the console */
  userLabel: string;
  /**
   * founder-review consent expiry (ISO date). the console must never allow
   * review of users without valid consent — expired cards render blocked.
   */
  consentActiveUntil: string;
  statement: string;
  evidence: string[];
  alternatives: string[];
  confidence: number;
  proposedMove: string | null;
}

export interface DecidedCandidate extends ReviewCandidate {
  decision: Decision;
  editedStatement?: string;
}

export interface AdapterFailure {
  adapter: string;
  target: string;
  error: string;
  failedAt: string;
  consecutiveFailures: number;
}

export interface JobFailure {
  task: string;
  runId: string;
  error: string;
  failedAt: string;
  retries: number;
}

export interface PrivacyRequest {
  id: string;
  kind: "deletion" | "export";
  userLabel: string;
  requestedAt: string;
  status: "queued" | "running" | "done" | "verified";
}

/** cost dashboard row — records by task (goal.md §25.6) */
export interface ModelCostRow {
  provider: string;
  model: string;
  feature: string;
  tokens: number;
  searchCalls: number;
  transcriptionMinutes: number;
  latencyMsP50: number;
  estimatedCostUsd: number;
  userLabel: string;
}
