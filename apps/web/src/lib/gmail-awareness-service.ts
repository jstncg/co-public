import {
  GmailClient,
  decodeGmailPush,
  gmailAwarenessTokenParams,
  googleWorkspaceSubject,
} from "@co/google-workspace";
import {
  featureFlagsFromEnvironment,
  gmailWatchRegistrationSchema,
  type GmailSyncTaskPayload,
} from "@co/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getToken, revokeToken, startAuthorization } from "@vercel/connect";
import { z } from "zod";
import { verifyGooglePushToken } from "./google-push-auth";
import { HttpStatusError } from "./http-status-error";

const gmailEnvironmentSchema = z
  .object({
    GOOGLE_CONNECTOR_UID: z.string().min(3),
    GMAIL_PUBSUB_TOPIC: z
      .string()
      .regex(/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~-]{2,254}$/u),
    GMAIL_PUSH_AUDIENCE: z.url(),
    GMAIL_PUSH_SERVICE_ACCOUNT: z.email(),
  })
  .passthrough();

type GmailEnvironment = z.infer<typeof gmailEnvironmentSchema>;

type GmailAwarenessDependencies = {
  client?: GmailClient;
  token?: (connector: string, userId: string) => Promise<string>;
  authorize?: (connector: string, userId: string, callbackUrl: string) => Promise<string>;
  revoke?: (connector: string, userId: string) => Promise<void>;
  verifyPush?: (authorization: string | null, configuration: GmailEnvironment) => Promise<void>;
  dispatch?: (payload: GmailSyncTaskPayload, idempotencyKey: string) => Promise<void>;
  log?: (event: string, properties: Record<string, string | boolean>) => void;
};

function configuration(environment: Record<string, string | undefined>) {
  const flags = featureFlagsFromEnvironment(environment);
  if (!flags.ambient_awareness || !flags.gmail_awareness) {
    throw new HttpStatusError(503, "Gmail awareness unavailable");
  }
  return gmailEnvironmentSchema.parse(environment);
}

async function connectorToken(connector: string, userId: string) {
  return getToken(connector, gmailAwarenessTokenParams(userId));
}

async function connectorAuthorization(connector: string, userId: string, callbackUrl: string) {
  const result = await startAuthorization(connector, gmailAwarenessTokenParams(userId), {
    callbackUrl,
    expiresInMs: 10 * 60_000,
  });
  return result.url;
}

async function connectorRevoke(connector: string, userId: string) {
  await revokeToken(connector, { subject: googleWorkspaceSubject(userId) });
}

export async function beginGmailAuthorization(
  userId: string,
  callbackUrl: string,
  environment: Record<string, string | undefined> = process.env,
  dependencies: GmailAwarenessDependencies = {},
) {
  const configured = configuration(environment);
  const parsedCallback = new URL(callbackUrl);
  const applicationOrigin = new URL(configured.GMAIL_PUSH_AUDIENCE).origin;
  if (parsedCallback.protocol !== "https:" || parsedCallback.origin !== applicationOrigin) {
    throw new Error(
      "Gmail authorization callback must use the configured HTTPS application origin",
    );
  }
  const authorize = dependencies.authorize ?? connectorAuthorization;
  return {
    authorization_url: await authorize(
      configured.GOOGLE_CONNECTOR_UID,
      userId,
      parsedCallback.toString(),
    ),
  };
}

export async function activateGmailAwareness(
  admin: SupabaseClient,
  userId: string,
  environment: Record<string, string | undefined> = process.env,
  dependencies: GmailAwarenessDependencies = {},
) {
  const configured = configuration(environment);
  const accessToken = await (dependencies.token ?? connectorToken)(
    configured.GOOGLE_CONNECTOR_UID,
    userId,
  );
  const client = dependencies.client ?? new GmailClient();
  const watched = await client.watch({
    accessToken,
    topicName: configured.GMAIL_PUBSUB_TOPIC,
  });
  const result = await admin.rpc("register_gmail_context_source", {
    p_user_id: userId,
    p_email_address: watched.emailAddress,
    p_history_id: watched.historyId,
    p_watch_expires_at: watched.expiresAt,
    p_access_mode: "snippet",
  });
  if (result.error) {
    await client.stop(accessToken).catch(() => undefined);
    throw result.error;
  }
  return gmailWatchRegistrationSchema.parse({
    source_id: result.data.source_id,
    email_address: result.data.email_address,
    history_id: result.data.history_id,
    expires_at: result.data.expires_at,
  });
}

export async function disconnectGmailAwareness(
  admin: SupabaseClient,
  userId: string,
  sourceId: string,
  environment: Record<string, string | undefined> = process.env,
  dependencies: GmailAwarenessDependencies = {},
) {
  const connector = environment.GOOGLE_CONNECTOR_UID?.trim();
  const token = dependencies.token ?? connectorToken;
  const client = dependencies.client ?? new GmailClient();
  let externalRevocation: "completed" | "deferred" = "completed";
  if (connector) {
    try {
      const accessToken = await token(connector, userId);
      await client.stop(accessToken);
    } catch {
      dependencies.log?.("gmail.watch_stop_failed", { source_id: sourceId });
    }
    try {
      await (dependencies.revoke ?? connectorRevoke)(connector, userId);
    } catch {
      externalRevocation = "deferred";
      dependencies.log?.("gmail.token_revoke_failed", { source_id: sourceId });
    }
  } else {
    externalRevocation = "deferred";
    dependencies.log?.("gmail.token_revoke_unconfigured", { source_id: sourceId });
  }
  const result = await admin.rpc("delete_gmail_context_source", {
    p_external_revocation: externalRevocation,
    p_user_id: userId,
    p_source_id: sourceId,
  });
  if (result.error) throw result.error;
  if (result.data !== true) throw new HttpStatusError(404, "Gmail context source not found");
  return {
    deleted: true as const,
    external_revocation: externalRevocation,
    source_id: sourceId,
  };
}

export async function ingestGmailPush(
  admin: SupabaseClient,
  authorization: string | null,
  envelopeInput: object | (() => Promise<unknown>),
  environment: Record<string, string | undefined> = process.env,
  dependencies: GmailAwarenessDependencies = {},
) {
  const configured = configuration(environment);
  const verify =
    dependencies.verifyPush ??
    (async (header, input) => {
      await verifyGooglePushToken({
        authorization: header,
        audience: input.GMAIL_PUSH_AUDIENCE,
        serviceAccount: input.GMAIL_PUSH_SERVICE_ACCOUNT,
      });
    });
  await verify(authorization, configured);
  const unknownEnvelope =
    typeof envelopeInput === "function" ? await envelopeInput() : envelopeInput;
  const { envelope, notification } = decodeGmailPush(unknownEnvelope);
  const queued = await admin.rpc("enqueue_gmail_sync", {
    p_email_address: notification.emailAddress,
    p_history_id: notification.historyId,
    p_pubsub_message_id: envelope.message.messageId,
    p_published_at: envelope.message.publishTime,
  });
  if (queued.error) throw queued.error;
  if (!queued.data) return { accepted: false, dispatched: false };

  const payload: GmailSyncTaskPayload = {
    userId: String(queued.data.user_id),
    sourceId: String(queued.data.source_id),
    resourceVersion: "gmail-awareness.v1",
  };
  let dispatched = false;
  if (dependencies.dispatch) {
    try {
      await dependencies.dispatch(
        payload,
        `gmail-sync:${payload.sourceId}:${envelope.message.messageId}`,
      );
      dispatched = true;
    } catch {
      dependencies.log?.("gmail.dispatch_deferred", { source_id: payload.sourceId });
    }
  }
  return { accepted: true, dispatched };
}
