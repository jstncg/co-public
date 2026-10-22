import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const prepareSchema = z.object({
  clientArtifactId: z.uuid(),
  title: z.string().trim().min(1).max(160),
  steps: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
}).strict();

const transitionSchema = z.object({
  moveId: z.uuid(),
  status: z.enum(["approved", "completed", "dismissed"]),
  userConfirmed: z.literal(true),
}).strict();

const outcomeSchema = z.object({
  moveId: z.uuid(),
  result: z.string().trim().min(1).max(500),
  valueRating: z.number().int().min(1).max(5),
  surpriseRating: z.number().int().min(1).max(5),
  repeatIntent: z.enum(["yes", "maybe", "no"]),
}).strict();

export async function listMoves(admin: SupabaseClient, userId: string) {
  const result = await admin.from("moves")
    .select("id,origin_id,title,move_type,plan_json,status,prepared_at,approved_at,completed_at")
    .eq("user_id", userId).eq("origin_type", "artifact").order("created_at", { ascending: false }).limit(100);
  if (result.error) throw new Error(`moves: ${result.error.message}`);
  const rows = result.data ?? [];
  const artifactIds = [...new Set(rows.map((row) => row.origin_id as string).filter(Boolean))];
  const artifacts = artifactIds.length === 0 ? { data: [], error: null } : await admin.from("artifacts")
    .select("id,client_artifact_id").eq("user_id", userId).in("id", artifactIds).is("deleted_at", null);
  if (artifacts.error) throw new Error(`move sources: ${artifacts.error.message}`);
  const clientIdByArtifact = new Map((artifacts.data ?? []).map((row) => [row.id as string, row.client_artifact_id]));
  return rows.flatMap((row) => {
    const clientArtifactId = clientIdByArtifact.get(row.origin_id as string);
    return clientArtifactId ? [{
    id: row.id,
    originClientArtifactId: clientArtifactId,
    title: row.title,
    moveType: row.move_type,
    steps: (row.plan_json as { steps?: unknown })?.steps ?? [],
    status: row.status,
    preparedAt: row.prepared_at,
    approvedAt: row.approved_at,
    completedAt: row.completed_at,
    }] : [];
  });
}

export async function prepareMove(admin: SupabaseClient, userId: string, unknownInput: unknown) {
  const input = prepareSchema.parse(unknownInput);
  const artifact = await admin.from("artifacts").select("id").eq("user_id", userId)
    .eq("client_artifact_id", input.clientArtifactId).is("deleted_at", null).single<{ id: string }>();
  if (artifact.error || !artifact.data) throw new Error("move source unavailable");
  const inserted = await admin.from("moves").insert({
    user_id: userId,
    origin_type: "artifact",
    origin_id: artifact.data.id,
    move_type: "start_small_experiment",
    title: input.title,
    plan_json: {
      steps: input.steps,
      external_effect: false,
      final_user_action_required: true,
      private_context_disclosed: false,
    },
    required_authority: "final_user_action",
    status: "prepared",
  }).select("id").single<{ id: string }>();
  if (inserted.error || !inserted.data) throw new Error(`prepare move: ${inserted.error?.message ?? "no row"}`);
  return { moveId: inserted.data.id, status: "prepared" as const };
}

export async function transitionMove(admin: SupabaseClient, userId: string, unknownInput: unknown) {
  const input = transitionSchema.parse(unknownInput);
  const result = await admin.rpc("transition_user_move", {
    p_user_id: userId,
    p_move_id: input.moveId,
    p_next_status: input.status,
    p_user_confirmed: input.userConfirmed,
  });
  if (result.error) throw new Error(`move transition: ${result.error.message}`);
  return { status: input.status };
}

export async function recordOutcome(admin: SupabaseClient, userId: string, unknownInput: unknown) {
  const input = outcomeSchema.parse(unknownInput);
  const result = await admin.rpc("record_move_outcome", {
    p_user_id: userId,
    p_move_id: input.moveId,
    p_result: input.result,
    p_value_rating: input.valueRating,
    p_surprise_rating: input.surpriseRating,
    p_repeat_intent: input.repeatIntent,
  });
  if (result.error) throw new Error(`move outcome: ${result.error.message}`);
  return { recorded: true as const };
}
