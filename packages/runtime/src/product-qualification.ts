import { stableId } from "./id.ts";
import type { ProductOutcomeManager, ProductQualitySnapshot } from "./product-outcomes.ts";
import type { IndependentQualityQualification, IndependentQualityReviewManager } from "./quality-reviews.ts";

export interface ProductQualificationStage {
  passed: boolean;
  requiredForPass: boolean;
  detail: string;
}

export interface ProductQualificationPolicyV1 {
  version: 1;
  minimumOwnerMessages: 10;
  minimumSubstantiveResponses: 10;
  maximumFirstWowDays: 7;
  maximumOwnerMessagesBeforeFirstWow: 10;
  minimumGoodResponseRatio: 0.7;
  maximumObviousOrAnnoyingResponseRatio: 0.1;
  minimumContextAdvantageRatings: 3;
  minimumContextAdvantageRatio: 0.5;
  minimumProactiveAcceptedPerComparisonMonth: 5;
  minimumTenureSeparationMonths: 2;
  minimumProactiveGoodRatioLift: 0.1;
  maximumOverduePromises: 0;
  maximumUncertainConsequentialEffects: 0;
  minimumConfirmedConsequentialEffects: 1;
  maximumDailyInterventions: number;
}

export interface MemberProductQualification {
  schemaVersion: 2;
  qualificationId: string;
  generatedAt: string;
  tenantId: string;
  passed: boolean;
  scope: "tenant-release-readiness";
  policy: ProductQualificationPolicyV1;
  observed: {
    relationshipStartedAt: string | null;
    ownerMessages: number;
    substantiveResponses: number;
    ratedMessages: number;
    feedbackCoverageRatio: number;
    usefulSurprises: number;
    firstWowElapsedDays: number | null;
    ownerMessagesBeforeFirstWow: number | null;
    goodResponseRatio: number;
    obviousOrAnnoyingResponseRatio: number;
    contextAdvantageRatings: number;
    contextAdvantageRatio: number | null;
    proactiveAccepted: number;
    proactiveDelivered: number;
    proactiveAdmissions: number;
    earlyTenureMonth: number | null;
    earlyProactiveGoodResponseRatio: number | null;
    earlyProactiveObviousOrAnnoyingResponseRatio: number | null;
    laterTenureMonth: number | null;
    laterProactiveGoodResponseRatio: number | null;
    laterProactiveObviousOrAnnoyingResponseRatio: number | null;
    proactiveGoodRatioLift: number | null;
    maximumRolling24HourAdmissions: number;
    overduePromises: number;
    confirmedConsequentialEffects: number;
    uncertainConsequentialEffects: number;
    independentQualityPlanId: string | null;
    independentQualityQualified: boolean;
  };
  stages: {
    evidenceSufficiency: ProductQualificationStage;
    firstWow: ProductQualificationStage;
    responseQuality: ProductQualificationStage;
    contextAdvantage: ProductQualificationStage;
    promiseReliability: ProductQualificationStage;
    actionTruth: ProductQualificationStage;
    proactiveTenure: ProductQualificationStage;
    interruptionBound: ProductQualificationStage;
    independentQuality: ProductQualificationStage;
  };
  limitations: string[];
}

const BASE_POLICY = {
  version: 1,
  minimumOwnerMessages: 10,
  minimumSubstantiveResponses: 10,
  maximumFirstWowDays: 7,
  maximumOwnerMessagesBeforeFirstWow: 10,
  minimumGoodResponseRatio: 0.7,
  maximumObviousOrAnnoyingResponseRatio: 0.1,
  minimumContextAdvantageRatings: 3,
  minimumContextAdvantageRatio: 0.5,
  minimumProactiveAcceptedPerComparisonMonth: 5,
  minimumTenureSeparationMonths: 2,
  minimumProactiveGoodRatioLift: 0.1,
  maximumOverduePromises: 0,
  maximumUncertainConsequentialEffects: 0,
  minimumConfirmedConsequentialEffects: 1,
} as const;

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? rounded(numerator / denominator) : null;
}

function sameRatio(left: number | null, right: number | null): boolean {
  return left === right || (left !== null && right !== null && Math.abs(left - right) < 0.000_01);
}

function nonnegativeIntegers(values: number[]): boolean {
  return values.every((value) => Number.isSafeInteger(value) && value >= 0);
}

function projectionConsistent(snapshot: ProductQualitySnapshot): boolean {
  const months = snapshot.tenureMonths;
  if (snapshot.attentionAdmissionProjectionValid !== true) return false;
  if (months.some((month, index) => !Number.isSafeInteger(month.month) || month.month < 0
    || (index > 0 && month.month <= (months[index - 1]?.month ?? -1)))) return false;
  const counts = [
    snapshot.ownerMessages, snapshot.authoredSubstantiveMessages, snapshot.ratedMessages, snapshot.usefulSurprises,
    snapshot.contextAdvantageRated, snapshot.contextAdvantagePositive, snapshot.proactiveAccepted, snapshot.proactiveDelivered,
    snapshot.proactiveInterruptionsSent, snapshot.proactiveAdmissionCount, snapshot.maximumRolling24HourAdmissions,
    snapshot.proactiveRatedMessages,
    ...Object.values(snapshot.byKind), ...Object.values(snapshot.proactiveByKind),
  ];
  if (!nonnegativeIntegers(counts)) return false;
  const sum = (select: (month: ProductQualitySnapshot["tenureMonths"][number]) => number) =>
    months.reduce((total, month) => total + select(month), 0);
  if (sum((month) => month.ownerMessages) !== snapshot.ownerMessages
    || sum((month) => month.authoredSubstantiveMessages) !== snapshot.authoredSubstantiveMessages
    || sum((month) => month.ratedMessages) !== snapshot.ratedMessages
    || sum((month) => month.proactiveAccepted) !== snapshot.proactiveAccepted
    || sum((month) => month.proactiveDelivered) !== snapshot.proactiveDelivered
    || sum((month) => month.proactiveRatedMessages) !== snapshot.proactiveRatedMessages
    || snapshot.proactiveInterruptionsSent !== snapshot.proactiveDelivered
    || snapshot.proactiveAccepted > snapshot.proactiveAdmissionCount
    || Object.values(snapshot.byKind).reduce((total, count) => total + count, 0) !== snapshot.ratedMessages
    || Object.values(snapshot.proactiveByKind).reduce((total, count) => total + count, 0) !== snapshot.proactiveRatedMessages
    || sum((month) => month.usefulSurprises) !== snapshot.byKind.useful_surprise
    || sum((month) => month.useful) !== snapshot.byKind.useful
    || sum((month) => month.obvious) !== snapshot.byKind.obvious
    || sum((month) => month.annoying) !== snapshot.byKind.annoying
    || sum((month) => month.neutral) !== snapshot.byKind.neutral
    || Object.keys(snapshot.proactiveByKind).some((kind) =>
      sum((month) => month.proactiveByKind[kind as keyof typeof month.proactiveByKind])
        !== snapshot.proactiveByKind[kind as keyof typeof snapshot.proactiveByKind])) return false;
  const positive = snapshot.byKind.useful_surprise + snapshot.byKind.useful;
  const negative = snapshot.byKind.obvious + snapshot.byKind.annoying;
  const proactivePositive = snapshot.proactiveByKind.useful_surprise + snapshot.proactiveByKind.useful;
  const proactiveNegative = snapshot.proactiveByKind.obvious + snapshot.proactiveByKind.annoying;
  if (snapshot.usefulSurprises !== snapshot.byKind.useful_surprise
    || snapshot.contextAdvantagePositive > snapshot.contextAdvantageRated
    || snapshot.contextAdvantageRated > snapshot.usefulSurprises
    || !sameRatio(snapshot.feedbackCoverageRatio, ratio(snapshot.ratedMessages, snapshot.authoredSubstantiveMessages) ?? 0)
    || !sameRatio(snapshot.goodResponseRatio, ratio(positive, snapshot.authoredSubstantiveMessages) ?? 0)
    || !sameRatio(snapshot.obviousOrAnnoyingResponseRatio, ratio(negative, snapshot.authoredSubstantiveMessages) ?? 0)
    || !sameRatio(snapshot.ratedGoodResponseRatio, ratio(positive, positive + negative))
    || !sameRatio(snapshot.ratedObviousOrAnnoyingRatio, ratio(negative, positive + negative))
    || !sameRatio(snapshot.contextAdvantageRatio, ratio(snapshot.contextAdvantagePositive, snapshot.contextAdvantageRated))
    || !sameRatio(snapshot.proactiveGoodResponseRatio, ratio(proactivePositive, snapshot.proactiveAccepted) ?? 0)
    || !sameRatio(snapshot.proactiveObviousOrAnnoyingResponseRatio, ratio(proactiveNegative, snapshot.proactiveAccepted) ?? 0)
    || !sameRatio(snapshot.proactiveFeedbackCoverageRatio, ratio(snapshot.proactiveRatedMessages, snapshot.proactiveAccepted) ?? 0)
    || !sameRatio(snapshot.proactiveRatedGoodResponseRatio, ratio(proactivePositive, proactivePositive + proactiveNegative))
    || !sameRatio(snapshot.proactiveRatedObviousOrAnnoyingRatio, ratio(proactiveNegative, proactivePositive + proactiveNegative))) return false;
  return months.every((month) => {
    const monthCounts = [
      month.ownerMessages, month.authoredSubstantiveMessages, month.ratedMessages, month.usefulSurprises,
      month.useful, month.obvious, month.annoying, month.neutral, month.proactiveAccepted, month.proactiveDelivered,
      month.proactiveInterruptionsSent, month.proactiveRatedMessages, ...Object.values(month.proactiveByKind),
    ];
    const good = month.usefulSurprises + month.useful;
    const bad = month.obvious + month.annoying;
    const proactiveGood = month.proactiveByKind.useful_surprise + month.proactiveByKind.useful;
    const proactiveBad = month.proactiveByKind.obvious + month.proactiveByKind.annoying;
    return nonnegativeIntegers(monthCounts)
      && month.ratedMessages === month.usefulSurprises + month.useful + month.obvious + month.annoying + month.neutral
      && month.proactiveRatedMessages === Object.values(month.proactiveByKind).reduce((total, count) => total + count, 0)
      && month.proactiveInterruptionsSent === month.proactiveDelivered
      && sameRatio(month.goodResponseRatio, ratio(good, month.authoredSubstantiveMessages) ?? 0)
      && sameRatio(month.obviousOrAnnoyingResponseRatio, ratio(bad, month.authoredSubstantiveMessages) ?? 0)
      && sameRatio(month.ratedGoodResponseRatio, ratio(good, good + bad))
      && sameRatio(month.proactiveGoodResponseRatio, ratio(proactiveGood, month.proactiveAccepted) ?? 0)
      && sameRatio(month.proactiveObviousOrAnnoyingResponseRatio, ratio(proactiveBad, month.proactiveAccepted) ?? 0)
      && sameRatio(month.proactiveFeedbackCoverageRatio, ratio(month.proactiveRatedMessages, month.proactiveAccepted))
      && sameRatio(month.proactiveRatedGoodResponseRatio, ratio(proactiveGood, proactiveGood + proactiveBad))
      && sameRatio(month.proactiveRatedObviousOrAnnoyingRatio, ratio(proactiveBad, proactiveGood + proactiveBad));
  });
}

function stage(passed: boolean, requiredForPass: boolean, detail: string): ProductQualificationStage {
  return { passed, requiredForPass, detail };
}

/**
 * Evaluates only the product targets that canonical member outcomes can prove.
 * It deliberately does not accept an externally supplied snapshot or infer
 * cohort identity, real-person participation, or causal attribution.
 */
export class MemberProductQualifier {
  readonly outcomes: ProductOutcomeManager;
  readonly qualityReviews: IndependentQualityReviewManager | undefined;

  constructor(outcomes: ProductOutcomeManager, qualityReviews?: IndependentQualityReviewManager) {
    this.outcomes = outcomes;
    this.qualityReviews = qualityReviews;
  }

  qualify(tenantId: string, maximumDailyInterventions: number, at = new Date(), independentQualityPlanId?: string): MemberProductQualification {
    const dailyBound = Number.isSafeInteger(maximumDailyInterventions) && maximumDailyInterventions >= 0
      ? maximumDailyInterventions : 0;
    const policy: ProductQualificationPolicyV1 = { ...BASE_POLICY, maximumDailyInterventions: dailyBound };
    const snapshot = this.outcomes.summary(tenantId, at);
    return this.evaluate(tenantId, snapshot, policy, independentQualityPlanId);
  }

  private evaluate(tenantId: string, snapshot: ProductQualitySnapshot, policy: ProductQualificationPolicyV1,
    independentQualityPlanId?: string): MemberProductQualification {
    const eligible = snapshot.tenureMonths.filter((month) => month.proactiveAccepted >= policy.minimumProactiveAcceptedPerComparisonMonth);
    const early = eligible[0];
    const later = early ? eligible.findLast((month) => month.month >= early.month + policy.minimumTenureSeparationMonths) : undefined;
    const lift = early && later ? rounded(later.proactiveGoodResponseRatio - early.proactiveGoodResponseRatio) : null;
    const projectionIsConsistent = projectionConsistent(snapshot);
    const evidenceSufficiency = Boolean(projectionIsConsistent
      && snapshot.relationshipStartedAt
      && snapshot.ownerMessages >= policy.minimumOwnerMessages
      && snapshot.authoredSubstantiveMessages >= policy.minimumSubstantiveResponses);
    const firstWowPassed = Boolean(snapshot.firstUsefulSurpriseElapsedDays !== null
      && snapshot.firstUsefulSurpriseElapsedDays <= policy.maximumFirstWowDays
      && snapshot.ownerMessagesBeforeFirstUsefulSurprise !== null
      && snapshot.ownerMessagesBeforeFirstUsefulSurprise <= policy.maximumOwnerMessagesBeforeFirstWow);
    const responseQualityPassed = snapshot.goodResponseRatio >= policy.minimumGoodResponseRatio
      && snapshot.obviousOrAnnoyingResponseRatio <= policy.maximumObviousOrAnnoyingResponseRatio;
    const contextAdvantagePassed = snapshot.contextAdvantageRated >= policy.minimumContextAdvantageRatings
      && snapshot.contextAdvantageRatio !== null
      && snapshot.contextAdvantageRatio >= policy.minimumContextAdvantageRatio;
    const promiseReliabilityPassed = snapshot.promises.overdue <= policy.maximumOverduePromises
      && snapshot.promises.accepted === 0;
    const actionTruthPassed = snapshot.consequentialEffects.confirmed >= policy.minimumConfirmedConsequentialEffects
      && snapshot.consequentialEffects.uncertain <= policy.maximumUncertainConsequentialEffects;
    const proactiveTenurePassed = Boolean(early && later && lift !== null
      && lift >= policy.minimumProactiveGoodRatioLift
      && later.proactiveGoodResponseRatio >= policy.minimumGoodResponseRatio
      && later.proactiveObviousOrAnnoyingResponseRatio <= policy.maximumObviousOrAnnoyingResponseRatio
      && later.proactiveObviousOrAnnoyingResponseRatio <= early.proactiveObviousOrAnnoyingResponseRatio);
    const deliveryProjectionConsistent = snapshot.proactiveDelivered <= snapshot.proactiveAccepted
      && snapshot.tenureMonths.every((month) => month.proactiveDelivered <= month.proactiveAccepted);
    const maximumRolling24HourAdmissions = snapshot.maximumRolling24HourAdmissions;
    const interruptionBoundPassed = policy.maximumDailyInterventions > 0
      && deliveryProjectionConsistent
      && maximumRolling24HourAdmissions <= policy.maximumDailyInterventions;
    let independentQuality: IndependentQualityQualification | undefined;
    let independentQualityReason = "No frozen independent quality plan was supplied.";
    if (independentQualityPlanId && this.qualityReviews) {
      try {
        const plan = this.qualityReviews.getPlan(independentQualityPlanId);
        if (!plan || plan.tenantId !== tenantId) independentQualityReason = "The independent quality plan does not belong to this tenant.";
        else {
          independentQuality = this.qualityReviews.qualification(independentQualityPlanId);
          independentQualityReason = independentQuality.qualified
            ? "A preregistered representative live sample passed its independent-human quality bounds."
            : `Independent quality remains unqualified: ${independentQuality.reasons.join("; ") || "required live evidence is incomplete"}.`;
        }
      } catch (error) {
        independentQualityReason = `Independent quality evidence failed closed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const stages = {
      evidenceSufficiency: stage(evidenceSufficiency, true, evidenceSufficiency
        ? "Enough canonical owner and response history exists to evaluate operational release gates."
        : projectionIsConsistent
          ? "Evidence is sparse: require 10 owner messages and 10 substantive responses."
          : "The derived product projection is internally inconsistent and cannot qualify."),
      firstWow: stage(firstWowPassed, false, firstWowPassed
        ? "Directional member feedback reports a useful surprise within the target; this is not independent quality proof."
        : "No directional member report met both the seven-day and ten-owner-message targets."),
      responseQuality: stage(responseQualityPassed, false, responseQualityPassed
        ? "Directional explicit feedback clears the legacy response targets; representative review remains authoritative."
        : "Directional explicit feedback misses a legacy target; it is diagnostic rather than a release gate."),
      contextAdvantage: stage(contextAdvantagePassed, false, contextAdvantagePassed
        ? "Directional feedback includes reported context advantage; representative review remains authoritative."
        : "Reported context advantage is missing, sparse, or below its diagnostic target."),
      promiseReliability: stage(promiseReliabilityPassed, true, promiseReliabilityPassed
        ? "No due promise is silently overdue or still merely accepted."
        : "At least one due promise is overdue or remains merely accepted."),
      actionTruth: stage(actionTruthPassed, true, actionTruthPassed
        ? "At least one consequential effect is confirmed and none has an uncertain outcome."
        : "A confirmed consequential effect is absent or an uncertain consequential outcome remains."),
      proactiveTenure: stage(proactiveTenurePassed, false, proactiveTenurePassed
        ? "Directional proactive feedback improved across separated tenure months; this association is not causal or independently calibrated."
        : "Separated proactive feedback is missing or did not improve enough; this remains a diagnostic."),
      interruptionBound: stage(interruptionBoundPassed, true, interruptionBoundPassed
        ? "Every exact rolling 24-hour attention-admission window remains inside the configured daily budget, and deliveries never exceed provider acceptances."
          : "The configured intervention budget is disabled/invalid, an exact rolling 24-hour admission window exceeds it, or delivery projections exceed acceptances."),
      independentQuality: stage(independentQuality?.qualified === true, true, independentQualityReason),
    };
    const passed = Object.values(stages).filter((candidate) => candidate.requiredForPass).every((candidate) => candidate.passed);
    const observed = {
      relationshipStartedAt: snapshot.relationshipStartedAt,
      ownerMessages: snapshot.ownerMessages,
      substantiveResponses: snapshot.authoredSubstantiveMessages,
      ratedMessages: snapshot.ratedMessages,
      feedbackCoverageRatio: snapshot.feedbackCoverageRatio,
      usefulSurprises: snapshot.usefulSurprises,
      firstWowElapsedDays: snapshot.firstUsefulSurpriseElapsedDays,
      ownerMessagesBeforeFirstWow: snapshot.ownerMessagesBeforeFirstUsefulSurprise,
      goodResponseRatio: snapshot.goodResponseRatio,
      obviousOrAnnoyingResponseRatio: snapshot.obviousOrAnnoyingResponseRatio,
      contextAdvantageRatings: snapshot.contextAdvantageRated,
      contextAdvantageRatio: snapshot.contextAdvantageRatio,
      proactiveAccepted: snapshot.proactiveAccepted,
      proactiveDelivered: snapshot.proactiveDelivered,
      proactiveAdmissions: snapshot.proactiveAdmissionCount,
      earlyTenureMonth: early?.month ?? null,
      earlyProactiveGoodResponseRatio: early?.proactiveGoodResponseRatio ?? null,
      earlyProactiveObviousOrAnnoyingResponseRatio: early?.proactiveObviousOrAnnoyingResponseRatio ?? null,
      laterTenureMonth: later?.month ?? null,
      laterProactiveGoodResponseRatio: later?.proactiveGoodResponseRatio ?? null,
      laterProactiveObviousOrAnnoyingResponseRatio: later?.proactiveObviousOrAnnoyingResponseRatio ?? null,
      proactiveGoodRatioLift: lift,
      maximumRolling24HourAdmissions,
      overduePromises: snapshot.promises.overdue,
      confirmedConsequentialEffects: snapshot.consequentialEffects.confirmed,
      uncertainConsequentialEffects: snapshot.consequentialEffects.uncertain,
      independentQualityPlanId: independentQualityPlanId ?? null,
      independentQualityQualified: independentQuality?.qualified === true,
    };
    const proof = { tenantId, scope: "tenant-release-readiness" as const, policy, observed, stages };
    return {
      schemaVersion: 2,
      qualificationId: stableId("product-qualification", JSON.stringify(proof)),
      generatedAt: snapshot.generatedAt,
      ...proof,
      passed,
      limitations: [
        "Explicit praise, complaints, context ratings, first-wow timing, and tenure trends are directional diagnostics; they cannot satisfy the independent quality gate.",
        "This report does not prove that the tenant belongs to a real non-founder; that requires externally verified participation.",
        "One member cannot establish cohort medians or a private-beta population target.",
        "Deposit decline cannot be attributed to Co from event counts alone; member research remains required.",
        "A longitudinal association does not prove that tenure caused the observed quality change.",
        ...(independentQuality?.limitations ?? []),
      ],
    };
  }
}
