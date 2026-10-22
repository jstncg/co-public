/** voice note → transcript → artifact pipeline. respects retention_mode (§21.1, §37 jordan). */
import { task } from "@trigger.dev/sdk/v3";
import { serviceDb, must } from "../lib/db";
import { processArtifact } from "./process-artifact";

export interface TranscribeVoicePayload {
  artifactId: string;
  idempotencyKey: string;
}

const STORAGE_BUCKET = process.env.STORAGE_BUCKET_MEDIA ?? "media";

export const transcribeVoice = task({
  id: "transcribe-voice",
  run: async (payload: TranscribeVoicePayload) => {
    const db = serviceDb();
    const artifact = must(
      await db.from("artifacts").select("id,user_id,raw_object_path,transcript,retention_mode,deleted_at,mime_type").eq("id", payload.artifactId).maybeSingle(),
      "load artifact",
    ) as Record<string, unknown>;

    if (artifact.deleted_at) return { skipped: "deleted" };
    if (artifact.retention_mode === "no_analysis") return { skipped: "no_analysis" }; // sensitive save: no transcription at all
    if (artifact.transcript) return { skipped: "already_transcribed" }; // re-run safe
    if (!artifact.raw_object_path) throw new Error("voice artifact has no raw_object_path");

    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.MODEL_TRANSCRIPTION;
    if (!apiKey || !model) {
      // BLOCKED: transcription needs OPENAI_API_KEY + MODEL_TRANSCRIPTION (see docs/setup.md).
      await db.from("artifacts").update({ processing_status: "awaiting_transcription" }).eq("id", payload.artifactId);
      return { blocked: "missing OPENAI_API_KEY / MODEL_TRANSCRIPTION" };
    }

    const download = await db.storage.from(STORAGE_BUCKET).download(artifact.raw_object_path as string);
    if (download.error || !download.data) throw new Error(`storage download failed: ${download.error?.message}`);

    const form = new FormData();
    form.append("model", model);
    form.append("file", download.data, `voice${(artifact.mime_type as string | null)?.includes("mp4") ? ".m4a" : ".webm"}`);
    // VERIFY: /v1/audio/transcriptions multipart fields (model, file) against live docs before production.
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) throw new Error(`transcription failed ${res.status}: ${await res.text()}`);
    const { text } = (await res.json()) as { text?: string };
    if (!text) throw new Error("transcription returned no text");

    await db.from("artifacts").update({ transcript: text, processing_status: "transcribed" }).eq("id", payload.artifactId);

    await processArtifact.trigger(
      { artifactId: payload.artifactId, idempotencyKey: `${payload.idempotencyKey}:process` },
      { idempotencyKey: `${payload.idempotencyKey}:process` },
    );
    return { transcribed: true };
  },
});
