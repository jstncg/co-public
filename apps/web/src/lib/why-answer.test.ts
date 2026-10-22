import { describe, expect, it, vi } from "vitest";
import { saveWhyAnswer } from "./why-answer";

describe("why answers", () => {
  it("delegates the authenticated ownership and exact-option check to one database transaction", async () => {
    const rpc = vi.fn(async () => ({ data: "annotation-1", error: null }));
    const admin: any = { rpc };
    await expect(saveWhyAnswer(admin, "user-1", {
      clientArtifactId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113",
      value: "the craft",
    })).resolves.toEqual({ accepted: true });
    expect(rpc).toHaveBeenCalledWith("set_why_annotation", {
      p_user_id: "user-1",
      p_client_artifact_id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113",
      p_value: "the craft",
    });
  });

  it("rejects free text and unknown fields before touching the database", async () => {
    const rpc = vi.fn();
    const admin: any = { rpc };
    await expect(saveWhyAnswer(admin, "user-1", {
      clientArtifactId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113",
      value: "x".repeat(61),
    })).rejects.toThrow();
    await expect(saveWhyAnswer(admin, "user-1", {
      clientArtifactId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113",
      value: "the craft",
      userId: "user-2",
    })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});
