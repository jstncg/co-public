import { describe, expect, it, vi } from "vitest";
import { prepareMove, recordOutcome, transitionMove } from "./move-service";

describe("persisted moves and outcomes", () => {
  it("prepares an artifact-owned experiment without granting external authority", async () => {
    const inserted: unknown[] = [];
    const artifactQuery: any = {
      select() { return artifactQuery; }, eq() { return artifactQuery; }, is() { return artifactQuery; },
      single: async () => ({ data: { id: "artifact-server-1" }, error: null }),
    };
    const moveQuery: any = {
      insert(value: unknown) { inserted.push(value); return moveQuery; }, select() { return moveQuery; },
      single: async () => ({ data: { id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04119" }, error: null }),
    };
    const admin: any = { from: (table: string) => table === "artifacts" ? artifactQuery : moveQuery };
    await expect(prepareMove(admin, "user-1", {
      clientArtifactId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113",
      title: "try one studio session",
      steps: ["find one low-commitment session", "choose after reviewing it"],
    })).resolves.toMatchObject({ status: "prepared" });
    expect(inserted[0]).toMatchObject({
      user_id: "user-1",
      status: "prepared",
      required_authority: "final_user_action",
      plan_json: { external_effect: false, final_user_action_required: true, private_context_disclosed: false },
    });
  });

  it("requires literal user confirmation and records outcomes only through owner-checking transactions", async () => {
    const rpc = vi.fn(async () => ({ data: "ok", error: null }));
    const admin: any = { rpc };
    await expect(transitionMove(admin, "user-1", {
      moveId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113", status: "approved", userConfirmed: false,
    })).rejects.toThrow();
    await transitionMove(admin, "user-1", {
      moveId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113", status: "completed", userConfirmed: true,
    });
    expect(rpc).toHaveBeenCalledWith("transition_user_move", expect.objectContaining({ p_user_id: "user-1", p_user_confirmed: true }));

    await recordOutcome(admin, "user-1", {
      moveId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113",
      result: "the small session made starting easier",
      valueRating: 5,
      surpriseRating: 3,
      repeatIntent: "yes",
    });
    expect(rpc).toHaveBeenCalledWith("record_move_outcome", expect.objectContaining({ p_user_id: "user-1", p_value_rating: 5 }));
  });
});
