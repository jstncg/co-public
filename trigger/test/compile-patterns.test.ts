import { MockModelProvider } from "@co/model-gateway";
import { describe, expect, it, vi } from "vitest";
import { compilePattern } from "../src/tasks/compile-patterns";
import { drainDeletionRecompiles } from "../src/tasks/recompile-deleted-memory";

function chain(result: { data: any; error: null }, singleData?: any) {
  const value: any = {
    select: vi.fn(() => value), eq: vi.fn(() => value), is: vi.fn(() => value),
    in: vi.fn(() => value), order: vi.fn(() => value), insert: vi.fn(() => value),
    limit: vi.fn(async () => result), maybeSingle: vi.fn(async () => result),
    single: vi.fn(async () => ({ data: singleData, error: null })),
    then: (resolve: (input: unknown) => unknown) => resolve(result),
  };
  return value;
}

describe("pattern compilation", () => {
  it("creates only a review candidate from explicit multi-day receipt evidence", async () => {
    const observations = chain({ data: [
      { id: "o1", artifact_id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04111", observation_type: "user_why", statement: "the shared making", confidence: 1, created_at: "2026-07-20T00:00:00Z" },
      { id: "o2", artifact_id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04112", observation_type: "user_why", statement: "the shared making", confidence: 1, created_at: "2026-07-21T00:00:00Z" },
      { id: "o3", artifact_id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113", observation_type: "source_content", statement: "a public workshop", confidence: 0.8, created_at: "2026-07-22T00:00:00Z" },
    ], error: null });
    const artifacts = chain({ data: [
      { id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04111", captured_at: "2026-07-20T00:00:00Z" },
      { id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04112", captured_at: "2026-07-21T00:00:00Z" },
      { id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113", captured_at: "2026-07-22T00:00:00Z" },
    ], error: null });
    const existingHypothesis = chain({ data: null, error: null });
    const insertedHypothesis = chain({ data: null, error: null }, { id: "hypothesis-1" });
    const evidenceLinks = chain({ data: null, error: null });
    const modelRun = chain({ data: null, error: null }, { id: "run-1" });
    let hypothesisCalls = 0;
    const admin: any = {
      from(table: string) {
        if (table === "observations") return observations;
        if (table === "artifacts") return artifacts;
        if (table === "hypotheses") return hypothesisCalls++ === 0 ? existingHypothesis : insertedHypothesis;
        if (table === "evidence_links") return evidenceLinks;
        throw new Error(`unexpected table ${table}`);
      },
      schema: () => ({ from: () => modelRun }),
    };

    await expect(compilePattern(admin, "user-1", new MockModelProvider())).resolves.toEqual({ status: "review", hypothesisId: "hypothesis-1" });
    expect(observations.is).toHaveBeenCalledWith("invalidated_at", null);
    expect(artifacts.is).toHaveBeenCalledWith("deleted_at", null);
    expect(insertedHypothesis.insert).toHaveBeenCalledWith(expect.objectContaining({ status: "review", alternatives_json: expect.any(Array) }));
    expect(evidenceLinks.insert).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ direction: "support", user_id: "user-1" })]));
  });

  it("durably drains deletion recompiles and marks the claimed job complete", async () => {
    const claim = vi.fn(async () => ({ data: [{ job_id: "job-1", user_id: "user-1" }], error: null }));
    const updateChain: any = { update: vi.fn(() => updateChain), eq: vi.fn(async () => ({ error: null })) };
    const admin: any = { schema: vi.fn(() => ({ rpc: claim, from: vi.fn(() => updateChain) })) };
    const compiler = vi.fn(async () => ({ status: "insufficient_explicit_evidence" }));
    await expect(drainDeletionRecompiles(admin, new MockModelProvider(), compiler)).resolves.toEqual([
      { jobId: "job-1", status: "succeeded", result: { status: "insufficient_explicit_evidence" } },
    ]);
    expect(compiler).toHaveBeenCalledWith(admin, "user-1", expect.any(MockModelProvider));
    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: "succeeded" }));
  });

  it("does not call a model without enough explicit user evidence", async () => {
    const observations = chain({ data: [{ id: "o1", artifact_id: "a1", observation_type: "source_content", statement: "visible", confidence: 1, created_at: "2026-07-20T00:00:00Z" }], error: null });
    const provider = new MockModelProvider();
    const generate = vi.spyOn(provider, "generatePatternCandidate");
    const admin: any = { from: () => observations };
    await expect(compilePattern(admin, "user-1", provider)).resolves.toEqual({ status: "insufficient_explicit_evidence" });
    expect(generate).not.toHaveBeenCalled();
  });
});
