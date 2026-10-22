import { featureFlagsFromEnvironment } from "@co/contracts";
import { GmailClient, gmailAwarenessTokenParams } from "@co/google-workspace";
import { schedules } from "@trigger.dev/sdk/v3";
import { getToken } from "@vercel/connect";
import { z } from "zod";
import { serviceDb, type Db } from "../lib/db";
import { dispatchDueGmailSyncs } from "./gmail-sync-v1";

type RenewalDependencies = {
  db?: Db;
  client?: GmailClient;
  environment?: Record<string, string | undefined>;
  token?: (connector: string, userId: string) => Promise<string>;
};

async function connectorToken(connector: string, userId: string) {
  return getToken(connector, gmailAwarenessTokenParams(userId));
}

export async function renewDueGmailWatches(dependencies: RenewalDependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const flags = featureFlagsFromEnvironment(environment);
  if (!flags.ambient_awareness || !flags.gmail_awareness) {
    return { status: "disabled" as const, renewed: 0 };
  }
  const connector = environment.GOOGLE_CONNECTOR_UID;
  const topicName = environment.GMAIL_PUBSUB_TOPIC;
  if (!connector || !topicName) {
    throw new Error("GOOGLE_CONNECTOR_UID and GMAIL_PUBSUB_TOPIC are required");
  }
  const db = dependencies.db ?? serviceDb(environment);
  const due = await db.rpc("list_gmail_watches_due", { p_limit: 50 });
  if (due.error) throw due.error;
  const rows = z
    .array(
      z
        .object({
          user_id: z.uuid(),
          source_id: z.uuid(),
          email_address: z.email(),
        })
        .strip(),
    )
    .parse(due.data ?? []);
  const client = dependencies.client ?? new GmailClient();
  const token = dependencies.token ?? connectorToken;
  await Promise.all(
    rows.map(async (row) => {
      const accessToken = await token(connector, row.user_id);
      const watched = await client.watch({ accessToken, topicName });
      if (watched.emailAddress !== row.email_address) {
        throw new Error("Gmail watch account identity changed");
      }
      const renewed = await db.rpc("renew_gmail_context_watch", {
        p_user_id: row.user_id,
        p_source_id: row.source_id,
        p_watch_history_id: watched.historyId,
        p_watch_expires_at: watched.expiresAt,
      });
      if (renewed.error) throw renewed.error;
      if (renewed.data !== true) throw new Error("Gmail watch source unavailable");
    }),
  );
  return { status: "processed" as const, renewed: rows.length };
}

export const gmailAwarenessRecoveryTick = schedules.task({
  id: "gmail-awareness-recovery-tick",
  cron: "* * * * *",
  run: async () => {
    const flags = featureFlagsFromEnvironment(process.env);
    if (!flags.ambient_awareness || !flags.gmail_awareness) {
      return { status: "disabled" as const };
    }
    return { status: "processed" as const, dispatched: await dispatchDueGmailSyncs() };
  },
});

export const gmailWatchRenewalTick = schedules.task({
  id: "gmail-watch-renewal-tick",
  cron: "17 3 * * *",
  run: async () => renewDueGmailWatches(),
});
