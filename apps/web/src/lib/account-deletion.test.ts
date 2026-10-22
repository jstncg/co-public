import { describe, expect, it, vi } from "vitest";
import { deleteAccount } from "./account-deletion";

describe("account deletion", () => {
  it("removes only resolved objects in the user namespace before deleting auth", async () => {
    const list = vi.fn(async (prefix: string) => ({
      data: prefix === "user-1"
        ? [{ id: null, name: "0198c5d2-bfed-75e0-b7d1-8a89b7c04111" }]
        : [{ id: "object-1", name: "voice.m4a" }],
      error: null,
    }));
    const remove = vi.fn(async () => ({ data: null, error: null }));
    const insert = vi.fn(async () => ({ data: null, error: null }));
    const deleteUser = vi.fn(async () => ({ data: null, error: null }));
    const revokeProvider = vi.fn(async () => true);
    const admin = {
      storage: { from: vi.fn((bucket: string) => bucket === "artifacts" ? { list, remove } : {
        list: vi.fn(async () => ({ data: [], error: null })), remove,
      }) },
      from: vi.fn(() => ({ insert })),
      auth: { admin: { deleteUser } },
    };

    await expect(deleteAccount(admin, "user-1", revokeProvider)).resolves.toEqual({
      storageObjectsRemoved: 1,
      providerRevoked: true,
      manualProviderRevocationRequired: false,
    });
    expect(remove).toHaveBeenCalledWith(["user-1/0198c5d2-bfed-75e0-b7d1-8a89b7c04111/voice.m4a"]);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ action: "account.delete" }));
    expect(deleteUser).toHaveBeenCalledWith("user-1");
    expect(revokeProvider.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0] ?? 0);
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(deleteUser.mock.invocationCallOrder[0] ?? 0);
  });

  it("fails closed on an unexpected namespace shape", async () => {
    const admin = {
      storage: { from: (bucket: string) => ({
        list: vi.fn(async () => ({ data: bucket === "artifacts" ? [{ id: null, name: "../another-user" }] : [], error: null })),
        remove: vi.fn(async () => ({ data: null, error: null })),
      }) },
      from: () => ({ insert: vi.fn(async () => ({ data: null, error: null })) }),
      auth: { admin: { deleteUser: vi.fn(async () => ({ data: null, error: null })) } },
    };
    await expect(deleteAccount(admin, "user-1", async () => true)).rejects.toThrow("unexpected storage folder");
    expect(admin.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("still fulfills deletion and reports manual Apple cleanup when provider revocation is unavailable", async () => {
    const deleteUser = vi.fn(async () => ({ data: null, error: null }));
    const insert = vi.fn(async () => ({ data: null, error: null }));
    const admin = {
      storage: { from: () => ({
        list: vi.fn(async () => ({ data: [], error: null })),
        remove: vi.fn(async () => ({ data: null, error: null })),
      }) },
      from: () => ({ insert }),
      auth: { admin: { deleteUser } },
    };
    await expect(deleteAccount(admin, "user-1", async () => { throw new Error("Apple unavailable"); })).resolves.toMatchObject({
      providerRevoked: false,
      manualProviderRevocationRequired: true,
    });
    expect(deleteUser).toHaveBeenCalledWith("user-1");
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ manual_provider_revocation_required: true }),
    }));
  });
});
