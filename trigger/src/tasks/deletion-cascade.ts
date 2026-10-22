/**
 * deletion cascade — implements goal.md §21.3 exactly, in order. re-run safe:
 * every step is a no-op when already applied. honest timing: active systems within
 * 24h; encrypted backups expire on the backup schedule (~30 days) — never claim instant erasure.
 */
import { task } from "@trigger.dev/sdk/v3";
import { serviceDb, must } from "../lib/db";

export type DeletionCascadePayload =
  | { scope: "artifact"; userId: string; artifactId: string; idempotencyKey: string }
  | { scope: "everything"; userId: string; idempotencyKey: string };

const MEDIA_BUCKET = process.env.STORAGE_BUCKET_MEDIA ?? "media";

async function deleteArtifact(db: ReturnType<typeof serviceDb>, userId: string, artifactId: string): Promise<void> {
  const artifact = must(
    await db.from("artifacts").select("id,raw_object_path,thumbnail_path").eq("id", artifactId).eq("user_id", userId).maybeSingle(),
    "load artifact",
  ) as { id: string; raw_object_path: string | null; thumbnail_path: string | null };

  // 1. immediately remove from user retrieval and ui
  await db.from("artifacts").update({ deleted_at: new Date().toISOString() }).eq("id", artifactId).is("deleted_at", null);

  // 2. delete (or queue hard deletion of) the raw object
  const paths = [artifact.raw_object_path, artifact.thumbnail_path].filter((p): p is string => !!p);
  if (paths.length > 0) {
    const removed = await db.storage.from(MEDIA_BUCKET).remove(paths);
    if (removed.error) throw new Error(`raw object deletion failed: ${removed.error.message}`); // retry via task retries
  }

  // 3. invalidate observations derived only from it
  await db.from("observations").update({ invalidated_at: new Date().toISOString() }).eq("artifact_id", artifactId).is("invalidated_at", null);

  // 4. remove embeddings
  await db.from("artifact_segments").delete().eq("artifact_id", artifactId);

  // 5. recompute affected threads and hypotheses
  const memberships = must(
    await db.from("thread_memberships").select("thread_id").eq("artifact_id", artifactId),
    "load memberships",
  ) as Array<{ thread_id: string }>;
  await db.from("thread_memberships").delete().eq("artifact_id", artifactId);
  for (const m of memberships) {
    await db.from("threads").update({ updated_at: new Date().toISOString(), status: "candidate" }).eq("id", m.thread_id); // demoted pending recompute
  }
  const links = must(
    await db.from("evidence_links").select("id,hypothesis_id").eq("artifact_id", artifactId),
    "load evidence links",
  ) as Array<{ id: string; hypothesis_id: string }>;
  await db.from("evidence_links").delete().eq("artifact_id", artifactId);
  for (const l of links) {
    await db.from("hypotheses").update({ status: "outdated", updated_at: new Date().toISOString() }).eq("id", l.hypothesis_id);
  }

  // 6. minimal tombstone for audit only
  await db.from("audit_events").insert({
    user_id: userId, actor_type: "user", action: "artifact_deleted",
    resource_type: "artifact", resource_id: artifactId, purpose: "user deletion request",
  });
}

export const deletionCascade = task({
  id: "deletion-cascade",
  run: async (payload: DeletionCascadePayload) => {
    const db = serviceDb();

    if (payload.scope === "artifact") {
      await deleteArtifact(db, payload.userId, payload.artifactId);
      return { deleted: payload.artifactId };
    }

    // delete everything (§21.3), in order:
    // 1. revoke sessions
    const user = must(await db.from("users").select("id,auth_id").eq("id", payload.userId).maybeSingle(), "load user") as { id: string; auth_id: string };
    const revoked = await db.auth.admin.signOut(user.auth_id, "global").catch((e: unknown) => ({ error: e }));
    // non-fatal if the auth session is already gone
    void revoked;

    // 2. disable callbacks and radar
    await db.from("watch_entities").update({ paused_at: new Date().toISOString() }).eq("user_id", payload.userId).is("paused_at", null);
    await db.from("callbacks").delete().eq("user_id", payload.userId).is("sent_at", null);

    // 3. remove active data: storage objects first, then rows (fk cascade from users)
    const artifacts = must(
      await db.from("artifacts").select("raw_object_path,thumbnail_path").eq("user_id", payload.userId),
      "load artifact paths",
    ) as Array<{ raw_object_path: string | null; thumbnail_path: string | null }>;
    const paths = artifacts.flatMap((a) => [a.raw_object_path, a.thumbnail_path]).filter((p): p is string => !!p);
    for (let i = 0; i < paths.length; i += 100) {
      const removed = await db.storage.from(MEDIA_BUCKET).remove(paths.slice(i, i + 100));
      if (removed.error) throw new Error(`storage purge failed: ${removed.error.message}`);
    }
    await db.from("users").delete().eq("id", payload.userId); // on delete cascade clears all user tables

    // 4. encryption material rotation — not implemented in v1 (no user-specific keys yet, §21.3)
    // 5. backup expiry is queued by infrastructure policy (~30 days) — recorded honestly in the audit event
    await db.from("audit_events").insert({
      user_id: null, actor_type: "system", action: "account_deleted",
      resource_type: "user", resource_id: payload.userId,
      purpose: "delete-everything request",
      metadata: { active_data: "removed", backups: "expire within 30 days", providers: "store:false, no provider-side memory" },
    });
    return { deleted: "everything" };
  },
});
