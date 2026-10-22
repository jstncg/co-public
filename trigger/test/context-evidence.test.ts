import { describe, expect, it } from "vitest";
import type { Db } from "../src/lib/db";
import { loadContextEvidence } from "../src/lib/context-evidence";

const userId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const itemId = "33333333-3333-4333-8333-333333333333";
const sourceId = "44444444-4444-4444-8444-444444444444";

function fakeEmailDb(accessMode: "metadata_only" | "snippet") {
  const data: Record<string, unknown[]> = {
    context_events: [{
      id: eventId,
      user_id: userId,
      source_id: sourceId,
      source_kind: "email",
      event_kind: "email_received",
      resource_type: "email_item",
      resource_id: itemId,
      occurred_at: "2026-09-01T19:00:00Z",
      effective_from: "2026-09-01T19:00:00Z",
      effective_to: "2026-09-01T19:00:00Z",
      state: "queued",
    }],
    messages: [],
    calendar_context_items: [],
    email_context_items: [{
      id: itemId,
      source_id: sourceId,
      internal_date: "2026-09-01T19:00:00Z",
      sender: "sender@example.com",
      recipients: "person@example.com",
      subject: "Return window closes Thursday",
      sent_date: "Tue, 1 Sep 2026 12:00:00 -0700",
      snippet: "Bring the item to the store next to dinner.",
      label_ids: ["INBOX"],
      analysis_allowed: true,
      sensitivity: "medium",
      tombstone: false,
    }],
    context_sources: [{ id: sourceId, access_mode: accessMode, status: "active" }],
  };
  const db = {
    from(table: string) {
      const builder = {
        select() { return builder; },
        eq() { return builder; },
        in() { return builder; },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: data[table] ?? [], error: null }).then(resolve);
        },
      };
      return builder;
    },
  } as unknown as Db;
  return db;
}

function fakeDb(accessMode: "availability_only" | "details", sensitivity = "low") {
  const userFilters: string[] = [];
  const data: Record<string, unknown[]> = {
    context_events: [{
      id: eventId,
      user_id: userId,
      source_id: sourceId,
      source_kind: "calendar",
      event_kind: "calendar_window_opening",
      resource_type: "calendar_item",
      resource_id: itemId,
      occurred_at: "2026-07-30T19:00:00Z",
      effective_from: "2026-07-31T18:00:00Z",
      effective_to: "2026-07-31T19:00:00Z",
      state: "queued",
    }],
    messages: [],
    calendar_context_items: [{
      id: itemId,
      source_id: sourceId,
      starts_at: "2026-07-31T18:00:00Z",
      ends_at: "2026-07-31T19:00:00Z",
      timezone: "America/Los_Angeles",
      is_all_day: false,
      status: "confirmed",
      availability: "busy",
      title: "Secret title",
      location: "Secret place",
      notes: "Secret notes",
      analysis_allowed: true,
      sensitivity,
      superseded_at: null,
    }],
    context_sources: [{ id: sourceId, access_mode: accessMode, status: "active" }],
  };
  const db = {
    from(table: string) {
      const builder = {
        select() { return builder; },
        eq(column: string, value: unknown) {
          if (column === "user_id") userFilters.push(String(value));
          return builder;
        },
        in() { return builder; },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve({ data: data[table] ?? [], error: null }).then(resolve);
        },
      };
      return builder;
    },
  } as unknown as Db;
  return { db, userFilters };
}

describe("context evidence access", () => {
  it("never renders calendar details from an availability-only source", async () => {
    const { db, userFilters } = fakeDb("availability_only");
    const evidence = await loadContextEvidence(db, userId, [eventId]);
    expect(evidence[0]?.harness.text).toContain("Calendar availability: busy");
    expect(evidence[0]?.harness.text).not.toContain("Secret");
    expect(userFilters).toEqual([userId, userId, userId]);
  });

  it("renders opted-in details and rejects high-sensitivity model evidence", async () => {
    const detailed = await loadContextEvidence(fakeDb("details").db, userId, [eventId]);
    expect(detailed[0]?.harness.text).toContain("Secret title");
    await expect(loadContextEvidence(
      fakeDb("details", "high").db,
      userId,
      [eventId],
    )).rejects.toThrow(/analysis-restricted/);
    const policyRead = await loadContextEvidence(
      fakeDb("details", "high").db,
      userId,
      [eventId],
      { allowRestricted: true },
    );
    expect(policyRead[0]?.awareness.sensitivity).toBe("high");
  });

  it("keeps Gmail snippets behind the source's explicit access mode", async () => {
    const metadata = await loadContextEvidence(fakeEmailDb("metadata_only"), userId, [eventId]);
    expect(metadata[0]?.harness.text).toContain("Return window closes Thursday");
    expect(metadata[0]?.harness.text).not.toContain("next to dinner");
    const snippet = await loadContextEvidence(fakeEmailDb("snippet"), userId, [eventId]);
    expect(snippet[0]?.harness.text).toContain("next to dinner");
    expect(snippet[0]?.awareness.sourceKind).toBe("email");
  });
});
