import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

type DatabaseError = { message: string } | null;

const patternFeedbackSchema = z.object({
  hypothesisId: z.uuid(),
  verdict: z.enum(["right", "partly", "wrong", "outdated"]),
  correction: z.string().trim().min(1).max(500).nullable().optional(),
}).strict();

const watchSchema = z.object({
  entityType: z.string().trim().min(1).max(80),
  displayName: z.string().trim().min(1).max(200),
  relationshipNote: z.string().trim().min(1).max(300).nullable().optional(),
  desiredEventTypes: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
}).strict();

const radarFeedbackSchema = z.object({
  candidateId: z.uuid(),
  feedback: z.enum(["useful", "not_relevant", "too_late", "already_knew", "too_creepy", "mute_entity", "mute_event_type"]),
}).strict();

function assertDatabase(error: DatabaseError, context: string) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

export async function listPatterns(admin: SupabaseClient, userId: string) {
  const hypotheses = await admin.from("hypotheses")
    .select("id,statement,alternatives_json,confidence,status,updated_at")
    .eq("user_id", userId).in("status", ["approved", "delivered"]).order("updated_at", { ascending: false }).limit(50);
  assertDatabase(hypotheses.error, "patterns");
  const hypothesisRows = hypotheses.data ?? [];
  if (hypothesisRows.length === 0) return [];

  const ids = hypothesisRows.map((row) => row.id as string);
  const links = await admin.from("evidence_links")
    .select("hypothesis_id,artifact_id,direction,weight")
    .eq("user_id", userId).in("hypothesis_id", ids).order("created_at", { ascending: true });
  assertDatabase(links.error, "pattern evidence");
  const artifactIds = [...new Set((links.data ?? []).map((row) => row.artifact_id as string))];
  const artifacts = artifactIds.length === 0 ? { data: [], error: null } : await admin.from("artifacts")
    .select("id,source_type,source_coverage,title,publisher,canonical_url,captured_at")
    .eq("user_id", userId).in("id", artifactIds).is("deleted_at", null);
  assertDatabase(artifacts.error, "pattern receipts");
  const artifactById = new Map((artifacts.data ?? []).map((row) => [row.id as string, row]));

  return hypothesisRows.map((hypothesis) => ({
    id: hypothesis.id,
    statement: hypothesis.statement,
    alternatives: hypothesis.alternatives_json,
    confidence: hypothesis.confidence,
    status: hypothesis.status,
    updatedAt: hypothesis.updated_at,
    receipts: (links.data ?? []).filter((link) => link.hypothesis_id === hypothesis.id).flatMap((link) => {
      const artifact = artifactById.get(link.artifact_id as string);
      return artifact ? [{
        artifactId: artifact.id,
        sourceType: artifact.source_type,
        coverage: artifact.source_coverage,
        title: artifact.title,
        publisher: artifact.publisher,
        url: artifact.canonical_url,
        capturedAt: artifact.captured_at,
        direction: link.direction,
      }] : [];
    }),
  }));
}

export async function recordPatternFeedback(admin: SupabaseClient, userId: string, input: unknown) {
  const feedback = patternFeedbackSchema.parse(input);
  const result = await admin.rpc("record_pattern_feedback", {
    p_user_id: userId,
    p_hypothesis_id: feedback.hypothesisId,
    p_verdict: feedback.verdict,
    p_correction: feedback.correction ?? null,
  });
  if (result.error) throw new Error(`pattern feedback: ${result.error.message}`);
  return { accepted: true as const };
}

export async function listRadar(admin: SupabaseClient, userId: string) {
  const candidates = await admin.from("radar_candidates")
    .select("id,watch_entity_id,world_event_id,why_user,status,total_score,created_at")
    .eq("user_id", userId).in("status", ["inbox", "notified", "opened"]).order("created_at", { ascending: false }).limit(100);
  assertDatabase(candidates.error, "radar");
  const rows = candidates.data ?? [];
  if (rows.length === 0) return [];
  const eventIds = [...new Set(rows.map((row) => row.world_event_id as string))];
  const watchIds = [...new Set(rows.map((row) => row.watch_entity_id as string))];
  const [events, watches] = await Promise.all([
    admin.from("world_events").select("id,event_type,title,summary,canonical_url,published_at,source_trust").in("id", eventIds),
    admin.from("watch_entities").select("id,display_name,entity_type").eq("user_id", userId).in("id", watchIds),
  ]);
  assertDatabase(events.error, "radar events");
  assertDatabase(watches.error, "radar watches");
  const eventById = new Map((events.data ?? []).map((row) => [row.id as string, row]));
  const watchById = new Map((watches.data ?? []).map((row) => [row.id as string, row]));
  return rows.flatMap((candidate) => {
    const event = eventById.get(candidate.world_event_id as string);
    const watch = watchById.get(candidate.watch_entity_id as string);
    return event && watch ? [{
      id: candidate.id,
      title: event.title,
      summary: event.summary,
      url: event.canonical_url,
      publishedAt: event.published_at,
      eventType: event.event_type,
      sourceTrust: event.source_trust,
      whyYou: candidate.why_user,
      status: candidate.status,
      score: candidate.total_score,
      watchName: watch.display_name,
    }] : [];
  });
}

export async function recordRadarFeedback(admin: SupabaseClient, userId: string, input: unknown) {
  const feedback = radarFeedbackSchema.parse(input);
  const result = await admin.rpc("record_radar_feedback", {
    p_user_id: userId,
    p_candidate_id: feedback.candidateId,
    p_feedback: feedback.feedback,
  });
  if (result.error) throw new Error(`radar feedback: ${result.error.message}`);
  return { accepted: true as const };
}

export async function createWatch(admin: SupabaseClient, userId: string, input: unknown) {
  const watch = watchSchema.parse(input);
  const inserted = await admin.from("watch_entities").insert({
    user_id: userId,
    entity_type: watch.entityType,
    display_name: watch.displayName,
    relationship_note: watch.relationshipNote ?? null,
    desired_event_types: watch.desiredEventTypes,
    approved_at: new Date().toISOString(),
  }).select("id").single<{ id: string }>();
  assertDatabase(inserted.error, "create watch");
  if (!inserted.data) throw new Error("create watch: no row returned");
  return { watchId: inserted.data.id, active: true as const };
}
