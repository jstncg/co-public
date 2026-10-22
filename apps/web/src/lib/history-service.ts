import { artifactCorrectionSchema, catchHistoryResponseSchema } from "@co/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, any>;

function assertDatabase(error: { message: string } | null, context: string) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

function preview(...values: unknown[]) {
  const value = values.find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
  return typeof value === "string" ? value.trim().slice(0, 500) : null;
}

async function exactCount(query: PromiseLike<{ count: number | null; error: { message: string } | null }>, context: string) {
  const result = await query;
  assertDatabase(result.error, context);
  return result.count ?? 0;
}

export async function listRelationshipHistory(admin: SupabaseClient, userId: string, unknownQuery?: unknown) {
  const query = typeof unknownQuery === "string" ? unknownQuery.trim().toLocaleLowerCase().slice(0, 120) : "";
  const [artifacts, messageCount, sharedMomentCount, recurringThreadCount, thingsTakingShapeCount, radarCount] = await Promise.all([
    admin.from("artifacts")
      .select("id,client_artifact_id,source_type,canonical_url,title,publisher,captured_at,raw_text,transcript,user_note,source_coverage,processing_status")
      .eq("user_id", userId).is("deleted_at", null).order("captured_at", { ascending: false }).limit(250),
    exactCount(admin.from("messages").select("id", { count: "exact", head: true }).eq("user_id", userId), "history message count"),
    exactCount(admin.from("artifacts").select("id", { count: "exact", head: true }).eq("user_id", userId).is("deleted_at", null), "history artifact count"),
    exactCount(admin.from("threads").select("id", { count: "exact", head: true }).eq("user_id", userId).is("deleted_at", null).in("status", ["active", "quiet", "resolved"]), "history thread count"),
    exactCount(admin.from("hypotheses").select("id", { count: "exact", head: true }).eq("user_id", userId).in("status", ["approved", "delivered"]), "history hypothesis count"),
    exactCount(admin.from("radar_candidates").select("id", { count: "exact", head: true }).eq("user_id", userId).in("status", ["inbox", "notified", "opened"]), "history radar count"),
  ]);
  assertDatabase(artifacts.error, "history artifacts");
  const artifactRows = (artifacts.data ?? []) as Row[];
  const artifactIds = artifactRows.map((row) => String(row.id));

  const [receipts, links] = artifactIds.length === 0
    ? [{ data: [], error: null }, { data: [], error: null }]
    : await Promise.all([
      admin.from("source_receipts").select("artifact_id,canonical_url,source_title,publisher,coverage,retrieved_at")
        .eq("user_id", userId).in("artifact_id", artifactIds),
      admin.from("message_artifacts").select("artifact_id,message_id").eq("user_id", userId).in("artifact_id", artifactIds),
    ]);
  assertDatabase(receipts.error, "history receipts");
  assertDatabase(links.error, "history message links");
  const linkRows = (links.data ?? []) as Row[];
  const messageIds = [...new Set(linkRows.map((row) => String(row.message_id)))];
  const messages = messageIds.length === 0
    ? { data: [], error: null }
    : await admin.from("messages")
      .select("id,direction,transport,text,sent_at,delivered_at,read_at,media_urls")
      .eq("user_id", userId).in("id", messageIds);
  assertDatabase(messages.error, "history message context");

  const receiptByArtifact = new Map(((receipts.data ?? []) as Row[]).map((row) => [String(row.artifact_id), row]));
  const messageById = new Map(((messages.data ?? []) as Row[]).map((row) => [String(row.id), row]));
  const messageIdByArtifact = new Map(linkRows.map((row) => [String(row.artifact_id), String(row.message_id)]));
  const catches = artifactRows.map((artifact) => {
    const receipt = receiptByArtifact.get(String(artifact.id));
    const message = messageById.get(messageIdByArtifact.get(String(artifact.id)) ?? "");
    return {
      artifactId: artifact.id,
      clientArtifactId: artifact.client_artifact_id,
      sourceType: artifact.source_type,
      canonicalUrl: artifact.canonical_url,
      title: artifact.title,
      publisher: artifact.publisher,
      textPreview: preview(artifact.raw_text, artifact.transcript, artifact.title, artifact.canonical_url),
      userNote: artifact.user_note,
      coverage: artifact.source_coverage,
      processingStatus: artifact.processing_status,
      capturedAt: artifact.captured_at,
      messageContext: message ? {
        messageId: message.id,
        direction: message.direction,
        transport: message.transport,
        textPreview: preview(message.text),
        sentAt: message.sent_at,
        deliveredAt: message.delivered_at,
        readAt: message.read_at,
        mediaCount: Array.isArray(message.media_urls) ? message.media_urls.length : 0,
      } : null,
      receipt: receipt ? {
        canonicalUrl: receipt.canonical_url,
        sourceTitle: receipt.source_title,
        publisher: receipt.publisher,
        coverage: receipt.coverage,
        retrievedAt: receipt.retrieved_at,
      } : null,
    };
  }).filter((item) => !query || [
    item.title, item.publisher, item.textPreview, item.userNote, item.canonicalUrl,
    item.messageContext?.textPreview, item.receipt?.sourceTitle, item.receipt?.publisher,
  ].some((value) => value?.toLocaleLowerCase().includes(query)));

  return catchHistoryResponseSchema.parse({
    summary: { messageCount, sharedMomentCount, recurringThreadCount, thingsTakingShapeCount, radarCount },
    catches,
  });
}

export async function correctArtifact(admin: SupabaseClient, userId: string, unknownInput: unknown) {
  const input = artifactCorrectionSchema.parse(unknownInput);
  const result = await admin.rpc("correct_user_artifact", {
    p_user_id: userId,
    p_client_artifact_id: input.clientArtifactId,
    p_correction: input.correction,
  });
  if (result.error) throw new Error(`artifact correction: ${result.error.message}`);
  return { corrected: true as const, annotationId: result.data as string };
}

