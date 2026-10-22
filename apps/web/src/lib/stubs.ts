// deterministic stub data. review candidates come from the seeded demo
// journeys (goal.md §37) so the console renders realistically before the
// backend exists. metrics are zeroed — no invented numbers.

import type {
  AdapterFailure,
  JobFailure,
  ModelCostRow,
  PrivacyRequest,
  ReviewCandidate,
  WeeklyMetric,
} from "./types";

/** goal.md §28.4 — the ten weekly dashboard numbers, in order */
export const weeklyMetrics: WeeklyMetric[] = [
  { id: "activation", label: "activation rate", value: null, unit: "%" },
  { id: "habit", label: "three-day save habit", value: null, unit: "%" },
  { id: "pattern-to-move", label: "pattern-to-move rate", value: null, unit: "%" },
  { id: "retention-w4", label: "week-four retention", value: null, unit: "%" },
  { id: "radar-useful", label: "radar useful/action rate", value: null, unit: "%" },
  { id: "mute-rate", label: "notification mute rate", value: null, unit: "%" },
  { id: "founder-edit", label: "founder edit/reject rate", value: null, unit: "%" },
  { id: "model-cost", label: "average model cost per active user", value: null, unit: "usd" },
  { id: "privacy-requests", label: "deletion/export requests", value: 0, unit: "count" },
  { id: "advocacy", label: "organic advocacy", value: 0, unit: "count" },
];

/** pattern candidates — maya + sam journeys (§37, §31 card shape) */
export const patternCandidates: ReviewCandidate[] = [
  {
    id: "pat-maya-room",
    kind: "pattern",
    userLabel: "user 0001 (maya · demo)",
    consentActiveUntil: "2026-09-12",
    statement: "the user may want a recurring creative room.",
    evidence: [
      "pottery reel — “the people mattered more than the pottery”",
      "communal dinner screenshot",
      "book-club post",
      "third-place youtube timestamp (12:34)",
      "voice note — “everyone i find interesting makes something”",
    ],
    alternatives: [
      "the aesthetic",
      "a broader desire for new friends",
      "nostalgia for being a beginner",
    ],
    confidence: 0.74,
    proposedMove: "six-week ceramics course",
  },
  {
    id: "pat-sam-running",
    kind: "pattern",
    userLabel: "user 0004 (sam · demo)",
    consentActiveUntil: "2026-09-12",
    statement: "the user may want to take up running.",
    evidence: [
      "running post 1",
      "running post 2",
      "running post 3",
      "explicit note — “i like the photography, not running” (CONTRADICTS)",
    ],
    alternatives: ["the photography", "one photographer's feed"],
    confidence: 0.31,
    proposedMove: null,
  },
  {
    id: "pat-expired-consent",
    kind: "pattern",
    userLabel: "user 0009 (demo)",
    consentActiveUntil: "2026-05-01",
    statement: "(consent expired — content withheld)",
    evidence: [],
    alternatives: [],
    confidence: 0,
    proposedMove: null,
  },
];

/** radar candidates — alex + priya journeys (§37, §15.7 card shape) */
export const radarCandidates: ReviewCandidate[] = [
  {
    id: "rad-priya-andera",
    kind: "radar",
    userLabel: "user 0003 (priya · demo)",
    consentActiveUntil: "2026-09-12",
    statement: "andera launched today.",
    evidence: [
      "user explicitly asked co to watch andera",
      "note — “stay close to their work”",
      "source: public launch post · 2h ago",
    ],
    alternatives: ["not novel: user may have seen it on x already"],
    confidence: 0.9,
    proposedMove: "open source + draft congratulations",
  },
  {
    id: "rad-alex-systems",
    kind: "radar",
    userLabel: "user 0002 (alex · demo)",
    consentActiveUntil: "2026-09-12",
    statement: "“the rise of systems thinkers” episode just released.",
    evidence: [
      "user watches systems thinking podcasts",
      "relevant to 2 active threads",
      "source: podcast feed · 3h ago",
    ],
    alternatives: ["episode may be an ad-heavy rerun"],
    confidence: 0.66,
    proposedMove: "notify with timestamped save action",
  },
];

// ops / privacy / costs: honest empty placeholders — nothing has run yet.
export const adapterFailures: AdapterFailure[] = [];
export const jobFailures: JobFailure[] = [];
export const privacyRequests: PrivacyRequest[] = [];
export const modelCosts: ModelCostRow[] = [];
