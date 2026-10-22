import assert from "node:assert/strict";
import test from "node:test";
import { AttentionGate } from "../src/attention.ts";
import { SqliteStore } from "../src/store.ts";
import { testConfig, testHome } from "./helpers.ts";

test("attention gate suppresses weak signals and repeated pings", () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.autonomy = { ...config.autonomy, quietHoursStart: 0, quietHoursEnd: 0 };
  const store = new SqliteStore(config.dbPath);
  const gate = new AttentionGate(config, store);
  try {
    const weak = gate.evaluate("test", {
      sourceEventId: "e1", topicKey: "mug", evidence: 1, novelty: 0.2, urgency: 0, usefulness: 0.1,
      actionability: 0, confidence: 0.6, interruptionCost: 0.9, content: "The mug moved.",
    });
    assert.equal(weak.send, false);
    const strong = gate.evaluate("test", {
      sourceEventId: "e2", topicKey: "flight", evidence: 3, novelty: 0.9, urgency: 1, usefulness: 1,
      actionability: 0.9, confidence: 0.95, interruptionCost: 0.1, content: "Your flight moved two hours earlier; leave by 4:10.",
    });
    assert.equal(strong.send, true);
    const repeat = gate.evaluate("test", {
      sourceEventId: "e3", topicKey: "flight", evidence: 3, novelty: 0.9, urgency: 1, usefulness: 1,
      actionability: 0.9, confidence: 0.95, interruptionCost: 0.1, content: "Same flight warning again.",
    });
    assert.equal(repeat.send, false);
    assert.match(repeat.reason, /cooldown/);
    const held = store.db.prepare("SELECT id,decision,next_attempt_at FROM interventions WHERE tenant_id=? AND source_event_id=?")
      .get("test", "e3") as { id: string; decision: string; next_attempt_at: string | null };
    assert.equal(held.decision, "held");
    assert.ok(held.next_attempt_at);
    store.db.prepare("UPDATE interventions SET created_at=?,attention_reserved_at=? WHERE tenant_id=? AND source_event_id=?")
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "test", "e2");
    store.db.prepare("UPDATE interventions SET next_attempt_at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", held.id);
    assert.equal(gate.reactivateOneDue("test"), true);
    assert.equal((store.db.prepare("SELECT decision,next_attempt_at FROM interventions WHERE id=?").get(held.id) as {
      decision: string; next_attempt_at: string | null;
    }).decision, "send");
    assert.equal(store.listEvents("test", { type: "intervention.reactivated" }).length, 1);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("perceptual attention requires specificity and suppresses generic introspection", () => {
  const home = testHome();
  const config = testConfig(home.path);
  const store = new SqliteStore(config.dbPath);
  const gate = new AttentionGate(config, store);
  try {
    const generic = gate.evaluate("test", {
      kind: "perceptual", sourceEventId: "e4", hypothesisId: "phy_generic", topicKey: "generic-growth",
      evidence: 4, novelty: 0.7, urgency: 0, usefulness: 0.7, actionability: 0, confidence: 0.88, interruptionCost: 0.2,
      perceptualValue: 0.75, specificity: 0.42, temporalBreadth: 1, genericity: 0.78, sensitivity: 0.2,
      content: "You seem introspective and should take more action.",
    });
    assert.equal(generic.send, false);
    assert.match(generic.reason, /weak|generic|interruptive/);

    const earned = gate.evaluate("test", {
      kind: "perceptual", sourceEventId: "e5", hypothesisId: "phy_earned", topicKey: "authorship-vs-status",
      evidence: 4, novelty: 0.9, urgency: 0, usefulness: 0.95, actionability: 0, confidence: 0.9, interruptionCost: 0.1,
      perceptualValue: 0.95, specificity: 0.94, temporalBreadth: 1, genericity: 0.05, sensitivity: 0.1,
      content: "One possibility: your energy has tracked authorship of the premise more closely than the project's status.",
    });
    assert.equal(earned.send, false, "a score without retrieved comparison evidence cannot establish novelty");
    assert.equal(earned.knownness.status, "uncertain");
  } finally {
    store.close();
    home.cleanup();
  }
});

test("high lexical overlap holds an optional intervention without pretending to establish semantic equivalence", () => {
  const home = testHome();
  const config = testConfig(home.path);
  const store = new SqliteStore(config.dbPath);
  const gate = new AttentionGate(config, store);
  try {
    const known = store.appendEvent({
      tenantId: "test", stream: "session:known", type: "message.received",
      payload: { text: "My Amazon return deadline is Friday." },
    });
    store.indexEvidence({
      tenantId: "test", sourceEventId: known.id, kind: "conversation.user", trustClass: "owner",
      content: "My Amazon return deadline is Friday.", observedAt: known.at, metadata: {},
    });
    const trigger = store.appendEvent({ tenantId: "test", stream: "ambient:return", type: "calendar.changed", payload: {} });
    const decision = gate.evaluate("test", {
      sourceEventId: trigger.id, topicKey: "amazon-return", evidence: 2, novelty: 0.9, urgency: 0.9,
      usefulness: 1, actionability: 0.9, confidence: 0.95, interruptionCost: 0.05,
      content: "Your Amazon return deadline is Friday.",
    });
    assert.equal(decision.send, false);
    assert.equal(decision.knownness.status, "uncertain");
    assert.equal(decision.knownness.matchedSourceEventId, known.id);
    assert.match(decision.reason, /knownness gate/);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("knownness does not add a model call or suppress a genuinely changed implication", () => {
  const home = testHome();
  const config = testConfig(home.path);
  const store = new SqliteStore(config.dbPath);
  const gate = new AttentionGate(config, store);
  try {
    const prior = store.appendEvent({ tenantId: "test", stream: "session:flight", type: "message.received", payload: { text: "My flight leaves at 8 PM." } });
    store.indexEvidence({ tenantId: "test", sourceEventId: prior.id, kind: "conversation.user", trustClass: "owner", content: "My flight leaves at 8 PM.", observedAt: prior.at, metadata: {} });
    const changed = store.appendEvent({ tenantId: "test", stream: "calendar:flight", type: "calendar.changed", payload: {} });
    const decision = gate.evaluate("test", {
      sourceEventId: changed.id, topicKey: "flight-change", evidence: 2, novelty: 0.95, urgency: 1,
      usefulness: 1, actionability: 1, confidence: 0.98, interruptionCost: 0.05,
      content: "Your flight moved two hours earlier; leave by 4:10.",
    });
    assert.equal(decision.send, true);
    assert.equal(decision.knownness.status, "new", "retrieved prior evidence establishes that the changed implication adds a delta");
  } finally {
    store.close();
    home.cleanup();
  }
});

test("reactivated holds reserve today's attention budget even when their candidates are old", () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.autonomy = { ...config.autonomy, maxDailyInterventions: 1, quietHoursStart: 0, quietHoursEnd: 24 };
  const store = new SqliteStore(config.dbPath);
  const gate = new AttentionGate(config, store);
  try {
    for (const [sourceEventId, topicKey, content] of [
      ["held-flight", "flight", "Your flight changed; the verified departure is now six tomorrow."],
      ["held-return", "return", "Your verified return window closes tomorrow at five."],
    ] as const) {
      const decision = gate.evaluate("test", {
        sourceEventId, topicKey, content, evidence: 3, novelty: 0.95, urgency: 0.8,
        usefulness: 1, actionability: 1, confidence: 0.98, interruptionCost: 0.02,
      });
      assert.equal(decision.send, false);
      assert.match(decision.reason, /quiet hours/);
    }
    store.db.prepare(`UPDATE interventions SET created_at='2000-01-01T00:00:00.000Z',next_attempt_at='2000-01-01T00:00:00.000Z'`).run();
    config.autonomy.quietHoursEnd = 0;
    assert.equal(gate.reactivateOneDue("test"), true);
    assert.equal(gate.reactivateOneDue("test"), true);
    const rows = store.db.prepare("SELECT decision,attention_reserved_at,next_attempt_at FROM interventions ORDER BY topic_key").all() as Array<{
      decision: string; attention_reserved_at: string | null; next_attempt_at: string | null;
    }>;
    assert.equal(rows.filter((row) => row.decision === "send").length, 1);
    assert.equal(rows.filter((row) => row.decision === "held").length, 1);
    assert.ok(rows.find((row) => row.decision === "send")?.attention_reserved_at?.startsWith(new Date().toISOString().slice(0, 10)));
    assert.ok(rows.find((row) => row.decision === "held")?.next_attempt_at);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("a held intervention is suppressed when newer owner evidence makes it redundant", () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.autonomy = { ...config.autonomy, quietHoursStart: 0, quietHoursEnd: 24 };
  const store = new SqliteStore(config.dbPath);
  const gate = new AttentionGate(config, store);
  try {
    const decision = gate.evaluate("test", {
      sourceEventId: "return-window-source", topicKey: "return-window", evidence: 2, novelty: 0.9, urgency: 0.7,
      usefulness: 1, actionability: 0.8, confidence: 0.95, interruptionCost: 0.05,
      content: "Your Amazon return deadline is Friday.",
    });
    assert.equal(decision.send, false);
    assert.match(decision.reason, /quiet hours/);
    const owner = store.appendEvent({
      tenantId: "test", stream: "session:return", type: "message.received",
      payload: { text: "My Amazon return deadline is Friday." },
    });
    store.indexEvidence({
      tenantId: "test", sourceEventId: owner.id, kind: "conversation.user", trustClass: "owner",
      content: "My Amazon return deadline is Friday.", observedAt: owner.at, metadata: {},
    });
    store.db.prepare("UPDATE interventions SET next_attempt_at='2000-01-01T00:00:00.000Z' WHERE source_event_id=?")
      .run("return-window-source");
    config.autonomy.quietHoursEnd = 0;
    assert.equal(gate.reactivateOneDue("test"), true);
    const row = store.db.prepare("SELECT decision,reason FROM interventions WHERE source_event_id=?")
      .get("return-window-source") as { decision: string; reason: string };
    assert.equal(row.decision, "silence");
    assert.match(row.reason, /revalidation/);
    assert.match(row.reason, /semantic delta/);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("knownness preserves negation and will not suppress an opposite claim as a restatement", () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.autonomy = { ...config.autonomy, quietHoursStart: 0, quietHoursEnd: 0 };
  const store = new SqliteStore(config.dbPath);
  const gate = new AttentionGate(config, store);
  try {
    const owner = store.appendEvent({
      tenantId: "test", stream: "session:move", type: "message.received",
      payload: { text: "I do not want to move to London." },
    });
    store.indexEvidence({
      tenantId: "test", sourceEventId: owner.id, kind: "conversation.user", trustClass: "owner",
      content: "I do not want to move to London.", observedAt: owner.at, metadata: {},
    });
    const trigger = store.appendEvent({ tenantId: "test", stream: "ambient:move", type: "calendar.changed", payload: {} });
    const decision = gate.evaluate("test", {
      sourceEventId: trigger.id, topicKey: "move", evidence: 2, novelty: 0.9, urgency: 0.7,
      usefulness: 1, actionability: 0.8, confidence: 0.95, interruptionCost: 0.05,
      content: "You want to move to London.",
    });
    assert.equal(decision.send, false);
    assert.equal(decision.knownness.status, "uncertain");
    assert.equal(decision.knownness.polarityConflict, true);
    assert.match(decision.reason, /reverses the polarity/);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("perceptual attention accepts a bounded semantic paraphrase veto after cheap local comparison", () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.autonomy = { ...config.autonomy, quietHoursStart: 0, quietHoursEnd: 0 };
  const store = new SqliteStore(config.dbPath);
  const gate = new AttentionGate(config, store);
  try {
    const owner = store.appendEvent({
      tenantId: "test", stream: "session:paraphrase", type: "message.received",
      payload: { text: "I feel energized when I choose the premise myself." },
    });
    const trigger = store.appendEvent({ tenantId: "test", stream: "perception:paraphrase", type: "perception.assessed", payload: {} });
    const decision = gate.evaluate("test", {
      kind: "perceptual", sourceEventId: trigger.id, hypothesisId: "phy_paraphrase", topicKey: "creative-authorship",
      evidence: 4, novelty: 0.9, urgency: 0, usefulness: 0.95, actionability: 0, confidence: 0.92,
      interruptionCost: 0.05, perceptualValue: 0.96, specificity: 0.95, temporalBreadth: 1,
      genericity: 0.03, sensitivity: 0.1,
      content: "One possibility: Projects feel alive when the original direction belongs to you.",
      verifiedKnownness: {
        status: "known", score: 1, reason: "semantic knownness gate: this paraphrases the owner's existing conclusion",
        matchedSourceEventId: owner.id,
      },
    });
    assert.equal(decision.send, false);
    assert.equal(decision.knownness.status, "known");
    assert.equal(decision.knownness.matchedSourceEventId, owner.id);
    assert.match(decision.reason, /semantic knownness gate/);
  } finally {
    store.close();
    home.cleanup();
  }
});
