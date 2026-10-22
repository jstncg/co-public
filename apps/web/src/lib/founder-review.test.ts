import { describe, expect, it, vi } from "vitest";
import { decideFounderReview, listFounderReviews, type FounderDatabase } from "./founder-review";

class FakeQuery {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  private inserted: unknown;

  constructor(private readonly result: { data: unknown; error: { message: string } | null }) {}
  select(...args: unknown[]) { this.calls.push({ method: "select", args }); return this; }
  eq(...args: unknown[]) { this.calls.push({ method: "eq", args }); return this; }
  in(...args: unknown[]) { this.calls.push({ method: "in", args }); return this; }
  is(...args: unknown[]) { this.calls.push({ method: "is", args }); return this; }
  not(...args: unknown[]) { this.calls.push({ method: "not", args }); return this; }
  gt(...args: unknown[]) { this.calls.push({ method: "gt", args }); return this; }
  order(...args: unknown[]) { this.calls.push({ method: "order", args }); return this; }
  limit(...args: unknown[]) { this.calls.push({ method: "limit", args }); return Promise.resolve(this.result); }
  insert(value: unknown) { this.inserted = value; this.calls.push({ method: "insert", args: [value] }); return Promise.resolve(this.result); }
  get insertedValue() { return this.inserted; }
}

function fakeDatabase(fixtures: Record<string, unknown[]>) {
  const queries = new Map<string, FakeQuery[]>();
  const database: FounderDatabase = {
    from(table: string) {
      const query = new FakeQuery({ data: fixtures[table] ?? [], error: null });
      queries.set(table, [...(queries.get(table) ?? []), query]);
      return query as never;
    },
    schema() { return database; },
    rpc: vi.fn(async () => ({ data: "decision-id", error: null })),
  };
  return { database, queries };
}

describe("founder review service", () => {
  it("does not query user hypotheses when no active consent is returned", async () => {
    const { database, queries } = fakeDatabase({ consents: [] });
    await expect(listFounderReviews(database, "founder-1")).resolves.toEqual([]);
    expect(queries.has("hypotheses")).toBe(false);
    const consentCalls = queries.get("consents")?.[0]?.calls ?? [];
    expect(consentCalls).toEqual(expect.arrayContaining([
      { method: "eq", args: ["consent_type", "founder_review"] },
      { method: "is", args: ["revoked_at", null] },
      { method: "not", args: ["expires_at", "is", null] },
    ]));
  });

  it("returns receipt-level evidence without selecting raw content and audits the view", async () => {
    const { database, queries } = fakeDatabase({
      consents: [{ id: "consent-1", user_id: "user-12345678", expires_at: "2026-09-12T00:00:00Z" }],
      hypotheses: [{ id: "hypothesis-1", user_id: "user-12345678", statement: "a recurring creative room", alternatives_json: ["novelty"], confidence: 0.74, sensitivity: "low", proposed_copy: "you keep returning to shared making", reason_to_send: "five moments across four days", proposed_move: null, created_at: "2026-07-20T00:00:00Z" }],
      evidence_links: [{ hypothesis_id: "hypothesis-1", artifact_id: "artifact-1", observation_id: "observation-1", direction: "support", weight: 1 }],
      artifacts: [{ id: "artifact-1", source_type: "image", source_coverage: "image", title: "studio wall", publisher: null, captured_at: "2026-07-18T00:00:00Z" }],
      observations: [{ id: "observation-1", statement: "shared making felt energizing", confidence: 0.8 }],
      audit_events: [],
    });

    const cards = await listFounderReviews(database, "founder-1", new Date("2026-07-20T00:00:00Z"));
    expect(cards[0]).toMatchObject({ userReference: "user-123", statement: "a recurring creative room" });
    expect(cards[0]?.evidence[0]).toMatchObject({ title: "studio wall", observation: "shared making felt energizing" });
    const artifactSelect = queries.get("artifacts")?.[0]?.calls.find((call) => call.method === "select");
    expect(artifactSelect?.args[0]).not.toMatch(/raw_text|transcript|user_note|raw_object_path/);
    expect(queries.get("audit_events")?.[0]?.insertedValue).toEqual([
      expect.objectContaining({ action: "founder_review.view", metadata: expect.objectContaining({ raw_content_revealed: false }) }),
    ]);
  });

  it("requires edited copy and delegates decisions to the consent-rechecking transaction", async () => {
    const { database } = fakeDatabase({});
    await expect(decideFounderReview(database, "founder-1", {
      hypothesisId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113",
      decision: "edit",
    })).rejects.toThrow("edited statement");

    await expect(decideFounderReview(database, "founder-1", {
      hypothesisId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113",
      decision: "approve",
      rubricLabels: ["evidence fidelity"],
    })).resolves.toBe("decision-id");
    expect(database.rpc).toHaveBeenCalledWith("founder_review_hypothesis", expect.objectContaining({
      reviewer: "founder-1",
      review_decision: "approve",
    }));
  });
});
