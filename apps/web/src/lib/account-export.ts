import type { SupabaseClient } from "@supabase/supabase-js";

const publicTables: Array<[string, string]> = [
  ["profiles", "*"], ["devices", "id,user_id,app_version,os_version,last_seen_at,notification_settings"],
  ["artifacts", "*"], ["artifact_segments", "id,user_id,artifact_id,segment_type,start_offset,end_offset,start_seconds,end_seconds,text,metadata,created_at"],
  ["source_receipts", "*"], ["annotations", "*"], ["observations", "*"], ["threads", "*"],
  ["thread_memberships", "*"], ["hypotheses", "*"], ["evidence_links", "*"], ["consents", "*"],
  ["audit_events", "*"], ["product_events", "*"], ["artifact_responses", "*"], ["standards", "*"],
  ["standard_evidence", "*"], ["circles", "*"], ["circle_evidence", "*"], ["pattern_feedback", "*"],
  ["watch_entities", "*"], ["source_subscriptions", "*"], ["radar_candidates", "*"], ["watch_feedback", "*"],
  ["moves", "*"], ["outcomes", "*"], ["callbacks", "*"], ["data_requests", "*"],
  ["conversations", "*"], ["messages", "*"], ["message_artifacts", "*"], ["interaction_policies", "*"],
  ["legacy_memory_claims", "*"], ["memory_returns", "*"],
];

async function selectRows(admin: SupabaseClient, table: string, columns: string, userId: string) {
  const rows: unknown[] = [];
  for (let from = 0; ; from += 1_000) {
    const scopeColumn = table === "profiles" ? "id" : "user_id";
    const { data, error } = await admin.from(table).select(columns).eq(scopeColumn, userId).range(from, from + 999);
    if (error) throw new Error(`export public.${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 1_000) return rows;
  }
}

export async function createAccountExport(admin: SupabaseClient, userId: string, now = new Date()) {
  const requested = await admin.from("data_requests").insert({
    user_id: userId,
    request_type: "export",
    status: "running",
    started_at: now.toISOString(),
  }).select("id").single<{ id: string }>();
  if (requested.error) throw new Error(`export request: ${requested.error.message}`);

  try {
    const [entries, privateExport] = await Promise.all([
      Promise.all(publicTables.map(async ([table, columns]) => [`public.${table}`, await selectRows(admin, table, columns, userId)] as const)),
      admin.rpc("export_private_user_data", { p_user_id: userId }),
    ]);
    if (privateExport.error) throw new Error(`export private records: ${privateExport.error.message}`);
    const privateData = privateExport.data as Record<string, unknown>;
    const payload = {
      format: "co-account-export.v1",
      generatedAt: now.toISOString(),
      userId,
      notes: ["Vector embeddings and APNs device tokens are omitted.", "Public world events are not personal data and are omitted."],
      tables: {
        ...Object.fromEntries(entries),
        "private.model_runs": privateData.model_runs ?? [],
        "private.external_queries": privateData.external_queries ?? [],
        "private.review_decisions": privateData.review_decisions ?? [],
        "private.shadow_comparisons": privateData.shadow_comparisons ?? [],
        "private.apple_authorization": privateData.apple_authorization ?? { stored: false },
        "private.transport_phone_link": privateData.transport_phone_link ?? null,
      },
    };
    const path = `${userId}/${requested.data.id}.json`;
    const body = new TextEncoder().encode(`${JSON.stringify(payload, null, 2)}\n`);
    const uploaded = await admin.storage.from("exports").upload(path, body, { contentType: "application/json", upsert: false });
    if (uploaded.error) throw new Error(`export upload: ${uploaded.error.message}`);
    const signed = await admin.storage.from("exports").createSignedUrl(path, 900, { download: `co-export-${now.toISOString().slice(0, 10)}.json` });
    if (signed.error) throw new Error(`export signed URL: ${signed.error.message}`);
    const expiresAt = new Date(now.getTime() + 900_000).toISOString();
    const completed = await admin.from("data_requests").update({
      status: "completed", object_path: path, object_expires_at: expiresAt, completed_at: new Date().toISOString(),
    }).eq("id", requested.data.id).eq("user_id", userId);
    if (completed.error) throw new Error(`export completion: ${completed.error.message}`);
    const audit = await admin.from("audit_events").insert({
      user_id: userId,
      actor_type: "user",
      actor_id: userId,
      action: "account.export",
      resource_type: "data_request",
      resource_id: requested.data.id,
      purpose: "user_requested_export",
      metadata: { expires_in_seconds: 900 },
    });
    if (audit.error) throw new Error(`export audit: ${audit.error.message}`);
    return { downloadURL: signed.data.signedUrl, expiresAt };
  } catch (error) {
    await admin.from("data_requests").update({ status: "failed" }).eq("id", requested.data.id).eq("user_id", userId);
    throw error;
  }
}
