/**
 * Google reached over loopback, and the three ways it must fail.
 *
 * The runtime owns the founder's conversation and has no Google client; the working integration
 * lives in the Python router beside the OAuth tokens. As of 9/6 there are no credentials at all
 * (`gog auth list` returns "refresh token missing"), so the not-connected path is the live path and
 * is tested first, not last.
 *
 * The failure that matters most is silent: an empty event list read as a free day. A member asking
 * "what's on tomorrow" and hearing "nothing" when the truth is "I cannot see your calendar" is a
 * confident lie about their life, and it is indistinguishable from a working system until they miss
 * something.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, describe, it } from "node:test";
import { bridgeConfig, holdCalendar, holdOutcome, listCalendar, searchMail } from "../src/google.ts";

const servers: Server[] = [];
after(() => { for (const server of servers) server.close(); });

/** A stand-in for the router's bridge. Returns whatever the case under test needs it to. */
async function bridge(handler: (verb: string, body: Record<string, unknown>) =>
  { status?: number; payload: unknown }): Promise<{ url: string }> {
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      const verb = (request.url ?? "").split("/").pop() ?? "";
      const { status = 200, payload } = handler(verb, JSON.parse(raw || "{}"));
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}` };
}

describe("the google bridge", () => {
  it("refuses any host that is not loopback", () => {
    assert.equal(bridgeConfig("https://example.com", "t"), undefined);
    assert.equal(bridgeConfig("http://10.0.0.5:8099", "t"), undefined);
    assert.equal(bridgeConfig("file:///etc/passwd", "t"), undefined);
    assert.equal(bridgeConfig("not a url", "t"), undefined);
    assert.ok(bridgeConfig("http://127.0.0.1:8099", "t"));
    assert.ok(bridgeConfig("http://localhost:8099/ignored/path", "t"));
  });

  it("is undefined without both a url and a token, so the tools never register", () => {
    assert.equal(bridgeConfig("", "t"), undefined);
    assert.equal(bridgeConfig("http://127.0.0.1:8099", ""), undefined);
    assert.equal(bridgeConfig(undefined, undefined), undefined);
  });

  it("reports a missing refresh token as not-connected, never as an empty day", async () => {
    const { url } = await bridge(() => ({
      status: 502,
      payload: { ok: false, connected: false, why: "token refresh failed for dennis@gmail.com", events: [] },
    }));
    const config = bridgeConfig(url, "tok")!;
    const result = await listCalendar(config, "dennis", 10);
    assert.equal(result.connected, false);
    assert.equal(result.unavailable, true);
    assert.match(String(result.reason), /token refresh failed/);
    assert.equal(result.events, undefined, "an unavailable calendar must not carry an event list");
    assert.match(String(result.say), /isn't connected/);
  });

  it("reports an unreachable router as our outage, not their empty calendar", async () => {
    const config = bridgeConfig("http://127.0.0.1:1", "tok")!;
    const result = await listCalendar(config, "dennis", 10);
    assert.equal(result.connected, false);
    assert.match(String(result.reason), /unreachable|timed out/);
    assert.equal(result.events, undefined);
  });

  it("returns events when google is actually connected", async () => {
    const { url } = await bridge(() => ({
      payload: { ok: true, connected: true, accounts: ["dennis@gmail.com"],
        events: [{ title: "Ewa", start: "2026-09-07T10:00" }] },
    }));
    const result = await listCalendar(bridgeConfig(url, "tok")!, "dennis", 10);
    assert.equal(result.connected, true);
    assert.equal(result.count, 1);
  });

  it("carries the tenant on every call, so one member cannot read another's calendar", async () => {
    const seen: Record<string, unknown>[] = [];
    const { url } = await bridge((_verb, body) => {
      seen.push(body);
      return { payload: { ok: true, connected: true, events: [], messages: [] } };
    });
    const config = bridgeConfig(url, "tok")!;
    await listCalendar(config, "p16474013399", 5);
    await searchMail(config, "p16474013399", "from:lance", 5);
    assert.deepEqual(seen.map((body) => body.tenant), ["p16474013399", "p16474013399"]);
  });

  it("clamps mail search to the caller's query and limit", async () => {
    let received: Record<string, unknown> = {};
    const { url } = await bridge((_verb, body) => {
      received = body;
      return { payload: { ok: true, connected: true, messages: [{ id: "1" }] } };
    });
    const result = await searchMail(bridgeConfig(url, "tok")!, "dennis", "from:ray newer_than:3d", 5);
    assert.equal(received.q, "from:ray newer_than:3d");
    assert.equal(result.count, 1);
  });
});

describe("a calendar hold is only complete with a receipt", () => {
  it("succeeds with outcome scope when the calendar returns an event link", async () => {
    const { url } = await bridge(() => ({
      payload: { ok: true, receipt: "https://calendar.google.com/event?eid=abc" },
    }));
    const result = await holdCalendar(bridgeConfig(url, "tok")!, "dennis",
      { title: "deep work", start: "2026-09-07T09:00", minutes: 60 });
    assert.equal(result.held, true);
    const outcome = holdOutcome(result as never);
    assert.equal(outcome.status, "succeeded");
    assert.equal(outcome.evidenceScope, "outcome");
  });

  it("does NOT complete when the bridge says ok but returns no link", async () => {
    const { url } = await bridge(() => ({ payload: { ok: true } }));
    const result = await holdCalendar(bridgeConfig(url, "tok")!, "dennis",
      { title: "deep work", start: "2026-09-07T09:00", minutes: 60 });
    assert.equal(result.held, false);
    assert.equal(result.unverified, true);
    const outcome = holdOutcome(result as never);
    assert.equal(outcome.status, "failed", "an accepted request is not a completed write");
    assert.equal(outcome.evidenceScope, "request");
  });

  it("fails honestly when google is not linked", async () => {
    const { url } = await bridge(() => ({
      status: 502, payload: { ok: false, why: "no linked google account for this member" },
    }));
    const result = await holdCalendar(bridgeConfig(url, "tok")!, "dennis",
      { title: "x", start: "2026-09-07T09:00", minutes: 30 });
    assert.equal(result.held, false);
    assert.equal(holdOutcome(result as never).status, "failed");
    assert.match(String(holdOutcome(result as never).error), /no linked google account/);
  });

  it("treats a malformed bridge reply as a failure, never a success", () => {
    for (const bad of [null, "ok", 42, [], {}, { held: true }, { held: true, receipt: "" }]) {
      const outcome = holdOutcome(bad as never);
      assert.equal(outcome.status, "failed", `${JSON.stringify(bad)} must not complete a write`);
    }
  });
});
