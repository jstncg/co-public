import assert from "node:assert/strict";
import test from "node:test";
import { MemberProductQualifier } from "../src/product-qualification.ts";
import type { ProductOutcomeManager, ProductQualitySnapshot } from "../src/product-outcomes.ts";
import type { IndependentQualityReviewManager } from "../src/quality-reviews.ts";
import { CoRuntime } from "../src/runtime.ts";
import { testConfig, testHome } from "./helpers.ts";

type TenureMonth = ProductQualitySnapshot["tenureMonths"][number];

function month(input: {
  month: number;
  owner: number;
  authored: number;
  surprise: number;
  useful: number;
  obvious: number;
  annoying: number;
  proactiveAccepted: number;
  proactiveSurprise: number;
  proactiveUseful: number;
  proactiveObvious: number;
  proactiveAnnoying: number;
}): TenureMonth {
  const rated = input.surprise + input.useful + input.obvious + input.annoying;
  const good = input.surprise + input.useful;
  const bad = input.obvious + input.annoying;
  const proactiveRated = input.proactiveSurprise + input.proactiveUseful + input.proactiveObvious + input.proactiveAnnoying;
  const proactiveGood = input.proactiveSurprise + input.proactiveUseful;
  const proactiveBad = input.proactiveObvious + input.proactiveAnnoying;
  const ratio = (numerator: number, denominator: number) => denominator ? Math.round((numerator / denominator) * 10_000) / 10_000 : null;
  return {
    month: input.month, ownerMessages: input.owner, authoredSubstantiveMessages: input.authored,
    ratedMessages: rated, usefulSurprises: input.surprise, useful: input.useful, obvious: input.obvious, annoying: input.annoying, neutral: 0,
    ratedGoodResponseRatio: ratio(good, good + bad),
    goodResponseRatio: ratio(good, input.authored) ?? 0,
    obviousOrAnnoyingResponseRatio: ratio(bad, input.authored) ?? 0,
    proactiveAccepted: input.proactiveAccepted, proactiveDelivered: input.proactiveAccepted,
    proactiveInterruptionsSent: input.proactiveAccepted, proactiveRatedMessages: proactiveRated,
    proactiveFeedbackCoverageRatio: ratio(proactiveRated, input.proactiveAccepted),
    proactiveByKind: {
      useful_surprise: input.proactiveSurprise, useful: input.proactiveUseful,
      obvious: input.proactiveObvious, annoying: input.proactiveAnnoying, neutral: 0,
    },
    proactiveGoodResponseRatio: ratio(proactiveGood, input.proactiveAccepted) ?? 0,
    proactiveObviousOrAnnoyingResponseRatio: ratio(proactiveBad, input.proactiveAccepted) ?? 0,
    proactiveRatedGoodResponseRatio: ratio(proactiveGood, proactiveGood + proactiveBad),
    proactiveRatedObviousOrAnnoyingRatio: ratio(proactiveBad, proactiveGood + proactiveBad),
  };
}

function passingSnapshot(): ProductQualitySnapshot {
  const tenureMonths = [
    month({
      month: 0, owner: 4, authored: 3, surprise: 1, useful: 1, obvious: 0, annoying: 1,
      proactiveAccepted: 5, proactiveSurprise: 1, proactiveUseful: 1, proactiveObvious: 1, proactiveAnnoying: 1,
    }),
    month({
      month: 1, owner: 4, authored: 3, surprise: 1, useful: 1, obvious: 0, annoying: 0,
      proactiveAccepted: 3, proactiveSurprise: 1, proactiveUseful: 0, proactiveObvious: 1, proactiveAnnoying: 0,
    }),
    month({
      month: 2, owner: 4, authored: 4, surprise: 1, useful: 2, obvious: 0, annoying: 0,
      proactiveAccepted: 5, proactiveSurprise: 2, proactiveUseful: 2, proactiveObvious: 0, proactiveAnnoying: 0,
    }),
  ];
  return {
    generatedAt: "2026-09-04T12:00:00.000Z",
    relationshipStartedAt: "2026-06-01T12:00:00.000Z",
    ownerMessages: 12, authoredSubstantiveMessages: 10, ratedMessages: 8, feedbackCoverageRatio: 0.8,
    byKind: { useful_surprise: 3, useful: 4, obvious: 0, annoying: 1, neutral: 0 },
    goodResponseRatio: 0.7, obviousOrAnnoyingResponseRatio: 0.1,
    ratedGoodResponseRatio: 0.875, ratedObviousOrAnnoyingRatio: 0.125,
    usefulSurprises: 3, firstUsefulSurpriseAt: "2026-06-04T12:00:00.000Z",
    firstUsefulSurpriseElapsedDays: 3, ownerMessagesBeforeFirstUsefulSurprise: 4,
    contextAdvantageRated: 3, contextAdvantagePositive: 2, contextAdvantageRatio: 0.6667,
    silentResponses: 2, tapbackResponses: 1,
    proactiveAccepted: 13, proactiveDelivered: 13, proactiveInterruptionsSent: 13, proactiveAdmissionCount: 13, proactiveRatedMessages: 10,
    maximumRolling24HourAdmissions: 2, attentionAdmissionProjectionValid: true,
    proactiveFeedbackCoverageRatio: 0.7692,
    proactiveByKind: { useful_surprise: 4, useful: 3, obvious: 2, annoying: 1, neutral: 0 },
    proactiveGoodResponseRatio: 0.5385, proactiveObviousOrAnnoyingResponseRatio: 0.2308,
    proactiveRatedGoodResponseRatio: 0.7, proactiveRatedObviousOrAnnoyingRatio: 0.3,
    tenureMonths,
    promises: { due: 2, completed: 2, released: 0, overdue: 0, accepted: 0 },
    consequentialEffects: { total: 1, notStarted: 0, confirmed: 1, accepted: 0, failed: 0, uncertain: 0 },
  };
}

function qualifier(snapshot: ProductQualitySnapshot): Pick<MemberProductQualifier, "qualify"> {
  const outcomes = { summary: () => snapshot } as unknown as ProductOutcomeManager;
  const qualityReviews = {
    getPlan: () => ({ tenantId: "tenant-a" }),
    qualification: () => ({ qualified: true, reasons: [], limitations: [] }),
  } as unknown as IndependentQualityReviewManager;
  const memberQualifier = new MemberProductQualifier(outcomes, qualityReviews);
  return {
    qualify: (tenantId, maximumDailyInterventions, at) => memberQualifier.qualify(
      tenantId, maximumDailyInterventions, at, "quality-plan",
    ),
  };
}

test("the measurable member gate uses conservative denominators and requires separated improving tenure evidence", () => {
  const snapshot = passingSnapshot();
  const report = qualifier(snapshot).qualify("tenant-a", 3, new Date(snapshot.generatedAt));
  assert.equal(report.passed, true);
  assert.equal(Object.values(report.stages).every((stage) => stage.passed), true);
  assert.equal(report.observed.goodResponseRatio, 0.7);
  assert.equal(report.observed.earlyTenureMonth, 0);
  assert.equal(report.observed.laterTenureMonth, 2);
  assert.equal(report.observed.proactiveGoodRatioLift, 0.4);
  assert.equal(report.observed.maximumRolling24HourAdmissions, 2);
  assert.equal(report.scope, "tenant-release-readiness");
  assert.equal(report.limitations.length, 5);
});

test("perfect ratings cannot hide sparse evidence, unrated substantive responses, or a corrupt projection", () => {
  const sparse = passingSnapshot();
  sparse.ownerMessages = 1;
  sparse.authoredSubstantiveMessages = 1;
  sparse.ratedMessages = 1;
  sparse.byKind = { useful_surprise: 1, useful: 0, obvious: 0, annoying: 0, neutral: 0 };
  sparse.goodResponseRatio = 1;
  sparse.obviousOrAnnoyingResponseRatio = 0;
  sparse.ratedGoodResponseRatio = 1;
  sparse.ratedObviousOrAnnoyingRatio = 0;
  sparse.tenureMonths = [month({
    month: 0, owner: 1, authored: 1, surprise: 1, useful: 0, obvious: 0, annoying: 0,
    proactiveAccepted: 0, proactiveSurprise: 0, proactiveUseful: 0, proactiveObvious: 0, proactiveAnnoying: 0,
  })];
  sparse.proactiveAccepted = 0;
  sparse.proactiveDelivered = 0;
  sparse.proactiveInterruptionsSent = 0;
  sparse.proactiveRatedMessages = 0;
  sparse.proactiveFeedbackCoverageRatio = 0;
  sparse.proactiveByKind = { useful_surprise: 0, useful: 0, obvious: 0, annoying: 0, neutral: 0 };
  sparse.proactiveGoodResponseRatio = 0;
  sparse.proactiveObviousOrAnnoyingResponseRatio = 0;
  sparse.proactiveRatedGoodResponseRatio = null;
  sparse.proactiveRatedObviousOrAnnoyingRatio = null;
  assert.equal(qualifier(sparse).qualify("tenant-a", 3).passed, false);

  const denominator = passingSnapshot();
  denominator.authoredSubstantiveMessages = 16;
  denominator.feedbackCoverageRatio = 0.5;
  denominator.goodResponseRatio = 0.4375;
  denominator.obviousOrAnnoyingResponseRatio = 0.0625;
  denominator.tenureMonths[2] = {
    ...denominator.tenureMonths[2] as TenureMonth,
    authoredSubstantiveMessages: 10, goodResponseRatio: 0.3, obviousOrAnnoyingResponseRatio: 0,
  };
  const denominatorReport = qualifier(denominator).qualify("tenant-a", 3);
  assert.equal(denominatorReport.stages.evidenceSufficiency.passed, true);
  assert.equal(denominatorReport.stages.responseQuality.passed, false,
    "a perfect rated-response ratio cannot erase substantive messages with no member-validated positive outcome");

  const corrupt = passingSnapshot();
  corrupt.ratedGoodResponseRatio = 1;
  const corruptReport = qualifier(corrupt).qualify("tenant-a", 3);
  assert.equal(corruptReport.stages.evidenceSufficiency.passed, false);
  assert.match(corruptReport.stages.evidenceSufficiency.detail, /internally inconsistent/i);

  const missingAdmissionHistory = passingSnapshot();
  missingAdmissionHistory.proactiveAdmissionCount = 12;
  const missingAdmissionReport = qualifier(missingAdmissionHistory).qualify("tenant-a", 3);
  assert.equal(missingAdmissionReport.stages.evidenceSufficiency.passed, false,
    "accepted proactive history without matching attention reservations cannot qualify under the rolling-window rule");
});

test("quality, context, promises, action truth, tenure, and interruption limits each fail independently", () => {
  const cases: Array<[keyof ReturnType<MemberProductQualifier["qualify"]>["stages"], (snapshot: ProductQualitySnapshot) => void, number?]> = [
    ["firstWow", (snapshot) => { snapshot.firstUsefulSurpriseElapsedDays = 8; }],
    ["responseQuality", (snapshot) => {
      snapshot.byKind = { useful_surprise: 3, useful: 3, obvious: 0, annoying: 2, neutral: 0 };
      snapshot.goodResponseRatio = 0.6; snapshot.obviousOrAnnoyingResponseRatio = 0.2;
      snapshot.ratedGoodResponseRatio = 0.75; snapshot.ratedObviousOrAnnoyingRatio = 0.25;
      snapshot.tenureMonths[0] = month({
        month: 0, owner: 4, authored: 3, surprise: 1, useful: 0, obvious: 0, annoying: 2,
        proactiveAccepted: 5, proactiveSurprise: 1, proactiveUseful: 1, proactiveObvious: 1, proactiveAnnoying: 1,
      });
    }],
    ["contextAdvantage", (snapshot) => { snapshot.contextAdvantagePositive = 1; snapshot.contextAdvantageRatio = 0.3333; }],
    ["promiseReliability", (snapshot) => { snapshot.promises = { due: 2, completed: 1, released: 0, overdue: 1, accepted: 0 }; }],
    ["actionTruth", (snapshot) => { snapshot.consequentialEffects = { total: 1, notStarted: 0, confirmed: 0, accepted: 0, failed: 0, uncertain: 1 }; }],
    ["proactiveTenure", (snapshot) => {
      snapshot.tenureMonths[2] = month({
        month: 2, owner: 4, authored: 4, surprise: 1, useful: 2, obvious: 0, annoying: 0,
        proactiveAccepted: 5, proactiveSurprise: 1, proactiveUseful: 1, proactiveObvious: 1, proactiveAnnoying: 1,
      });
      snapshot.proactiveByKind = { useful_surprise: 3, useful: 2, obvious: 3, annoying: 2, neutral: 0 };
      snapshot.proactiveGoodResponseRatio = 0.3846; snapshot.proactiveObviousOrAnnoyingResponseRatio = 0.3846;
      snapshot.proactiveRatedGoodResponseRatio = 0.5; snapshot.proactiveRatedObviousOrAnnoyingRatio = 0.5;
    }],
    ["interruptionBound", (snapshot) => {
      snapshot.maximumRolling24HourAdmissions = 4;
    }, 3],
  ];
  for (const [expectedStage, mutate, dailyBound = 3] of cases) {
    const snapshot = passingSnapshot();
    mutate(snapshot);
    const report = qualifier(snapshot).qualify("tenant-a", dailyBound);
    assert.equal(report.stages[expectedStage].passed, false, `${expectedStage} should fail`);
    assert.equal(report.passed, report.stages[expectedStage].requiredForPass === false,
      `${expectedStage} affects the release only when it is an independent operational gate`);
  }
});

test("directional praise cannot qualify a release without a frozen independent review", () => {
  const snapshot = passingSnapshot();
  const outcomes = { summary: () => snapshot } as unknown as ProductOutcomeManager;
  const report = new MemberProductQualifier(outcomes).qualify("tenant-a", 3, new Date(snapshot.generatedAt));
  assert.equal(report.stages.responseQuality.passed, true);
  assert.equal(report.stages.responseQuality.requiredForPass, false);
  assert.equal(report.stages.independentQuality.passed, false);
  assert.equal(report.stages.independentQuality.requiredForPass, true);
  assert.equal(report.passed, false);
});

test("the production-wired qualifier refuses an empty or acceptance-shaped tenant history", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    runtime.store.appendEvent({
      tenantId: "test", stream: "run:forged", type: "message.delivery_accepted",
      correlationId: "intervention:forged", causationId: "missing-intent",
      payload: { providerReceipt: { provider: "linq", messageId: "forged" } },
    });
    const report = runtime.productQualification.qualify("test", runtime.config.autonomy.maxDailyInterventions);
    assert.equal(report.passed, false);
    assert.equal(report.observed.proactiveAccepted, 0);
    assert.equal(report.observed.usefulSurprises, 0);
    assert.equal(JSON.stringify(report).includes("forged"), false);
  } finally {
    runtime.close();
    home.cleanup();
  }
});
