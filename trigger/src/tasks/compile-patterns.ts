import { createHash } from "node:crypto";
import { evaluatePatternDelivery } from "@co/intelligence";
import { createModelProvider, type PipelineModelProvider } from "@co/model-gateway";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { task } from "@trigger.dev/sdk/v3";
import { z } from "zod";

type ObservationRow = {
  id: string; artifact_id: string; observation_type: string; statement: string; confidence: number; created_at: string;
};

export async function compilePattern(admin: SupabaseClient, userId: string, provider: PipelineModelProvider = createModelProvider()) {
  const observations = await admin.from("observations")
    .select("id,artifact_id,observation_type,statement,confidence,created_at")
    .eq("user_id", userId).is("invalidated_at", null).order("created_at", { ascending: false }).limit(200);
  if (observations.error) throw observations.error;
  const rows = (observations.data ?? []) as ObservationRow[];
  const byArtifact = new Map<string, ObservationRow>();
  for (const row of rows.sort((a, b) => {
    const rank = (value: string) => value === "move_outcome" ? 0 : value === "user_why" ? 1 : 2;
    return rank(a.observation_type) - rank(b.observation_type);
  })) if (!byArtifact.has(row.artifact_id)) byArtifact.set(row.artifact_id, row);
  const selectedRows = [...byArtifact.values()].slice(0, 30);
  if (selectedRows.length < 3 || selectedRows.filter((row) => ["user_why", "move_outcome"].includes(row.observation_type)).length < 2) {
    return { status: "insufficient_explicit_evidence" as const };
  }
  const artifacts = await admin.from("artifacts").select("id,captured_at").eq("user_id", userId)
    .in("id", selectedRows.map((row) => row.artifact_id)).is("deleted_at", null);
  if (artifacts.error) throw artifacts.error;
  const capturedAt = new Map((artifacts.data ?? []).map((row) => [row.id as string, row.captured_at as string]));
  const evidence = selectedRows.flatMap((row) => {
    const captured = capturedAt.get(row.artifact_id);
    return captured ? [{ artifactId: row.artifact_id, statement: row.statement, observationType: row.observation_type, capturedAt: captured }] : [];
  });
  if (new Set(evidence.map((item) => item.capturedAt.slice(0, 10))).size < 2) return { status: "insufficient_time_span" as const };

  if (!provider.generatePatternCandidate) throw new Error("pattern candidate generation is unavailable");
  const generated = await provider.generatePatternCandidate({ evidence });
  const allowedIds = new Set(evidence.map((item) => item.artifactId));
  if (generated.value.supporting_evidence_ids.some((id) => !allowedIds.has(id)) || generated.value.contradicting_evidence_ids.some((id) => !allowedIds.has(id))) {
    throw new Error("pattern cited evidence outside the supplied set");
  }
  const delivery = evaluatePatternDelivery(
    generated.value,
    evidence.map((item) => ({ artifactId: item.artifactId, capturedAt: item.capturedAt, direction: generated.value.contradicting_evidence_ids.includes(item.artifactId) ? "contradict" as const : "support" as const, invalidated: false })),
    { required: false, approved: false },
  );
  if (!delivery.deliverable) return { status: "withheld" as const, reasons: delivery.reasons };
  const fingerprint = createHash("sha256").update([...generated.value.supporting_evidence_ids].sort().join("|")).digest("hex");
  const existing = await admin.from("hypotheses").select("id").eq("user_id", userId).eq("fingerprint", fingerprint).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return { status: "already_exists" as const, hypothesisId: existing.data.id };

  const run = await admin.schema("private").from("model_runs").insert({
    user_id: userId, task_type: "pattern_candidate", provider: generated.meta.provider, model: generated.meta.model,
    prompt_version: generated.meta.promptVersion, input_artifact_ids: generated.value.supporting_evidence_ids,
    output_schema_version: generated.meta.schemaVersion, latency_ms: generated.meta.latencyMs,
    input_tokens: generated.meta.inputTokens, output_tokens: generated.meta.outputTokens,
    status: "succeeded", uncertainty_summary: generated.value.alternative_explanations,
  }).select("id").single<{ id: string }>();
  if (run.error) throw run.error;
  const inserted = await admin.from("hypotheses").insert({
    user_id: userId, statement: generated.value.statement,
    alternatives_json: generated.value.alternative_explanations, confidence: generated.value.confidence,
    sensitivity: generated.value.sensitivity, status: "review", fingerprint,
    proposed_copy: generated.value.statement,
    reason_to_send: `supported by ${generated.value.supporting_evidence_ids.length} receipts across multiple days`,
    proposed_move: generated.value.door_hypothesis ? { title: generated.value.door_hypothesis } : null,
  }).select("id").single<{ id: string }>();
  if (inserted.error) throw inserted.error;
  const observationByArtifact = new Map(selectedRows.map((row) => [row.artifact_id, row.id]));
  const links = await admin.from("evidence_links").insert([
    ...generated.value.supporting_evidence_ids.map((artifactId) => ({ user_id: userId, hypothesis_id: inserted.data.id, artifact_id: artifactId, observation_id: observationByArtifact.get(artifactId), direction: "support" })),
    ...generated.value.contradicting_evidence_ids.map((artifactId) => ({ user_id: userId, hypothesis_id: inserted.data.id, artifact_id: artifactId, observation_id: observationByArtifact.get(artifactId), direction: "contradict" })),
  ]);
  if (links.error) throw links.error;
  return { status: "review" as const, hypothesisId: inserted.data.id };
}

export const compilePatternsTask = task({
  id: "compile-patterns-v1",
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 2_000, maxTimeoutInMs: 60_000, randomize: true },
  run: async (unknownPayload) => {
    const payload = z.object({ userId: z.uuid(), resourceVersion: z.literal("pattern-compilation.v1") }).parse(unknownPayload);
    if (process.env.FEATURE_PATTERN_COMPILATION !== "true") return { status: "disabled" };
    const admin = createClient(z.url().parse(process.env.NEXT_PUBLIC_SUPABASE_URL), z.string().min(20).parse(process.env.SUPABASE_SERVICE_ROLE_KEY), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    return compilePattern(admin, payload.userId);
  },
});
