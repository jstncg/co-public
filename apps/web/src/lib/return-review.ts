import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const decisionSchema = z.object({
  returnId: z.uuid(),
  decision: z.enum(["approve", "edit", "reject", "unsafe"]),
  editedCopy: z.string().trim().min(1).max(1_000).optional(),
  rubricLabels: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
}).superRefine((value, context) => {
  if (value.decision === "edit" && !value.editedCopy) context.addIssue({ code: "custom", path: ["editedCopy"], message: "edited copy required" });
});

export async function listReturnReviews(admin: SupabaseClient, reviewerId: string, now = new Date()) {
  const consents = await admin.from("consents").select("id,user_id,expires_at")
    .eq("consent_type", "founder_review").is("revoked_at", null).gt("expires_at", now.toISOString()).limit(500);
  if (consents.error) throw new Error(`return review consent: ${consents.error.message}`);
  const consentByUser = new Map((consents.data ?? []).map((row) => [String(row.user_id), row]));
  if (consentByUser.size === 0) return [];
  const returns = await admin.from("memory_returns")
    .select("id,user_id,old_artifact_id,trigger_artifact_id,trigger_message_id,reason,proposed_copy,created_at")
    .eq("status", "review").in("user_id", [...consentByUser.keys()]).order("created_at", { ascending: true }).limit(100);
  if (returns.error) throw new Error(`return review queue: ${returns.error.message}`);
  const artifactIds = [...new Set((returns.data ?? []).flatMap((row) => [String(row.old_artifact_id), ...(row.trigger_artifact_id ? [String(row.trigger_artifact_id)] : [])]))];
  const artifacts = artifactIds.length === 0 ? { data: [], error: null } : await admin.from("artifacts")
    .select("id,title,publisher,canonical_url,captured_at,source_coverage").in("id", artifactIds).is("deleted_at", null);
  if (artifacts.error) throw new Error(`return review receipts: ${artifacts.error.message}`);
  const artifactById = new Map((artifacts.data ?? []).map((row) => [String(row.id), row]));
  const cards = (returns.data ?? []).flatMap((item) => {
    const oldReceipt = artifactById.get(String(item.old_artifact_id));
    const consent = consentByUser.get(String(item.user_id));
    if (!oldReceipt || !consent) return [];
    return [{
      id: item.id,
      userReference: String(item.user_id).slice(0, 8),
      consentExpiresAt: consent.expires_at,
      reason: item.reason,
      proposedCopy: item.proposed_copy,
      oldReceipt,
      triggerReceipt: item.trigger_artifact_id ? artifactById.get(String(item.trigger_artifact_id)) ?? null : null,
      triggerMessageId: item.trigger_message_id,
      createdAt: item.created_at,
    }];
  });
  if (cards.length > 0) {
    const audit = await admin.from("audit_events").insert(cards.map((card) => ({
      user_id: (returns.data ?? []).find((item) => item.id === card.id)?.user_id,
      actor_type: "founder",
      actor_id: reviewerId,
      action: "founder_review.view",
      resource_type: "return",
      resource_id: card.id,
      purpose: "consented_alpha_review",
      metadata: { consent_expires_at: card.consentExpiresAt, raw_content_revealed: false },
    })));
    if (audit.error) throw new Error(`return review audit: ${audit.error.message}`);
  }
  return cards;
}

export async function decideReturnReview(admin: SupabaseClient, reviewerId: string, unknownInput: unknown) {
  const input = decisionSchema.parse(unknownInput);
  const result = await admin.rpc("founder_review_memory_return", {
    p_return_id: input.returnId,
    p_reviewer: reviewerId,
    p_decision: input.decision,
    p_edited_copy: input.editedCopy ?? null,
    p_rubric_labels: input.rubricLabels,
  });
  if (result.error) throw new Error(`return review decision: ${result.error.message}`);
  return { decisionId: result.data as string };
}
