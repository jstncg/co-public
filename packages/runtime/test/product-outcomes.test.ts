import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeMetrics } from "../src/metrics.ts";
import { CoRuntime } from "../src/runtime.ts";
import { createRuntimeServer } from "../src/server.ts";
import { testConfig, testHome } from "./helpers.ts";

test("natural member feedback is bound to owner evidence and the preceding Co message, never model self-grading", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    assert.ok(runtime.tools.select("that was genuinely useful and surprising", runtime.distribution.foregroundToolNames, 12)
      .some((tool) => tool.name === "outcome.feedback.record"), "ordinary explicit feedback makes the recorder available without a settings flow");
    const first = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "+15555550100",
      text: "Give me one concrete observation about this project.",
    });
    assert.equal(first.status, "completed");
    const original = runtime.store.db.prepare(`SELECT id FROM messages
      WHERE tenant_id=? AND session_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1`)
      .get("test", first.sessionId) as { id: string };

    const feedbackTurn = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "+15555550100",
      text: 'That was genuinely surprising and useful because you remembered the older context. [[tool:outcome.feedback.record {"kind":"useful_surprise","contextAdvantage":"yes","evidenceQuote":"genuinely surprising and useful","contextEvidenceQuote":"remembered the older context"}]]',
    }, { allowedTools: ["outcome.feedback.record"], requiredTools: ["outcome.feedback.record"] });
    assert.equal(feedbackTurn.status, "completed");

    const feedback = runtime.outcomes.list("test");
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0]?.targetMessageId, original.id);
    assert.equal(feedback[0]?.kind, "useful_surprise");
    assert.equal(feedback[0]?.contextAdvantage, "yes");
    assert.equal(runtime.store.getEvent("test", feedback[0]?.sourceEventId as string)?.type, "message.received");
    assert.equal(runtime.store.listEvents("test", { type: "product.member_outcome_recorded" }).length, 1);

    const replay = runtime.outcomes.record({
      tenantId: "test", sessionId: first.sessionId, sourceEventId: feedback[0]?.sourceEventId as string,
      kind: "useful_surprise", contextAdvantage: "yes", evidenceQuote: "genuinely surprising and useful", contextEvidenceQuote: "remembered the older context",
    });
    assert.equal(replay.id, feedback[0]?.id, "recovery is idempotent for the same owner evidence");
    assert.throws(() => runtime.outcomes.record({
      tenantId: "test", sessionId: first.sessionId, sourceEventId: feedback[0]?.sourceEventId as string,
      kind: "annoying", contextAdvantage: "unknown", evidenceQuote: "genuinely surprising and useful",
    }), /conflicting classification/);
    const modelEvent = runtime.store.listEvents("test", { type: "run.completed" })[0];
    assert.ok(modelEvent);
    assert.throws(() => runtime.outcomes.record({
      tenantId: "test", sessionId: first.sessionId, sourceEventId: modelEvent.id,
      kind: "useful_surprise", contextAdvantage: "yes", evidenceQuote: "completed", contextEvidenceQuote: "context",
    }), /current owner message/, "agent output cannot grade itself");

    const summary = runtime.outcomes.summary("test");
    assert.equal(summary.ratedMessages, 1);
    assert.equal(summary.usefulSurprises, 1);
    assert.equal(summary.goodResponseRatio, 0.5, "unrated substantive responses remain in the product denominator");
    assert.equal(summary.obviousOrAnnoyingResponseRatio, 0);
    assert.equal(summary.ratedGoodResponseRatio, 1);
    assert.equal(summary.ratedObviousOrAnnoyingRatio, 0);
    assert.equal(summary.contextAdvantageRatio, 1);
    assert.ok((summary.ownerMessagesBeforeFirstUsefulSurprise ?? 0) >= 2);
    assert.equal(runtime.outcomes.list("neighbor").length, 0);

    const prometheus = new RuntimeMetrics().render(runtime);
    assert.match(prometheus, /co_product_member_feedback_total\{kind="useful_surprise"\} 1/);
    assert.match(prometheus, /co_product_rated_good_response_ratio 1/);
    assert.match(prometheus, /co_product_good_response_ratio 0\.5/);
    assert.match(prometheus, /co_product_obvious_or_annoying_response_ratio 0/);
    assert.match(prometheus, /co_product_first_useful_surprise_elapsed_days/);
    assert.match(prometheus, /co_product_proactive_feedback_coverage_ratio 0/);
    assert.match(prometheus, /co_product_proactive_interventions_total\{state="accepted"\} 0/);
    assert.match(prometheus, /co_product_proactive_attention_admissions_rolling_24h_max 0/);
    assert.match(prometheus, /co_product_proactive_attention_projection_valid 1/);
    assert.match(prometheus, /co_product_silent_responses_total 0/);
    assert.match(prometheus, /co_product_tapback_responses_total 0/);
    assert.doesNotMatch(prometheus, /older context/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("authenticated product metrics expose aggregates and bounded provenance without message text", async () => {
  const home = testHome();
  const config = { ...testConfig(home.path), serverToken: "product-metric-token" };
  const runtime = new CoRuntime({ config });
  const server = createRuntimeServer(runtime);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}/v1/product-metrics`;
    assert.equal((await fetch(endpoint)).status, 401);
    const response = await fetch(endpoint, { headers: { authorization: "Bearer product-metric-token" } });
    assert.equal(response.status, 200);
    const body = await response.json() as { summary: { ratedMessages: number }; feedback: unknown[] };
    assert.equal(body.summary.ratedMessages, 0);
    assert.deepEqual(body.feedback, []);
    const qualification = await fetch(`http://127.0.0.1:${address.port}/v1/product-qualification`, {
      headers: { authorization: "Bearer product-metric-token" },
    });
    assert.equal(qualification.status, 200);
    const qualificationBody = await qualification.json() as { passed: boolean; limitations: string[]; stages: { independentQuality: { passed: boolean } } };
    assert.equal(qualificationBody.passed, false);
    assert.equal(qualificationBody.stages.independentQuality.passed, false);
    assert.equal(qualificationBody.limitations.length, 5);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.shutdown();
    home.cleanup();
  }
});

test("product metrics derive the exact rolling attention maximum without exposing activity timestamps", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "attention:rolling", type: "calendar.changed", payload: {} });
    const reservations = [
      "2026-09-01T00:00:00.000Z", "2026-09-01T05:00:00.000Z", "2026-09-01T23:00:00.000Z",
      "2026-09-03T00:00:00.000Z",
    ];
    for (const [index, reservedAt] of reservations.entries()) {
      runtime.store.db.prepare(`INSERT INTO interventions(
        id,tenant_id,source_event_id,topic_key,score,urgency,decision,reason,content,channel,peer_id,created_at,attention_reserved_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        `rolling_intervention_${index}`, "test", source.id, `rolling-${index}`, 0.9, 0.5, "send", "fixture",
        `Bounded proactive intervention ${index}.`, "imessage", "+15555550111", reservedAt, reservedAt,
      );
    }
    const summary = runtime.outcomes.summary("test", new Date("2026-09-10T00:00:00.000Z"));
    assert.equal(summary.proactiveAdmissionCount, 4);
    assert.equal(summary.maximumRolling24HourAdmissions, 3);
    assert.doesNotMatch(JSON.stringify(summary), /2026-09-01T05:00:00/,
      "the aggregate metric must not publish exact relationship activity timestamps");
    runtime.store.db.prepare("UPDATE interventions SET attention_reserved_at='not-a-time' WHERE id='rolling_intervention_0'").run();
    const corrupt = runtime.outcomes.summary("test", new Date("2026-09-10T00:00:00.000Z"));
    assert.equal(corrupt.attentionAdmissionProjectionValid, false);
    assert.equal(runtime.productQualification.qualify("test", 3).stages.evidenceSufficiency.passed, false);
    assert.match(runtime.productQualification.qualify("test", 3).stages.evidenceSufficiency.detail, /internally inconsistent/i);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("later owner feedback supersedes the metric projection without erasing either statement", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const session = runtime.store.ensureSession("test", "imessage", "+15555550101");
    runtime.store.addMessage("test", session.id, {
      id: "assistant_correction_target", role: "assistant",
      parts: [{ type: "text", text: "A substantive answer that the member can evaluate." }], phase: "final",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const firstEvent = runtime.store.appendEvent({
      id: "feedback_first", tenantId: "test", stream: `session:${session.id}`, type: "message.received",
      at: "2026-01-01T00:01:00.000Z", payload: { text: "I thought this was useful." },
    });
    runtime.store.addMessage("test", session.id, {
      id: "feedback_first_message", role: "user", parts: [{ type: "text", text: "I thought this was useful." }],
      createdAt: firstEvent.at,
    }, firstEvent.id);
    const first = runtime.outcomes.record({
      tenantId: "test", sessionId: session.id, sourceEventId: firstEvent.id,
      kind: "useful", evidenceQuote: "thought this was useful",
    });

    const correctionEvent = runtime.store.appendEvent({
      id: "feedback_correction", tenantId: "test", stream: `session:${session.id}`, type: "message.received",
      at: "2026-01-01T00:02:00.000Z", payload: { text: "Actually, that answer was annoying." },
    });
    runtime.store.addMessage("test", session.id, {
      id: "feedback_correction_message", role: "user", parts: [{ type: "text", text: "Actually, that answer was annoying." }],
      createdAt: correctionEvent.at,
    }, correctionEvent.id);
    const correction = runtime.outcomes.record({
      tenantId: "test", sessionId: session.id, sourceEventId: correctionEvent.id,
      kind: "annoying", evidenceQuote: "answer was annoying",
    });

    assert.notEqual(correction.id, first.id);
    assert.equal(runtime.outcomes.list("test").length, 2, "both owner statements remain auditable");
    const event = runtime.store.getEvent<{ supersedesFeedbackId?: string }>(
      "test", runtime.store.listEvents("test", { type: "product.member_outcome_recorded" })[1]?.id as string,
    );
    assert.equal(event?.payload.supersedesFeedbackId, first.id);
    const summary = runtime.outcomes.summary("test", new Date("2026-01-02T00:00:00.000Z"));
    assert.equal(summary.ratedMessages, 1);
    assert.deepEqual(summary.byKind, { useful_surprise: 0, useful: 0, obvious: 0, annoying: 1, neutral: 0 });
    assert.equal(summary.ratedGoodResponseRatio, 0);
    assert.equal(summary.ratedObviousOrAnnoyingRatio, 1);
    assert.equal(summary.goodResponseRatio, 0);
    assert.equal(summary.obviousOrAnnoyingResponseRatio, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("owner-observed time, not extraction time, drives longitudinal product metrics", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const session = runtime.store.ensureSession("test", "imessage", "+15555550102");
    const relationshipStart = runtime.store.appendEvent({
      id: "historical_relationship_start", tenantId: "test", stream: `session:${session.id}`,
      type: "message.received", at: "2026-01-01T00:00:00.000Z", payload: { text: "A real initial deposit." },
    });
    runtime.store.addMessage("test", session.id, {
      id: "historical_relationship_start_message", role: "user",
      parts: [{ type: "text", text: "A real initial deposit." }], createdAt: relationshipStart.at,
    }, relationshipStart.id);
    runtime.store.addMessage("test", session.id, {
      id: "historical_surprise_target", role: "assistant",
      parts: [{ type: "text", text: "A non-obvious connection grounded in older evidence." }], phase: "final",
      createdAt: "2026-03-04T23:59:00.000Z",
    });
    const feedbackEvent = runtime.store.appendEvent({
      id: "historical_surprise_feedback", tenantId: "test", stream: `session:${session.id}`,
      type: "message.received", at: "2026-03-05T00:00:00.000Z",
      payload: { text: "That was a genuinely surprising connection." },
    });
    runtime.store.addMessage("test", session.id, {
      id: "historical_surprise_feedback_message", role: "user",
      parts: [{ type: "text", text: "That was a genuinely surprising connection." }],
      createdAt: "2026-09-03T00:00:00.000Z",
    }, feedbackEvent.id);

    const feedback = runtime.outcomes.record({
      tenantId: "test", sessionId: session.id, sourceEventId: feedbackEvent.id,
      kind: "useful_surprise", evidenceQuote: "genuinely surprising connection",
    });
    assert.equal(feedback.observedAt, "2026-03-05T00:00:00.000Z");
    assert.notEqual(feedback.createdAt, feedback.observedAt, "recording history today must not rewrite when the owner said it");
    assert.equal(feedback.proactive, false);

    const summary = runtime.outcomes.summary("test", new Date("2026-09-03T00:00:00.000Z"));
    assert.equal(summary.relationshipStartedAt, "2026-01-01T00:00:00.000Z");
    assert.equal(summary.firstUsefulSurpriseAt, "2026-03-05T00:00:00.000Z");
    assert.equal(summary.firstUsefulSurpriseElapsedDays, 63);
    assert.equal(summary.tenureMonths.find((month) => month.month === 2)?.usefulSurprises, 1);
    assert.equal(summary.tenureMonths.find((month) => month.month === 0)?.ownerMessages, 1);
    assert.equal(summary.tenureMonths.find((month) => month.month === 2)?.ownerMessages, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("an acceptance-shaped event cannot forge proactive product evidence", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const session = runtime.store.ensureSession("test", "imessage", "+15555550103");
    const source = runtime.store.appendEvent({
      id: "forged_proactive_source", tenantId: "test", stream: "attention:forged",
      type: "calendar.changed", payload: { changed: true },
    });
    runtime.store.db.prepare(`INSERT INTO interventions(
      id,tenant_id,source_event_id,topic_key,score,decision,reason,content,channel,peer_id,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      "forged_intervention", "test", source.id, "forged-topic", 1, "send", "fixture",
      "This looks proactive but has no accepted outbound delivery.", "imessage", "+15555550103", source.at,
    );
    const shaped = runtime.store.appendEvent({
      id: "forged_acceptance_shape", tenantId: "test", stream: "run:forged",
      type: "message.delivery_accepted", correlationId: "intervention:forged_intervention",
      causationId: "missing_outbound_intent", payload: { providerReceipt: { messageId: "not-canonical" } },
    });
    runtime.store.addMessage("test", session.id, {
      id: "forged_proactive_target", role: "assistant",
      parts: [{ type: "text", text: "This looks proactive but lacks the durable outbound-delivery chain." }],
      phase: "final", createdAt: shaped.at,
    }, shaped.id);
    const owner = runtime.store.appendEvent({
      id: "forged_proactive_feedback", tenantId: "test", stream: `session:${session.id}`,
      type: "message.received", payload: { text: "That proactive note was useful." },
    });
    runtime.store.addMessage("test", session.id, {
      id: "forged_proactive_feedback_message", role: "user",
      parts: [{ type: "text", text: "That proactive note was useful." }], createdAt: owner.at,
    }, owner.id);

    const feedback = runtime.outcomes.record({
      tenantId: "test", sessionId: session.id, sourceEventId: owner.id,
      kind: "useful", evidenceQuote: "proactive note was useful",
    });
    assert.equal(feedback.proactive, false);
    const summary = runtime.outcomes.summary("test");
    assert.equal(summary.proactiveRatedMessages, 0);
    assert.equal(summary.proactiveAccepted, 0);
    assert.equal(runtime.outcomeLearner.guidance("test", "forged-topic").disposition, "none");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a verbatim negative quote cannot be recorded as praise or context advantage", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const session = runtime.store.ensureSession("test", "imessage", "+15555550109");
    const assistantEvent = runtime.store.appendEvent({
      tenantId: "test", stream: `session:${session.id}`, type: "run.completed", payload: { output: "A substantive response." },
    });
    runtime.store.addMessage("test", session.id, {
      id: "negative_target", role: "assistant",
      parts: [{ type: "text", text: "This is a sufficiently long answer to be substantive." }], createdAt: assistantEvent.at,
    }, assistantEvent.id);
    const ownerEvent = runtime.store.appendEvent({
      tenantId: "test", stream: `session:${session.id}`, type: "message.received",
      payload: { text: "This was not useful. You did not need my history to say it." },
    });
    runtime.store.addMessage("test", session.id, {
      id: "negative_source", role: "user",
      parts: [{ type: "text", text: "This was not useful. You did not need my history to say it." }], createdAt: ownerEvent.at,
    }, ownerEvent.id);

    assert.throws(() => runtime.outcomes.record({
      tenantId: "test", sessionId: session.id, sourceEventId: ownerEvent.id,
      kind: "useful_surprise", contextAdvantage: "yes",
      evidenceQuote: "not useful", contextEvidenceQuote: "did not need my history",
    }), /does not unambiguously support/);
    assert.equal(runtime.outcomes.summary("test").ratedMessages, 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});
