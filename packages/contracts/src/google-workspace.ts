import { z } from "zod";

export const gmailAwarenessScopes = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

export const gmailAccessModes = ["metadata_only", "snippet"] as const;

export const gmailPubSubEnvelopeSchema = z
  .object({
    message: z
      .object({
        data: z.string().min(1).max(8_192),
        messageId: z.string().min(1).max(512),
        publishTime: z.iso.datetime({ offset: true }),
      })
      .strip(),
    subscription: z.string().min(1).max(1_024),
  })
  .strip();

export const gmailPushNotificationSchema = z
  .object({
    emailAddress: z
      .email()
      .max(320)
      .transform((value) => value.toLocaleLowerCase()),
    historyId: z.string().regex(/^\d{1,40}$/u),
  })
  .strict();

const nullableHeader = (maximum: number) => z.string().trim().max(maximum).nullable().default(null);

export const gmailContextItemSchema = z
  .object({
    external_id: z.string().min(1).max(512),
    thread_id: z.string().min(1).max(512),
    history_id: z.string().regex(/^\d{1,40}$/u),
    internal_date: z.iso.datetime({ offset: true }),
    change_kind: z.enum(["received", "updated"]),
    from: nullableHeader(1_000),
    to: nullableHeader(2_000),
    cc: nullableHeader(2_000),
    subject: nullableHeader(1_000),
    sent_date: nullableHeader(256),
    snippet: nullableHeader(1_000),
    label_ids: z.array(z.string().min(1).max(128)).max(100),
    analysis_allowed: z.boolean().default(true),
    sensitivity: z.enum(["unknown", "low", "medium", "high"]).default("medium"),
  })
  .strict();

export const gmailHistorySyncSchema = z
  .object({
    next_history_id: z.string().regex(/^\d{1,40}$/u),
    items: z.array(gmailContextItemSchema).max(500),
    deleted_external_ids: z.array(z.string().min(1).max(512)).max(500),
    reconciliation: z.boolean(),
  })
  .strict();

export const gmailSyncTaskPayloadSchema = z
  .object({
    userId: z.uuid(),
    sourceId: z.uuid(),
    resourceVersion: z.literal("gmail-awareness.v1"),
  })
  .strict();

export const gmailWatchRegistrationSchema = z
  .object({
    source_id: z.uuid(),
    email_address: z.email(),
    history_id: z.string().regex(/^\d{1,40}$/u),
    expires_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export type GmailAccessMode = (typeof gmailAccessModes)[number];
export type GmailContextItem = z.infer<typeof gmailContextItemSchema>;
export type GmailHistorySync = z.infer<typeof gmailHistorySyncSchema>;
export type GmailPubSubEnvelope = z.infer<typeof gmailPubSubEnvelopeSchema>;
export type GmailPushNotification = z.infer<typeof gmailPushNotificationSchema>;
export type GmailSyncTaskPayload = z.infer<typeof gmailSyncTaskPayloadSchema>;
export type GmailWatchRegistration = z.infer<typeof gmailWatchRegistrationSchema>;
