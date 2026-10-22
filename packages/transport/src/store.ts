import { createHmac, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DeliveryStatus, IngestArtifact, IngestEnvelope, Transport, TransportMetadata } from "@co/contracts";

export class TransportStoreError extends Error {
  constructor(readonly code: "unknown_tenant" | "database", message: string) {
    super(message);
    this.name = "TransportStoreError";
  }
}

export type EnvelopeIdentity = { idempotencyKey: string; dedupSig: string | null };
export type StoredMessage = {
  id: string; userId: string; conversationId: string; transport: Transport;
  idempotencyKey: string; externalMessageId: string | null; dedupSig: string | null;
  direction: "inbound" | "outbound"; text: string | null; sentAt: string;
  deliveredAt: string | null; readAt: string | null; replyToMessageId: string | null;
  metadata: TransportMetadata; artifactIds: string[];
};
export type StoredArtifact = IngestArtifact & { id: string; userId: string; messageId: string; capturedAt: string };

export interface TransportStore {
  ingestMessage(envelope: IngestEnvelope, identity: EnvelopeIdentity): Promise<{
    messageId: string;
    deduped: boolean;
    userId: string;
    artifactIds: string[];
  }>;
  applyStatus(envelope: IngestEnvelope & { status: DeliveryStatus }): Promise<string | null>;
}

function firstTimestamp(current: string | null, incoming: string) { return current ?? incoming; }

export class InMemoryTransportStore implements TransportStore {
  private readonly phoneUsers = new Map<string, string>();
  private readonly conversations = new Map<string, string>();
  readonly messages: StoredMessage[] = [];
  readonly artifacts: StoredArtifact[] = [];

  constructor(phoneUsers: Record<string, string> = {}) {
    for (const [phone, userId] of Object.entries(phoneUsers)) this.phoneUsers.set(phone, userId);
  }

  async ingestMessage(envelope: IngestEnvelope, identity: EnvelopeIdentity) {
    const userId = this.phoneUsers.get(envelope.tenant_phone);
    if (!userId) throw new TransportStoreError("unknown_tenant", "unknown tenant");
    const existing = this.messages.find((message) =>
      message.userId === userId && (
        message.idempotencyKey === identity.idempotencyKey ||
        (envelope.external_message_id !== null && message.transport === envelope.transport && message.externalMessageId === envelope.external_message_id) ||
        (identity.dedupSig !== null && message.conversationId === this.conversationId(userId, envelope.transport, envelope.external_thread_id) && message.dedupSig === identity.dedupSig)
      ));
    if (existing) return { messageId: existing.id, deduped: true, userId, artifactIds: existing.artifactIds };

    const conversationId = this.conversationId(userId, envelope.transport, envelope.external_thread_id);
    const replyTo = envelope.reply_to_external_id
      ? this.messages.find((message) => message.userId === userId && message.transport === envelope.transport && message.externalMessageId === envelope.reply_to_external_id)?.id ?? null
      : null;
    const message: StoredMessage = {
      id: randomUUID(), userId, conversationId, transport: envelope.transport,
      idempotencyKey: identity.idempotencyKey, externalMessageId: envelope.external_message_id,
      dedupSig: identity.dedupSig, direction: envelope.direction, text: envelope.text,
      sentAt: envelope.sent_at, deliveredAt: null, readAt: null, replyToMessageId: replyTo,
      metadata: envelope.transport_metadata, artifactIds: [],
    };
    const additions = envelope.artifacts.map((artifact) => ({
      ...artifact, id: randomUUID(), userId, messageId: message.id, capturedAt: envelope.sent_at,
    }));
    message.artifactIds = additions.map((artifact) => artifact.id);
    // This commit point mirrors the database RPC: message and artifacts become visible together.
    this.messages.push(message);
    this.artifacts.push(...additions);
    return { messageId: message.id, deduped: false, userId, artifactIds: message.artifactIds };
  }

  async applyStatus(envelope: IngestEnvelope & { status: DeliveryStatus }) {
    const userId = this.phoneUsers.get(envelope.tenant_phone);
    if (!userId) throw new TransportStoreError("unknown_tenant", "unknown tenant");
    const message = this.messages.find((candidate) =>
      candidate.userId === userId && candidate.transport === envelope.transport &&
      candidate.externalMessageId === envelope.external_message_id);
    if (!message) return null;
    if (envelope.status === "DELIVERED") message.deliveredAt = firstTimestamp(message.deliveredAt, envelope.sent_at);
    if (envelope.status === "READ") {
      message.deliveredAt = firstTimestamp(message.deliveredAt, envelope.sent_at);
      message.readAt = firstTimestamp(message.readAt, envelope.sent_at);
    }
    if (envelope.status === "ERROR") {
      const errorCode = envelope.transport_metadata.error_code;
      if (errorCode) message.metadata = { ...message.metadata, error_code: errorCode };
    }
    return message.id;
  }

  private conversationId(userId: string, transport: Transport, externalThreadId: string) {
    const key = `${userId}|${transport}|${externalThreadId}`;
    const existing = this.conversations.get(key);
    if (existing) return existing;
    const created = randomUUID();
    this.conversations.set(key, created);
    return created;
  }
}

export function phoneLookupHash(phone: string, pepper: string) {
  if (pepper.length < 32) throw new Error("CO_PHONE_MAPPING_PEPPER must contain at least 32 characters");
  return createHmac("sha256", pepper).update(phone).digest("hex");
}

function databaseError(error: { message: string } | null, context: string): never {
  throw new TransportStoreError("database", `${context}: ${error?.message ?? "empty response"}`);
}

export function artifactsForTransportRpc(artifacts: IngestEnvelope["artifacts"]) {
  return artifacts.map((artifact) => {
    if (artifact.canonical_url || artifact.extraction || artifact.segments.length === 0) return artifact;
    return {
      ...artifact,
      // The v1 database function predates first-class segments and requires either a URL or
      // extraction. Preserve the supplied evidence as raw text; normalized, timecoded segments
      // are upserted immediately after the idempotent RPC returns.
      extraction: artifact.segments.map((segment) => segment.text).join("\n"),
    };
  });
}

export class SupabaseTransportStore implements TransportStore {
  private readonly database: SupabaseClient;
  private readonly pepper: string;

  constructor(environment: Record<string, string | undefined> = process.env) {
    const url = environment.NEXT_PUBLIC_SUPABASE_URL ?? environment.SUPABASE_URL;
    const key = environment.SUPABASE_SERVICE_ROLE_KEY;
    const pepper = environment.CO_PHONE_MAPPING_PEPPER;
    if (!url || !key || !pepper) throw new Error("Supabase service configuration and CO_PHONE_MAPPING_PEPPER are required");
    this.database = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
    this.pepper = pepper;
  }

  async ingestMessage(envelope: IngestEnvelope, identity: EnvelopeIdentity) {
    const result = await this.database.rpc("ingest_transport_message", {
      p_phone_hash: phoneLookupHash(envelope.tenant_phone, this.pepper),
      p_transport: envelope.transport,
      p_external_thread_id: envelope.external_thread_id,
      p_idempotency_key: identity.idempotencyKey,
      p_external_message_id: envelope.external_message_id,
      p_dedup_sig: identity.dedupSig,
      p_direction: envelope.direction,
      p_text: envelope.text,
      p_media_urls: envelope.media_urls,
      p_sent_at: envelope.sent_at,
      p_reply_to_external_id: envelope.reply_to_external_id,
      p_transport_metadata: envelope.transport_metadata,
      p_artifacts: artifactsForTransportRpc(envelope.artifacts),
    });
    if (result.error) {
      if (/unknown transport tenant/i.test(result.error.message)) throw new TransportStoreError("unknown_tenant", "unknown tenant");
      databaseError(result.error, "transport ingest");
    }
    const row = result.data?.[0] as { message_id?: string; deduped?: boolean } | undefined;
    if (!row?.message_id || typeof row.deduped !== "boolean") databaseError(null, "transport ingest");
    const message = await this.database.from("messages").select("user_id,artifact_ids")
      .eq("id", row.message_id).single<{ user_id: string; artifact_ids: string[] }>();
    if (message.error || !message.data) databaseError(message.error, "transport artifact lookup");
    for (const [index, artifact] of envelope.artifacts.entries()) {
      const artifactId = message.data.artifact_ids[index];
      if (!artifactId) continue;
      const enriched = await this.database.from("artifacts").update({
        occurred_at: artifact.occurred_at,
        provenance_class: artifact.provenance_class,
        consent_state: artifact.consent_state,
        source_adapter: artifact.source_adapter,
        source_adapter_version: artifact.source_adapter_version,
      }).eq("id", artifactId).eq("user_id", message.data.user_id);
      if (enriched.error) databaseError(enriched.error, "transport artifact enrichment");
      if (artifact.segments.length > 0) {
        const segments = await this.database.from("artifact_segments").upsert(
          artifact.segments.map((segment) => ({
            user_id: message.data.user_id,
            artifact_id: artifactId,
            segment_type: segment.content_kind,
            ...segment,
            metadata: {
              producer: "transport-ingest.v2",
              source_adapter: artifact.source_adapter,
              source_adapter_version: artifact.source_adapter_version,
            },
          })),
          { onConflict: "artifact_id,segment_key" },
        );
        if (segments.error) databaseError(segments.error, "transport artifact segments");
      }
    }
    return {
      messageId: row.message_id,
      deduped: row.deduped,
      userId: message.data.user_id,
      artifactIds: message.data.artifact_ids,
    };
  }

  async applyStatus(envelope: IngestEnvelope & { status: DeliveryStatus }) {
    const result = await this.database.rpc("apply_transport_status", {
      p_phone_hash: phoneLookupHash(envelope.tenant_phone, this.pepper),
      p_transport: envelope.transport,
      p_external_message_id: envelope.external_message_id,
      p_status: envelope.status,
      p_at: envelope.sent_at,
      p_error_code: envelope.transport_metadata.error_code ?? null,
    });
    if (result.error) {
      if (/unknown transport tenant/i.test(result.error.message)) throw new TransportStoreError("unknown_tenant", "unknown tenant");
      databaseError(result.error, "transport status");
    }
    return typeof result.data === "string" ? result.data : null;
  }
}
