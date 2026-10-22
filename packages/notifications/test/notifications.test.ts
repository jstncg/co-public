import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAPNsRequest, buildPrivacySafePayload, evaluateInterruption, isWithinQuietHours } from "../src/index";

function configuration() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    teamId: "TEAMID1234", keyId: "KEYID12345", bundleId: "com.co.app",
    privateKeyBase64: Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64"),
  };
}

describe("privacy-safe APNs", () => {
  it("uses fixed generic copy and only routing identifiers", () => {
    const body = JSON.parse(buildPrivacySafePayload("radar", "0198c5d2-bfed-75e0-b7d1-8a89b7c04113").toString());
    expect(body).toEqual({
      aps: { alert: "something on your radar may be worth a look.", sound: "default" },
      route: "callback", callback_type: "radar", resource_id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113",
    });
    expect(JSON.stringify(body)).not.toMatch(/why_user|note|transcript|title|summary/);
  });

  it("builds the required alert headers for the correct APNs environment", () => {
    const request = buildAPNsRequest({
      token: "ab".repeat(32), environment: "sandbox", callbackType: "pattern",
      resourceId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113", configuration: configuration(),
      now: new Date("2026-07-20T12:00:00Z"),
    });
    expect(request.authority).toBe("https://api.sandbox.push.apple.com");
    expect(request.headers).toMatchObject({ "apns-push-type": "alert", "apns-topic": "com.co.app", "apns-priority": "5" });
    expect(request.headers.authorization.split(".")).toHaveLength(3);
  });

  it("handles quiet hours that cross midnight in the user's timezone", () => {
    expect(isWithinQuietHours(new Date("2026-07-20T07:30:00Z"), "America/Los_Angeles", "23:00", "08:00")).toBe(true);
    expect(isWithinQuietHours(new Date("2026-07-20T20:00:00Z"), "America/Los_Angeles", "23:00", "08:00")).toBe(false);
  });

  it("uses one unread-gated weekly budget while exempting requested reminders", () => {
    expect(evaluateInterruption({ callbackType: "return", withinQuietHours: false, proactiveSentThisWeek: 0, weeklyCap: 2, hasUnreadProactive: true }))
      .toEqual({ decision: "inbox_only", reason: "unread_previous" });
    expect(evaluateInterruption({ callbackType: "radar", withinQuietHours: false, proactiveSentThisWeek: 2, weeklyCap: 2, hasUnreadProactive: false }))
      .toEqual({ decision: "inbox_only", reason: "weekly_cap" });
    expect(evaluateInterruption({ callbackType: "reminder", withinQuietHours: false, proactiveSentThisWeek: 99, weeklyCap: 0, hasUnreadProactive: true }))
      .toEqual({ decision: "send" });
  });

  it("keeps every proactive payload generic, including returns and second opinions", () => {
    const resource = "0198c5d2-bfed-75e0-b7d1-8a89b7c04113";
    expect(JSON.parse(buildPrivacySafePayload("return", resource).toString()).aps.alert).toBe("something you saved became useful again.");
    expect(JSON.parse(buildPrivacySafePayload("second_opinion", resource).toString()).aps.alert).not.toMatch(/source|title|history/);
  });
});
