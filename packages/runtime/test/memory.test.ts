import assert from "node:assert/strict";
import test from "node:test";
import { MemoryStore } from "../src/memory.ts";
import { SqliteStore } from "../src/store.ts";
import { testHome } from "./helpers.ts";

test("memory carries stable patterns independently of recency and preserves corrections", () => {
  const home = testHome();
  const store = new SqliteStore(`${home.path}/test.sqlite`);
  const memory = new MemoryStore(store);
  try {
    const source = store.appendEvent({ tenantId: "t", stream: "test", type: "evidence", at: "2025-09-01T00:00:00.000Z", payload: { text: "six months of behavior" } });
    const stable = memory.remember({
      tenantId: "t", kind: "pattern", statement: "Usually moves from a concrete prototype into action quickly", sourceEventId: source.id,
      confidence: 0.9, salience: 0.95, observedAt: "2025-09-01T00:00:00.000Z", userConfirmed: true,
    });
    for (let day = 1; day <= 6; day += 1) {
      memory.remember({
        tenantId: "t", kind: "episode", statement: `Had a low-action reflective day ${day}`, sourceEventId: source.id,
        confidence: 0.7, salience: 0.5, observedAt: `2026-07-${String(20 + day).padStart(2, "0")}T00:00:00.000Z`,
      });
    }
    const context = memory.context("t", "am I biased toward action?");
    assert.equal(context.carried.some((item) => item.id === stable.id), true);
    assert.equal(context.carried[0]?.observedAt, "2025-09-01T00:00:00.000Z");

    const correctionSource = store.appendEvent({ tenantId: "t", stream: "test", type: "user.correction", payload: { text: "changed" } });
    const replacement = memory.correct({ tenantId: "t", memoryId: stable.id, replacement: "Now pauses to validate before moving into action", sourceEventId: correctionSource.id });
    assert.equal(memory.get(stable.id)?.status, "superseded");
    assert.equal(memory.get(stable.id)?.validTo !== undefined, true);
    assert.equal(replacement.supersedesId, stable.id);
    assert.equal(replacement.userConfirmed, true);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("memory deduplicates identical active statements without deleting provenance history", () => {
  const home = testHome();
  const store = new SqliteStore(`${home.path}/test.sqlite`);
  const memory = new MemoryStore(store);
  try {
    const source = store.appendEvent({ tenantId: "t", stream: "test", type: "evidence", payload: {} });
    const first = memory.remember({ tenantId: "t", kind: "preference", statement: "Prefers concise answers", sourceEventId: source.id, confidence: 0.6 });
    const second = memory.remember({ tenantId: "t", kind: "preference", statement: "Prefers concise answers", sourceEventId: source.id, confidence: 0.9 });
    assert.equal(first.id, second.id);
    assert.equal(second.confidence, 0.9);
    assert.equal(memory.list("t", { status: "active" }).length, 1);
  } finally {
    store.close();
    home.cleanup();
  }
});
