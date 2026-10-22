import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const whyAnswerSchema = z.object({
  clientArtifactId: z.uuid(),
  value: z.string().trim().min(1).max(60),
}).strict();

export async function saveWhyAnswer(admin: SupabaseClient, userId: string, input: unknown) {
  const answer = whyAnswerSchema.parse(input);
  const result = await admin.rpc("set_why_annotation", {
    p_user_id: userId,
    p_client_artifact_id: answer.clientArtifactId,
    p_value: answer.value,
  });
  if (result.error) throw new Error(`why answer: ${result.error.message}`);
  return { accepted: true as const };
}
