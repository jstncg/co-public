import {
  gmailPubSubEnvelopeSchema,
  gmailPushNotificationSchema,
  type GmailPubSubEnvelope,
  type GmailPushNotification,
} from "@co/contracts";

export type DecodedGmailPush = {
  envelope: GmailPubSubEnvelope;
  notification: GmailPushNotification;
};

export function decodeGmailPush(unknownEnvelope: unknown): DecodedGmailPush {
  const envelope = gmailPubSubEnvelopeSchema.parse(unknownEnvelope);
  const decoded = Buffer.from(envelope.message.data, "base64url").toString("utf8");
  if (decoded.length === 0 || decoded.length > 4_096) {
    throw new Error("Gmail notification payload is outside the allowed size");
  }
  const notification = gmailPushNotificationSchema.parse(JSON.parse(decoded));
  return { envelope, notification };
}
