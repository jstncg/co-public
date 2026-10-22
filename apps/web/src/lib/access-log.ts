import type { SupabaseClient } from "@supabase/supabase-js";

export async function listAccessLog(admin: SupabaseClient, userId: string) {
  const result = await admin.from("audit_events")
    .select("id,actor_type,action,resource_type,purpose,created_at")
    .eq("user_id", userId).order("created_at", { ascending: false }).limit(200);
  if (result.error) throw new Error(`access log: ${result.error.message}`);
  return (result.data ?? []).map((row) => ({
    id: row.id,
    actorType: row.actor_type,
    action: row.action,
    resourceType: row.resource_type,
    purpose: row.purpose,
    createdAt: row.created_at,
  }));
}
