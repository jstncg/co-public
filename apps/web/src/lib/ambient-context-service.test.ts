import { describe, expect, it, vi } from "vitest";
import { syncCalendarContext } from "./ambient-context-service";

const userId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const eventId = "33333333-3333-4333-8333-333333333333";

const sync = {
  source_id: sourceId,
  source_label: "Personal",
  access_mode: "details",
  sync_cursor: "cursor-1",
  full_sync: false,
  synced_at: "2026-07-30T19:00:00Z",
  events: [{
    external_id: "event-1",
    revision: "revision-1",
    starts_at: "2026-07-31T18:00:00Z",
    ends_at: "2026-07-31T19:00:00Z",
    timezone: "America/Los_Angeles",
    is_all_day: false,
    status: "confirmed",
    availability: "busy",
    title: "Planning",
    location: null,
    notes: null,
    url: null,
    analysis_allowed: true,
    sensitivity: "low",
  }],
  deleted_external_ids: [],
};

describe("ambient context service", () => {
  it("fails closed behind the ambient-awareness feature flag", async () => {
    await expect(syncCalendarContext({} as never, userId, sync, {
      environment: { FEATURE_AMBIENT_AWARENESS: "false" },
    })).rejects.toMatchObject({ status: 503 });
  });

  it("scopes calendar sync to the authenticated user and dispatches durable event work", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        source_id: sourceId,
        accepted: 1,
        unchanged: 0,
        deleted: 0,
        context_event_ids: [eventId],
        next_due_at: "2026-07-31T18:00:00Z",
      },
      error: null,
    }));
    const dispatch = vi.fn(async () => {});
    const response = await syncCalendarContext({ rpc } as never, userId, sync, {
      environment: { FEATURE_AMBIENT_AWARENESS: "true" },
      dispatch,
    });
    expect(rpc).toHaveBeenCalledWith("sync_calendar_context", expect.objectContaining({
      p_user_id: userId,
      p_external_source_id: sourceId,
    }));
    expect(dispatch).toHaveBeenCalledWith({
      userId,
      eventId,
      idempotencyKey: `ambient-context:${eventId}`,
    });
    expect(response.accepted).toBe(1);
  });

  it("rejects detail leakage in availability-only sync before touching storage", async () => {
    const rpc = vi.fn();
    await expect(syncCalendarContext({ rpc } as never, userId, {
      ...sync,
      access_mode: "availability_only",
    }, {
      environment: { FEATURE_AMBIENT_AWARENESS: "true" },
    })).rejects.toThrow(/availability-only/i);
    expect(rpc).not.toHaveBeenCalled();
  });
});
