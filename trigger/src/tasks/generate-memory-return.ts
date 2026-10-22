import { selectReturnCandidate, type ReturnArtifact } from "@co/intelligence";
import { createClient } from "@supabase/supabase-js";
import { task } from "@trigger.dev/sdk/v3";
import { z } from "zod";

const payloadSchema = z.object({
  userId: z.uuid(),
  triggerArtifactId: z.uuid(),
  resourceVersion: z.literal("memory-return.v1"),
});

export const generateMemoryReturnTask = task({
  id: "generate-memory-return-v1",
  retry: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 30_000, randomize: true },
  run: async (unknownPayload) => {
    const payload = payloadSchema.parse(unknownPayload);
    if (process.env.FEATURE_MEMORY_RETURNS !== "true") return { status: "disabled" };
    const admin = createClient(
      z.url().parse(process.env.NEXT_PUBLIC_SUPABASE_URL),
      z.string().min(20).parse(process.env.SUPABASE_SERVICE_ROLE_KEY),
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const trigger = await admin.from("artifacts").select("id,captured_at,title,raw_text,user_note")
      .eq("id", payload.triggerArtifactId).eq("user_id", payload.userId).is("deleted_at", null).single();
    if (trigger.error) throw trigger.error;
    const older = await admin.from("artifacts").select("id,captured_at,title,raw_text,user_note")
      .eq("user_id", payload.userId).is("deleted_at", null).lt("captured_at", trigger.data.captured_at)
      .order("captured_at", { ascending: false }).limit(200);
    if (older.error) throw older.error;
    const map = (row: any): ReturnArtifact => ({
      id: row.id, capturedAt: row.captured_at, title: row.title, text: row.raw_text, note: row.user_note,
    });
    const candidate = selectReturnCandidate(map(trigger.data), (older.data ?? []).map(map));
    if (!candidate) return { status: "abstained" };
    const created = await admin.rpc("create_memory_return", {
      p_user_id: payload.userId,
      p_old_artifact_id: candidate.oldArtifactId,
      p_trigger_artifact_id: payload.triggerArtifactId,
      p_trigger_message_id: null,
      p_reason: candidate.reason,
      p_proposed_copy: candidate.copy,
    });
    if (created.error) {
      if (created.error.code === "23505") return { status: "already_exists" };
      throw created.error;
    }
    return { status: "review", returnId: created.data };
  },
});

