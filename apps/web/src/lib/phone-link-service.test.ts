import { describe, expect, it, vi } from "vitest";
import { getPhoneLinkStatus, requestPhoneLink, verifyPhoneLink } from "./phone-link-service";

const challengeId = "0198c5d2-bfed-75e0-b7d1-8a89b7c04410";
const environment = {
  FEATURE_PHONE_LINKING: "true",
  CO_RAIL: "sendblue",
  CO_PHONE_MAPPING_PEPPER: "p".repeat(32),
  CO_PHONE_LINK_CHALLENGE_SECRET: "c".repeat(32),
  SENDBLUE_API_KEY_ID: "sendblue-key",
  SENDBLUE_API_SECRET_KEY: "sendblue-secret",
  SENDBLUE_FROM_NUMBER: "+14155550100",
};
const linqEnvironment = {
  FEATURE_PHONE_LINKING: "true",
  CO_RAIL: "linq",
  CO_PHONE_MAPPING_PEPPER: "p".repeat(32),
  CO_PHONE_LINK_CHALLENGE_SECRET: "c".repeat(32),
  LINQ_API_KEY: "linq-api-key",
  LINQ_FROM_NUMBER: "+14155550101",
};

describe("phone linking", () => {
  it("stores only hashes and sends a short-lived code from the backend", async () => {
    const rpc = vi.fn(async (_name: string, _payload: unknown) => ({ data: challengeId, error: null }));
    const send = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ status: "OK" }), { status: 200 }));
    const result = await requestPhoneLink({ rpc } as any, "user-1", { phoneNumber: "+14155550123" }, {
      environment, fetchImplementation: send as typeof fetch, challengeId, code: "042731",
      now: new Date("2026-07-20T19:00:00Z"),
    });
    expect(result).toEqual({ challengeId, expiresAt: "2026-07-20T19:05:00.000Z", phoneLast4: "0123" });
    const databasePayload = rpc.mock.calls[0]?.[1] as Record<string, string>;
    expect(databasePayload.p_phone_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(databasePayload.p_code_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(databasePayload)).not.toContain("+14155550123");
    expect(JSON.stringify(databasePayload)).not.toContain("042731");
    const request = send.mock.calls[0]?.[1] as RequestInit;
    expect(send.mock.calls[0]?.[0]).toBe("https://api.sendblue.com/api/send-message");
    expect(request.headers).toMatchObject({ "sb-api-key-id": "sendblue-key", "sb-api-secret-key": "sendblue-secret" });
    expect(JSON.parse(String(request.body))).toEqual({
      number: "+14155550123", from_number: "+14155550100",
      content: "your co verification code is 042731. it expires in 5 minutes.",
    });
  });

  it("delivers the same challenge through a fixed Linq identity", async () => {
    const rpc = vi.fn(async () => ({ data: challengeId, error: null }));
    const send = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ chat_id: "chat-1" }), { status: 200 }));
    await requestPhoneLink({ rpc } as any, "user-1", { phoneNumber: "+14155550123" }, {
      environment: linqEnvironment,
      fetchImplementation: send as typeof fetch,
      challengeId,
      code: "042731",
      now: new Date("2026-07-20T19:00:00Z"),
    });
    expect(send.mock.calls[0]?.[0]).toBe("https://api.linqapp.com/api/partner/v3/chats");
    const request = send.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({ authorization: "Bearer linq-api-key" });
    expect(JSON.parse(String(request.body))).toEqual({
      from: "+14155550101",
      to: ["+14155550123"],
      message: {
        idempotency_key: `phone-link:${challengeId}`,
        parts: [{ type: "text", value: "your co verification code is 042731. it expires in 5 minutes." }],
      },
    });
  });

  it("fails closed while disabled and verifies only through the challenge hash", async () => {
    const rpc = vi.fn(async (_name: string, _payload: unknown) => ({ data: true, error: null }));
    await expect(requestPhoneLink({ rpc } as any, "user-1", { phoneNumber: "+14155550123" }, {
      environment: { ...environment, FEATURE_PHONE_LINKING: "false" },
    })).rejects.toMatchObject({ status: 503 });
    expect(rpc).not.toHaveBeenCalled();

    await expect(verifyPhoneLink({ rpc } as any, "user-1", { challengeId, code: "042731" }, {
      environment, now: new Date("2026-07-20T19:01:00Z"),
    })).resolves.toEqual({ linked: true });
    const verification = rpc.mock.calls[0]?.[1] as Record<string, string>;
    expect(verification.p_code_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(verification)).not.toContain("042731");
  });

  it("returns only last-four status and the configured handoff line", async () => {
    const rpc = vi.fn(async () => ({ data: [{ phone_last4: "0123", verified_at: "2026-07-20T19:01:00Z" }], error: null }));
    await expect(getPhoneLinkStatus({ rpc } as any, "user-1", environment)).resolves.toEqual({
      linked: true, phoneLast4: "0123", verifiedAt: "2026-07-20T19:01:00Z", handoffNumber: "+14155550100",
    });
  });

  it("returns the Linq number as the handoff when Linq carries the relationship", async () => {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    await expect(getPhoneLinkStatus({ rpc } as any, "user-1", linqEnvironment)).resolves.toMatchObject({
      linked: false,
      handoffNumber: "+14155550101",
    });
  });

  it("does not require provider credentials after the code has already been delivered", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    const challengeOnly = {
      FEATURE_PHONE_LINKING: "true",
      CO_PHONE_MAPPING_PEPPER: "p".repeat(32),
      CO_PHONE_LINK_CHALLENGE_SECRET: "c".repeat(32),
    };
    await expect(verifyPhoneLink({ rpc } as any, "user-1", { challengeId, code: "042731" }, {
      environment: challengeOnly,
    })).resolves.toEqual({ linked: true });
  });

  it("consumes an unusable challenge when provider delivery fails", async () => {
    const rpc = vi.fn(async (name: string, _payload: unknown) => ({ data: name === "begin_transport_phone_link" ? challengeId : null, error: null }));
    const send = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response("unavailable", { status: 503 }));
    await expect(requestPhoneLink({ rpc } as any, "user-1", { phoneNumber: "+14155550123" }, {
      environment, fetchImplementation: send as typeof fetch, challengeId, code: "042731",
      now: new Date("2026-07-20T19:00:00Z"),
    })).rejects.toThrow("delivery rejected (503)");
    expect(rpc).toHaveBeenLastCalledWith("cancel_transport_phone_link", {
      p_challenge_id: challengeId, p_user_id: "user-1",
    });
  });
});
