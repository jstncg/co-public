import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the portable action-proof benchmark has 25 bounded vendor-neutral cases", () => {
  const benchmark = JSON.parse(readFileSync(new URL("../benchmarks/action-proof-v0.8.json", import.meta.url), "utf8")) as {
    schemaVersion: number;
    metrics: string[];
    cases: Array<{ id: string; category: string; prompt: string; successContract: string; evidencePolicy: string; requiredCapabilities: string[] }>;
  };
  assert.equal(benchmark.schemaVersion, 1);
  assert.equal(benchmark.cases.length, 25);
  assert.equal(new Set(benchmark.cases.map((item) => item.id)).size, benchmark.cases.length);
  assert.deepEqual(new Set(benchmark.cases.map((item) => item.category)), new Set(["local-work", "external-action", "recovery", "context-use", "judgment"]));
  assert.ok(benchmark.metrics.includes("completed"));
  assert.ok(benchmark.metrics.includes("evidence_valid"));
  for (const item of benchmark.cases) {
    assert.ok(item.prompt.length > 10 && item.prompt.length < 1_000);
    assert.ok(item.successContract.length > 10 && item.successContract.length < 1_000);
    assert.ok(item.evidencePolicy === "run" || item.evidencePolicy === "tool" || item.evidencePolicy === "external-write");
    assert.ok(item.requiredCapabilities.length > 0);
  }
});
