import assert from "node:assert/strict";
import test from "node:test";
import { CoRuntime } from "../src/runtime.ts";
import { testConfig, testHome } from "./helpers.ts";

test("an unclassified builtin cannot satisfy even an exact named outcome requirement", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    assert.deepEqual(runtime.tools.get("clock.now")!.evaluateResult({ error: "unclassified domain result" }),
      { status: "succeeded", evidenceScope: "request" });
    const admission = await runtime.submitWorkOrder({ objective: "[[tool:clock.now {}]]", successContract: "The required outcome was verified.",
      requiredToolNames: ["clock.now"], allowedTools: ["clock.now"] });
    const result = await runtime.executeWorkOrder(admission.workOrder.id);
    assert.equal(result.status, "needs_input");
    const rows = runtime.store.db.prepare("SELECT evidence_scope FROM tool_receipts WHERE run_id=?").all(result.runId!);
    assert.ok(rows.length);
    assert.ok(rows.every((row) => row.evidence_scope === "request"));
  } finally { runtime.close(); home.cleanup(); }
});

test("an evaluator omitting evidence scope cannot promote its result to a confirmed outcome", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    runtime.tools.register({ definition: { name: "fixture.unclassified", description: "Returns without an outcome contract.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "local-write", tags: [], idempotent: true },
      execute: async () => ({ accepted: true }), evaluateResult: () => ({ status: "succeeded" }) });
    const admission = await runtime.submitWorkOrder({ objective: "[[tool:fixture.unclassified {}]]", requiredToolNames: ["fixture.unclassified"], allowedTools: ["fixture.unclassified"] });
    const result = await runtime.executeWorkOrder(admission.workOrder.id);
    assert.equal(result.status, "needs_input");
    assert.equal(runtime.store.db.prepare("SELECT effect_state FROM tool_receipts WHERE run_id=?").get(result.runId!)!.effect_state, "accepted");
  } finally { runtime.close(); home.cleanup(); }
});

test("explicit local-persistence outcome evaluators reject error-shaped return values", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    for (const name of ["artifact.prepare", "research.source.record", "research.finding.record", "memory.remember", "file.write", "goal.reality_check"]) {
      assert.equal(runtime.tools.get(name)!.evaluateResult({ error: "not persisted" }).status, "failed", name);
    }
  } finally { runtime.close(); home.cleanup(); }
});

test("receipt settlement and legacy missing scopes never infer outcome evidence", async () => {
  const home = testHome();
  let runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const result = await runtime.turn({ tenantId: "test", channel: "cli", peerId: "receipt-default", text: "[[tool:clock.now {}]]" });
    const row = runtime.store.db.prepare("SELECT id FROM tool_receipts WHERE run_id=?").get(result.runId)!;
    const receiptId = String(row.id);
    runtime.store.db.prepare("UPDATE tool_receipts SET status='running',effect_state='accepted',lease_token='fixture-owner' WHERE id=?").run(receiptId);
    assert.equal(runtime.store.finishReceipt({ receiptId, leaseToken: "fixture-owner", status: "succeeded", output: { accepted: true } }), true);
    assert.equal(runtime.store.db.prepare("SELECT evidence_scope FROM tool_receipts WHERE id=?").get(receiptId)!.evidence_scope, "request");
    runtime.store.db.prepare("UPDATE tool_receipts SET evidence_scope=NULL WHERE id=?").run(receiptId);
    runtime.close();
    runtime = new CoRuntime({ config: testConfig(home.path) });
    const restored = runtime.store.db.prepare("SELECT evidence_scope,output_json FROM tool_receipts WHERE id=?").get(receiptId)!;
    assert.equal(restored.evidence_scope, "request");
    assert.equal(restored.output_json, '{"accepted":true}', "the original result is preserved");
  } finally { runtime.close(); home.cleanup(); }
});
