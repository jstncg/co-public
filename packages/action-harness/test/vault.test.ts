import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryEncryptedVaultStore, WorkspaceBoundVault } from "../src/index";

describe("workspace-bound action vault", () => {
  it("decrypts only for the sealing workspace and exact stored origin", async () => {
    const store = new InMemoryEncryptedVaultStore();
    const vault = new WorkspaceBoundVault(randomBytes(32), store);
    const secret = Buffer.from("canary-password-9f4e", "utf8");
    const reference = await vault.seal({
      workspaceId: "workspace-a",
      kind: "credential",
      origin: "https://accounts.example.test",
      secret,
      now: new Date("2026-08-29T18:00:00Z"),
    });
    secret.fill(0);
    let observed = "";
    await vault.withSecret(
      {
        workspaceId: "workspace-a",
        handle: reference.handle,
        currentOrigin: "https://accounts.example.test",
      },
      async (plaintext) => {
        observed = Buffer.from(plaintext).toString("utf8");
      },
    );
    expect(observed).toBe("canary-password-9f4e");
    await expect(
      vault.withSecret(
        {
          workspaceId: "workspace-b",
          handle: reference.handle,
          currentOrigin: "https://accounts.example.test",
        },
        async () => {},
      ),
    ).rejects.toThrow(/workspace/);
    await expect(
      vault.withSecret(
        {
          workspaceId: "workspace-a",
          handle: reference.handle,
          currentOrigin: "https://evil.example.test",
        },
        async () => {},
      ),
    ).rejects.toThrow(/origin/);
    vault.destroy();
  });

  it("binds origin and workspace into authenticated ciphertext", async () => {
    const store = new InMemoryEncryptedVaultStore();
    const vault = new WorkspaceBoundVault(randomBytes(32), store);
    const reference = await vault.seal({
      workspaceId: "workspace-a",
      kind: "credential",
      origin: "https://accounts.example.test",
      secret: Buffer.from("canary-password-9f4e"),
    });
    const record = await store.get(reference.handle);
    expect(record?.ciphertext).not.toContain("canary-password-9f4e");
    await store.put({ ...record!, handle: "77777777-7777-4777-8777-777777777777" });
    await expect(
      vault.withSecret(
        {
          workspaceId: "workspace-a",
          handle: "77777777-7777-4777-8777-777777777777",
          currentOrigin: "https://accounts.example.test",
        },
        async () => {},
      ),
    ).rejects.toThrow(/workspace/);
    vault.destroy();
  });
});
