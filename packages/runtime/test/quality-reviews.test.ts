import assert from "node:assert/strict";
import test from "node:test";
import { IndependentQualityReviewManager, QUALITY_RUBRIC_VERSION, qualitySeedCommitment, wilsonInterval, type QualityReviewLabels } from "../src/quality-reviews.ts";
import { CURRENT_SCHEMA_VERSION, SqliteStore } from "../src/store.ts";
import { TenantLifecycleManager } from "../src/tenant-lifecycle.ts";
import { testHome } from "./helpers.ts";

const REGISTERED_AT = "2026-01-01T00:00:00.000Z";
const WINDOW_START = "2026-01-02T00:00:00.000Z";
const WINDOW_END = "2026-01-03T00:00:00.000Z";
const FROZEN_AT = "2026-01-04T00:00:00.000Z";
const SEED = "externally-generated-review-seed-0001";

const goodReply: QualityReviewLabels = {
  worthwhile: "yes",
  harmful: "no",
  unnecessaryInterruption: "no",
  missedWorthwhileOpportunity: "not_applicable",
  unsupportedInference: "no",
  actionUseful: "not_applicable",
};
const goodSilence: QualityReviewLabels = {
  worthwhile: "yes",
  harmful: "no",
  unnecessaryInterruption: "not_applicable",
  missedWorthwhileOpportunity: "no",
  unsupportedInference: "no",
  actionUseful: "not_applicable",
};

function fixture(): { store: SqliteStore; manager: IndependentQualityReviewManager; setNow: (value: string) => void; cleanup: () => void } {
  const home = testHome();
  const store = new SqliteStore(`${home.path}/runtime.sqlite`);
  const session = store.ensureSession("tenant-a", "imessage", "member");
  for (let index = 0; index < 3; index += 1) {
    const runId = `quality-run-${index}`;
    const source = store.appendEvent({
      id: `quality-source-${index}`, tenantId: "tenant-a", stream: `run:${runId}`, type: "message.received",
      at: `2026-01-02T0${index}:00:00.000Z`, payload: { text: `request ${index}`, model: "must-be-blinded", releaseId: "must-be-blinded" },
    });
    store.createRun({
      id: runId, tenantId: "tenant-a", sessionId: session.id, kind: "foreground", status: "completed", modelRole: "foreground",
      provider: "secret-provider", model: "secret-model", releaseId: "release-secret", releaseDigest: "digest-secret",
      releaseLabel: "label-secret", rolloutId: "rollout-secret", releaseCohort: "stable",
      input: `request ${index}`, output: `response ${index}`, inputTokens: 1, outputTokens: 1,
      createdAt: `2026-01-02T0${index}:00:00.000Z`, updatedAt: `2026-01-02T0${index}:01:00.000Z`,
    });
    store.db.prepare(`INSERT INTO relationship_admissions(
      id,tenant_id,session_id,source_event_id,run_id,delivery_key,delivery_intent_id,delivery_class,precedence,
      attention_class,urgency,content_digest,authority_ref,binding_digest,status,reason,created_at,updated_at,settled_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      `admission-${index}`, "tenant-a", session.id, source.id, runId, `delivery-${index}`, `intent-${index}`,
      "requested_reply", 500, "response", 0.5, `content-${index}`, `owner:${source.id}`, `binding-${index}`,
      "accepted", "provider accepted delivery", `2026-01-02T0${index}:02:00.000Z`, `2026-01-02T0${index}:03:00.000Z`, `2026-01-02T0${index}:03:00.000Z`,
    );
  }
  for (let index = 0; index < 2; index += 1) {
    const runId = `silence-run-${index}`;
    store.createRun({
      id: runId, tenantId: "tenant-a", sessionId: session.id, kind: "foreground", status: "completed", modelRole: "foreground",
      provider: "secret-provider", model: "secret-model", input: `silence request ${index}`, output: "",
      inputTokens: 1, outputTokens: 0, createdAt: `2026-01-02T1${index}:00:00.000Z`, updatedAt: `2026-01-02T1${index}:01:00.000Z`,
    });
    store.appendEvent({
      id: `silence-event-${index}`, tenantId: "tenant-a", stream: `run:${runId}`, type: index
        ? "relationship.response_knownness_suppressed" : "relationship.response_silenced",
      correlationId: runId, at: `2026-01-02T1${index}:02:00.000Z`,
      payload: { runId, reason: "legitimate silence", provider: "must-be-blinded", model_id: "must-be-blinded" },
    });
  }
  let current = REGISTERED_AT;
  return {
    store, manager: new IndependentQualityReviewManager(store, { now: () => current }),
    setNow: (value) => { current = value; }, cleanup: () => { store.close(); home.cleanup(); },
  };
}

function register(manager: IndependentQualityReviewManager, evidenceOrigin: "synthetic" | "live_external" = "synthetic") {
  return manager.registerPlan({
    scopeKind: "tenant", scopeKey: "tenant-a", windowStart: WINDOW_START, windowEnd: WINDOW_END,
    evidenceOrigin, strata: ["requested_reply", "silence"], sampleSizes: { requested_reply: 2, silence: 2 },
    thresholds: {
      minimumAdjudicatedPerStratum: 2, worthwhileLowerBound: 0, harmfulUpperBound: 1,
      unnecessaryInterruptionUpperBound: 1, missedOpportunityUpperBound: 1,
      unsupportedInferenceUpperBound: 1, actionUsefulLowerBound: 0,
    },
    seedCommitment: qualitySeedCommitment(SEED),
  });
}

test("v52 adds tenant-scoped immutable quality evidence tables", () => {
  const setup = fixture();
  try {
    assert.equal(CURRENT_SCHEMA_VERSION >= 52, true);
    assert.equal(setup.store.schemaVersion(), CURRENT_SCHEMA_VERSION);
    for (const name of ["quality_review_plans", "quality_review_units", "quality_reviews"]) {
      assert.ok(setup.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
    }
    const plan = register(setup.manager);
    assert.throws(() => setup.store.db.prepare("UPDATE quality_review_plans SET window_end=? WHERE id=?").run(FROZEN_AT, plan.id), /immutable|append-only/i);
    assert.throws(() => setup.store.db.prepare("DELETE FROM quality_review_plans WHERE id=?").run(plan.id), /immutable/i);
  } finally {
    setup.cleanup();
  }
});

test("a v51 runtime migrates additively to tenant-scoped review evidence", () => {
  const home = testHome();
  const path = `${home.path}/runtime.sqlite`;
  let store = new SqliteStore(path);
  try {
    store.db.exec(`
      DROP TABLE quality_reviews;
      DROP TABLE quality_review_units;
      DROP TABLE quality_review_plans;
      DROP TABLE tenant_deletion_permits;
      DELETE FROM schema_migrations WHERE version=52;
      PRAGMA user_version=51;
    `);
    store.close();
    store = new SqliteStore(path);
    assert.equal(store.schemaVersion(), CURRENT_SCHEMA_VERSION);
    assert.ok(store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=52").get());
    const planColumns = store.db.prepare("PRAGMA table_info(quality_review_plans)").all() as Array<{ name: string }>;
    assert.ok(planColumns.some((column) => column.name === "tenant_id"));
  } finally {
    store.close();
    home.cleanup();
  }
});

test("registration is future-only and seed commitment fails closed", () => {
  const setup = fixture();
  try {
    setup.setNow(WINDOW_START);
    assert.throws(() => setup.manager.registerPlan({
      scopeKind: "tenant", scopeKey: "tenant-a", windowStart: WINDOW_START, windowEnd: WINDOW_END,
      evidenceOrigin: "synthetic", strata: ["silence"], sampleSizes: { silence: 2 },
      thresholds: { minimumAdjudicatedPerStratum: 2 }, seedCommitment: qualitySeedCommitment(SEED),
    }), /before the sampling window/i);
    setup.setNow(REGISTERED_AT);
    const plan = register(setup.manager);
    setup.setNow(FROZEN_AT);
    assert.throws(() => setup.manager.freezePopulation(plan.id, "wrong-seed"), /does not match/i);
    assert.equal(setup.manager.getPlan(plan.id)?.status, "registered");
    assert.equal((setup.store.db.prepare("SELECT COUNT(*) AS count FROM quality_review_units WHERE plan_id=?").get(plan.id) as { count: number }).count, 0);
    const session = setup.store.ensureSession("tenant-a", "imessage", "member");
    setup.store.db.prepare(`INSERT INTO relationship_admissions(
      id,tenant_id,session_id,source_event_id,run_id,delivery_key,delivery_intent_id,delivery_class,precedence,
      attention_class,urgency,content_digest,authority_ref,binding_digest,status,reason,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "unresolved-admission", "tenant-a", session.id, "quality-source-0", "quality-run-0", "unresolved",
      "unresolved-intent", "optional_reply", 200, "unsolicited", 0.3, "unresolved-content",
      "owner:quality-source-0", "unresolved-binding", "held", "still waiting", "2026-01-02T22:00:00.000Z", "2026-01-02T22:00:00.000Z",
    );
    assert.throws(() => setup.manager.freezePopulation(plan.id, SEED), /unresolved or corrupt/i);
    assert.equal(setup.manager.getPlan(plan.id)?.status, "registered");
  } finally {
    setup.cleanup();
  }
});

test("freeze stores the complete canonical population and samples deterministically", () => {
  const setup = fixture();
  try {
    const first = register(setup.manager);
    const second = register(setup.manager);
    setup.setNow(FROZEN_AT);
    setup.manager.freezePopulation(first.id, SEED);
    setup.manager.freezePopulation(second.id, SEED);
    const counts = setup.store.db.prepare(`SELECT stratum,COUNT(*) AS population,SUM(selected) AS selected
      FROM quality_review_units WHERE plan_id=? GROUP BY stratum ORDER BY stratum`).all(first.id) as Array<{ stratum: string; population: number; selected: number }>;
    assert.deepEqual(counts.map((row) => ({ ...row })), [
      { stratum: "requested_reply", population: 3, selected: 2 },
      { stratum: "silence", population: 2, selected: 2 },
    ]);
    const selectedTargets = (planId: string) => (setup.store.db.prepare(`SELECT target_id FROM quality_review_units
      WHERE plan_id=? AND selected=1 ORDER BY target_id`).all(planId) as Array<{ target_id: string }>).map((row) => row.target_id);
    assert.deepEqual(selectedTargets(first.id), selectedTargets(second.id));
    assert.deepEqual(setup.manager.freezePopulation(first.id, SEED), setup.manager.getPlan(first.id));
    assert.throws(() => setup.manager.freezePopulation(first.id, `${SEED}-different`), /different seed/i);
  } finally {
    setup.cleanup();
  }
});

test("the population distinguishes optional replies and uses terminal decision time", () => {
  const setup = fixture();
  try {
    const session = setup.store.ensureSession("tenant-a", "imessage", "member");
    for (let index = 0; index < 2; index += 1) {
      setup.store.db.prepare(`INSERT INTO relationship_admissions(
        id,tenant_id,session_id,source_event_id,run_id,delivery_key,delivery_intent_id,delivery_class,precedence,
        attention_class,urgency,content_digest,authority_ref,binding_digest,status,reason,created_at,updated_at,settled_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        `optional-admission-${index}`, "tenant-a", session.id, `quality-source-${index}`, `quality-run-${index}`,
        `optional-${index}`, `optional-intent-${index}`, "optional_reply", 200, "unsolicited", 0.3,
        `optional-content-${index}`, `owner:quality-source-${index}`, `optional-binding-${index}`, "accepted",
        "provider accepted optional reply", "2026-01-01T12:00:00.000Z", `2026-01-02T2${index}:00:00.000Z`,
        `2026-01-02T2${index}:00:00.000Z`,
      );
    }
    const plan = setup.manager.registerPlan({
      scopeKind: "tenant", scopeKey: "tenant-a", windowStart: WINDOW_START, windowEnd: WINDOW_END,
      evidenceOrigin: "synthetic", strata: ["optional_reply"], sampleSizes: { optional_reply: 2 },
      thresholds: { minimumAdjudicatedPerStratum: 2 },
      seedCommitment: qualitySeedCommitment(SEED),
    });
    setup.setNow(FROZEN_AT);
    setup.manager.freezePopulation(plan.id, SEED);
    assert.deepEqual(setup.manager.exportBlindPacket(plan.id).units.map((unit) => unit.stratum), ["optional_reply", "optional_reply"]);
  } finally {
    setup.cleanup();
  }
});

test("blind export binds the frozen packet and removes deployment identity", () => {
  const setup = fixture();
  try {
    const plan = register(setup.manager);
    setup.setNow(FROZEN_AT);
    setup.manager.freezePopulation(plan.id, SEED);
    const packet = setup.manager.exportBlindPacket(plan.id);
    assert.equal(packet.units.length, 4);
    assert.equal(packet.rubricVersion, QUALITY_RUBRIC_VERSION);
    const serialized = JSON.stringify(packet);
    assert.doesNotMatch(serialized, /tenant-a|secret-provider|secret-model|release-secret|must-be-blinded/);
    assert.match(serialized, /request [0-9]|silence request/);
    const selected = packet.units[0];
    assert.ok(selected);
    assert.throws(() => setup.manager.importBlindReviews({
      planId: plan.id, manifestDigest: "tampered", populationDigest: packet.populationDigest,
      rubricVersion: packet.rubricVersion, reviews: [],
    }), /do not match/i);
  } finally {
    setup.cleanup();
  }
});

test("reviews require independent-human provenance, append corrections, and adjudicate disagreement", () => {
  const setup = fixture();
  try {
    const plan = register(setup.manager);
    setup.setNow(FROZEN_AT);
    setup.manager.freezePopulation(plan.id, SEED);
    const unit = setup.manager.exportBlindPacket(plan.id).units.find((candidate) => candidate.stratum === "requested_reply");
    assert.ok(unit);
    const first = setup.manager.appendReview({
      planId: plan.id, unitId: unit.unitId, reviewerId: "human-one", reviewerKind: "external_human",
      reviewRole: "primary", labels: goodReply, rationale: "The answer directly resolves the request.",
    });
    assert.throws(() => setup.manager.appendReview({
      planId: plan.id, unitId: unit.unitId, reviewerId: "model-reviewer", reviewerKind: "model" as "external_human",
      reviewRole: "primary", labels: goodReply, rationale: "A model cannot certify product quality.",
    }), /external human/i);
    const negative = { ...goodReply, worthwhile: "no" as const };
    setup.manager.appendReview({
      planId: plan.id, unitId: unit.unitId, reviewerId: "human-two", reviewerKind: "external_human",
      reviewRole: "primary", labels: negative, rationale: "The response does not add enough value.",
    });
    assert.equal(setup.manager.qualification(plan.id).strata.find((row) => row.stratum === "requested_reply")?.primaryDisagreements, 1);
    setup.manager.appendReview({
      planId: plan.id, unitId: unit.unitId, reviewerId: "human-three", reviewerKind: "external_human",
      reviewRole: "adjudicator", labels: goodReply, rationale: "The concrete resolution supports the positive judgment.",
    });
    const correction = setup.manager.appendReview({
      planId: plan.id, unitId: unit.unitId, reviewerId: "human-one", reviewerKind: "external_human",
      reviewRole: "primary", labels: goodReply, rationale: "Corrected rationale; the labels and evidence are unchanged.",
      supersedesReviewId: first.id,
    });
    assert.equal(correction.supersedesReviewId, first.id);
    assert.equal((setup.store.db.prepare("SELECT COUNT(*) AS count FROM quality_reviews WHERE unit_id=?").get(unit.unitId) as { count: number }).count, 4);
    assert.throws(() => setup.store.db.prepare("UPDATE quality_reviews SET rationale='rewritten' WHERE id=?").run(first.id), /append-only/i);
    assert.throws(() => setup.store.db.prepare("DELETE FROM quality_reviews WHERE id=?").run(first.id), /append-only/i);
  } finally {
    setup.cleanup();
  }
});

test("synthetic samples can exercise statistics but can never claim live quality", () => {
  const setup = fixture();
  try {
    const plan = register(setup.manager, "synthetic");
    setup.setNow(FROZEN_AT);
    setup.manager.freezePopulation(plan.id, SEED);
    const packet = setup.manager.exportBlindPacket(plan.id);
    for (const unit of packet.units) {
      const labels = unit.stratum === "silence" ? goodSilence : goodReply;
      for (const reviewerId of ["external-one", "external-two"]) {
        setup.manager.appendReview({
          planId: plan.id, unitId: unit.unitId, reviewerId, reviewerKind: "external_human", reviewRole: "primary",
          labels, rationale: "Synthetic fixture judgment used only to test aggregation behavior.",
        });
      }
    }
    const result = setup.manager.qualification(plan.id);
    assert.equal(result.statisticallyQualified, true);
    assert.equal(result.qualified, false);
    assert.ok(result.reasons.some((reason) => /synthetic evidence/i.test(reason)));
    assert.throws(() => setup.manager.closePlan(plan.id), /cannot close/i);
  } finally {
    setup.cleanup();
  }
});

test("a complete live external sample can satisfy the statistical quality gate", () => {
  const setup = fixture();
  try {
    const plan = register(setup.manager, "live_external");
    setup.setNow(FROZEN_AT);
    setup.manager.freezePopulation(plan.id, SEED);
    for (const unit of setup.manager.exportBlindPacket(plan.id).units) {
      const labels = unit.stratum === "silence" ? goodSilence : goodReply;
      for (const reviewerId of ["independent-one", "independent-two"]) {
        setup.manager.appendReview({
          planId: plan.id, unitId: unit.unitId, reviewerId, reviewerKind: "external_human", reviewRole: "primary",
          labels, rationale: "Independent fixture review for the complete selected sample.",
        });
      }
    }
    const result = setup.manager.qualification(plan.id);
    assert.equal(result.statisticallyQualified, true);
    assert.equal(result.qualified, true);
    assert.deepEqual(result.reasons, []);
  } finally {
    setup.cleanup();
  }
});

test("Wilson interval uses a one-sided 95% bound and incomplete or unknown evidence fails closed", () => {
  const perfect = wilsonInterval(30, 30);
  assert.ok(perfect.lower > 0.91 && perfect.lower < 0.92);
  const zeroBad = wilsonInterval(0, 30);
  assert.ok(zeroBad.upper > 0.08 && zeroBad.upper < 0.09);

  const setup = fixture();
  try {
    const plan = register(setup.manager, "live_external");
    setup.setNow(FROZEN_AT);
    setup.manager.freezePopulation(plan.id, SEED);
    const result = setup.manager.qualification(plan.id);
    assert.equal(result.qualified, false);
    assert.ok(result.reasons.some((reason) => /too small|incomplete/i.test(reason)));
  } finally {
    setup.cleanup();
  }
});

test("tenant export, restore, and deliberate deletion preserve the frozen review lifecycle", () => {
  const setup = fixture();
  const destinationHome = testHome();
  const destination = new SqliteStore(`${destinationHome.path}/runtime.sqlite`);
  try {
    setup.store.db.prepare(`UPDATE runs SET release_id=NULL,release_digest=NULL,release_label=NULL,
      rollout_id=NULL,release_cohort=NULL WHERE tenant_id=?`).run("tenant-a");
    const plan = register(setup.manager, "synthetic");
    setup.setNow(FROZEN_AT);
    setup.manager.freezePopulation(plan.id, SEED);
    const unit = setup.manager.exportBlindPacket(plan.id).units[0];
    assert.ok(unit);
    const labels = unit.stratum === "silence" ? goodSilence : goodReply;
    setup.manager.appendReview({ planId: plan.id, unitId: unit.unitId, reviewerId: "portable-reviewer-one",
      reviewerKind: "external_human", reviewRole: "primary", labels, rationale: "Portable review one." });
    setup.manager.appendReview({ planId: plan.id, unitId: unit.unitId, reviewerId: "portable-reviewer-two",
      reviewerKind: "external_human", reviewRole: "primary", labels, rationale: "Portable review two." });

    const lifecycle = new TenantLifecycleManager(setup.store);
    const bundle = lifecycle.createExport("tenant-a", FROZEN_AT);
    assert.equal(bundle.tables.find((table) => table.name === "quality_review_plans")?.rowCount, 1);
    assert.equal(bundle.tables.find((table) => table.name === "quality_review_units")?.rowCount, 5);
    assert.equal(bundle.tables.find((table) => table.name === "quality_reviews")?.rowCount, 2);
    new TenantLifecycleManager(destination).restoreExport({ tenantId: "tenant-a", bundle, confirmation: "RESTORE:tenant-a" });
    const restored = new IndependentQualityReviewManager(destination);
    assert.equal(restored.exportBlindPacket(plan.id).populationDigest, setup.manager.exportBlindPacket(plan.id).populationDigest);

    assert.equal(lifecycle.deleteFromExport({ tenantId: "tenant-a", bundle, confirmation: "DELETE:tenant-a" }).deleted, true);
    for (const table of ["quality_review_plans", "quality_review_units", "quality_reviews", "tenant_deletion_permits"]) {
      assert.equal((setup.store.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id=?`).get("tenant-a") as { count: number }).count, 0);
    }
  } finally {
    destination.close();
    destinationHome.cleanup();
    setup.cleanup();
  }
});
