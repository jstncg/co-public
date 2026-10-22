import assert from "node:assert/strict";
import test from "node:test";
import { CoRuntime } from "../src/runtime.ts";
import { createRuntimeServer } from "../src/server.ts";
import { InquiryManager } from "../src/inquiries.ts";
import { CURRENT_SCHEMA_VERSION, SqliteStore } from "../src/store.ts";
import { TenantLifecycleManager } from "../src/tenant-lifecycle.ts";
import { testConfig, testHome } from "./helpers.ts";
import { RuntimeWorker } from "../src/worker.ts";

function setupInquiry(manager: InquiryManager, store: SqliteStore, suffix = "one") {
  const session = store.ensureSession("test", "imessage", "+15550001111");
  const source = store.appendEvent({
    id: `evt_inquiry_source_${suffix}`, tenantId: "test", stream: `conversation:${suffix}`,
    type: "message.received", payload: { text: "A source change worth considering privately." },
  });
  return manager.create({
    tenantId: "test", sourceEventId: source.id, sessionId: session.id, triggerKind: "artifact",
    triggerBasis: "A newly inspected source overlaps a decision represented in prior owner evidence.",
    question: "Does this source materially change the member's current decision, or is it merely adjacent and interesting?",
    concreteBenefit: "Resolving the distinction avoids an interruption while preserving any decision-changing evidence.",
    answerability: "records",
    competingHypotheses: [
      "The source changes a live choice in a way the member has not already considered.",
      "The source is interesting but changes no present understanding, choice, avoidance, or action.",
    ],
    falsifiers: ["No current matter, deadline, choice, or usable artifact changes after comparing the source with owner records."],
    retrievalPlan: ["Search dated owner evidence and current matters before requesting any member input."],
    stopCondition: "Stop after the bounded record search and one counterevidence pass.",
    idempotencyKey: `fixture:${suffix}`,
  });
}

test("inquiries are durable backstage work and cannot send by construction", () => {
  const home = testHome();
  const store = new SqliteStore(`${home.path}/runtime.sqlite`);
  const manager = new InquiryManager(store);
  try {
    assert.ok(CURRENT_SCHEMA_VERSION >= 54);
    assert.ok(store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=54").get());
    const proposed = setupInquiry(manager, store);
    assert.equal(proposed.status, "proposed");
    assert.equal(proposed.foregroundDisposition, "backstage");
    assert.equal(manager.foregroundDecisions("test", proposed.id).length, 0);
    const investigating = manager.begin("test", proposed.id);
    assert.equal(investigating.status, "investigating");
    const resolved = manager.resolve({
      tenantId: "test", inquiryId: proposed.id, status: "insufficient",
      finding: "The bounded record did not establish a decision-changing delta.",
      counterevidence: "Existing evidence supports the quieter explanation that the source is only adjacent.",
      remainingUncertainty: "A future live decision could make the source relevant, but that condition is not present now.",
      nextPermittedConsequence: "Retain the source for retrieval and do not notify the member.",
    });
    assert.equal(resolved.status, "insufficient");
    assert.equal(resolved.foregroundDisposition, "backstage");
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM interventions WHERE tenant_id='test'").get()!.count, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM outbound_deliveries WHERE tenant_id='test'").get()!.count, 0);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("a v53 database migrates additively to bounded inquiry state", () => {
  const home = testHome();
  const path = `${home.path}/runtime.sqlite`;
  let store = new SqliteStore(path);
  try {
    store.appendEvent({ id: "evt_before_inquiries", tenantId: "test", stream: "conversation", type: "message.received", payload: { text: "Preserve this history." } });
    store.db.exec(`
      DROP TABLE inquiry_foreground_decisions;
      DROP TABLE inquiries;
      DELETE FROM schema_migrations WHERE version=54;
      PRAGMA user_version=53;
    `);
    store.close();
    store = new SqliteStore(path);
    assert.equal(store.schemaVersion(), CURRENT_SCHEMA_VERSION);
    assert.ok(store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=54").get());
    assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inquiries'").get());
    assert.ok(store.getEvent("test", "evt_before_inquiries"));
  } finally {
    store.close();
    home.cleanup();
  }
});

test("expired findings cannot gain foreground eligibility even before maintenance runs", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const inquiry = setupInquiry(runtime.inquiries, runtime.store, "expired-finding");
    runtime.inquiries.begin("test", inquiry.id);
    runtime.inquiries.resolve({ tenantId: "test", inquiryId: inquiry.id, status: "resolved", finding: "The choice had a useful comparison.",
      counterevidence: "The opportunity might already have closed.", remainingUncertainty: "The source has not been refreshed.",
      nextPermittedConsequence: "Only consider surfacing while the opportunity remains live." });
    runtime.store.db.prepare("UPDATE inquiries SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1_000).toISOString(), inquiry.id);
    assert.throws(() => runtime.inquiries.decideForeground({ tenantId: "test", inquiryId: inquiry.id, disposition: "interrupt",
      memberDelta: 0.95, timingLoss: 0.95, whyNow: "The proposed deadline is close.", bestQuietAlternative: "Retain the comparison.",
      answerUnavailablePrivately: true, reason: "The model believes this is still timely." }), /expired/);
    assert.equal(runtime.inquiries.foregroundDecisions("test", inquiry.id).length, 0);
  } finally { runtime.close(); home.cleanup(); }
});

test("worker maintenance quietly expires pending inquiries and preserves completed findings", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const pending = setupInquiry(runtime.inquiries, runtime.store, "pending-expiry");
    const completed = setupInquiry(runtime.inquiries, runtime.store, "completed-expiry");
    runtime.inquiries.begin("test", completed.id);
    runtime.inquiries.resolve({ tenantId: "test", inquiryId: completed.id, status: "resolved", finding: "An earlier option was well supported.",
      counterevidence: "Its relevance was time limited.", remainingUncertainty: "Future relevance needs new investigation.",
      nextPermittedConsequence: "Keep this finding for historical retrieval." });
    runtime.store.db.prepare("UPDATE inquiries SET expires_at=? WHERE tenant_id=?").run(new Date(Date.now() - 1_000).toISOString(), "test");
    await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce();
    assert.equal(runtime.inquiries.get("test", pending.id)?.status, "expired");
    assert.equal(runtime.inquiries.get("test", completed.id)?.status, "resolved", "deadline expiry is not a retraction of the historical finding");
    assert.equal(runtime.inquiries.get("test", completed.id)?.foregroundDisposition, "expired");
    assert.equal(runtime.store.listJobs("test").length, 0);
    assert.equal(runtime.office.listAttention("test", "open").length, 0);
    assert.equal(runtime.store.db.prepare("SELECT count(*) AS n FROM outbound_deliveries").get()!.n, 0);
  } finally { runtime.close(); home.cleanup(); }
});

test("foreground inquiry decisions fail closed on curiosity, repetition-shaped asks, and weak timing", () => {
  const home = testHome();
  const store = new SqliteStore(`${home.path}/runtime.sqlite`);
  const manager = new InquiryManager(store);
  try {
    const inquiry = setupInquiry(manager, store, "question");
    manager.begin("test", inquiry.id);
    manager.resolve({
      tenantId: "test", inquiryId: inquiry.id, status: "needs_member",
      finding: "Private records cannot distinguish whether the upcoming choice is still active.",
      counterevidence: "The most recent record may supersede the older open matter.",
      remainingUncertainty: "Only the member can confirm whether the choice remains live.",
      nextPermittedConsequence: "At most one concise question in a natural related conversation, subject to the relationship arbiter.",
      memberQuestion: "Is the Atlas choice still live?",
    });
    const base = {
      tenantId: "test", inquiryId: inquiry.id, whyNow: "The current choice could affect a prepared comparison.",
      bestQuietAlternative: "Hold the comparison until the member raises Atlas again.",
      answerUnavailablePrivately: true, reason: "One answer would retire or activate the prepared comparison.",
    };
    assert.throws(() => manager.decideForeground({
      ...base, disposition: "natural_opening", memberDelta: 0.4, timingLoss: 0.1,
      naturalOpeningEventId: inquiry.sourceEventId,
    }), /material member delta/);
    assert.throws(() => manager.decideForeground({
      ...base, disposition: "natural_opening", memberDelta: 0.9, timingLoss: 0.1,
    }), /natural-opening/);
    const unrelated = store.appendEvent({ tenantId: "test", stream: "other", type: "message.received", payload: { text: "Unrelated relationship." } });
    assert.throws(() => manager.decideForeground({
      ...base, disposition: "natural_opening", memberDelta: 0.9, timingLoss: 0.1, naturalOpeningEventId: unrelated.id,
    }), /relationship context/);
    assert.throws(() => manager.decideForeground({
      ...base, disposition: "interrupt", memberDelta: 0.9, timingLoss: 0.4,
    }), /waiting destroys material value/);
    const held = manager.decideForeground({
      ...base, disposition: "backstage", memberDelta: 0.4, timingLoss: 0.1,
      reason: "The quiet alternative preserves all present value without creating question debt.",
    });
    assert.equal(held.disposition, "backstage");
    const natural = manager.decideForeground({
      ...base, disposition: "natural_opening", memberDelta: 0.9, timingLoss: 0.1,
      naturalOpeningEventId: inquiry.sourceEventId,
    });
    assert.equal(natural.disposition, "natural_opening");
    const staleInquiry = setupInquiry(manager, store, "stale-opening");
    manager.begin("test", staleInquiry.id);
    manager.resolve({
      tenantId: "test", inquiryId: staleInquiry.id, status: "resolved",
      finding: "The finding is supported but no longer belongs in the active conversational moment.",
      counterevidence: "Waiting did not destroy the finding's retrieval value.", remainingUncertainty: "Timing remains uncertain.",
      nextPermittedConsequence: "Retain the finding for a future genuinely related opening.",
    });
    store.db.prepare("UPDATE events SET at=? WHERE tenant_id=? AND id=?")
      .run(new Date(Date.now() - 31 * 60_000).toISOString(), "test", staleInquiry.sourceEventId);
    assert.throws(() => manager.decideForeground({
      ...base, inquiryId: staleInquiry.id, disposition: "natural_opening", memberDelta: 0.9, timingLoss: 0.1,
      naturalOpeningEventId: staleInquiry.sourceEventId,
    }), /conversationally current/);
    const repeatedInquiry = setupInquiry(manager, store, "repeated-question");
    manager.begin("test", repeatedInquiry.id);
    manager.resolve({
      tenantId: "test", inquiryId: repeatedInquiry.id, status: "needs_member",
      finding: "A second private pass reached the same missing fact.", counterevidence: "No newer private evidence resolves it.",
      remainingUncertainty: "The same live-state answer remains missing.",
      nextPermittedConsequence: "Do not repeat a recently surfaced equivalent question.", memberQuestion: "Is the Atlas choice still live?",
    });
    assert.throws(() => manager.decideForeground({
      ...base, inquiryId: repeatedInquiry.id, disposition: "natural_opening", memberDelta: 0.9, timingLoss: 0.1,
      naturalOpeningEventId: repeatedInquiry.sourceEventId,
    }), /already spent recent relationship attention/);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM outbound_deliveries WHERE tenant_id='test'").get()!.count, 0,
      "even an eligible foreground recommendation is not a connector send");
  } finally {
    store.close();
    home.cleanup();
  }
});

test("authenticated operator surfaces expose inquiry state and its separate foreground ledger", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  const server = createRuntimeServer(runtime);
  try {
    const inquiry = setupInquiry(runtime.inquiries, runtime.store, "http");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const listed = await fetch(`${base}/v1/inquiries?status=proposed`);
    assert.equal(listed.status, 200);
    assert.equal((await listed.json() as unknown[]).length, 1);
    const detail = await fetch(`${base}/v1/inquiries/${inquiry.id}`);
    assert.equal(detail.status, 200);
    const body = await detail.json() as { inquiry: { id: string; foregroundDisposition: string }; foregroundDecisions: unknown[] };
    assert.equal(body.inquiry.id, inquiry.id);
    assert.equal(body.inquiry.foregroundDisposition, "backstage");
    assert.deepEqual(body.foregroundDecisions, []);
    assert.equal((await fetch(`${base}/v1/inquiries?status=curious`)).status, 400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    home.cleanup();
  }
});

test("inquiries and foreground decisions survive exact tenant export and restore", () => {
  const sourceHome = testHome();
  const destinationHome = testHome();
  const sourceStore = new SqliteStore(`${sourceHome.path}/runtime.sqlite`);
  const destinationStore = new SqliteStore(`${destinationHome.path}/runtime.sqlite`);
  try {
    const source = new InquiryManager(sourceStore);
    const inquiry = setupInquiry(source, sourceStore, "portable");
    source.decideForeground({
      tenantId: "test", inquiryId: inquiry.id, disposition: "backstage", memberDelta: 0.2,
      whyNow: "No current decision would change.", bestQuietAlternative: "Retain it for relevant retrieval.",
      answerUnavailablePrivately: false, timingLoss: 0, reason: "Silence preserves the complete present value.",
    });
    const bundle = new TenantLifecycleManager(sourceStore).createExport("test");
    new TenantLifecycleManager(destinationStore).restoreExport({ tenantId: "test", bundle, confirmation: "RESTORE:test" });
    const restored = new InquiryManager(destinationStore);
    assert.equal(restored.get("test", inquiry.id)?.question, inquiry.question);
    assert.equal(restored.foregroundDecisions("test", inquiry.id)[0]?.disposition, "backstage");
  } finally {
    sourceStore.close();
    destinationStore.close();
    sourceHome.cleanup();
    destinationHome.cleanup();
  }
});
