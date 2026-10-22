import { describe, expect, it, vi } from "vitest";
import {
  decodeGmailPush,
  GmailClient,
  GmailHistoryCursorExpiredError,
  redactWorkspaceText,
} from "../src/index";

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

describe("Gmail Pub/Sub boundary", () => {
  it("decodes only the bounded notification identity", () => {
    const data = Buffer.from(
      JSON.stringify({
        emailAddress: "Person@Example.com",
        historyId: "12345678901234567890",
      }),
    ).toString("base64url");
    const decoded = decodeGmailPush({
      message: {
        data,
        messageId: "pubsub-1",
        publishTime: "2026-09-01T19:00:00Z",
        attributes: { private: "ignored" },
      },
      subscription: "projects/co-prod/subscriptions/gmail",
      raw: "ignored",
    });
    expect(decoded.notification).toEqual({
      emailAddress: "person@example.com",
      historyId: "12345678901234567890",
    });
    expect(decoded.envelope.message).not.toHaveProperty("attributes");
    const unsafe = Buffer.from(
      JSON.stringify({
        emailAddress: "person@example.com",
        historyId: "1",
        accessToken: "must not cross the boundary",
      }),
    ).toString("base64url");
    expect(() =>
      decodeGmailPush({
        message: {
          data: unsafe,
          messageId: "pubsub-2",
          publishTime: "2026-09-01T19:00:00Z",
        },
        subscription: "projects/co-prod/subscriptions/gmail",
      }),
    ).toThrow(/Unrecognized key/u);
  });

  it("redacts authentication and payment material before model-readable storage", () => {
    const text = redactWorkspaceText(
      "Your code is 123456. password=hunter2. Card 4242 4242 4242 4242.",
    );
    expect(text).not.toContain("123456");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("4242 4242");
  });
});

describe("Gmail API client", () => {
  it("registers an INBOX-only watch and returns an ISO expiry", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) {
        return json({ emailAddress: "person@example.com", historyId: "10" });
      }
      expect(url.pathname).toMatch(/\/watch$/u);
      expect(JSON.parse(String(init?.body))).toEqual({
        labelFilterBehavior: "INCLUDE",
        labelIds: ["INBOX"],
        topicName: "projects/co-prod/topics/gmail-awareness",
      });
      return json({ historyId: "11", expiration: "1788292800000" });
    });
    const watched = await new GmailClient({ fetch: fetchMock }).watch({
      accessToken: "access-token",
      topicName: "projects/co-prod/topics/gmail-awareness",
    });
    expect(watched).toEqual({
      emailAddress: "person@example.com",
      historyId: "11",
      expiresAt: "2026-09-01T20:00:00.000Z",
    });
  });

  it("turns history deltas into bounded, redacted inbox evidence", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/history")) {
        return json({
          historyId: "14",
          history: [
            {
              id: "14",
              messagesAdded: [{ message: { id: "message-1" } }],
              messagesDeleted: [{ message: { id: "message-2" } }],
            },
          ],
        });
      }
      if (url.pathname.endsWith("/messages/message-1")) {
        return json({
          id: "message-1",
          threadId: "thread-1",
          historyId: "14",
          internalDate: "1788292800000",
          labelIds: ["INBOX", "UNREAD"],
          snippet: "Your sign-in code is 123456",
          payload: {
            headers: [
              { name: "From", value: "Sender <sender@example.com>" },
              { name: "To", value: "person@example.com" },
              { name: "Subject", value: "Launch moved to Thursday" },
              { name: "Date", value: "Tue, 1 Sep 2026 12:00:00 -0700" },
            ],
          },
        });
      }
      throw new Error(`unexpected request: ${url.toString()}`);
    });
    const sync = await new GmailClient({ fetch: fetchMock }).syncHistory({
      accessToken: "access-token",
      startHistoryId: "10",
    });
    expect(sync).toMatchObject({
      next_history_id: "14",
      deleted_external_ids: ["message-2"],
      reconciliation: false,
    });
    expect(sync.items).toHaveLength(1);
    expect(sync.items[0]).toMatchObject({
      external_id: "message-1",
      change_kind: "received",
      subject: "Launch moved to Thursday",
    });
    expect(sync.items[0]?.snippet).not.toContain("123456");
  });

  it("distinguishes an expired history cursor so the worker can reconcile", async () => {
    const client = new GmailClient({
      fetch: vi.fn<typeof fetch>(async () => json({ error: "stale" }, 404)),
    });
    await expect(
      client.syncHistory({
        accessToken: "access-token",
        startHistoryId: "10",
      }),
    ).rejects.toBeInstanceOf(GmailHistoryCursorExpiredError);
  });

  it("does not poison a delta when a message disappears before metadata fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/history")) {
        return json({
          historyId: "15",
          history: [{ id: "15", messagesAdded: [{ message: { id: "vanished" } }] }],
        });
      }
      if (url.pathname.endsWith("/messages/vanished")) {
        return json({ error: "not found" }, 404);
      }
      throw new Error(`unexpected request: ${url.toString()}`);
    });
    const sync = await new GmailClient({ fetch: fetchMock }).syncHistory({
      accessToken: "access-token",
      startHistoryId: "10",
    });
    expect(sync).toMatchObject({
      next_history_id: "15",
      items: [],
      deleted_external_ids: ["vanished"],
      reconciliation: false,
    });
  });

  it("reconciles a bounded current inbox without pretending old mail just arrived", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) {
        return json({ emailAddress: "person@example.com", historyId: "50" });
      }
      if (url.pathname.endsWith("/messages")) {
        expect(url.searchParams.get("q")).toBe("in:inbox newer_than:30d");
        return json({ messages: [{ id: "message-3" }] });
      }
      if (url.pathname.endsWith("/messages/message-3")) {
        return json({
          id: "message-3",
          threadId: "thread-3",
          historyId: "49",
          internalDate: "1788292800000",
          labelIds: ["INBOX"],
          snippet: "A current receipt",
          payload: { headers: [] },
        });
      }
      throw new Error(`unexpected request: ${url.toString()}`);
    });
    const sync = await new GmailClient({ fetch: fetchMock }).reconcileInbox({
      accessToken: "access-token",
    });
    expect(sync).toMatchObject({ next_history_id: "50", reconciliation: true });
    expect(sync.items[0]?.change_kind).toBe("updated");
  });
});
