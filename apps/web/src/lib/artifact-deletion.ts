import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

export async function deleteArtifact(admin: SupabaseClient, userId: string, unknownClientArtifactId: unknown) {
  const clientArtifactId = z.uuid().parse(unknownClientArtifactId);
  const selected = await admin.from("artifacts").select("id,raw_object_path")
    .eq("user_id", userId).eq("client_artifact_id", clientArtifactId).is("deleted_at", null).maybeSingle<{ id: string; raw_object_path: string | null }>();
  if (selected.error) throw new Error(`artifact deletion lookup: ${selected.error.message}`);
  if (!selected.data) return { deleted: true as const, alreadyAbsent: true };
  if (selected.data.raw_object_path) {
    const prefix = `${userId}/${clientArtifactId}/`;
    if (!selected.data.raw_object_path.startsWith(prefix) || selected.data.raw_object_path.includes("..")) {
      throw new Error("artifact deletion rejected an unexpected object path");
    }
    const removed = await admin.storage.from("artifacts").remove([selected.data.raw_object_path]);
    if (removed.error) throw new Error(`artifact object deletion: ${removed.error.message}`);
  }
  const deleted = await admin.rpc("delete_user_artifact", {
    p_user_id: userId,
    p_client_artifact_id: clientArtifactId,
  });
  if (deleted.error) throw new Error(`artifact deletion: ${deleted.error.message}`);
  return { deleted: true as const, alreadyAbsent: false };
}
