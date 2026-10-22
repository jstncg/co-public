import { describe, expect, it, vi } from "vitest";
import { enforceUserRateLimit } from "./rate-limit";

describe("authenticated rate limiting", () => {
  it("claims a user-scoped database bucket", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ allowed: true, retry_after_seconds: 0, current_count: 1 }],
      error: null,
    });
    await expect(enforceUserRateLimit({ rpc } as never, "user-id", {
      bucket: "captures.write",
      limit: 60,
      windowSeconds: 600,
    })).resolves.toMatchObject({ allowed: true, current_count: 1 });
    expect(rpc).toHaveBeenCalledWith("claim_api_rate_limit", {
      p_scope_key: "user:user-id",
      p_bucket: "captures.write",
      p_limit: 60,
      p_window_seconds: 600,
    });
  });

  it("returns a generic 429 with Retry-After when exhausted", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ allowed: false, retry_after_seconds: 41, current_count: 4 }],
      error: null,
    });
    try {
      await enforceUserRateLimit({ rpc } as never, "user-id", {
        bucket: "account.export",
        limit: 3,
        windowSeconds: 86_400,
      });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      expect((error as Response).status).toBe(429);
      expect((error as Response).headers.get("retry-after")).toBe("41");
      await expect((error as Response).json()).resolves.toEqual({ error: "rate_limited" });
    }
  });
});

