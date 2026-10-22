import { describe, expect, it, vi } from "vitest";
import {
  GmailApiError,
  GmailHistoryCursorExpiredError,
  type GmailClient,
} from "@co/google-workspace";
import type { Db } from "../src/lib/db";
import { runGmailSyncV1 } from "../src/tasks/gmail-sync-v1";

const userId = "11111111-1111-4111-8111-111111111111";
const sourceId = "22222222-2222-4222-8222-222222222222";
const lease = "33333333-3333-4333-8333-333333333333";
const eventId = "44444444-4444-4444-8444-444444444444";
const payload = { userId, sourceId, resourceVersion: "gmail-awareness.v1" } as const;
const environment = {
  FEATURE_AMBIENT_AWARENESS: "true",
  FEATURE_GMAIL_AWARENESS: "true",
  GOOGLE_CONNECTOR_UID: "google/co",
};

function database(
  applyData: Record<string, unknown> = {
    applied: true,
    accepted: 1,
    deleted: 0,
    context_event_ids: [eventId],
  },
) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "claim_gmail_sync") {
      return {
        data: {
          user_id: userId,
          source_id: sourceId,
          email_address: "person@example.com",
          start_history_id: "40",
          target_history_id: "42",
          lease_token: lease,
        },
        error: null,
      };
    }
    if (name === "apply_gmail_sync") return { data: applyData, error: null };
    if (name === "release_gmail_sync") return { data: true, error: null };
    if (name === "pause_gmail_context_source") return { data: true, error: null };
    throw new Error(`unexpected RPC: ${name}`);
  });
  return { db: { rpc } as unknown as Db, rpc };
}

describe("Gmail sync worker", () => {
  it("applies the exact claimed cursor and emits durable context work", async () => {
    const { db, rpc } = database();
    const syncHistory = vi.fn(async () => ({
      next_history_id: "42",
      items: [],
      deleted_external_ids: [],
      reconciliation: false,
    }));
    const result = await runGmailSyncV1(payload, {
      db,
      environment,
      client: { syncHistory } as unknown as GmailClient,
      token: async () => "access-token",
    });
    expect(result).toMatchObject({
      status: "processed",
      accepted: 1,
      contextEventIds: [eventId],
      reconciliation: false,
    });
    expect(rpc).toHaveBeenCalledWith(
      "apply_gmail_sync",
      expect.objectContaining({
        p_user_id: userId,
        p_source_id: sourceId,
        p_lease_token: lease,
        p_expected_history_id: "40",
        p_next_history_id: "42",
        p_reconciliation: false,
      }),
    );
  });

  it("uses a bounded reconciliation after Gmail expires the history cursor", async () => {
    const { db, rpc } = database({
      applied: true,
      accepted: 2,
      deleted: 0,
      context_event_ids: [],
    });
    const reconcileInbox = vi.fn(async () => ({
      next_history_id: "60",
      items: [],
      deleted_external_ids: [],
      reconciliation: true,
    }));
    await runGmailSyncV1(payload, {
      db,
      environment,
      client: {
        syncHistory: vi.fn(async () => {
          throw new GmailHistoryCursorExpiredError();
        }),
        reconcileInbox,
      } as unknown as GmailClient,
      token: async () => "access-token",
    });
    expect(reconcileInbox).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith(
      "apply_gmail_sync",
      expect.objectContaining({
        p_next_history_id: "60",
        p_reconciliation: true,
      }),
    );
  });

  it("releases the lease with content-free diagnostics when a provider call fails", async () => {
    const { db, rpc } = database();
    await expect(
      runGmailSyncV1(payload, {
        db,
        environment,
        client: {
          syncHistory: vi.fn(async () => {
            throw new Error("private email text");
          }),
        } as unknown as GmailClient,
        token: async () => "access-token",
        now: () => new Date("2026-09-01T19:00:00Z"),
      }),
    ).rejects.toThrow("private email text");
    expect(rpc).toHaveBeenCalledWith("release_gmail_sync", {
      p_user_id: userId,
      p_source_id: sourceId,
      p_lease_token: lease,
      p_error_code: "gmail_sync_error",
      p_retry_at: "2026-09-01T19:01:00.000Z",
    });
  });

  it("pauses the source instead of retrying invalid Google credentials", async () => {
    const { db, rpc } = database();
    const result = await runGmailSyncV1(payload, {
      db,
      environment,
      client: {
        syncHistory: vi.fn(async () => {
          throw new GmailApiError(401, "unauthorized");
        }),
      } as unknown as GmailClient,
      token: async () => "access-token",
    });
    expect(result).toEqual({ status: "reauthorization_required" });
    expect(rpc).toHaveBeenCalledWith("pause_gmail_context_source", {
      p_user_id: userId,
      p_source_id: sourceId,
      p_lease_token: lease,
    });
    expect(rpc).not.toHaveBeenCalledWith("release_gmail_sync", expect.anything());
  });
});
