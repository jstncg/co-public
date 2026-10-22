import { artifactCaptureSchema, artifactReceiptSchema, featureFlagsFromEnvironment, immediateResponseSchema, type ArtifactCapture } from "@co/contracts";
import { processArtifact } from "@co/processing";
import type { SupabaseClient } from "@supabase/supabase-js";
import { tasks } from "@trigger.dev/sdk";
import { assertOwnedObjectPaths } from "./upload-service";

type ArtifactRow = { id: string; created_at: string; processing_status: string; source_coverage: ArtifactCapture["coverage"] };

type CaptureDependencies = {
  environment?: Record<string, string | undefined>;
  dispatch?: (input: { artifactId: string; userId: string; idempotencyKey: string }) => Promise<void>;
  process?: typeof processArtifact;
};

async function dispatchWithTrigger(input: { artifactId: string; userId: string; idempotencyKey: string }) {
  await tasks.trigger("process-artifact-v1", {
    artifactId: input.artifactId,
    userId: input.userId,
    resourceVersion: "artifact-processing.v1",
  }, { idempotencyKey: input.idempotencyKey });
}

export async function captureArtifact(admin: SupabaseClient, userId: string, unknownInput: unknown, dependencies: CaptureDependencies = {}) {
  const capture = artifactCaptureSchema.parse(unknownInput);
  assertOwnedObjectPaths(userId, capture.clientArtifactId, capture.uploadObjectKeys);
  const artifactValues = {
    user_id: userId,
    client_artifact_id: capture.clientArtifactId,
    idempotency_key: capture.idempotencyKey,
    source_type: capture.sourceType,
    source_app: capture.sourceApp,
    canonical_url: capture.canonicalUrl,
    raw_text: capture.suppliedText,
    raw_object_path: capture.uploadObjectKeys[0] ?? null,
    retention_mode: capture.sourceType === "voice" ? "delete_after_processing" : "default",
    captured_at: capture.capturedAt,
    timestamp_seconds: capture.timestampSeconds,
    user_note: capture.userNote,
    source_coverage: capture.coverage,
    analysis_allowed: capture.analysisAllowed,
    processing_status: capture.analysisAllowed ? "queued" : "saved_without_analysis",
  };

  const { data: inserted, error: insertError } = await admin.from("artifacts").insert(artifactValues).select("id, created_at, processing_status, source_coverage").maybeSingle<ArtifactRow>();
  let artifact = inserted;
  if (insertError?.code === "23505") {
    const existing = await admin.from("artifacts").select("id, created_at, processing_status, source_coverage").eq("user_id", userId).eq("idempotency_key", capture.idempotencyKey).single<ArtifactRow>();
    if (existing.error) throw existing.error;
    artifact = existing.data;
  } else if (insertError) throw insertError;
  if (!artifact) throw new Error("artifact insert returned no row");

  if (capture.canonicalUrl) {
    await admin.from("source_receipts").upsert({ user_id: userId, artifact_id: artifact.id, canonical_url: capture.canonicalUrl, coverage: capture.coverage }, { onConflict: "artifact_id" });
  }

  if (!capture.analysisAllowed) {
    const quiet = immediateResponseSchema.parse({ mode: "quiet", response: "saved without analysis.", why_question: null, suggested_actions: [], confidence: 1, should_wait_for_user: false });
    return {
      receipt: artifactReceiptSchema.parse({ artifactId: artifact.id, status: "saved_without_analysis", coverage: capture.coverage, localAcknowledgement: "saved without analysis", createdAt: artifact.created_at }),
      immediate: quiet,
    };
  }

  const flags = featureFlagsFromEnvironment(dependencies.environment ?? process.env);
  if (flags.async_processing) {
    await (dependencies.dispatch ?? dispatchWithTrigger)({ artifactId: artifact.id, userId, idempotencyKey: capture.idempotencyKey });
    return {
      receipt: artifactReceiptSchema.parse({ artifactId: artifact.id, status: "queued", coverage: capture.coverage, localAcknowledgement: "saved. working on it", createdAt: artifact.created_at }),
      immediate: immediateResponseSchema.parse({ mode: "remember", response: "saved. working on it.", why_question: null, suggested_actions: [], confidence: 1, should_wait_for_user: false }),
    };
  }

  const result = await (dependencies.process ?? processArtifact)(admin, { artifactId: artifact.id, userId });
  const status = result.status === "ready" || result.status === "already_complete" ? "ready" : "failed_safe";
  return {
    receipt: artifactReceiptSchema.parse({ artifactId: artifact.id, status, coverage: capture.coverage, localAcknowledgement: "saved", createdAt: artifact.created_at }),
    immediate: result.immediate,
  };
}
