import { task } from "@trigger.dev/sdk/v3";
import { processArtifact } from "@co/processing";
import { featureFlagsFromEnvironment } from "@co/contracts";
import { serviceDb } from "../lib/db";

export type ProcessArtifactV1Payload = {
  artifactId: string;
  userId: string;
  resourceVersion: "artifact-processing.v1";
};

export async function runProcessArtifactV1(payload: ProcessArtifactV1Payload) {
  const db = serviceDb();
  const idempotencyKey = `artifact-processing.v1:${payload.artifactId}`;
  const existing = await db.schema("private").from("job_runs")
    .select("id,status,attempts")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle<{ id: string; status: string; attempts: number }>();
  if (existing.error) throw existing.error;
  if (existing.data?.status === "succeeded") return { status: "already_complete" as const };

  let jobId = existing.data?.id;
  if (!jobId) {
    const inserted = await db.schema("private").from("job_runs").insert({
      task_type: "process_artifact_v1",
      resource_type: "artifact",
      resource_id: payload.artifactId,
      resource_version: payload.resourceVersion,
      idempotency_key: idempotencyKey,
      status: "queued",
    }).select("id").single<{ id: string }>();
    if (inserted.error) throw inserted.error;
    jobId = inserted.data.id;
  }

  const claimed = await db.schema("private").from("job_runs").update({
    status: "running",
    attempts: (existing.data?.attempts ?? 0) + 1,
    error_class: null,
  }).eq("id", jobId);
  if (claimed.error) throw claimed.error;

  try {
    const result = await processArtifact(db, {
      artifactId: payload.artifactId,
      userId: payload.userId,
      failForRetry: true,
      signalRefineryEnabled: featureFlagsFromEnvironment(process.env).signal_refinery,
    });
    const completed = await db.schema("private").from("job_runs")
      .update({ status: "succeeded", error_class: null }).eq("id", jobId);
    if (completed.error) throw completed.error;
    return result;
  } catch (error) {
    await db.schema("private").from("job_runs").update({
      status: "failed",
      error_class: error instanceof Error ? error.name : "unknown",
    }).eq("id", jobId);
    throw error;
  }
}

export const processArtifactV1 = task({
  id: "process-artifact-v1",
  run: runProcessArtifactV1,
});
