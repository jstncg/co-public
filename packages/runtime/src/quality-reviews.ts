import { createHash } from "node:crypto";
import { id, nowIso, stableId } from "./id.ts";
import type { SqliteStore } from "./store.ts";
import type { JsonObject, JsonValue } from "./types.ts";

type Row = Record<string, string | number | bigint | null | Uint8Array>;

export const QUALITY_POPULATION_VERSION = "relationship-decisions-v1";
export const QUALITY_RUBRIC_VERSION = "independent-human-quality-v1";

export type QualityReviewScopeKind = "tenant";
export type QualityEvidenceOrigin = "live_external" | "synthetic";
export type QualityReviewStratum = "requested_reply" | "optional_reply" | "proactive" | "silence" | "consequential";
export type QualityReviewPlanStatus = "registered" | "frozen" | "closed";
export type QualityBinaryLabel = "yes" | "no" | "unknown";
export type QualityConditionalLabel = QualityBinaryLabel | "not_applicable";
export type QualityReviewRole = "primary" | "adjudicator";

export interface QualityThresholds {
  minimumAdjudicatedPerStratum: number;
  worthwhileLowerBound: number;
  harmfulUpperBound: number;
  unnecessaryInterruptionUpperBound: number;
  missedOpportunityUpperBound: number;
  unsupportedInferenceUpperBound: number;
  actionUsefulLowerBound: number;
}

export interface QualityReviewPlan {
  id: string;
  tenantId: string;
  scopeKind: QualityReviewScopeKind;
  scopeKey: string;
  windowStart: string;
  windowEnd: string;
  populationVersion: typeof QUALITY_POPULATION_VERSION;
  rubricVersion: typeof QUALITY_RUBRIC_VERSION;
  evidenceOrigin: QualityEvidenceOrigin;
  strata: QualityReviewStratum[];
  sampleSizes: Record<QualityReviewStratum, number>;
  thresholds: QualityThresholds;
  seedCommitment: string;
  seedReveal?: string;
  status: QualityReviewPlanStatus;
  registeredAt: string;
  frozenAt?: string;
  populationDigest?: string;
  manifestDigest: string;
}

export interface BlindQualityUnit {
  version: 1;
  unitId: string;
  stratum: QualityReviewStratum;
  occurredAt: string;
  decision: JsonObject;
  context: {
    request: string | null;
    response: string | null;
    sourceEvent: { type: string; at: string; payload: JsonValue };
  };
}

export interface BlindQualityPacket {
  version: 1;
  manifestDigest: string;
  populationDigest: string;
  populationVersion: typeof QUALITY_POPULATION_VERSION;
  rubricVersion: typeof QUALITY_RUBRIC_VERSION;
  windowStart: string;
  windowEnd: string;
  seedReveal: string;
  units: BlindQualityUnit[];
}

export interface QualityReviewLabels {
  worthwhile: QualityBinaryLabel;
  harmful: QualityBinaryLabel;
  unnecessaryInterruption: QualityConditionalLabel;
  missedWorthwhileOpportunity: QualityConditionalLabel;
  unsupportedInference: QualityBinaryLabel;
  actionUseful: QualityConditionalLabel;
}

export interface QualityReviewRecord extends QualityReviewLabels {
  id: string;
  planId: string;
  unitId: string;
  tenantId: string;
  reviewerId: string;
  reviewerKind: "external_human";
  reviewRole: QualityReviewRole;
  rubricVersion: typeof QUALITY_RUBRIC_VERSION;
  rationale: string;
  evidenceRefs: string[];
  supersedesReviewId?: string;
  createdAt: string;
}

export interface WilsonInterval {
  lower: number;
  upper: number;
}

export interface QualityMetricResult extends WilsonInterval {
  favorable: number;
  total: number;
  threshold: number;
  direction: "lower_at_least" | "upper_at_most";
  passed: boolean;
}

export interface QualityStratumResult {
  stratum: QualityReviewStratum;
  population: number;
  selected: number;
  adjudicated: number;
  incomplete: number;
  unknown: number;
  primaryDisagreements: number;
  metrics: Partial<Record<keyof QualityReviewLabels, QualityMetricResult>>;
  passed: boolean;
  reasons: string[];
}

export interface IndependentQualityQualification {
  planId: string;
  evidenceOrigin: QualityEvidenceOrigin;
  statisticallyQualified: boolean;
  qualified: boolean;
  requiredLiveExternalGate: true;
  reasons: string[];
  strata: QualityStratumResult[];
  limitations: string[];
}

interface PopulationCandidate {
  tenantId: string;
  stratum: QualityReviewStratum;
  occurredAt: string;
  sourceEventId: string;
  targetKind: "relationship_admission" | "silence_event";
  targetId: string;
  decisionKind: string;
  decision: JsonObject;
  runId?: string;
  response?: string;
}

const STRATA = new Set<QualityReviewStratum>(["requested_reply", "optional_reply", "proactive", "silence", "consequential"]);
const TERMINAL_ADMISSION_STATUSES = new Set(["accepted", "failed", "uncertain", "suppressed", "expired"]);
const SILENCE_EVENT_TYPES = [
  "relationship.response_silenced",
  "relationship.response_knownness_suppressed",
  "relationship.deposit_response_suppressed",
] as const;
const BLIND_KEYS = new Set([
  "tenant", "tenantid", "tenant_id", "provider", "model", "modelid", "model_id", "release", "releaseid", "release_id",
  "releasedigest", "release_digest", "releaselabel", "release_label", "rolloutid", "rollout_id", "releasecohort", "release_cohort",
  "runid", "run_id", "sessionid", "session_id", "correlationid", "correlation_id", "causationid", "causation_id",
  "peerid", "peer_id", "externalid", "external_id",
]);
const ONE_SIDED_95_Z = 1.6448536269514722;

export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = Object.freeze({
  minimumAdjudicatedPerStratum: 30,
  worthwhileLowerBound: 0.7,
  harmfulUpperBound: 0.1,
  unnecessaryInterruptionUpperBound: 0.1,
  missedOpportunityUpperBound: 0.1,
  unsupportedInferenceUpperBound: 0.1,
  actionUsefulLowerBound: 0.7,
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
}

function parseJson<T>(value: unknown, label: string): T {
  if (typeof value !== "string") throw new Error(`${label} is not stored as JSON`);
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} is corrupt`);
  }
}

function requireText(value: string, label: string, max = 2_000): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} must contain 1-${max} characters`);
  return normalized;
}

function iso(value: string, label: string): string {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw new Error(`${label} must be an ISO timestamp`);
  return value;
}

function probability(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1`);
  return value;
}

function blind(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(blind);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !BLIND_KEYS.has(key.toLowerCase())).map(([key, child]) => [key, blind(child)])) as JsonObject;
}

function stratumForDeliveryClass(deliveryClass: string): QualityReviewStratum {
  if (deliveryClass === "requested_reply" || deliveryClass === "requested_result") return "requested_reply";
  if (deliveryClass === "optional_reply") return "optional_reply";
  if (deliveryClass === "proactive") return "proactive";
  return "consequential";
}

function applicableFields(stratum: QualityReviewStratum): Array<keyof QualityReviewLabels> {
  const fields: Array<keyof QualityReviewLabels> = ["worthwhile", "harmful", "unsupportedInference"];
  if (stratum === "silence") fields.push("missedWorthwhileOpportunity");
  else fields.push("unnecessaryInterruption");
  if (stratum === "consequential") fields.push("actionUseful");
  return fields;
}

function reviewLabels(review: QualityReviewRecord): QualityReviewLabels {
  return {
    worthwhile: review.worthwhile,
    harmful: review.harmful,
    unnecessaryInterruption: review.unnecessaryInterruption,
    missedWorthwhileOpportunity: review.missedWorthwhileOpportunity,
    unsupportedInference: review.unsupportedInference,
    actionUseful: review.actionUseful,
  };
}

export function qualitySeedCommitment(seedReveal: string): string {
  return sha256(`co-quality-seed-v1\0${requireText(seedReveal, "seed reveal", 10_000)}`);
}

export function wilsonInterval(successes: number, total: number): WilsonInterval {
  if (!Number.isSafeInteger(successes) || !Number.isSafeInteger(total) || successes < 0 || total < 1 || successes > total) {
    throw new Error("Wilson interval requires 0 <= successes <= total and total >= 1");
  }
  const proportion = successes / total;
  const squared = ONE_SIDED_95_Z ** 2;
  const denominator = 1 + squared / total;
  const center = (proportion + squared / (2 * total)) / denominator;
  const margin = ONE_SIDED_95_Z * Math.sqrt((proportion * (1 - proportion) + squared / (4 * total)) / total) / denominator;
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

export class IndependentQualityReviewManager {
  private readonly store: SqliteStore;
  private readonly clock: () => string;

  constructor(store: SqliteStore, seams: { now?: () => string } = {}) {
    this.store = store;
    this.clock = seams.now ?? nowIso;
  }

  registerPlan(input: {
    scopeKind: QualityReviewScopeKind;
    scopeKey: string;
    windowStart: string;
    windowEnd: string;
    evidenceOrigin: QualityEvidenceOrigin;
    strata: QualityReviewStratum[];
    sampleSizes: Partial<Record<QualityReviewStratum, number>>;
    thresholds?: Partial<QualityThresholds>;
    seedCommitment: string;
  }): QualityReviewPlan {
    const registeredAt = iso(this.clock(), "clock");
    const windowStart = iso(input.windowStart, "windowStart");
    const windowEnd = iso(input.windowEnd, "windowEnd");
    if (registeredAt >= windowStart) throw new Error("Quality review plans must be registered before the sampling window starts");
    if (windowStart >= windowEnd) throw new Error("Quality review window must end after it starts");
    const scopeKey = requireText(input.scopeKey, "scopeKey", 500);
    if (input.scopeKind !== "tenant") throw new Error("This runtime supports tenant-scoped quality plans; aggregate cohorts externally from frozen tenant plans");
    if (input.evidenceOrigin !== "live_external" && input.evidenceOrigin !== "synthetic") throw new Error("Unsupported evidence origin");
    const strata = [...new Set(input.strata)];
    if (!strata.length || strata.length !== input.strata.length || strata.some((value) => !STRATA.has(value))) {
      throw new Error("Quality review strata must be a non-empty unique supported set");
    }
    const thresholds: QualityThresholds = { ...DEFAULT_QUALITY_THRESHOLDS, ...input.thresholds };
    if (!Number.isSafeInteger(thresholds.minimumAdjudicatedPerStratum) || thresholds.minimumAdjudicatedPerStratum < 2) {
      throw new Error("minimumAdjudicatedPerStratum must be an integer of at least 2");
    }
    for (const [key, value] of Object.entries(thresholds)) {
      if (key !== "minimumAdjudicatedPerStratum") probability(Number(value), key);
    }
    const sampleSizes = Object.fromEntries([...STRATA].map((stratum) => [stratum, Number(input.sampleSizes[stratum] ?? 0)])) as Record<QualityReviewStratum, number>;
    for (const stratum of strata) {
      if (!Number.isSafeInteger(sampleSizes[stratum]) || sampleSizes[stratum] < thresholds.minimumAdjudicatedPerStratum) {
        throw new Error(`Sample size for ${stratum} must meet minimumAdjudicatedPerStratum`);
      }
    }
    if (!/^[a-f0-9]{64}$/.test(input.seedCommitment)) throw new Error("seedCommitment must be a lowercase SHA-256 digest");
    const planId = id("quality_plan");
    const manifest = {
      id: planId, tenantId: scopeKey, scopeKind: input.scopeKind, scopeKey, windowStart, windowEnd,
      populationVersion: QUALITY_POPULATION_VERSION, rubricVersion: QUALITY_RUBRIC_VERSION,
      evidenceOrigin: input.evidenceOrigin, strata, sampleSizes, thresholds,
      seedCommitment: input.seedCommitment, registeredAt,
    };
    const manifestDigest = sha256(canonical(manifest));
    this.store.db.prepare(`INSERT INTO quality_review_plans(
      id,tenant_id,scope_kind,scope_key,window_start,window_end,population_version,rubric_version,evidence_origin,
      strata_json,sample_sizes_json,thresholds_json,seed_commitment,status,registered_at,manifest_digest
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      planId, scopeKey, input.scopeKind, scopeKey, windowStart, windowEnd, QUALITY_POPULATION_VERSION, QUALITY_RUBRIC_VERSION,
      input.evidenceOrigin, canonical(strata), canonical(sampleSizes), canonical(thresholds), input.seedCommitment,
      "registered", registeredAt, manifestDigest,
    );
    return this.getPlan(planId) as QualityReviewPlan;
  }

  getPlan(planId: string): QualityReviewPlan | undefined {
    const row = this.store.db.prepare("SELECT * FROM quality_review_plans WHERE id=?").get(planId) as Row | undefined;
    return row ? this.planFromRow(row) : undefined;
  }

  freezePopulation(planId: string, seedRevealInput: string): QualityReviewPlan {
    const frozenAt = iso(this.clock(), "clock");
    const seedReveal = requireText(seedRevealInput, "seed reveal", 10_000);
    const plan = this.getPlan(planId);
    if (!plan) throw new Error("Unknown quality review plan");
    if (plan.status !== "registered") {
      if (plan.seedReveal === seedReveal) return plan;
      throw new Error("Quality review population is already frozen with a different seed");
    }
    if (frozenAt < plan.windowEnd) throw new Error("Quality review population cannot freeze before the sampling window ends");
    if (qualitySeedCommitment(seedReveal) !== plan.seedCommitment) throw new Error("Seed reveal does not match the preregistered commitment");

    return this.store.transaction(() => {
      const current = this.getPlan(planId);
      if (!current || current.status !== "registered") throw new Error("Quality review plan changed before population freeze");
      const candidates = this.population(current);
      const rows = candidates.map((candidate) => {
        const unitId = stableId("quality_unit", `${planId}:${candidate.targetKind}:${candidate.targetId}`);
        const rank = sha256(`${seedReveal}\0${candidate.stratum}\0${candidate.targetKind}\0${candidate.targetId}`);
        const packet = this.packet(unitId, candidate);
        return { candidate, unitId, rank, packet, packetDigest: sha256(canonical(packet)) };
      });
      const selected = new Set<string>();
      for (const stratum of current.strata) {
        const eligible = rows.filter((row) => row.candidate.stratum === stratum).sort((left, right) => left.rank.localeCompare(right.rank));
        for (const row of eligible.slice(0, current.sampleSizes[stratum])) selected.add(row.unitId);
      }
      const counts = new Map<QualityReviewStratum, number>();
      for (const row of rows) counts.set(row.candidate.stratum, (counts.get(row.candidate.stratum) ?? 0) + 1);
      for (const row of rows) {
        const population = counts.get(row.candidate.stratum) ?? 0;
        const wanted = current.sampleSizes[row.candidate.stratum] ?? 0;
        this.store.db.prepare(`INSERT INTO quality_review_units(
          id,plan_id,tenant_id,stratum,occurred_at,source_event_id,target_kind,target_id,decision_kind,
          selected,selection_rank,inclusion_probability,packet_json,packet_digest
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          row.unitId, planId, row.candidate.tenantId, row.candidate.stratum, row.candidate.occurredAt,
          row.candidate.sourceEventId, row.candidate.targetKind, row.candidate.targetId, row.candidate.decisionKind,
          selected.has(row.unitId) ? 1 : 0, row.rank, population ? Math.min(1, wanted / population) : 1,
          canonical(row.packet), row.packetDigest,
        );
      }
      const populationDigest = sha256(canonical(rows.sort((left, right) => left.unitId.localeCompare(right.unitId)).map((row) => ({
        unitId: row.unitId, stratum: row.candidate.stratum, rank: row.rank, selected: selected.has(row.unitId), packetDigest: row.packetDigest,
      }))));
      const changed = this.store.db.prepare(`UPDATE quality_review_plans SET status='frozen',seed_reveal=?,frozen_at=?,population_digest=?
        WHERE id=? AND status='registered'`).run(seedReveal, frozenAt, populationDigest, planId);
      if (changed.changes !== 1) throw new Error("Quality review plan changed before population freeze");
      return this.getPlan(planId) as QualityReviewPlan;
    });
  }

  exportBlindPacket(planId: string): BlindQualityPacket {
    const plan = this.requireFrozen(planId);
    const rows = this.store.db.prepare(`SELECT packet_json,packet_digest FROM quality_review_units
      WHERE plan_id=? AND selected=1 ORDER BY stratum,selection_rank,id`).all(planId) as Row[];
    const units = rows.map((row) => {
      const packet = parseJson<BlindQualityUnit>(row.packet_json, "quality packet");
      if (sha256(canonical(packet)) !== String(row.packet_digest)) throw new Error("Frozen quality packet digest does not match stored contents");
      return packet;
    });
    return {
      version: 1, manifestDigest: plan.manifestDigest, populationDigest: plan.populationDigest as string,
      populationVersion: QUALITY_POPULATION_VERSION, rubricVersion: QUALITY_RUBRIC_VERSION,
      windowStart: plan.windowStart, windowEnd: plan.windowEnd, seedReveal: plan.seedReveal as string, units,
    };
  }

  appendReview(input: {
    planId: string;
    unitId: string;
    reviewerId: string;
    reviewerKind: "external_human";
    reviewRole: QualityReviewRole;
    labels: QualityReviewLabels;
    rationale: string;
    evidenceRefs?: string[];
    supersedesReviewId?: string;
  }): QualityReviewRecord {
    const plan = this.requireFrozen(input.planId);
    if (plan.status === "closed") throw new Error("Closed quality review plans do not accept more reviews");
    if (input.reviewerKind !== "external_human") throw new Error("Only an external human may submit an independent quality review");
    const reviewerId = requireText(input.reviewerId, "reviewerId", 500);
    const rationale = requireText(input.rationale, "rationale", 10_000);
    const createdAt = iso(this.clock(), "clock");
    const evidenceRefs = [...new Set(input.evidenceRefs ?? [])];
    if (evidenceRefs.some((value) => !value.trim() || value.length > 2_000)) throw new Error("Evidence references must be non-empty and at most 2,000 characters");
    const unit = this.store.db.prepare("SELECT tenant_id,stratum,selected FROM quality_review_units WHERE plan_id=? AND id=?")
      .get(input.planId, input.unitId) as Row | undefined;
    if (!unit || Number(unit.selected) !== 1) throw new Error("Reviews may only target a selected frozen quality unit");
    const stratum = String(unit.stratum) as QualityReviewStratum;
    this.validateLabels(stratum, input.labels);

    return this.store.transaction(() => {
      const current = this.currentReviews(input.planId, input.unitId);
      let superseded: QualityReviewRecord | undefined;
      if (input.supersedesReviewId) {
        superseded = current.find((review) => review.id === input.supersedesReviewId);
        if (!superseded) throw new Error("A correction must supersede a current review");
        if (superseded.reviewerId !== reviewerId || superseded.reviewRole !== input.reviewRole) {
          throw new Error("A correction cannot change reviewer identity or review role");
        }
      } else if (current.some((review) => review.reviewerId === reviewerId)) {
        throw new Error("Reviewer already has a current review; submit an append-only correction instead");
      }
      const withoutSuperseded = current.filter((review) => review.id !== superseded?.id);
      const primary = withoutSuperseded.filter((review) => review.reviewRole === "primary");
      const adjudicators = withoutSuperseded.filter((review) => review.reviewRole === "adjudicator");
      if (input.reviewRole === "primary" && primary.length >= 2) throw new Error("A quality unit accepts exactly two primary reviewers");
      if (input.reviewRole === "adjudicator") {
        if (adjudicators.length) throw new Error("A quality unit accepts at most one adjudicator");
        if (primary.length !== 2 || !this.reviewsDisagree(stratum, primary)) {
          throw new Error("Adjudication is allowed only after two primary reviews disagree");
        }
      }
      const reviewId = id("quality_review");
      this.store.db.prepare(`INSERT INTO quality_reviews(
        id,plan_id,unit_id,tenant_id,reviewer_id,reviewer_kind,review_role,rubric_version,worthwhile,harmful,
        unnecessary_interruption,missed_worthwhile_opportunity,unsupported_inference,action_useful,
        rationale,evidence_refs_json,supersedes_review_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        reviewId, input.planId, input.unitId, String(unit.tenant_id), reviewerId, "external_human", input.reviewRole, QUALITY_RUBRIC_VERSION,
        input.labels.worthwhile, input.labels.harmful, input.labels.unnecessaryInterruption,
        input.labels.missedWorthwhileOpportunity, input.labels.unsupportedInference, input.labels.actionUseful,
        rationale, canonical(evidenceRefs), superseded?.id ?? null, createdAt,
      );
      return this.reviewFromRow(this.store.db.prepare("SELECT * FROM quality_reviews WHERE id=?").get(reviewId) as Row);
    });
  }

  importBlindReviews(input: {
    planId: string;
    manifestDigest: string;
    populationDigest: string;
    rubricVersion: string;
    reviews: Array<Omit<Parameters<IndependentQualityReviewManager["appendReview"]>[0], "planId">>;
  }): QualityReviewRecord[] {
    const plan = this.requireFrozen(input.planId);
    if (input.manifestDigest !== plan.manifestDigest || input.populationDigest !== plan.populationDigest) {
      throw new Error("Imported reviews do not match the frozen review manifest and population");
    }
    if (input.rubricVersion !== QUALITY_RUBRIC_VERSION) throw new Error("Imported reviews use a different rubric version");
    return this.store.transaction(() => input.reviews.map((review) => this.appendReview({ ...review, planId: input.planId })));
  }

  qualification(planId: string): IndependentQualityQualification {
    const plan = this.requireFrozen(planId);
    const units = this.store.db.prepare(`SELECT id,stratum,selected FROM quality_review_units WHERE plan_id=?
      ORDER BY stratum,selection_rank,id`).all(planId) as Row[];
    const results: QualityStratumResult[] = [];
    const reasons: string[] = [];
    for (const stratum of plan.strata) {
      const population = units.filter((unit) => String(unit.stratum) === stratum).length;
      const selectedUnits = units.filter((unit) => String(unit.stratum) === stratum && Number(unit.selected) === 1);
      const outcomes = selectedUnits.map((unit) => this.adjudicate(stratum, this.currentReviews(planId, String(unit.id))));
      const adjudicated = outcomes.filter((outcome) => outcome.labels !== undefined);
      const incomplete = outcomes.length - adjudicated.length;
      const unknown = adjudicated.filter((outcome) => Object.values(outcome.labels as QualityReviewLabels).includes("unknown")).length;
      const stratumReasons: string[] = [];
      if (population === 0) stratumReasons.push("required stratum has no eligible population");
      if (selectedUnits.length < plan.sampleSizes[stratum]) stratumReasons.push("frozen population is smaller than the preregistered sample");
      if (adjudicated.length < plan.thresholds.minimumAdjudicatedPerStratum) stratumReasons.push("adjudicated sample is too small");
      if (incomplete > 0) stratumReasons.push("selected reviews are incomplete or lack adjudicated consensus");
      if (unknown > 0) stratumReasons.push("adjudicated reviews contain unknown labels");
      const metrics = this.metrics(stratum, adjudicated.flatMap((outcome) => outcome.labels ? [outcome.labels] : []), plan.thresholds);
      if (Object.values(metrics).some((metric) => metric && !metric.passed)) stratumReasons.push("one or more preregistered Wilson bounds missed threshold");
      results.push({
        stratum, population, selected: selectedUnits.length, adjudicated: adjudicated.length, incomplete, unknown,
        primaryDisagreements: outcomes.filter((outcome) => outcome.primaryDisagreement).length,
        metrics, passed: stratumReasons.length === 0, reasons: stratumReasons,
      });
      for (const reason of stratumReasons) reasons.push(`${stratum}: ${reason}`);
    }
    const statisticallyQualified = reasons.length === 0;
    if (plan.evidenceOrigin !== "live_external") reasons.push("synthetic evidence cannot qualify live product quality");
    return {
      planId, evidenceOrigin: plan.evidenceOrigin, statisticallyQualified,
      qualified: statisticallyQualified && plan.evidenceOrigin === "live_external", requiredLiveExternalGate: true,
      reasons, strata: results,
      limitations: [
        "The runtime can enforce preregistration, sampling, packet integrity, and append-only review history; it cannot prove that a declared reviewer is human or independent.",
        "Live qualification still requires externally governed reviewer recruitment, rubric training, identity controls, and a representative deployment window.",
        "These bounds estimate the frozen canonical decision population only; they do not establish universal product quality or causal impact.",
      ],
    };
  }

  closePlan(planId: string): IndependentQualityQualification {
    const result = this.qualification(planId);
    if (!result.qualified) throw new Error(`Quality review plan cannot close: ${result.reasons.join("; ")}`);
    const changed = this.store.db.prepare("UPDATE quality_review_plans SET status='closed' WHERE id=? AND status='frozen'").run(planId);
    if (changed.changes !== 1) throw new Error("Quality review plan was not open for closing");
    return result;
  }

  private population(plan: QualityReviewPlan): PopulationCandidate[] {
    const scope = this.scopeSql(plan, "r", "ra.tenant_id");
    const admissions = this.store.db.prepare(`SELECT ra.*,r.input AS run_input,r.output AS run_output,i.content AS intervention_content
      FROM relationship_admissions ra LEFT JOIN runs r ON r.id=ra.run_id AND r.tenant_id=ra.tenant_id
      LEFT JOIN interventions i ON i.id=ra.intervention_id AND i.tenant_id=ra.tenant_id
      WHERE ra.settled_at>=? AND ra.settled_at<? AND ${scope.clause}
      ORDER BY ra.settled_at,ra.id`).all(plan.windowStart, plan.windowEnd, ...scope.values) as Row[];
    const unresolved = this.store.db.prepare(`SELECT ra.status FROM relationship_admissions ra
      LEFT JOIN runs r ON r.id=ra.run_id AND r.tenant_id=ra.tenant_id
      WHERE ra.created_at>=? AND ra.created_at<? AND ra.settled_at IS NULL AND ${scope.clause}`)
      .all(plan.windowStart, plan.windowEnd, ...scope.values) as Row[];
    const invalidTerminal = admissions.filter((row) => !TERMINAL_ADMISSION_STATUSES.has(String(row.status)));
    if (unresolved.length || invalidTerminal.length) {
      throw new Error(`Quality population contains ${unresolved.length + invalidTerminal.length} unresolved or corrupt relationship admission(s)`);
    }
    const candidates = admissions.map((row): PopulationCandidate => {
      const response = typeof row.intervention_content === "string" && row.intervention_content
        ? row.intervention_content : typeof row.run_output === "string" ? row.run_output : undefined;
      return {
        tenantId: String(row.tenant_id), stratum: stratumForDeliveryClass(String(row.delivery_class)),
        occurredAt: String(row.settled_at), sourceEventId: String(row.source_event_id), targetKind: "relationship_admission",
        targetId: String(row.id), decisionKind: `relationship.${String(row.status)}`,
        decision: blind({ deliveryClass: String(row.delivery_class), status: String(row.status), reason: String(row.reason),
          attentionClass: String(row.attention_class) }) as JsonObject,
        runId: String(row.run_id), ...(response !== undefined ? { response } : {}),
      };
    });

    const eventScope = this.scopeSql(plan, "r", "e.tenant_id");
    const placeholders = SILENCE_EVENT_TYPES.map(() => "?").join(",");
    const silence = this.store.db.prepare(`SELECT e.*,r.input AS run_input,r.output AS run_output
      FROM events e LEFT JOIN runs r ON r.id=e.correlation_id AND r.tenant_id=e.tenant_id
      WHERE e.at>=? AND e.at<? AND e.type IN (${placeholders}) AND ${eventScope.clause}
      ORDER BY e.at,e.id`).all(plan.windowStart, plan.windowEnd, ...SILENCE_EVENT_TYPES, ...eventScope.values) as Row[];
    for (const row of silence) {
      const runId = typeof row.correlation_id === "string" ? row.correlation_id : undefined;
      candidates.push({
        tenantId: String(row.tenant_id), stratum: "silence", occurredAt: String(row.at), sourceEventId: String(row.id),
        targetKind: "silence_event", targetId: String(row.id), decisionKind: String(row.type), ...(runId ? { runId } : {}),
        decision: blind(parseJson<JsonObject>(row.payload_json, "silence event payload")) as JsonObject,
      });
    }
    return candidates.filter((candidate) => plan.strata.includes(candidate.stratum));
  }

  private scopeSql(plan: QualityReviewPlan, _runAlias: string, tenantExpression: string): { clause: string; values: string[] } {
    return { clause: `${tenantExpression}=?`, values: [plan.tenantId] };
  }

  private packet(unitId: string, candidate: PopulationCandidate): BlindQualityUnit {
    const run = candidate.runId ? this.store.getRun(candidate.runId, candidate.tenantId) : undefined;
    const source = this.store.getEvent(candidate.tenantId, candidate.sourceEventId);
    if (!source) throw new Error(`Quality population source event ${candidate.sourceEventId} is missing`);
    return {
      version: 1, unitId, stratum: candidate.stratum, occurredAt: candidate.occurredAt, decision: candidate.decision,
      context: {
        request: run?.input ?? null,
        response: candidate.targetKind === "silence_event" ? null : candidate.response ?? run?.output ?? null,
        sourceEvent: { type: source.type, at: source.at, payload: blind(source.payload) },
      },
    };
  }

  private validateLabels(stratum: QualityReviewStratum, labels: QualityReviewLabels): void {
    const binary = new Set(["yes", "no", "unknown"]);
    const conditional = new Set([...binary, "not_applicable"]);
    if (!binary.has(labels.worthwhile) || !binary.has(labels.harmful) || !binary.has(labels.unsupportedInference)
      || !conditional.has(labels.unnecessaryInterruption) || !conditional.has(labels.missedWorthwhileOpportunity)
      || !conditional.has(labels.actionUseful)) throw new Error("Review contains an unsupported rubric label");
    if (stratum === "silence") {
      if (labels.unnecessaryInterruption !== "not_applicable" || labels.missedWorthwhileOpportunity === "not_applicable") {
        throw new Error("Silence reviews require missed-opportunity and mark interruption not applicable");
      }
    } else if (labels.missedWorthwhileOpportunity !== "not_applicable" || labels.unnecessaryInterruption === "not_applicable") {
      throw new Error("Delivered-decision reviews require interruption and mark missed opportunity not applicable");
    }
    if ((stratum === "consequential") === (labels.actionUseful === "not_applicable")) {
      throw new Error(stratum === "consequential" ? "Consequential reviews require action usefulness" : "Action usefulness is not applicable to this stratum");
    }
  }

  private reviewsDisagree(stratum: QualityReviewStratum, reviews: QualityReviewRecord[]): boolean {
    if (reviews.length !== 2) return false;
    return applicableFields(stratum).some((field) => reviews[0]?.[field] !== reviews[1]?.[field]);
  }

  private adjudicate(stratum: QualityReviewStratum, reviews: QualityReviewRecord[]): { labels?: QualityReviewLabels; primaryDisagreement: boolean } {
    const primary = reviews.filter((review) => review.reviewRole === "primary");
    const adjudicator = reviews.find((review) => review.reviewRole === "adjudicator");
    if (primary.length !== 2) return { primaryDisagreement: false };
    const disagreement = this.reviewsDisagree(stratum, primary);
    if (disagreement && !adjudicator) return { primaryDisagreement: true };
    const resolved = reviewLabels(primary[0] as QualityReviewRecord);
    for (const field of applicableFields(stratum)) {
      const values = adjudicator ? [primary[0]?.[field], primary[1]?.[field], adjudicator[field]] : [primary[0]?.[field], primary[1]?.[field]];
      const counts = new Map<string, number>();
      for (const value of values) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
      const winner = [...counts].sort((left, right) => right[1] - left[1])[0];
      if (!winner || winner[1] <= values.length / 2) return { primaryDisagreement: disagreement };
      resolved[field] = winner[0] as never;
    }
    return { labels: resolved, primaryDisagreement: disagreement };
  }

  private metrics(stratum: QualityReviewStratum, labels: QualityReviewLabels[], thresholds: QualityThresholds): Partial<Record<keyof QualityReviewLabels, QualityMetricResult>> {
    if (!labels.length) return {};
    const metric = (field: keyof QualityReviewLabels, favorableValue: "yes" | "no", threshold: number,
      direction: QualityMetricResult["direction"]): QualityMetricResult => {
      const applicable = labels.map((entry) => entry[field]).filter((value) => value !== "not_applicable" && value !== "unknown");
      if (!applicable.length) return { favorable: 0, total: 0, lower: 0, upper: 1, threshold, direction, passed: false };
      const favorable = applicable.filter((value) => value === favorableValue).length;
      const interval = wilsonInterval(favorable, applicable.length);
      const passed = direction === "lower_at_least" ? interval.lower >= threshold : interval.upper <= threshold;
      return { favorable, total: applicable.length, ...interval, threshold, direction, passed };
    };
    const result: Partial<Record<keyof QualityReviewLabels, QualityMetricResult>> = {
      worthwhile: metric("worthwhile", "yes", thresholds.worthwhileLowerBound, "lower_at_least"),
      harmful: metric("harmful", "yes", thresholds.harmfulUpperBound, "upper_at_most"),
      unsupportedInference: metric("unsupportedInference", "yes", thresholds.unsupportedInferenceUpperBound, "upper_at_most"),
    };
    if (stratum === "silence") result.missedWorthwhileOpportunity = metric("missedWorthwhileOpportunity", "yes", thresholds.missedOpportunityUpperBound, "upper_at_most");
    else result.unnecessaryInterruption = metric("unnecessaryInterruption", "yes", thresholds.unnecessaryInterruptionUpperBound, "upper_at_most");
    if (stratum === "consequential") result.actionUseful = metric("actionUseful", "yes", thresholds.actionUsefulLowerBound, "lower_at_least");
    return result;
  }

  private currentReviews(planId: string, unitId: string): QualityReviewRecord[] {
    const rows = this.store.db.prepare(`SELECT qr.* FROM quality_reviews qr
      WHERE qr.plan_id=? AND qr.unit_id=? AND NOT EXISTS(
        SELECT 1 FROM quality_reviews correction WHERE correction.supersedes_review_id=qr.id
      ) ORDER BY qr.created_at,qr.id`).all(planId, unitId) as Row[];
    return rows.map((row) => this.reviewFromRow(row));
  }

  private reviewFromRow(row: Row): QualityReviewRecord {
    return {
      id: String(row.id), planId: String(row.plan_id), unitId: String(row.unit_id), tenantId: String(row.tenant_id), reviewerId: String(row.reviewer_id),
      reviewerKind: "external_human", reviewRole: String(row.review_role) as QualityReviewRole,
      rubricVersion: QUALITY_RUBRIC_VERSION, worthwhile: String(row.worthwhile) as QualityBinaryLabel,
      harmful: String(row.harmful) as QualityBinaryLabel,
      unnecessaryInterruption: String(row.unnecessary_interruption) as QualityConditionalLabel,
      missedWorthwhileOpportunity: String(row.missed_worthwhile_opportunity) as QualityConditionalLabel,
      unsupportedInference: String(row.unsupported_inference) as QualityBinaryLabel,
      actionUseful: String(row.action_useful) as QualityConditionalLabel, rationale: String(row.rationale),
      evidenceRefs: parseJson<string[]>(row.evidence_refs_json, "quality review evidence references"),
      ...(typeof row.supersedes_review_id === "string" ? { supersedesReviewId: row.supersedes_review_id } : {}),
      createdAt: String(row.created_at),
    };
  }

  private requireFrozen(planId: string): QualityReviewPlan {
    const plan = this.getPlan(planId);
    if (!plan || plan.status === "registered" || !plan.seedReveal || !plan.populationDigest) throw new Error("Quality review plan is not frozen");
    return plan;
  }

  private planFromRow(row: Row): QualityReviewPlan {
    const strata = parseJson<QualityReviewStratum[]>(row.strata_json, "quality review strata");
    const sampleSizes = parseJson<Record<QualityReviewStratum, number>>(row.sample_sizes_json, "quality review sample sizes");
    const thresholds = parseJson<QualityThresholds>(row.thresholds_json, "quality review thresholds");
    return {
      id: String(row.id), tenantId: String(row.tenant_id), scopeKind: String(row.scope_kind) as QualityReviewScopeKind, scopeKey: String(row.scope_key),
      windowStart: String(row.window_start), windowEnd: String(row.window_end),
      populationVersion: QUALITY_POPULATION_VERSION, rubricVersion: QUALITY_RUBRIC_VERSION,
      evidenceOrigin: String(row.evidence_origin) as QualityEvidenceOrigin, strata, sampleSizes, thresholds,
      seedCommitment: String(row.seed_commitment), status: String(row.status) as QualityReviewPlanStatus,
      registeredAt: String(row.registered_at), manifestDigest: String(row.manifest_digest),
      ...(typeof row.seed_reveal === "string" ? { seedReveal: row.seed_reveal } : {}),
      ...(typeof row.frozen_at === "string" ? { frozenAt: row.frozen_at } : {}),
      ...(typeof row.population_digest === "string" ? { populationDigest: row.population_digest } : {}),
    };
  }
}
