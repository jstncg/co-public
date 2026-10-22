import { describe, expect, it } from "vitest";
import { listAccessLog } from "./access-log";

describe("user access log", () => {
  it("returns the authenticated user's categorical audit trail without metadata or content", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const query: any = {
      select(...args: unknown[]) { calls.push({ method: "select", args }); return query; },
      eq(...args: unknown[]) { calls.push({ method: "eq", args }); return query; },
      order(...args: unknown[]) { calls.push({ method: "order", args }); return query; },
      limit(...args: unknown[]) {
        calls.push({ method: "limit", args });
        return Promise.resolve({ data: [{ id: 1, actor_type: "founder", action: "founder_review.view", resource_type: "hypothesis", purpose: "consented_alpha_review", created_at: "2026-07-20T00:00:00Z" }], error: null });
      },
    };
    const admin: any = { from: () => query };
    await expect(listAccessLog(admin, "user-1")).resolves.toEqual([expect.objectContaining({ id: 1, actorType: "founder" })]);
    expect(calls).toContainEqual({ method: "eq", args: ["user_id", "user-1"] });
    const columns = String(calls.find((call) => call.method === "select")?.args[0]);
    expect(columns).not.toMatch(/metadata|raw|text|note|transcript/);
  });
});
