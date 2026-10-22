import { describe, expect, it } from "vitest";
import { requireFounder } from "./founder-auth";

const validEnvironment = {
  FEATURE_FOUNDER_REVIEW: "true",
  FOUNDER_ACCESS_TOKEN: "a-founder-secret-that-is-at-least-32-characters",
  FOUNDER_REVIEWER_ID: "founder-1",
};

describe("founder authentication boundary", () => {
  it("is unavailable while the kill switch is off", () => {
    expect(() => requireFounder(new Request("https://co.example"), {
      ...validEnvironment,
      FEATURE_FOUNDER_REVIEW: "false",
    })).toThrowError(expect.objectContaining({ status: 404 }));
  });

  it("rejects a consumer or incorrect bearer token", () => {
    const request = new Request("https://co.example", { headers: { authorization: "Bearer wrong" } });
    expect(() => requireFounder(request, validEnvironment)).toThrowError(expect.objectContaining({ status: 401 }));
  });

  it("returns only the server-configured reviewer identity", () => {
    const request = new Request("https://co.example", {
      headers: { authorization: `Bearer ${validEnvironment.FOUNDER_ACCESS_TOKEN}` },
    });
    expect(requireFounder(request, validEnvironment)).toEqual({ reviewerId: "founder-1" });
  });
});
