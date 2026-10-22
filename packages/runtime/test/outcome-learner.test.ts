import assert from "node:assert/strict";
import test from "node:test";
import { AttentionGate } from "../src/attention.ts";
import type { ConnectorAdapter } from "../src/connectors.ts";
import { RuntimeMetrics } from "../src/metrics.ts";
import { CoRuntime } from "../src/runtime.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { testConfig, testHome } from "./helpers.ts";

function strongSignal(sourceEventId: string, topicKey: string, urgency = 0.8) {
  return {
    sourceEventId, topicKey, evidence: 3, novelty: 0.9, urgency, usefulness: 1,
    actionability: 0.95, confidence: 0.95, interruptionCost: 0.1,
    content: `A concrete, newly evidenced update about ${topicKey} that is worth acting on.`,
    channel: "learning-rail", peerId: "member",
  };
}

function ownerFeedback(runtime: CoRuntime, sessionId: string, id: string, text: string): string {
  const event = runtime.store.appendEvent({
    id, tenantId: "test", stream: `session:${sessionId}`, type: "message.received", payload: { text },
  });
  runtime.store.addMessage("test", sessionId, {
    id: `${id}_message`, role: "user", parts: [{ type: "text", text }], phase: "final", createdAt: event.at,
  }, event.id);
  return event.id;
}

test("verified outcome learning is exact-topic, tenant-scoped, reversible, and cannot loosen attention policy", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.autonomy = {
    ...config.autonomy, quietHoursStart: 0, quietHoursEnd: 0,
    maxDailyInterventions: 100, interventionCooldownMinutes: 0,
  };
  const runtime = new CoRuntime({ config });
  let deliveries = 0;
  const adapter: ConnectorAdapter = {
    id: "learning-rail",
    inboundPrincipal: "trusted-system",
    status: () => ({ id: "learning-rail", inboundConfigured: false, outboundConfigured: true }),
    verifyWebhook: () => false,
    parseWebhook: () => undefined,
    deliver: async () => ({ provider: "learning-rail", messageId: `learned-${++deliveries}` }),
  };
  runtime.connectors.register(adapter);
  const gate = new AttentionGate(config, runtime.store, runtime.outcomeLearner);
  const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
  const deliver = (worker as unknown as {
    deliverConnector(tenantId: string, runId: string, channel: string, peerId: string, content: string, deliveryKey: string): Promise<string>;
  }).deliverConnector.bind(worker);
  try {
    const source = runtime.store.appendEvent({
      tenantId: "test", stream: "ambient:returns", type: "calendar.changed", payload: { changed: true },
    });
    const initial = gate.evaluate("test", strongSignal(source.id, "returns-near-restaurant"));
    assert.equal(initial.send, true);
    const intervention = runtime.store.db.prepare(`SELECT id,content FROM interventions
      WHERE tenant_id=? AND source_event_id=?`).get("test", source.id) as { id: string; content: string };
    await deliver(
      "test", `intervention:${intervention.id}`, "learning-rail", "member", intervention.content,
      `intervention:${intervention.id}`,
    );
    assert.equal(deliveries, 1);
    runtime.store.db.prepare("UPDATE interventions SET accepted_at=?,created_at=? WHERE tenant_id=? AND id=?")
      .run(new Date().toISOString(), "2000-01-01T00:00:00.000Z", "test", intervention.id);

    const queuedSource = runtime.store.appendEvent({
      tenantId: "test", stream: "ambient:returns", type: "calendar.changed", payload: { queuedBeforeFeedback: true },
    });
    assert.equal(gate.evaluate("test", strongSignal(queuedSource.id, "returns-near-restaurant")).send, true);
    const queued = runtime.store.db.prepare("SELECT id FROM interventions WHERE tenant_id=? AND source_event_id=?")
      .get("test", queuedSource.id) as { id: string };
    runtime.store.db.prepare("UPDATE interventions SET created_at=?,attention_reserved_at=? WHERE tenant_id=? AND id=?")
      .run("2000-01-02T00:00:00.000Z", "2000-01-02T00:00:00.000Z", "test", queued.id);
    const heldSource = runtime.store.appendEvent({
      tenantId: "test", stream: "ambient:returns", type: "calendar.changed", payload: { heldBeforeFeedback: true },
    });
    assert.equal(gate.evaluate("test", strongSignal(heldSource.id, "returns-near-restaurant")).send, true);
    const held = runtime.store.db.prepare("SELECT id FROM interventions WHERE tenant_id=? AND source_event_id=?")
      .get("test", heldSource.id) as { id: string };
    runtime.store.db.prepare(`UPDATE interventions
      SET decision='held',reason='temporary attention hold: test fixture',next_attempt_at='2000-01-01T00:00:00.000Z'
      WHERE tenant_id=? AND id=?`).run("test", held.id);

    const session = runtime.store.ensureSession("test", "learning-rail", "member");
    const annoyedEventId = ownerFeedback(runtime, session.id, "owner_annoyed", "That reminder was annoying and repetitive.");
    const annoyed = runtime.outcomes.record({
      tenantId: "test", sessionId: session.id, sourceEventId: annoyedEventId,
      kind: "annoying", evidenceQuote: "reminder was annoying",
    });
    const negative = runtime.outcomeLearner.guidance("test", "returns-near-restaurant");
    assert.equal(negative.disposition, "suppress");
    assert.equal(negative.feedbackId, annoyed.id);
    assert.equal(negative.interventionId, intervention.id);
    assert.equal(runtime.store.listEvents("test", { type: "product.outcome_learning_recorded" }).length, 1);
    const negativeMetrics = runtime.outcomes.summary("test");
    assert.equal(negativeMetrics.proactiveAccepted, 1);
    assert.equal(negativeMetrics.proactiveDelivered, 0, "provider acceptance is not silently counted as delivered");
    assert.equal(negativeMetrics.proactiveRatedMessages, 1);
    assert.equal(negativeMetrics.proactiveFeedbackCoverageRatio, 1);
    assert.equal(negativeMetrics.proactiveByKind.annoying, 1);
    assert.equal(negativeMetrics.proactiveGoodResponseRatio, 0);
    assert.equal(negativeMetrics.proactiveObviousOrAnnoyingResponseRatio, 1);
    assert.equal(negativeMetrics.proactiveRatedObviousOrAnnoyingRatio, 1);
    const negativePrometheus = new RuntimeMetrics().render(runtime);
    assert.match(negativePrometheus, /co_product_proactive_feedback_total\{kind="annoying"\} 1/);
    assert.match(negativePrometheus, /co_product_proactive_interventions_total\{state="accepted"\} 1/);
    assert.match(negativePrometheus, /co_product_proactive_interventions_total\{state="delivered"\} 0/);
    assert.match(negativePrometheus, /co_product_proactive_obvious_or_annoying_response_ratio 1/);

    assert.equal(await worker.runOnce(), true);
    assert.equal(deliveries, 1, "feedback arriving after admission suppresses queued work before the provider call");
    const deferred = runtime.store.db.prepare("SELECT id,decision,next_attempt_at FROM interventions WHERE id IN (?,?) ORDER BY id")
      .all(queued.id, held.id) as Array<{ id: string; decision: string; next_attempt_at: string | null }>;
    assert.equal(deferred.length, 2);
    assert.ok(deferred.every((row) => row.decision === "silence" && row.next_attempt_at === null),
      "feedback also prevents a previously held interruption from reactivating later");

    const repeatedSource = runtime.store.appendEvent({
      tenantId: "test", stream: "ambient:returns", type: "calendar.changed", payload: { changed: false },
    });
    const suppressed = gate.evaluate("test", strongSignal(repeatedSource.id, "returns-near-restaurant"));
    assert.equal(suppressed.send, false);
    assert.match(suppressed.reason, /owner outcome gate.*annoying/);

    const otherTopicSource = runtime.store.appendEvent({
      tenantId: "test", stream: "ambient:flight", type: "calendar.changed", payload: { changed: true },
    });
    assert.equal(gate.evaluate("test", strongSignal(otherTopicSource.id, "flight-change")).send, true,
      "negative feedback does not suppress an unrelated topic");
    assert.equal(gate.evaluate("other-tenant", strongSignal("other_source", "returns-near-restaurant")).send, true,
      "one member's feedback cannot alter another tenant's policy");

    const urgentSource = runtime.store.appendEvent({
      tenantId: "test", stream: "ambient:returns", type: "calendar.changed", payload: { deadlineToday: true },
    });
    const urgent = gate.evaluate("test", strongSignal(urgentSource.id, "returns-near-restaurant", 1));
    assert.equal(urgent.send, true, "a materially changed, exceptionally urgent operational fact may still break through");
    assert.match(urgent.reason, /suppression overridden only/);

    const correctionEventId = ownerFeedback(runtime, session.id, "owner_correction", "Correction: that original reminder was actually useful.");
    const correction = runtime.outcomes.record({
      tenantId: "test", sessionId: session.id, sourceEventId: correctionEventId,
      kind: "useful", evidenceQuote: "reminder was actually useful",
    });
    assert.notEqual(correction.id, annoyed.id);
    assert.equal(runtime.outcomes.list("test").length, 2, "the corrected and original statements both remain in history");
    const positive = runtime.outcomeLearner.guidance("test", "returns-near-restaurant");
    assert.equal(positive.disposition, "positive");
    assert.equal(positive.feedbackId, correction.id, "the later owner statement controls the current projection");
    const correctedMetrics = runtime.outcomes.summary("test");
    assert.equal(correctedMetrics.proactiveRatedMessages, 1, "a correction supersedes instead of double-counting the target");
    assert.equal(correctedMetrics.proactiveByKind.annoying, 0);
    assert.equal(correctedMetrics.proactiveByKind.useful, 1);
    assert.equal(correctedMetrics.proactiveGoodResponseRatio, 1);
    assert.equal(correctedMetrics.proactiveObviousOrAnnoyingResponseRatio, 0);
    assert.equal(correctedMetrics.proactiveRatedGoodResponseRatio, 1);
    assert.equal(correctedMetrics.tenureMonths.reduce((sum, month) => sum + month.proactiveRatedMessages, 0), 1);

    const weakSource = runtime.store.appendEvent({
      tenantId: "test", stream: "ambient:returns", type: "calendar.changed", payload: { noise: true },
    });
    const weak = gate.evaluate("test", {
      ...strongSignal(weakSource.id, "returns-near-restaurant"), evidence: 1, novelty: 0.1, urgency: 0,
      usefulness: 0.1, actionability: 0, confidence: 0.6, interruptionCost: 0.9,
    });
    assert.equal(weak.send, false, "positive feedback cannot raise a weak signal above the ordinary threshold");
    assert.doesNotMatch(weak.reason, /owner outcome gate/);

    const events = runtime.store.listEvents("test", { type: "product.outcome_learning_recorded" });
    assert.equal(events.length, 2, "both learning inputs remain auditable");
    assert.equal(runtime.outcomeLearner.guidance("other-tenant", "returns-near-restaurant").disposition, "none");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("unlinked conversational praise is measured but cannot change proactive policy", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const session = runtime.store.ensureSession("test", "imessage", "member");
    runtime.store.addMessage("test", session.id, {
      id: "ordinary_answer", role: "assistant", parts: [{ type: "text", text: "A useful but ordinary conversational answer." }],
      phase: "final", createdAt: "2026-01-01T00:00:00.000Z",
    });
    const eventId = ownerFeedback(runtime, session.id, "ordinary_praise", "That answer was useful.");
    const feedback = runtime.outcomes.record({
      tenantId: "test", sessionId: session.id, sourceEventId: eventId, kind: "useful", evidenceQuote: "answer was useful",
    });
    assert.equal(feedback.proactive, false);
    assert.equal(runtime.outcomes.summary("test").proactiveRatedMessages, 0);
    assert.equal(runtime.outcomeLearner.guidance("test", "any-topic").disposition, "none");
    const learned = runtime.store.listEvents("test", { type: "product.outcome_learning_recorded" });
    assert.equal(learned.length, 1);
    assert.equal((learned[0]!.payload as { appliedToAttentionPolicy?: boolean }).appliedToAttentionPolicy, false);
    assert.equal((learned[0]!.payload as { feedbackId?: string }).feedbackId, feedback.id);
    assert.throws(() => runtime.outcomeLearner.record({
      id: feedback.id, tenantId: "other-tenant", targetMessageId: feedback.targetMessageId,
      sourceEventId: feedback.sourceEventId, kind: feedback.kind,
    }), /exact canonical member feedback row/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});
