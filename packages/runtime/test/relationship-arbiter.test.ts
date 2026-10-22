import assert from "node:assert/strict";
import test from "node:test";
import { stableId } from "../src/id.ts";
import { RelationshipArbiter, type RelationshipAdmissionBinding } from "../src/relationship-arbiter.ts";
import { CURRENT_SCHEMA_VERSION, SqliteStore } from "../src/store.ts";
import { testHome } from "./helpers.ts";

const valid = { authorized: true, fresh: true, reason: "authority and source are current" } as const;

function fixture(): {
  store: SqliteStore;
  arbiter: RelationshipArbiter;
  binding: (suffix: string, overrides?: Partial<RelationshipAdmissionBinding>) => RelationshipAdmissionBinding;
  cleanup: () => void;
} {
  const home = testHome();
  const store = new SqliteStore(`${home.path}/runtime.sqlite`);
  const session = store.ensureSession("test", "imessage", "member");
  const source = store.appendEvent({ tenantId: "test", stream: `session:${session.id}`, type: "message.received", payload: { text: "source" } });
  const binding = (suffix: string, overrides: Partial<RelationshipAdmissionBinding> = {}): RelationshipAdmissionBinding => {
    const runId = overrides.runId ?? `run_${suffix}`;
    const deliveryKey = overrides.deliveryKey ?? `delivery-${suffix}`;
    return {
      tenantId: "test", sessionId: session.id, sourceEventId: source.id, runId, deliveryKey,
      deliveryIntentId: overrides.deliveryIntentId ?? stableId("evt", `delivery-intent:test:${runId}:fixture:member:${deliveryKey}`),
      deliveryClass: "requested_reply", urgency: 0.5, contentDigest: stableId("content", `content-${suffix}`),
      authorityRef: `owner:${source.id}`,
      ...overrides,
    };
  };
  return { store, arbiter: new RelationshipArbiter(store), binding, cleanup: () => { store.close(); home.cleanup(); } };
}

function acceptOutbound(store: SqliteStore, binding: RelationshipAdmissionBinding): void {
  const claim = store.claimOutboundDelivery({
    tenantId: binding.tenantId, intentId: binding.deliveryIntentId,
    requestDigest: stableId("delivery", binding.contentDigest), channel: "fixture", peerId: "member",
  });
  assert.equal(claim.state, "claimed");
  assert.ok(claim.claimToken);
  assert.equal(store.beginOutboundDelivery(binding.deliveryIntentId, binding.tenantId, claim.claimToken), true);
  const acceptance = store.appendEvent({
    tenantId: binding.tenantId, stream: `run:${binding.runId}`, type: "message.delivery_accepted",
    correlationId: binding.runId, causationId: binding.deliveryIntentId,
    payload: { providerReceipt: { provider: "fixture", messageId: `provider-${binding.runId}` } },
  });
  assert.equal(store.reconcileOutboundDeliveryAcceptance(binding.tenantId, binding.deliveryIntentId, acceptance.id), true);
}

test("relationship admission schema is additive and participates in tenant projection", () => {
  const setup = fixture();
  try {
    assert.equal(setup.store.schemaVersion(), CURRENT_SCHEMA_VERSION);
    const columns = setup.store.db.prepare("PRAGMA table_info(relationship_admissions)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "binding_digest"));
    assert.ok(columns.some((column) => column.name === "delivery_intent_id"));
  } finally {
    setup.cleanup();
  }
});

test("a version-50 database migrates additively without requiring relationship history", () => {
  const home = testHome();
  const path = `${home.path}/runtime.sqlite`;
  let store = new SqliteStore(path);
  try {
    store.db.exec("DROP TABLE relationship_admissions; DELETE FROM schema_migrations WHERE version=51; PRAGMA user_version=50;");
    store.close();
    store = new SqliteStore(path);
    assert.equal(store.schemaVersion(), CURRENT_SCHEMA_VERSION);
    assert.ok(store.db.prepare("SELECT 1 FROM schema_migrations WHERE version=51").get());
    assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='relationship_admissions'").get());
  } finally {
    store.close();
    home.cleanup();
  }
});

test("immutable binding rejects content or authority rebinding and fences stale settlement", () => {
  const setup = fixture();
  try {
    const binding = setup.binding("immutable");
    const admitted = setup.arbiter.consider(binding, valid);
    assert.equal(admitted.decision, "admitted");
    assert.ok(admitted.leaseToken);
    assert.equal(setup.arbiter.assertAdmitted({
      tenantId: "test", admissionId: admitted.record.id, leaseToken: admitted.leaseToken, binding,
    }).bindingDigest, admitted.record.bindingDigest);

    assert.throws(() => setup.arbiter.consider({ ...binding, contentDigest: stableId("content", "changed") }, valid), /rebound/i);
    assert.throws(() => setup.arbiter.assertAdmitted({
      tenantId: "test", admissionId: admitted.record.id, leaseToken: admitted.leaseToken as string,
      binding: { ...binding, authorityRef: "mandate:different" },
    }), /immutable binding/i);

    acceptOutbound(setup.store, binding);
    const settled = setup.arbiter.settle({
      tenantId: "test", admissionId: admitted.record.id, leaseToken: admitted.leaseToken,
      settlement: { outcome: "accepted", reason: "exact provider acceptance is durable" },
    });
    assert.equal(settled.status, "accepted");
    assert.throws(() => setup.arbiter.settle({
      tenantId: "test", admissionId: admitted.record.id, leaseToken: admitted.leaseToken as string,
      settlement: { outcome: "accepted", reason: "stale duplicate" },
    }), /rejected as stale/i);
  } finally {
    setup.cleanup();
  }
});

test("class precedence preempts only before transport and keeps one active relationship admission", () => {
  const setup = fixture();
  try {
    const proactiveBinding = setup.binding("proactive", { deliveryClass: "proactive", urgency: 0.7 });
    const proactive = setup.arbiter.consider(proactiveBinding, valid);
    assert.equal(proactive.decision, "admitted");
    assert.equal(proactive.record.attentionClass, "unsolicited");

    const safetyBinding = setup.binding("safety", { deliveryClass: "safety", urgency: 1 });
    const safety = setup.arbiter.consider(safetyBinding, valid);
    assert.equal(safety.decision, "admitted");
    assert.equal(safety.record.attentionClass, "safety");
    assert.equal(setup.arbiter.get("test", proactive.record.id)?.status, "held");
    assert.match(setup.arbiter.get("test", proactive.record.id)?.reason ?? "", /preempted before transport/);

    const approval = setup.arbiter.consider(setup.binding("approval", { deliveryClass: "approval", urgency: 0.9 }), valid);
    assert.equal(approval.decision, "held");
    assert.equal(approval.record.attentionClass, "requested");
    const active = setup.store.db.prepare(`SELECT COUNT(*) AS count FROM relationship_admissions
      WHERE tenant_id='test' AND status='admitted'`).get() as { count: number };
    assert.equal(Number(active.count), 1);

    const policy = setup.arbiter.list("test", safety.record.sessionId).sort((left, right) => left.precedence - right.precedence);
    assert.deepEqual(policy.map((record) => [record.deliveryClass, record.precedence]), [
      ["proactive", 100], ["approval", 600], ["safety", 800],
    ]);
  } finally {
    setup.cleanup();
  }
});

test("an outbound transport claim prevents late preemption", () => {
  const setup = fixture();
  try {
    const lowBinding = setup.binding("started", { deliveryClass: "proactive", urgency: 0.5 });
    const low = setup.arbiter.consider(lowBinding, valid);
    assert.equal(low.decision, "admitted");
    const claim = setup.store.claimOutboundDelivery({
      tenantId: "test", intentId: lowBinding.deliveryIntentId,
      requestDigest: stableId("delivery", "started"), channel: "fixture", peerId: "member",
    });
    assert.equal(claim.state, "claimed");

    const high = setup.arbiter.consider(setup.binding("late-safety", { deliveryClass: "safety", urgency: 1 }), valid);
    assert.equal(high.decision, "held");
    assert.equal(setup.arbiter.get("test", low.record.id)?.status, "admitted");
  } finally {
    setup.cleanup();
  }
});

test("two store connections serialize admission on the canonical relationship", () => {
  const home = testHome();
  const path = `${home.path}/runtime.sqlite`;
  const firstStore = new SqliteStore(path);
  const session = firstStore.ensureSession("test", "imessage", "member");
  const source = firstStore.appendEvent({ tenantId: "test", stream: `session:${session.id}`, type: "message.received", payload: {} });
  const secondStore = new SqliteStore(path);
  const binding = (suffix: string, deliveryClass: RelationshipAdmissionBinding["deliveryClass"]): RelationshipAdmissionBinding => ({
    tenantId: "test", sessionId: session.id, sourceEventId: source.id, runId: `run_${suffix}`, deliveryKey: suffix,
    deliveryIntentId: stableId("evt", `delivery-intent:${suffix}`), deliveryClass, urgency: 0.8,
    contentDigest: stableId("content", suffix), authorityRef: `owner:${source.id}`,
  });
  try {
    const first = new RelationshipArbiter(firstStore).consider(binding("cross-low", "proactive"), valid);
    const second = new RelationshipArbiter(secondStore).consider(binding("cross-high", "approval"), valid);
    assert.equal(first.decision, "admitted");
    assert.equal(second.decision, "admitted");
    const rows = firstStore.db.prepare("SELECT delivery_class,status FROM relationship_admissions ORDER BY precedence")
      .all() as Array<{ delivery_class: string; status: string }>;
    assert.deepEqual(rows.map((row) => ({ delivery_class: row.delivery_class, status: row.status })), [
      { delivery_class: "proactive", status: "held" },
      { delivery_class: "approval", status: "admitted" },
    ]);
  } finally {
    secondStore.close();
    firstStore.close();
    home.cleanup();
  }
});

test("holds have deterministic due, invalidation, and expiry behavior", () => {
  const setup = fixture();
  try {
    const future = setup.binding("future", {
      notBefore: "2026-09-04T12:00:00.000Z", expiresAt: "2026-09-04T13:00:00.000Z",
    });
    const held = setup.arbiter.consider(future, valid, { at: "2026-09-04T11:00:00.000Z" });
    assert.equal(held.decision, "held");
    assert.equal(setup.arbiter.expireDue("test", future.sessionId, "2026-09-04T13:00:00.000Z"), 1);
    assert.equal(setup.arbiter.get("test", held.record.id)?.status, "expired");

    const unauthorized = setup.arbiter.consider(setup.binding("unauthorized"), {
      authorized: false, fresh: true, reason: "mandate was revoked",
    });
    assert.equal(unauthorized.decision, "suppressed");
    const stale = setup.arbiter.consider(setup.binding("stale"), {
      authorized: true, fresh: false, reason: "source state changed",
    });
    assert.equal(stale.decision, "expired");
  } finally {
    setup.cleanup();
  }
});

test("expired leases recover from the exact outbound state and preserve intervention reservations", () => {
  const setup = fixture();
  try {
    const interventionId = "int_reservation";
    const reservedAt = "2026-09-04T10:00:00.000Z";
    const sourceEventId = setup.binding("unused").sourceEventId;
    setup.store.db.prepare(`INSERT INTO interventions(
      id,tenant_id,source_event_id,topic_key,score,urgency,decision,reason,content,created_at,attention_reserved_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      interventionId, "test", sourceEventId, "reservation", 0.9, 0.8, "send", "reserved", "content", reservedAt, reservedAt,
    );
    const binding = setup.binding("recover", { deliveryClass: "proactive", interventionId });
    const admitted = setup.arbiter.consider(binding, valid, { at: "2026-09-04T10:00:00.000Z", leaseMs: 1_000 });
    assert.equal(admitted.decision, "admitted");
    const recovered = setup.arbiter.recoverExpired("test", binding.sessionId, "2026-09-04T10:00:02.000Z");
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.status, "held");
    const intervention = setup.store.db.prepare("SELECT attention_reserved_at FROM interventions WHERE id=?")
      .get(interventionId) as { attention_reserved_at: string };
    assert.equal(intervention.attention_reserved_at, reservedAt);

    const reclaimed = setup.arbiter.claimNext({ tenantId: "test", sessionId: binding.sessionId, validate: () => valid,
      at: "2026-09-04T10:00:03.000Z", leaseMs: 1_000 });
    assert.equal(reclaimed?.decision, "admitted");
    assert.equal(reclaimed?.record.id, admitted.record.id);
    assert.notEqual(reclaimed?.leaseToken, admitted.leaseToken);
    assert.throws(() => setup.arbiter.assertAdmitted({
      tenantId: "test", admissionId: admitted.record.id, leaseToken: admitted.leaseToken as string, binding,
      at: "2026-09-04T10:00:03.000Z",
    }), /fenced/i);
  } finally {
    setup.cleanup();
  }
});

test("retryable settlement creates a durable wakeup instead of orphaning a held candidate", () => {
  const setup = fixture();
  try {
    const binding = setup.binding("retry");
    const admitted = setup.arbiter.consider(binding, valid);
    assert.equal(admitted.decision, "admitted");
    const delivery = setup.store.claimOutboundDelivery({
      tenantId: "test", intentId: binding.deliveryIntentId,
      requestDigest: stableId("delivery", "retry"), channel: "fixture", peerId: "member",
    });
    assert.equal(delivery.state, "claimed");
    assert.ok(delivery.claimToken);
    assert.equal(setup.store.beginOutboundDelivery(binding.deliveryIntentId, "test", delivery.claimToken), true);
    assert.equal(setup.store.settleOutboundDelivery({
      intentId: binding.deliveryIntentId, tenantId: "test", claimToken: delivery.claimToken,
      state: "retryable", error: "provider unavailable",
    }), true);
    const retryAt = new Date(Date.now() + 60_000).toISOString();
    const held = setup.arbiter.settle({
      tenantId: "test", admissionId: admitted.record.id, leaseToken: admitted.leaseToken as string,
      settlement: { outcome: "retryable", reason: "provider unavailable", retryAt },
    });
    assert.equal(held.status, "held");
    assert.equal(held.notBefore, retryAt);
  } finally {
    setup.cleanup();
  }
});

test("an accepted status string without its exact acceptance event cannot settle admission", () => {
  const setup = fixture();
  try {
    const binding = setup.binding("unproved-acceptance");
    const admitted = setup.arbiter.consider(binding, valid);
    const delivery = setup.store.claimOutboundDelivery({
      tenantId: "test", intentId: binding.deliveryIntentId,
      requestDigest: stableId("delivery", "unproved"), channel: "fixture", peerId: "member",
    });
    assert.equal(delivery.state, "claimed");
    assert.ok(delivery.claimToken);
    assert.equal(setup.store.beginOutboundDelivery(binding.deliveryIntentId, "test", delivery.claimToken), true);
    assert.equal(setup.store.settleOutboundDelivery({
      intentId: binding.deliveryIntentId, tenantId: "test", claimToken: delivery.claimToken,
      state: "accepted",
    }), true);
    assert.throws(() => setup.arbiter.settle({
      tenantId: "test", admissionId: admitted.record.id, leaseToken: admitted.leaseToken as string,
      settlement: { outcome: "accepted", reason: "status alone is not evidence" },
    }), /exact outbound acceptance event/i);
  } finally {
    setup.cleanup();
  }
});
