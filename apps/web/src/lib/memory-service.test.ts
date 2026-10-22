import { describe, expect, it, vi } from "vitest";
import { createStandingOrder, dismissMemoryReturn, importLegacyClaim } from "./memory-service";

describe("governed memory service", () => {
  it("stores a standing order in the user's own words and scope", async () => {
    const row = {
      id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04810", instruction: "stop asking follow-up questions",
      scope: "all", exact_receipt: null, created_at: "2026-07-20T19:00:00Z",
    };
    const query: any = {
      insert: vi.fn(() => query), select: vi.fn(() => query),
      single: vi.fn(async () => ({ data: row, error: null })),
    };
    const result = await createStandingOrder({ from: () => query } as any, "user-1", {
      instruction: "  stop asking follow-up questions  ", scope: "all", exactReceipt: null,
    });
    expect(query.insert).toHaveBeenCalledWith({
      user_id: "user-1", instruction: "stop asking follow-up questions", scope: "all", exact_receipt: null,
    });
    expect(result).toMatchObject({ id: row.id, instruction: row.instruction });
  });

  it("imports predecessor claims only as unconfirmed receipt-linked evidence", async () => {
    const rpc = vi.fn(async () => ({ data: "0198c5d2-bfed-75e0-b7d1-8a89b7c04811", error: null }));
    const evidenceArtifactIds = ["0198c5d2-bfed-75e0-b7d1-8a89b7c04812"];
    await expect(importLegacyClaim({ rpc } as any, "user-1", {
      sourceClaimId: "legacy-1", statement: "  you may prefer smaller rooms  ",
      evidenceArtifactIds, alternatives: ["it may be the people"], sourceSystem: "predecessor",
    })).resolves.toMatchObject({ status: "unconfirmed" });
    expect(rpc).toHaveBeenCalledWith("import_legacy_memory_claim", expect.objectContaining({
      p_user_id: "user-1", p_statement: "you may prefer smaller rooms", p_evidence_artifact_ids: evidenceArtifactIds,
    }));
  });

  it("dismisses a return only through the scoped transaction", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const id = "0198c5d2-bfed-75e0-b7d1-8a89b7c04813";
    await expect(dismissMemoryReturn({ rpc } as any, "user-1", id)).resolves.toEqual({ dismissed: true });
    expect(rpc).toHaveBeenCalledWith("dismiss_memory_return", { p_user_id: "user-1", p_return_id: id });
  });
});
