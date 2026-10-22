/**
 * pattern engine (goal.md §23): evidence → pre-filters → model candidates → post-filters →
 * hypotheses in 'review' status. founder review gates every callback for the first 100 users.
 */
import { task } from "@trigger.dev/sdk/v3";
import { makeProvider, type EvidenceItem } from "@co/model-gateway";
import type { SourceType } from "@co/contracts";
import { serviceDb, must } from "../lib/db";
import { eligibleEvidence, acceptCandidate } from "../lib/patterns";

export interface PatternEngineRunPayload {
  userId: string;
  trigger: "why_annotation" | "nightly" | "outcome" | "correction";
  idempotencyKey: string;
}

export const patternEngineRun = task({
  id: "pattern-engine-run",
  run: async (payload: PatternEngineRunPayload) => {
    const db = serviceDb();

    const observations = must(
      await db
        .from("observations")
        .select("id,statement,observation_type,created_at,artifact_id,artifacts(source_type,captured_at,retention_mode)")
        .eq("user_id", payload.userId)
        .is("invalidated_at", null)
        .order("created_at", { ascending: false })
        .limit(60),
      "load observations",
    ) as Array<Record<string, unknown>>;

    // no_analysis artifacts can never feed patterns (§37 jordan)
    const usable = observations.filter((o) => (o.artifacts as { retention_mode?: string } | null)?.retention_mode !== "no_analysis");
    const supporting: EvidenceItem[] = [];
    const contradicting: EvidenceItem[] = [];
    for (const o of usable) {
      const item: EvidenceItem = {
        id: o.id as string,
        kind: o.observation_type === "user_statement" ? "annotation" : "observation",
        statement: o.statement as string,
        occurred_at: ((o.artifacts as { captured_at?: string } | null)?.captured_at ?? o.created_at) as string,
        source_type: (o.artifacts as { source_type?: SourceType } | null)?.source_type,
      };
      // explicit user negation ("...not X") is contradiction evidence, not support
      (o.observation_type === "user_statement" && /\bnot\b/i.test(item.statement) ? contradicting : supporting).push(item);
    }

    const gate = eligibleEvidence(supporting);
    if (!gate.eligible) return { skipped: gate.reason };

    const existing = must(
      await db.from("hypotheses").select("statement").eq("user_id", payload.userId),
      "load hypotheses",
    ) as Array<{ statement: string }>;

    const provider = makeProvider(process.env);
    const candidates = await provider.proposePatterns({
      evidence: supporting,
      contradicting_evidence: contradicting,
      known_patterns: existing.map((h) => h.statement),
    });

    let created = 0;
    for (const candidate of candidates) {
      const verdict = acceptCandidate(candidate);
      // idempotent: same statement never inserted twice for a user
      if (existing.some((h) => h.statement === candidate.statement)) continue;
      const hypothesis = must(
        await db.from("hypotheses").insert({
          user_id: payload.userId,
          statement: candidate.statement,
          alternatives_json: candidate.alternative_explanations,
          confidence: candidate.confidence,
          status: verdict.accepted ? "review" : "rejected", // review = awaiting founder approval (§23)
        }).select("id").single(),
        "insert hypothesis",
      ) as { id: string };
      const links = [
        ...candidate.supporting_evidence_ids.map((id) => ({ hypothesis_id: hypothesis.id, observation_id: id, direction: "support" as const })),
        ...candidate.contradicting_evidence_ids.map((id) => ({ hypothesis_id: hypothesis.id, observation_id: id, direction: "contradict" as const })),
      ];
      if (links.length > 0) must(await db.from("evidence_links").insert(links).select("id"), "insert evidence links");
      created += 1;
    }
    return { candidates: candidates.length, created };
  },
});
