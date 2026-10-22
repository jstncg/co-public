import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAppleClientSecret, saveAppleAuthorization } from "./apple-authorization";

function testConfiguration() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    APPLE_TEAM_ID: "TEAMID1234",
    APPLE_KEY_ID: "KEYID12345",
    APPLE_CLIENT_ID: "co.app",
    APPLE_PRIVATE_KEY_BASE64: Buffer.from(pem).toString("base64"),
  };
}

describe("Sign in with Apple authorization retention", () => {
  it("creates a five-minute ES256 client secret with Apple claims", () => {
    const environment = testConfiguration();
    const token = createAppleClientSecret({
      teamId: environment.APPLE_TEAM_ID,
      keyId: environment.APPLE_KEY_ID,
      clientId: environment.APPLE_CLIENT_ID,
      privateKeyBase64: environment.APPLE_PRIVATE_KEY_BASE64,
    }, new Date("2026-07-20T12:00:00Z"));
    const [encodedHeader, encodedPayload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(encodedHeader!, "base64url").toString())).toMatchObject({ alg: "ES256", kid: "KEYID12345" });
    expect(JSON.parse(Buffer.from(encodedPayload!, "base64url").toString())).toMatchObject({
      iss: "TEAMID1234", sub: "co.app", aud: "https://appleid.apple.com",
      exp: 1784549100, iat: 1784548800,
    });
    expect(Buffer.from(signature!, "base64url")).toHaveLength(64);
  });

  it("exchanges the one-time native code and stores only the server-side refresh token", async () => {
    const environment = testConfiguration();
    const upsert = vi.fn(async () => ({ data: null, error: null }));
    const admin: any = { schema: vi.fn(() => ({ from: vi.fn(() => ({ upsert })) })) };
    const fetchImplementation = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("one-time-code");
      expect(body.get("client_secret")?.split(".")).toHaveLength(3);
      return Response.json({ refresh_token: "server-refresh-token", access_token: "short-lived" });
    });
    await expect(saveAppleAuthorization(admin, "user-1", { authorizationCode: "one-time-code" }, {
      environment,
      fetchImplementation: fetchImplementation as typeof fetch,
      now: new Date("2026-07-20T12:00:00Z"),
    })).resolves.toEqual({ stored: true });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "user-1", refresh_token: "server-refresh-token",
    }), { onConflict: "user_id" });
  });
});
