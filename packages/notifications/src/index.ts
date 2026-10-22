import { createPrivateKey, randomUUID, sign } from "node:crypto";
import { connect } from "node:http2";

export type CallbackType = "pattern" | "radar" | "reminder" | "weekly" | "outcome" | "return" | "event_anchor" | "second_opinion" | "reflection" | "absence";

const safeCopy: Record<CallbackType, string> = {
  pattern: "a pattern is ready to review.",
  radar: "something on your radar may be worth a look.",
  reminder: "you asked co to bring something back.",
  weekly: "your private week is ready to review.",
  outcome: "want to note what happened?",
  return: "something you saved became useful again.",
  event_anchor: "something you asked co to remember is here.",
  second_opinion: "co found a sharper angle worth reviewing.",
  reflection: "a private reflection is ready when you are.",
  absence: "something you saved may be useful now.",
};

export function evaluateInterruption(input: {
  callbackType: CallbackType;
  withinQuietHours: boolean;
  proactiveSentThisWeek: number;
  weeklyCap: number;
  hasUnreadProactive: boolean;
}) {
  if (input.withinQuietHours) return { decision: "inbox_only" as const, reason: "quiet_hours" as const };
  if (input.callbackType === "reminder") return { decision: "send" as const };
  if (input.hasUnreadProactive) return { decision: "inbox_only" as const, reason: "unread_previous" as const };
  if (input.proactiveSentThisWeek >= input.weeklyCap) return { decision: "inbox_only" as const, reason: "weekly_cap" as const };
  return { decision: "send" as const };
}

export type APNsConfiguration = {
  teamId: string;
  keyId: string;
  bundleId: string;
  privateKeyBase64: string;
};

const base64url = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");

export function createAPNsProviderToken(config: APNsConfiguration, now = new Date()) {
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const payload = base64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(now.getTime() / 1_000) }));
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey(Buffer.from(config.privateKeyBase64, "base64").toString("utf8"));
  const signature = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64url(signature)}`;
}

export function buildPrivacySafePayload(callbackType: CallbackType, resourceId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(resourceId)) throw new Error("invalid callback resource");
  const payload = {
    aps: { alert: safeCopy[callbackType], sound: "default" },
    route: "callback",
    callback_type: callbackType,
    resource_id: resourceId,
  };
  const body = Buffer.from(JSON.stringify(payload));
  if (body.byteLength > 4_096) throw new Error("APNs payload exceeds 4 KB");
  return body;
}

export function buildAPNsRequest(input: {
  token: string;
  environment: "sandbox" | "production";
  callbackType: CallbackType;
  resourceId: string;
  configuration: APNsConfiguration;
  now?: Date;
}) {
  if (!/^(?:[a-f0-9]{2}){16,100}$/.test(input.token)) throw new Error("invalid APNs token");
  const authority = input.environment === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
  return {
    authority,
    headers: {
      ":method": "POST",
      ":path": `/3/device/${input.token}`,
      authorization: `bearer ${createAPNsProviderToken(input.configuration, input.now)}`,
      "apns-push-type": "alert",
      "apns-topic": input.configuration.bundleId,
      "apns-priority": "5",
      "apns-expiration": String(Math.floor((input.now ?? new Date()).getTime() / 1_000) + 86_400),
      "apns-id": randomUUID(),
    },
    body: buildPrivacySafePayload(input.callbackType, input.resourceId),
  };
}

export async function sendAPNs(input: Parameters<typeof buildAPNsRequest>[0]) {
  const built = buildAPNsRequest(input);
  return new Promise<{ status: number; reason?: string }>((resolve, reject) => {
    const client = connect(built.authority);
    client.once("error", reject);
    const request = client.request(built.headers);
    let status = 0;
    const chunks: Buffer[] = [];
    request.on("response", (headers) => { status = Number(headers[":status"] ?? 0); });
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", (error) => { client.close(); reject(error); });
    request.on("end", () => {
      client.close();
      const responseBody = Buffer.concat(chunks).toString("utf8");
      const reason = responseBody ? (JSON.parse(responseBody) as { reason?: string }).reason : undefined;
      resolve(reason === undefined ? { status } : { status, reason });
    });
    request.end(built.body);
  });
}

export function isWithinQuietHours(now: Date, timeZone: string, start: string, end: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  const current = hour * 60 + minute;
  const parse = (value: string) => { const [h = "0", m = "0"] = value.split(":"); return Number(h) * 60 + Number(m); };
  const startMinute = parse(start);
  const endMinute = parse(end);
  return startMinute <= endMinute
    ? current >= startMinute && current < endMinute
    : current >= startMinute || current < endMinute;
}
