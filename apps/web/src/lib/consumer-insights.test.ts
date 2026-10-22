import { describe, expect, it, vi } from "vitest";
import { createWatch, listPatterns, recordPatternFeedback, recordRadarFeedback } from "./consumer-insights";

class InsightQuery {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  constructor(private readonly result: { data: any[]; error: null }) {}
  select(...args: unknown[]) { this.calls.push({ method: "select", args }); return this; }
  eq(...args: unknown[]) { this.calls.push({ method: "eq", args }); return this; }
  in(...args: unknown[]) { this.calls.push({ method: "in", args }); return this; }
  is(...args: unknown[]) { this.calls.push({ method: "is", args }); return this; }
  order(...args: unknown[]) { this.calls.push({ method: "order", args }); return this; }
  limit(...args: unknown[]) { this.calls.push({ method: "limit", args }); return Promise.resolve(this.result); }
  insert(...args: unknown[]) { this.calls.push({ method: "insert", args }); return this; }
  single<T>() { return Promise.resolve({ data: ({ id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04119" } as T), error: null }); }
  then(resolve: (value: { data: any[]; error: null }) => unknown) { return Promise.resolve(resolve(this.result)); }
}

function database(fixtures: Record<string, any[]>) {
  const queries = new Map<string, InsightQuery[]>();
  const rpc = vi.fn(async () => ({ data: "feedback-1", error: null }));
  const admin: any = {
    from(table: string) {
      const query = new InsightQuery({ data: fixtures[table] ?? [], error: null });
      queries.set(table, [...(queries.get(table) ?? []), query]);
      return query;
    },
    rpc,
  };
  return { admin, queries, rpc };
}

describe("consumer insight read models", () => {
  it("returns only delivered patterns with receipt metadata, never raw artifact content", async () => {
    const { admin, queries } = database({
      hypotheses: [{ id: "pattern-1", statement: "you return to shared making", alternatives_json: ["novelty"], confidence: 0.8, status: "approved", updated_at: "2026-07-20T00:00:00Z" }],
      evidence_links: [{ hypothesis_id: "pattern-1", artifact_id: "artifact-1", direction: "support", weight: 1 }],
      artifacts: [{ id: "artifact-1", source_type: "article", source_coverage: "text", title: "Studio practice", publisher: "Journal", canonical_url: "https://example.com/studio", captured_at: "2026-07-19T00:00:00Z" }],
    });
    const result = await listPatterns(admin, "user-1");
    expect(result[0]).toMatchObject({ statement: "you return to shared making", receipts: [{ title: "Studio practice", direction: "support" }] });
    expect(queries.get("hypotheses")?.[0]?.calls).toContainEqual({ method: "in", args: ["status", ["approved", "delivered"]] });
    const artifactSelect = queries.get("artifacts")?.[0]?.calls.find((call) => call.method === "select");
    expect(String(artifactSelect?.args[0])).not.toMatch(/raw_text|transcript|user_note|raw_object_path/);
  });

  it("records feedback and creates watches only in the authenticated namespace", async () => {
    const { admin, queries, rpc } = database({});
    await recordPatternFeedback(admin, "user-1", {
      hypothesisId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113",
      verdict: "partly",
      correction: "only when the group is small",
    });
    expect(rpc).toHaveBeenCalledWith("record_pattern_feedback", expect.objectContaining({ p_user_id: "user-1" }));
    await recordRadarFeedback(admin, "user-1", {
      candidateId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04114",
      feedback: "mute_entity",
    });
    expect(rpc).toHaveBeenCalledWith("record_radar_feedback", expect.objectContaining({ p_user_id: "user-1", p_feedback: "mute_entity" }));

    await createWatch(admin, "user-1", {
      entityType: "person",
      displayName: "A public artist",
      relationshipNote: "their studio practice matters",
      desiredEventTypes: ["release", "appearance"],
    });
    expect(queries.get("watch_entities")?.[0]?.calls).toContainEqual({
      method: "insert",
      args: [expect.objectContaining({ user_id: "user-1", approved_at: expect.any(String) })],
    });
  });
});
