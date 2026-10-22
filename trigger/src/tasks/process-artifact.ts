/**
 * artifact pipeline (goal.md §22): normalize → extract → memory update → embeddings.
 * the fast immediate response runs in the API request path (p50 < 5s), not here.
 * re-run safe: derived rows are replaced per artifact, never duplicated.
 */
import { task } from "@trigger.dev/sdk/v3";
import { makeProvider, type ArtifactInput } from "@co/model-gateway";
import type { Coverage, SourceType } from "@co/contracts";
import { serviceDb, must } from "../lib/db";
import { embedSegments } from "./embed-segments";

export interface ProcessArtifactPayload {
  artifactId: string;
  idempotencyKey: string;
}

export const processArtifact = task({
  id: "process-artifact",
  run: async (payload: ProcessArtifactPayload) => {
    const db = serviceDb();
    const artifact = must(
      await db.from("artifacts").select("*").eq("id", payload.artifactId).maybeSingle(),
      "load artifact",
    ) as Record<string, unknown>;

    if (artifact.deleted_at) return { skipped: "deleted" };
    // jordan journey (§37): no_analysis means stored only — no extraction, no embedding, no pattern use.
    if (artifact.retention_mode === "no_analysis") {
      await db.from("artifacts").update({ processing_status: "stored_only" }).eq("id", payload.artifactId);
      return { skipped: "no_analysis" };
    }

    const provider = makeProvider(process.env);
    const input: ArtifactInput = {
      source_type: artifact.source_type as SourceType,
      coverage: artifact.coverage as Coverage,
      raw_text: (artifact.raw_text as string | null) ?? undefined,
      transcript: (artifact.transcript as string | null) ?? undefined,
      metadata: {
        title: (artifact.title as string | null) ?? null,
        publisher: (artifact.publisher as string | null) ?? null,
        canonical_url: (artifact.canonical_url as string | null) ?? null,
      },
      user_note: (artifact.user_note as string | null) ?? undefined,
    };

    const extraction = await provider.extractArtifact(input);

    const why = must(
      await db.from("annotations").select("free_text,value").eq("artifact_id", payload.artifactId).eq("annotation_type", "why"),
      "load why annotations",
    ) as Array<{ free_text: string | null; value: string | null }>;
    const whyText = why.map((a) => a.free_text ?? a.value).filter(Boolean).join("; ") || undefined;

    const threads = must(
      await db.from("threads").select("title,summary").eq("user_id", artifact.user_id).eq("status", "active").is("deleted_at", null).limit(5),
      "load active threads",
    ) as Array<{ title: string; summary: string | null }>;

    const memory = await provider.updateMemory({
      artifact: { ...input, why_annotation: whyText },
      extraction,
      existing_observations: [],
      active_threads: threads.map((t) => ({ title: t.title, summary: t.summary ?? undefined })),
    });

    // re-run safety: replace this artifact's non-invalidated derived observations.
    await db.from("observations").delete().eq("artifact_id", payload.artifactId).is("invalidated_at", null);
    if (memory.observations_to_add.length > 0) {
      must(
        await db.from("observations").insert(
          memory.observations_to_add.map((o) => ({
            user_id: artifact.user_id,
            artifact_id: payload.artifactId,
            observation_type: o.observation_type,
            statement: o.statement,
            scope: o.scope,
            confidence: o.confidence,
          })),
        ).select("id"),
        "insert observations",
      );
    }
    for (const id of memory.observations_to_invalidate) {
      await db.from("observations").update({ invalidated_at: new Date().toISOString() }).eq("id", id).eq("user_id", artifact.user_id);
    }

    await db.from("artifacts").update({ processing_status: "processed" }).eq("id", payload.artifactId);

    await embedSegments.trigger(
      { artifactId: payload.artifactId, idempotencyKey: `${payload.idempotencyKey}:embed` },
      { idempotencyKey: `${payload.idempotencyKey}:embed` },
    );

    return { extraction_summary: extraction.source_summary, observations: memory.observations_to_add.length };
  },
});
