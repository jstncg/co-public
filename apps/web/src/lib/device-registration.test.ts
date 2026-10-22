import { describe, expect, it, vi } from "vitest";
import { registerDevice } from "./device-registration";

describe("APNs device registration", () => {
  it("binds a validated token to the authenticated user through one transaction", async () => {
    const rpc = vi.fn(async () => ({ data: "device-1", error: null }));
    const admin: any = { rpc };
    await expect(registerDevice(admin, "user-1", {
      deviceId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113",
      apnsToken: "ab".repeat(32),
      apnsEnvironment: "sandbox",
      appVersion: "1.0 (1)",
      osVersion: "iOS 26.1",
    })).resolves.toEqual({ registered: true });
    expect(rpc).toHaveBeenCalledWith("register_apns_device", expect.objectContaining({
      p_user_id: "user-1",
      p_apns_token: "ab".repeat(32),
    }));
  });

  it("rejects malformed or extra client fields", async () => {
    const rpc = vi.fn();
    const admin: any = { rpc };
    await expect(registerDevice(admin, "user-1", {
      deviceId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113",
      apnsToken: "not-a-token",
      apnsEnvironment: "production",
      appVersion: "1",
      osVersion: "iOS",
    })).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});
