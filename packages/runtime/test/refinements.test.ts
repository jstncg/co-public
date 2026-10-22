import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRegistry } from "../src/providers.ts";
import { CoRuntime } from "../src/runtime.ts";
import type { ProviderAdapter } from "../src/types.ts";
import { testConfig, testHome } from "./helpers.ts";

test("refinements require operator approval, detect stale plans, and preserve every version", async () => {
  const home = testHome();
  const systems: string[] = [];
  const adapter: ProviderAdapter = {
    name: "mock",
    complete: async (request) => {
      systems.push(request.system);
      return { text: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    },
  };
  const runtime = new CoRuntime({ config: testConfig(home.path), providers: new ProviderRegistry([adapter]) });
  try {
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "work", type: "behavior.verified", payload: { evidence: true } });
    const first = runtime.refinements.propose({
      tenantId: "test", kind: "prompt_overlay", scope: "tenant", targetId: "test", title: "Prefer concrete checks",
      rationale: "Repeated verified runs improved when completion was concrete", expectedEffect: "Fewer unsupported completion claims",
      patch: { instructions: "Before claiming completion, distinguish evidence observed from work merely attempted." },
      evidenceEventIds: [source.id], sourceEventId: source.id,
    });
    const stale = runtime.refinements.propose({
      tenantId: "test", kind: "prompt_overlay", scope: "tenant", targetId: "test", title: "Stale alternative",
      rationale: "Alternative planned from the same baseline", expectedEffect: "Demonstrate conflict protection",
      patch: { instructions: "This stale alternative must never overwrite a newer active overlay." },
      evidenceEventIds: [source.id], sourceEventId: source.id,
    });
    assert.equal(first.status, "proposed");
    assert.equal(runtime.tools.get("refinement.propose") !== undefined, true);
    assert.equal(runtime.tools.get("refinement.approve"), undefined);
    assert.equal(runtime.refinements.overlays("test").length, 0);

    runtime.refinements.approve("test", first.id, { reviewer: "operator", evidenceChecked: true });
    const applied = runtime.refinements.apply("test", first.id);
    assert.equal(applied.overlay.version, 1);
    assert.equal(applied.overlay.status, "active");
    runtime.refinements.approve("test", stale.id);
    assert.throws(() => runtime.refinements.apply("test", stale.id), /planned from version 0, active version is 1/);

    await runtime.turn({ tenantId: "test", channel: "cli", peerId: "owner", text: "check the current behavior" });
    assert.match(systems.at(-1) ?? "", /GOVERNED PROMPT OVERLAYS/);
    assert.match(systems.at(-1) ?? "", /distinguish evidence observed/);

    const revision = runtime.refinements.propose({
      tenantId: "test", kind: "prompt_overlay", scope: "tenant", targetId: "test", title: "Tighten concrete checks",
      rationale: "A narrower revision is easier to evaluate", expectedEffect: "Clear evidence boundaries",
      patch: { instructions: "State the exact receipt, test, or observation that supports completion." },
      evidenceEventIds: [source.id], sourceEventId: source.id, supersedesId: first.id,
    });
    runtime.refinements.approve("test", revision.id);
    const revised = runtime.refinements.apply("test", revision.id);
    assert.equal(revised.overlay.version, 2);
    const overlays = runtime.refinements.overlays("test");
    assert.equal(overlays.length, 2);
    assert.equal(overlays.some((overlay) => overlay.version === 1 && overlay.status === "superseded"), true);
    assert.equal(overlays.some((overlay) => overlay.version === 2 && overlay.status === "active"), true);

    runtime.refinements.retire("test", revision.id);
    assert.equal(runtime.refinements.overlays("test").length, 2);
    assert.equal(runtime.refinements.activeOverlay("test", "prompt_overlay", "tenant", "test"), undefined);
    assert.equal(runtime.refinements.get("test", first.id)?.status, "applied");
    assert.equal(runtime.refinements.get("test", revision.id)?.status, "retired");

    const restored = runtime.refinements.rollback("test", first.id);
    assert.equal(restored.overlay.version, 3);
    assert.equal(restored.overlay.content.instructions, first.patch.instructions);
    assert.equal(runtime.refinements.overlays("test").length, 3);
    assert.equal(runtime.refinements.activeOverlay("test", "prompt_overlay", "tenant", "test")?.id, restored.overlay.id);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("refinement patches fail closed on authority-bearing fields and foreign evidence", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "work", type: "behavior.verified", payload: {} });
    const foreign = runtime.store.appendEvent({ tenantId: "other", stream: "work", type: "behavior.verified", payload: {} });
    assert.throws(() => runtime.refinements.propose({
      tenantId: "test", kind: "agent_spec", scope: "tenant", targetId: "test", title: "Expand tools", rationale: "No",
      expectedEffect: "No", patch: { allowedTools: ["process.run"] }, evidenceEventIds: [source.id], sourceEventId: source.id,
    }), /authority-bearing or unknown fields/);
    assert.throws(() => runtime.refinements.propose({
      tenantId: "test", kind: "prompt_overlay", scope: "tenant", targetId: "test", title: "Foreign", rationale: "No",
      expectedEffect: "No", patch: { instructions: "No" }, evidenceEventIds: [foreign.id], sourceEventId: source.id,
    }), /does not belong to tenant/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});
