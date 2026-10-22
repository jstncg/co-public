/**
 * Google, reached over loopback rather than reimplemented.
 *
 * The runtime owns the member's conversation and has no Google client. The working integration —
 * OAuth consent, token refresh, per-member account scoping, 800 tested lines — lives in the Python
 * router beside the tokens. Porting it would mean re-earning consent and re-testing something that
 * already works, so the capability stays where it works and the runtime calls it under its own
 * authority: the runtime decides whether a call is permitted, the bridge only performs it.
 *
 * Three properties this file exists to guarantee.
 *
 * Not-connected is never nothing. A missing refresh token must reach the model as "the calendar is
 * not connected", never as an empty event list, because an empty list reads as a free day and is
 * the exact shape of a confident lie about someone's life.
 *
 * A write is a write. `calendar.hold` puts a real event on a real calendar that other people can
 * see, so it is `external-write` and stops for approval. Its outcome is `outcome`-scoped only when
 * the bridge returns the event link, which is the receipt; a request that was merely accepted stays
 * `request`-scoped and cannot complete a work order on its own.
 *
 * The member is always named. `gcal.accounts_for` exists because an unscoped hold once landed on
 * the founder's calendar instead of the member's (8/28). Every call here carries the tenant, and a
 * tenant with no linked account gets nothing rather than inheriting someone else's mailbox.
 */
import type { JsonObject, JsonValue } from "./types.ts";

export interface GoogleBridgeConfig {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

export interface GoogleReply extends JsonObject {
  ok: boolean;
  connected?: boolean;
  why?: string;
}

/** Loopback only. A bridge that performs Google calls on the member's behalf must never be
 *  addressable from off the machine, and a misconfigured host is a silent exfiltration path. */
export function bridgeConfig(baseUrl: string | undefined, token: string | undefined,
  timeoutMs = 20_000): GoogleBridgeConfig | undefined {
  if (!baseUrl || !token) return undefined;
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { return undefined; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname)) return undefined;
  return { baseUrl: parsed.origin, token, timeoutMs };
}

async function call(config: GoogleBridgeConfig, verb: "calendar" | "hold" | "mail",
  body: JsonObject): Promise<GoogleReply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/google/${config.token}/${verb}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch {
      return { ok: false, connected: false, why: `bridge returned non-JSON (${response.status})` };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, connected: false, why: "bridge returned a non-object" };
    }
    return parsed as GoogleReply;
  } catch (error) {
    // A timeout or a dead router is OUR outage, and it must not be reported as an empty calendar.
    const reason = error instanceof Error && error.name === "AbortError"
      ? `google bridge timed out after ${config.timeoutMs}ms`
      : `google bridge unreachable: ${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, connected: false, why: reason };
  } finally {
    clearTimeout(timer);
  }
}

/** The line the model sees when Google is not connected. One sentence, no apology, and it names
 *  the actual next step rather than implying the member has nothing scheduled. */
export function notConnected(reply: GoogleReply): JsonObject {
  return {
    connected: false,
    unavailable: true,
    reason: String(reply.why ?? "google is not connected for this member"),
    say: "i can't see your calendar or mail — google isn't connected on my side yet",
  };
}

export async function listCalendar(config: GoogleBridgeConfig, tenantId: string,
  limit: number): Promise<JsonObject> {
  const reply = await call(config, "calendar", { tenant: tenantId, limit });
  if (!reply.ok) return notConnected(reply);
  const events = Array.isArray(reply.events) ? reply.events as JsonValue[] : [];
  return { connected: true, count: events.length, events,
    accounts: Array.isArray(reply.accounts) ? reply.accounts as JsonValue[] : [] };
}

export async function searchMail(config: GoogleBridgeConfig, tenantId: string, query: string,
  limit: number): Promise<JsonObject> {
  const reply = await call(config, "mail", { tenant: tenantId, q: query, limit });
  if (!reply.ok) return notConnected(reply);
  const messages = Array.isArray(reply.messages) ? reply.messages as JsonValue[] : [];
  return { connected: true, query, count: messages.length, messages };
}

export interface HoldRequest {
  title: string;
  start: string;
  minutes: number;
  instructions?: string;
}

export async function holdCalendar(config: GoogleBridgeConfig, tenantId: string,
  request: HoldRequest): Promise<JsonObject> {
  const reply = await call(config, "hold", {
    tenant: tenantId, title: request.title, start: request.start,
    minutes: request.minutes, instructions: request.instructions ?? "",
  });
  if (!reply.ok) return { held: false, ...notConnected(reply) };
  // The receipt is the event link. Without it the write is unproven, whatever the bridge said.
  const receipt = typeof reply.receipt === "string" ? reply.receipt : "";
  return { held: Boolean(receipt), receipt, title: request.title, start: request.start,
    minutes: request.minutes, ...(receipt ? {} : { unverified: true, reason: "no event link returned" }) };
}

/** Outcome classification for the write. A hold is only `outcome`-scoped with a link in hand;
 *  everything else is a failure or an accepted request, never a completion. */
export function holdOutcome(output: JsonValue): { status: "succeeded" | "failed"; error?: string;
  evidenceScope: "request" | "outcome" } {
  const record = output && typeof output === "object" && !Array.isArray(output)
    ? output as JsonObject : {};
  if (record.held === true && typeof record.receipt === "string" && record.receipt.length > 0) {
    return { status: "succeeded", evidenceScope: "outcome" };
  }
  const reason = typeof record.reason === "string" ? record.reason
    : typeof record.why === "string" ? record.why : "the calendar write returned no event link";
  return { status: "failed", error: reason, evidenceScope: "request" };
}
