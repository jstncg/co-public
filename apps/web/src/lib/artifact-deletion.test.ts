import { describe, expect, it, vi } from "vitest";
import { deleteArtifact } from "./artifact-deletion";

describe("single artifact deletion", () => {
  it("removes only the resolved owned object before invalidating derived memory", async () => {
    const query: any = {
      select() { return query; }, eq() { return query; }, is() { return query; },
      maybeSingle: async () => ({ data: { id: "artifact-1", raw_object_path: "user-1/0198c5d2-bfed-75e0-b7d1-8a89b7c04113/voice.m4a" }, error: null }),
    };
    const remove = vi.fn(async () => ({ data: null, error: null }));
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    const admin: any = { from: () => query, storage: { from: () => ({ remove }) }, rpc };
    await deleteArtifact(admin, "user-1", "0198c5d2-bfed-75e0-b7d1-8a89b7c04113");
    expect(remove).toHaveBeenCalledWith(["user-1/0198c5d2-bfed-75e0-b7d1-8a89b7c04113/voice.m4a"]);
    expect(rpc).toHaveBeenCalledWith("delete_user_artifact", {
      p_user_id: "user-1", p_client_artifact_id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113",
    });
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(rpc.mock.invocationCallOrder[0] ?? 0);
  });

  it("fails closed on a mismatched storage namespace", async () => {
    const query: any = {
      select() { return query; }, eq() { return query; }, is() { return query; },
      maybeSingle: async () => ({ data: { id: "artifact-1", raw_object_path: "user-2/artifact/file" }, error: null }),
    };
    const admin: any = { from: () => query, storage: { from: () => ({ remove: vi.fn() }) }, rpc: vi.fn() };
    await expect(deleteArtifact(admin, "user-1", "0198c5d2-bfed-75e0-b7d1-8a89b7c04113")).rejects.toThrow("unexpected object path");
    expect(admin.rpc).not.toHaveBeenCalled();
  });
});
