import assert from "node:assert/strict";
import test from "node:test";
import { CoRuntime } from "../src/runtime.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { DependencyError } from "../src/dependency-errors.ts";
import { CURRENT_SCHEMA_VERSION, SqliteStore } from "../src/store.ts";
import { testConfig, testHome } from "./helpers.ts";

function fixture(disposition: "interrupt" | "natural_opening" = "interrupt") {
  const home = testHome();
  let runtime = new CoRuntime({ config: testConfig(home.path) });
  let attempts = 0;
  let retryFirst = false;
  runtime.connectors.register({ id: "inquiry-rail", inboundPrincipal: "trusted-system",
    status: () => ({ id: "inquiry-rail", inboundConfigured: false, outboundConfigured: true }),
    verifyWebhook: () => false, parseWebhook: () => undefined,
    deliver: async () => {
      attempts++;
      if (retryFirst && attempts === 1) throw new DependencyError({ service: "inquiry-rail", kind: "rate_limited",
        message: "Try later", retryable: true, uncertain: false, retryAfterMs: 60_000 });
      return { provider: "inquiry-rail", messageId: `accepted-${attempts}` };
    },
  });
  const session = runtime.store.ensureSession("test", "inquiry-rail", "member");
  const source = runtime.store.appendEvent({ tenantId: "test", stream: `session:${session.id}`, type: "message.received", payload: { text: "An opportunity to investigate." } });
  const inquiry = runtime.inquiries.create({ tenantId: "test", sourceEventId: source.id, sessionId: session.id,
    triggerKind: "artifact", triggerBasis: "A selected source may change an existing choice.",
    question: "Does the new source change an existing choice?", concreteBenefit: "Avoid missing a useful option before its deadline.",
    answerability: "records", competingHypotheses: ["A useful option has opened.", "The option does not change the choice."],
    falsifiers: ["The source is no longer current."], retrievalPlan: ["Compare the source against dated member evidence."],
    stopCondition: "Stop after one bounded comparison.", idempotencyKey: "delivery-fixture" });
  runtime.inquiries.begin("test", inquiry.id);
  runtime.inquiries.resolve({ tenantId: "test", inquiryId: inquiry.id, status: "resolved",
    finding: "A relevant option remains open today.", counterevidence: "The member might already have chosen another option.",
    remainingUncertainty: "The source can change later.", nextPermittedConsequence: "Consider a separately gated message." });
  const decide = (next: "interrupt" | "natural_opening" | "backstage", reason = "A material option needs a timely decision.") => runtime.inquiries.decideForeground({
    tenantId: "test", inquiryId: inquiry.id, disposition: next, memberDelta: 0.95, timingLoss: 0.95,
    answerUnavailablePrivately: true, whyNow: "The option closes before the next planned conversation.",
    bestQuietAlternative: "Retain a dated comparison without sending it.", reason,
    ...(next === "natural_opening" ? { naturalOpeningEventId: source.id } : {}),
  });
  const decision = decide(disposition);
  const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
  const queue = () => {
    const result = worker.attention.evaluate("test", { sourceEventId: source.id, inquiryDecisionId: decision.id,
      topicKey: "inquiry-window", evidence: 3, novelty: 1, urgency: 1, usefulness: 1, actionability: 1,
      confidence: 0.99, interruptionCost: 0.01, content: "A workshop place opened; registration closes this evening.",
      channel: "inquiry-rail", peerId: "member" });
    assert.equal(result.send, true);
    return String(runtime.store.db.prepare("SELECT id FROM interventions WHERE tenant_id='test'").get()!.id);
  };
  return { get runtime() { return runtime; }, worker, inquiry, source, session, decision, decide, queue,
    restart: () => {
      const connector = runtime.connectors.webhook("inquiry-rail")!;
      runtime.close();
      runtime = new CoRuntime({ config: testConfig(home.path) });
      runtime.connectors.register(connector);
      return new RuntimeWorker(runtime, { videoAnalyzer: null });
    },
    attempts: () => attempts, retryFirst: () => { retryFirst = true; },
    close: () => { runtime.close(); home.cleanup(); } };
}

test("an eligible inquiry carries its exact decision through transport acceptance", async () => {
  const f = fixture();
  try {
    const interventionId = f.queue();
    await f.worker.runOnce();
    assert.equal(f.attempts(), 1);
    const row = f.runtime.store.db.prepare("SELECT authority_ref,status FROM relationship_admissions WHERE intervention_id=?").get(interventionId)!;
    assert.equal(row.authority_ref, `intervention:${interventionId}:inquiry:${f.decision.id}`);
    assert.equal(row.status, "accepted");
  } finally { f.close(); }
});

test("expired queued inquiry output stays silent and retains its finding", async () => {
  const f = fixture();
  try {
    const interventionId = f.queue();
    f.runtime.store.db.prepare("UPDATE inquiries SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1_000).toISOString(), f.inquiry.id);
    await f.worker.runOnce();
    assert.equal(f.attempts(), 0);
    assert.equal(f.runtime.store.db.prepare("SELECT decision FROM interventions WHERE id=?").get(interventionId)!.decision, "silence");
    assert.equal(f.runtime.inquiries.get("test", f.inquiry.id)?.finding, "A relevant option remains open today.");
    assert.equal(await f.worker.runOnce(), false, "suppression does not become permanent ready work");
  } finally { f.close(); }
});

test("a held natural opening cannot return later as an unsolicited interruption", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-05T12:00:00Z") });
  const f = fixture("natural_opening");
  try {
    const interventionId = f.queue();
    f.runtime.store.db.prepare(`UPDATE interventions SET decision='held',next_attempt_at=?,reason='temporary attention hold: fixture'
      WHERE id=?`).run(new Date(Date.now() + 31 * 60_000).toISOString(), interventionId);
    t.mock.timers.tick(31 * 60_000);
    await f.worker.runOnce();
    assert.equal(f.attempts(), 0);
    assert.equal(f.runtime.store.db.prepare("SELECT decision FROM interventions WHERE id=?").get(interventionId)!.decision, "silence");
  } finally { f.close(); }
});

test("a durable delivery retry rechecks inquiry authority in a new worker", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-05T12:00:00Z") });
  const f = fixture();
  try {
    f.retryFirst();
    f.queue();
    await f.worker.runOnce();
    assert.equal(f.attempts(), 1);
    assert.equal(f.runtime.store.listJobs("test").filter((job) => job.type === "relationship.dispatch").length, 1);
    f.decide("backstage");
    t.mock.timers.tick(61_000);
    await f.restart().drain(5);
    assert.equal(f.attempts(), 1);
    assert.equal(f.runtime.store.db.prepare("SELECT status FROM relationship_admissions").get()!.status, "suppressed");
    assert.equal(f.runtime.office.listAttention("test", "open").length, 0);
  } finally { f.close(); }
});

test("revocation after outbound claim but before effect initiation prevents the connector call", async () => {
  const f = fixture();
  try {
    f.queue();
    const worker = new RuntimeWorker(f.runtime, { videoAnalyzer: null, faultInjector: (point) => {
      if (point === "delivery.after_intent_event") f.decide("backstage");
    } });
    await worker.runOnce();
    assert.equal(f.attempts(), 0);
    const row = f.runtime.store.db.prepare("SELECT state FROM outbound_deliveries").get()!;
    assert.equal(row.state, "failed");
    assert.equal(f.runtime.store.listEvents("test", { type: "message.delivery_withheld" }).length, 1);
    assert.equal(await worker.runOnce(), false);
  } finally { f.close(); }
});

test("reallowing an inquiry does not resurrect an older withdrawn delivery decision", () => {
  const f = fixture();
  try {
    f.decide("backstage");
    const renewed = f.decide("interrupt", "New evidence establishes a different useful moment.");
    assert.ok(f.runtime.inquiries.foregroundDecisions("test", f.inquiry.id).find((decision) => decision.id === f.decision.id)?.revokedAt);
    assert.equal(f.runtime.inquiries.deliveryValidity("test", f.decision.id, f.source.id).authorized, false);
    assert.equal(f.runtime.inquiries.deliveryValidity("test", renewed.id, f.source.id).authorized, true);
    assert.equal(f.runtime.inquiries.deliveryValidity("other", renewed.id, f.source.id).authorized, false);
    assert.equal(f.runtime.inquiries.deliveryValidity("test", renewed.id, "different-source").authorized, false);
    assert.equal(f.runtime.inquiries.deliveryValidity("test", renewed.id, f.source.id, "different-session").authorized, false);
  } finally { f.close(); }
});

test("a restored inquiry retains the exact revoked decision without sending or losing its finding", async () => {
  const f = fixture();
  const home = testHome();
  const restored = new CoRuntime({ config: testConfig(home.path) });
  try {
    const interventionId = f.queue();
    f.decide("backstage");
    restored.tenantLifecycle.restoreExport({ tenantId: "test", bundle: f.runtime.tenantLifecycle.createExport("test"), confirmation: "RESTORE:test" });
    assert.equal(restored.store.db.prepare("SELECT inquiry_decision_id FROM interventions WHERE id=?").get(interventionId)!.inquiry_decision_id, f.decision.id);
    assert.equal(restored.inquiries.deliveryValidity("test", f.decision.id, f.source.id).authorized, false);
    await new RuntimeWorker(restored, { videoAnalyzer: null }).runOnce();
    assert.equal(restored.store.db.prepare("SELECT count(*) AS n FROM outbound_deliveries").get()!.n, 0);
    assert.equal(restored.inquiries.get("test", f.inquiry.id)?.finding, f.runtime.inquiries.get("test", f.inquiry.id)?.finding);
  } finally { restored.close(); home.cleanup(); f.close(); }
});

test("schema 55 migrates additively without guessing legacy inquiry authority", () => {
  const home = testHome();
  const path = `${home.path}/runtime.sqlite`;
  let store = new SqliteStore(path);
  try {
    store.appendEvent({ id: "evt_before_binding", tenantId: "test", stream: "fixture", type: "fixture.original", payload: { text: "keep this" } });
    store.db.exec(`ALTER TABLE interventions DROP COLUMN inquiry_decision_id;
      ALTER TABLE inquiry_foreground_decisions DROP COLUMN revoked_at;
      DELETE FROM schema_migrations WHERE version=56; PRAGMA user_version=55;`);
    store.close();
    store = new SqliteStore(path);
    assert.equal(store.schemaVersion(), CURRENT_SCHEMA_VERSION);
    assert.ok(store.getEvent("test", "evt_before_binding"));
    assert.ok(store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=56").get());
    assert.ok((store.db.prepare("PRAGMA table_info(interventions)").all() as Array<{ name: string }>).some((column) => column.name === "inquiry_decision_id"));
  } finally { store.close(); home.cleanup(); }
});

test("a queued legacy perceptual candidate without exact inquiry authority fails closed", async () => {
  const f = fixture();
  try {
    const interventionId = f.queue();
    f.runtime.store.db.prepare("UPDATE interventions SET inquiry_decision_id=NULL,hypothesis_id='legacy-hypothesis' WHERE id=?").run(interventionId);
    await f.worker.runOnce();
    assert.equal(f.attempts(), 0);
    assert.equal(f.runtime.store.db.prepare("SELECT decision FROM interventions WHERE id=?").get(interventionId)!.decision, "silence");
    assert.equal(f.runtime.inquiries.get("test", f.inquiry.id)?.status, "resolved");
    assert.equal(await f.worker.runOnce(), false);
  } finally { f.close(); }
});

test("pre-effect withdrawal is fenced and cannot relabel an already-started delivery", () => {
  const f = fixture();
  try {
    const claim = f.runtime.store.claimOutboundDelivery({ tenantId: "test", intentId: "withdrawal-fixture",
      requestDigest: "exact-digest", channel: "inquiry-rail", peerId: "member" });
    assert.ok(claim.claimToken);
    assert.equal(f.runtime.store.failOutboundBeforeEffect("withdrawal-fixture", "test", "stale-token", "No longer permitted"), false);
    assert.equal(f.runtime.store.failOutboundBeforeEffect("withdrawal-fixture", "other", claim.claimToken, "No longer permitted"), false);
    assert.equal(f.runtime.store.beginOutboundDelivery("withdrawal-fixture", "test", claim.claimToken), true);
    assert.equal(f.runtime.store.failOutboundBeforeEffect("withdrawal-fixture", "test", claim.claimToken, "Too late to claim nothing happened"), false);
    assert.equal(f.runtime.store.getOutboundDeliveryState("test", "withdrawal-fixture"), "running");
  } finally { f.close(); }
});
