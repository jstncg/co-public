import {
  featureFlagsFromEnvironment,
  gmailSyncTaskPayloadSchema,
  type GmailSyncTaskPayload,
} from "@co/contracts";
import {
  GmailApiError,
  GmailClient,
  GmailHistoryCursorExpiredError,
  gmailAwarenessTokenParams,
} from "@co/google-workspace";
import { task, tasks } from "@trigger.dev/sdk/v3";
import { getToken } from "@vercel/connect";
import { z } from "zod";
import { serviceDb, type Db } from "../lib/db";

const claimSchema = z
  .object({
    user_id: z.uuid(),
    source_id: z.uuid(),
    email_address: z.email(),
    start_history_id: z.string().regex(/^\d{1,40}$/u),
    target_history_id: z.string().regex(/^\d{1,40}$/u),
    lease_token: z.uuid(),
  })
  .strict();

type GmailSyncDependencies = {
  db?: Db;
  client?: GmailClient;
  environment?: Record<string, string | undefined>;
  token?: (connector: string, userId: string) => Promise<string>;
  now?: () => Date;
};

async function connectorToken(connector: string, userId: string) {
  return getToken(connector, gmailAwarenessTokenParams(userId));
}

function retryCode(error: unknown) {
  if (error instanceof GmailHistoryCursorExpiredError) return "history_cursor_expired";
  if (error instanceof Error && error.name === "GmailApiError") return "gmail_api_error";
  return "gmail_sync_error";
}

export async function runGmailSyncV1(
  unknownPayload: unknown,
  dependencies: GmailSyncDependencies = {},
) {
  const payload = gmailSyncTaskPayloadSchema.parse(unknownPayload);
  const environment = dependencies.environment ?? process.env;
  const flags = featureFlagsFromEnvironment(environment);
  if (!flags.ambient_awareness || !flags.gmail_awareness) {
    return { status: "disabled" as const };
  }
  const connector = environment.GOOGLE_CONNECTOR_UID;
  if (!connector) throw new Error("GOOGLE_CONNECTOR_UID is required");
  const db = dependencies.db ?? serviceDb(environment);
  const claimed = await db.rpc("claim_gmail_sync", {
    p_user_id: payload.userId,
    p_source_id: payload.sourceId,
  });
  if (claimed.error) throw claimed.error;
  if (!claimed.data) return { status: "deduped" as const };
  const claim = claimSchema.parse(claimed.data);
  const client = dependencies.client ?? new GmailClient();
  const now = dependencies.now ?? (() => new Date());

  try {
    const accessToken = await (dependencies.token ?? connectorToken)(connector, payload.userId);
    let sync;
    try {
      sync = await client.syncHistory({
        accessToken,
        startHistoryId: claim.start_history_id,
      });
    } catch (error) {
      if (!(error instanceof GmailHistoryCursorExpiredError)) throw error;
      sync = await client.reconcileInbox({ accessToken });
    }
    const applied = await db.rpc("apply_gmail_sync", {
      p_user_id: payload.userId,
      p_source_id: payload.sourceId,
      p_lease_token: claim.lease_token,
      p_expected_history_id: claim.start_history_id,
      p_next_history_id: sync.next_history_id,
      p_items: sync.items,
      p_deleted_external_ids: sync.deleted_external_ids,
      p_reconciliation: sync.reconciliation,
    });
    if (applied.error) throw applied.error;
    return {
      status:
        applied.data?.applied === false ? ("cursor_advanced" as const) : ("processed" as const),
      accepted: Number(applied.data?.accepted ?? 0),
      deleted: Number(applied.data?.deleted ?? 0),
      contextEventIds: z.array(z.uuid()).parse(applied.data?.context_event_ids ?? []),
      reconciliation: sync.reconciliation,
    };
  } catch (error) {
    if (error instanceof GmailApiError && error.status === 401) {
      const paused = await db.rpc("pause_gmail_context_source", {
        p_user_id: payload.userId,
        p_source_id: payload.sourceId,
        p_lease_token: claim.lease_token,
      });
      if (paused.error) throw paused.error;
      return { status: "reauthorization_required" as const };
    }
    const retryAt = new Date(now().getTime() + 60_000);
    const released = await db.rpc("release_gmail_sync", {
      p_user_id: payload.userId,
      p_source_id: payload.sourceId,
      p_lease_token: claim.lease_token,
      p_error_code: retryCode(error),
      p_retry_at: retryAt.toISOString(),
    });
    if (released.error) throw released.error;
    throw error;
  }
}

export const gmailSyncV1 = task({
  id: "gmail-sync-v1",
  maxDuration: 300,
  run: async (payload) => runGmailSyncV1(payload),
});

export async function dispatchDueGmailSyncs(db: Db = serviceDb()) {
  const due = await db.rpc("list_due_gmail_syncs", { p_limit: 50 });
  if (due.error) throw due.error;
  const rows = z
    .array(z.object({ user_id: z.uuid(), source_id: z.uuid() }).strip())
    .parse(due.data ?? []);
  await Promise.all(
    rows.map(async (row) => {
      const payload: GmailSyncTaskPayload = {
        userId: row.user_id,
        sourceId: row.source_id,
        resourceVersion: "gmail-awareness.v1",
      };
      await tasks.trigger("gmail-sync-v1", payload, {
        idempotencyKey: `gmail-recovery:${row.source_id}:${new Date().toISOString().slice(0, 16)}`,
      });
    }),
  );
  return rows.length;
}
