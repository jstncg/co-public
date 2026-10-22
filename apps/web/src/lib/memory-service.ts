import { legacyClaimImportSchema, memoryReturnSchema, standingOrderCreateSchema, standingOrderSchema } from "@co/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

function assertDatabase(error: { message: string } | null, context: string) {
  if (error) throw new Error(`${context}: ${error.message}`);
}

export async function listStandingOrders(admin: SupabaseClient, userId: string) {
  const result = await admin.from("interaction_policies")
    .select("id,instruction,scope,exact_receipt,created_at")
    .eq("user_id", userId).eq("status", "active").order("created_at", { ascending: false }).limit(100);
  assertDatabase(result.error, "standing orders");
  return (result.data ?? []).map((row) => standingOrderSchema.parse({
    id: row.id, instruction: row.instruction, scope: row.scope,
    exactReceipt: row.exact_receipt, createdAt: row.created_at,
  }));
}

export async function createStandingOrder(admin: SupabaseClient, userId: string, unknownInput: unknown) {
  const input = standingOrderCreateSchema.parse(unknownInput);
  const inserted = await admin.from("interaction_policies").insert({
    user_id: userId,
    instruction: input.instruction,
    scope: input.scope,
    exact_receipt: input.exactReceipt,
  }).select("id,instruction,scope,exact_receipt,created_at").single();
  assertDatabase(inserted.error, "create standing order");
  if (!inserted.data) throw new Error("create standing order: no row returned");
  return standingOrderSchema.parse({
    id: inserted.data.id, instruction: inserted.data.instruction, scope: inserted.data.scope,
    exactReceipt: inserted.data.exact_receipt, createdAt: inserted.data.created_at,
  });
}

export async function revokeStandingOrder(admin: SupabaseClient, userId: string, unknownId: unknown) {
  const id = z.uuid().parse(unknownId);
  const updated = await admin.from("interaction_policies")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("id", id).eq("user_id", userId).eq("status", "active").select("id").maybeSingle();
  assertDatabase(updated.error, "revoke standing order");
  return { revoked: Boolean(updated.data) };
}

export async function listMemoryReturns(admin: SupabaseClient, userId: string) {
  const result = await admin.from("memory_returns")
    .select("id,old_artifact_id,trigger_artifact_id,trigger_message_id,reason,proposed_copy,status,created_at,delivered_at")
    .eq("user_id", userId).in("status", ["approved", "delivered"])
    .order("created_at", { ascending: false }).limit(50);
  assertDatabase(result.error, "memory returns");
  const rows = result.data ?? [];
  const artifactIds = [...new Set(rows.map((row) => String(row.old_artifact_id)))];
  const artifacts = artifactIds.length === 0 ? { data: [], error: null } : await admin.from("artifacts")
    .select("id,title,publisher,canonical_url,captured_at,source_coverage")
    .eq("user_id", userId).in("id", artifactIds).is("deleted_at", null);
  assertDatabase(artifacts.error, "memory return receipts");
  const artifactById = new Map((artifacts.data ?? []).map((row) => [String(row.id), row]));
  return rows.flatMap((row) => {
    const old = artifactById.get(String(row.old_artifact_id));
    if (!old) return [];
    return [memoryReturnSchema.parse({
      id: row.id,
      oldArtifactId: row.old_artifact_id,
      triggerArtifactId: row.trigger_artifact_id,
      triggerMessageId: row.trigger_message_id,
      reason: row.reason,
      copy: row.proposed_copy,
      status: row.status,
      createdAt: row.created_at,
      deliveredAt: row.delivered_at,
      oldReceipt: {
        title: old.title, publisher: old.publisher, canonicalUrl: old.canonical_url,
        capturedAt: old.captured_at, coverage: old.source_coverage,
      },
    })];
  });
}

export async function dismissMemoryReturn(admin: SupabaseClient, userId: string, unknownId: unknown) {
  const id = z.uuid().parse(unknownId);
  const result = await admin.rpc("dismiss_memory_return", { p_user_id: userId, p_return_id: id });
  assertDatabase(result.error, "dismiss memory return");
  return { dismissed: result.data === true };
}

export async function importLegacyClaim(admin: SupabaseClient, userId: string, unknownInput: unknown) {
  const input = legacyClaimImportSchema.parse(unknownInput);
  const result = await admin.rpc("import_legacy_memory_claim", {
    p_user_id: userId,
    p_source_system: input.sourceSystem,
    p_source_claim_id: input.sourceClaimId,
    p_statement: input.statement,
    p_evidence_artifact_ids: input.evidenceArtifactIds,
    p_alternatives: input.alternatives,
  });
  assertDatabase(result.error, "legacy claim import");
  return { claimId: result.data as string, status: "unconfirmed" as const };
}
