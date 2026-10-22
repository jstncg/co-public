/** full user export → private storage object + signed url (goal.md §21, user sovereignty §4.8). */
import { task } from "@trigger.dev/sdk/v3";
import { serviceDb, must } from "../lib/db";

export interface ExportUserPayload {
  userId: string;
  idempotencyKey: string;
}

const EXPORT_BUCKET = process.env.STORAGE_BUCKET_EXPORTS ?? "exports";

const USER_TABLES = [
  "artifacts", "artifact_segments", "annotations", "observations", "threads", "thread_memberships",
  "hypotheses", "evidence_links", "people_entities", "standards", "circles", "watch_entities",
  "source_subscriptions", "radar_candidates", "callbacks", "moves", "outcomes", "consents",
] as const;

export const exportUser = task({
  id: "export-user",
  run: async (payload: ExportUserPayload) => {
    const db = serviceDb();
    const user = must(await db.from("users").select("*").eq("id", payload.userId).maybeSingle(), "load user");

    const dump: Record<string, unknown> = { user, exported_at: new Date().toISOString() };
    for (const table of USER_TABLES) {
      // tables without a direct user_id column are exported via their parent linkage
      if (table === "artifact_segments") {
        dump[table] = must(
          await db.from(table).select("*,artifacts!inner(user_id)").eq("artifacts.user_id", payload.userId),
          `export ${table}`,
        );
      } else if (table === "thread_memberships") {
        dump[table] = must(
          await db.from(table).select("*,threads!inner(user_id)").eq("threads.user_id", payload.userId),
          `export ${table}`,
        );
      } else if (table === "evidence_links") {
        dump[table] = must(
          await db.from(table).select("*,hypotheses!inner(user_id)").eq("hypotheses.user_id", payload.userId),
          `export ${table}`,
        );
      } else if (table === "source_subscriptions") {
        dump[table] = must(
          await db.from(table).select("*,watch_entities!inner(user_id)").eq("watch_entities.user_id", payload.userId),
          `export ${table}`,
        );
      } else {
        dump[table] = must(await db.from(table).select("*").eq("user_id", payload.userId), `export ${table}`);
      }
    }

    const path = `${payload.userId}/${payload.idempotencyKey}.json`; // idempotent: same key overwrites same object
    const upload = await db.storage.from(EXPORT_BUCKET).upload(path, JSON.stringify(dump, null, 2), {
      contentType: "application/json",
      upsert: true,
    });
    if (upload.error) throw new Error(`export upload failed: ${upload.error.message}`);

    const signed = await db.storage.from(EXPORT_BUCKET).createSignedUrl(path, 24 * 3600);
    if (signed.error || !signed.data) throw new Error(`signed url failed: ${signed.error?.message}`);

    await db.from("audit_events").insert({
      user_id: payload.userId, actor_type: "system", action: "export_created",
      resource_type: "storage_object", resource_id: path, purpose: "user data export",
    });
    return { path, signed_url: signed.data.signedUrl };
  },
});
