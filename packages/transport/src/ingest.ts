import { createHash } from "node:crypto";
import { ingestEnvelopeSchema, type IngestEnvelope, type IngestResponse } from "@co/contracts";
import { TransportStoreError, type TransportStore } from "./store";

export class IngestError extends Error {
  constructor(readonly status: 404 | 422 | 503, readonly reason: string) {
    super(reason);
    this.name = "IngestError";
  }
}

export type IngestLog = (event: string, fields: Record<string, string | number | boolean | null>) => void;
export type ArtifactsStoredHook = (input: {
  userId: string;
  messageId: string;
  artifactIds: string[];
  deduped: boolean;
}) => Promise<void>;

export function envelopeIdentity(envelope: Pick<IngestEnvelope, "transport" | "tenant_phone" | "direction" | "external_message_id" | "text" | "sent_at">) {
  if (envelope.external_message_id) {
    return { idempotencyKey: `${envelope.transport}:${envelope.external_message_id}`, dedupSig: null };
  }
  const bucket = Math.floor(Date.parse(envelope.sent_at) / 5_000);
  const dedupSig = createHash("sha256")
    .update(`${envelope.tenant_phone}|${envelope.direction}|${envelope.text ?? ""}|${bucket}`)
    .digest("hex");
  return { idempotencyKey: `${envelope.transport}:sig:${dedupSig}`, dedupSig };
}

export async function handleIngest(
  unknownEnvelope: unknown,
  store: TransportStore,
  log: IngestLog = () => {},
  onArtifactsStored: ArtifactsStoredHook = async () => {},
): Promise<IngestResponse> {
  const parsed = ingestEnvelopeSchema.safeParse(unknownEnvelope);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || "body";
    throw new IngestError(422, `malformed envelope: ${field}: ${issue?.message ?? "invalid"}`);
  }
  const envelope = parsed.data;
  const identity = envelopeIdentity(envelope);
  try {
    if (envelope.status) {
      const messageId = await store.applyStatus({ ...envelope, status: envelope.status });
      if (!messageId) throw new IngestError(503, "status callback arrived before its message; retry later");
      log("transport.status", {
        transport: envelope.transport, message_id: messageId, status: envelope.status,
      });
      return { ok: true, message_id: messageId, deduped: false };
    }
    const result = await store.ingestMessage(envelope, identity);
    if (result.artifactIds.length > 0) {
      await onArtifactsStored({
        userId: result.userId,
        messageId: result.messageId,
        artifactIds: result.artifactIds,
        deduped: result.deduped,
      });
    }
    log("transport.message", {
      transport: envelope.transport, message_id: result.messageId,
      direction: envelope.direction, deduped: result.deduped,
      artifact_count: envelope.artifacts.length, media_count: envelope.media_urls.length,
    });
    return { ok: true, message_id: result.messageId, deduped: result.deduped };
  } catch (error) {
    if (error instanceof IngestError) throw error;
    if (error instanceof TransportStoreError && error.code === "unknown_tenant") {
      throw new IngestError(404, "unknown tenant; alpha mappings must be pre-provisioned");
    }
    throw error;
  }
}
