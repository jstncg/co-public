import { z } from "zod";

type QueryResult<T> = PromiseLike<{ data: T | null; error: { message: string } | null }>;
type Query = {
  select(columns: string): Query;
  insert(values: unknown): QueryResult<unknown>;
  eq(column: string, value: unknown): Query;
  in(column: string, values: readonly string[]): Query;
  is(column: string, value: null): Query;
  not(column: string, operator: string, value: null): Query;
  gt(column: string, value: string): Query;
  order(column: string, options: { ascending: boolean }): Query;
  limit(count: number): QueryResult<unknown[]>;
};

export type FounderDatabase = {
  from(table: string): Query;
  schema(schema: string): FounderDatabase;
  rpc(functionName: string, parameters: Record<string, unknown>): QueryResult<unknown>;
};

const decisionSchema = z.object({
  hypothesisId: z.uuid(),
  decision: z.enum(["approve", "edit", "reject", "unsafe"]),
  editedStatement: z.string().trim().min(1).max(1_000).optional(),
  rubricLabels: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
}).superRefine((value, context) => {
  if (value.decision === "edit" && !value.editedStatement) {
    context.addIssue({ code: "custom", path: ["editedStatement"], message: "an edited statement is required" });
  }
});

type ConsentRow = { id: string; user_id: string; expires_at: string };
type HypothesisRow = {
  id: string;
  user_id: string;
  statement: string;
  alternatives_json: unknown;
  confidence: number;
  sensitivity: string;
  proposed_copy: string | null;
  reason_to_send: string | null;
  proposed_move: unknown;
  created_at: string;
};
type EvidenceLinkRow = { hypothesis_id: string; artifact_id: string; observation_id: string | null; direction: string; weight: number };
type ArtifactRow = { id: string; source_type: string; source_coverage: string; title: string | null; publisher: string | null; captured_at: string };
type ObservationRow = { id: string; statement: string; confidence: number };

export type FounderReviewCard = {
  id: string;
  userReference: string;
  consentExpiresAt: string;
  statement: string;
  alternatives: unknown;
  confidence: number;
  sensitivity: string;
  proposedCopy: string | null;
  reasonToSend: string | null;
  proposedMove: unknown;
  createdAt: string;
  evidence: Array<{
    artifactId: string;
    sourceType: string;
    coverage: string;
    title: string | null;
    publisher: string | null;
    capturedAt: string;
    direction: string;
    weight: number;
    observation: string | null;
    observationConfidence: number | null;
  }>;
};

function rows<T>(result: { data: unknown; error: { message: string } | null }, label: string): T[] {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return (result.data ?? []) as T[];
}

export async function listFounderReviews(
  database: FounderDatabase,
  reviewerId: string,
  now = new Date(),
): Promise<FounderReviewCard[]> {
  const timestamp = now.toISOString();
  const consentResult = await database.from("consents")
    .select("id,user_id,expires_at")
    .eq("consent_type", "founder_review")
    .is("revoked_at", null)
    .not("expires_at", "is", null)
    .gt("expires_at", timestamp)
    .limit(500);
  const consents = rows<ConsentRow>(consentResult, "active founder consents");
  if (consents.length === 0) return [];

  const consentByUser = new Map(consents.map((consent) => [consent.user_id, consent]));
  const hypothesisResult = await database.from("hypotheses")
    .select("id,user_id,statement,alternatives_json,confidence,sensitivity,proposed_copy,reason_to_send,proposed_move,created_at")
    .eq("status", "review")
    .in("user_id", [...consentByUser.keys()])
    .order("created_at", { ascending: true })
    .limit(100);
  const hypotheses = rows<HypothesisRow>(hypothesisResult, "review hypotheses");
  if (hypotheses.length === 0) return [];

  const hypothesisIds = hypotheses.map((hypothesis) => hypothesis.id);
  const linkResult = await database.from("evidence_links")
    .select("hypothesis_id,artifact_id,observation_id,direction,weight")
    .in("hypothesis_id", hypothesisIds)
    .limit(1_000);
  const links = rows<EvidenceLinkRow>(linkResult, "review evidence");

  const artifactIds = [...new Set(links.map((link) => link.artifact_id))];
  const observationIds = [...new Set(links.flatMap((link) => link.observation_id ? [link.observation_id] : []))];
  const artifacts = artifactIds.length === 0 ? [] : rows<ArtifactRow>(
    await database.from("artifacts")
      .select("id,source_type,source_coverage,title,publisher,captured_at")
      .is("deleted_at", null)
      .in("id", artifactIds)
      .limit(1_000),
    "review artifact receipts",
  );
  const observations = observationIds.length === 0 ? [] : rows<ObservationRow>(
    await database.from("observations")
      .select("id,statement,confidence")
      .is("invalidated_at", null)
      .in("id", observationIds)
      .limit(1_000),
    "review observations",
  );
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const observationById = new Map(observations.map((observation) => [observation.id, observation]));

  const cards = hypotheses.flatMap((hypothesis): FounderReviewCard[] => {
    const consent = consentByUser.get(hypothesis.user_id);
    if (!consent) return [];
    return [{
      id: hypothesis.id,
      userReference: hypothesis.user_id.slice(0, 8),
      consentExpiresAt: consent.expires_at,
      statement: hypothesis.statement,
      alternatives: hypothesis.alternatives_json,
      confidence: hypothesis.confidence,
      sensitivity: hypothesis.sensitivity,
      proposedCopy: hypothesis.proposed_copy,
      reasonToSend: hypothesis.reason_to_send,
      proposedMove: hypothesis.proposed_move,
      createdAt: hypothesis.created_at,
      evidence: links.flatMap((link) => {
        if (link.hypothesis_id !== hypothesis.id) return [];
        const artifact = artifactById.get(link.artifact_id);
        if (!artifact) return [];
        const observation = link.observation_id ? observationById.get(link.observation_id) : undefined;
        return [{
          artifactId: artifact.id,
          sourceType: artifact.source_type,
          coverage: artifact.source_coverage,
          title: artifact.title,
          publisher: artifact.publisher,
          capturedAt: artifact.captured_at,
          direction: link.direction,
          weight: link.weight,
          observation: observation?.statement ?? null,
          observationConfidence: observation?.confidence ?? null,
        }];
      }),
    }];
  });

  const { error: auditError } = await database.from("audit_events").insert(cards.map((card) => ({
    user_id: hypotheses.find((hypothesis) => hypothesis.id === card.id)?.user_id,
    actor_type: "founder",
    actor_id: reviewerId,
    action: "founder_review.view",
    resource_type: "hypothesis",
    resource_id: card.id,
    purpose: "consented_alpha_review",
    metadata: { consent_expires_at: card.consentExpiresAt, raw_content_revealed: false },
  })));
  if (auditError) throw new Error(`review access audit: ${auditError.message}`);

  return cards;
}

export async function decideFounderReview(
  database: FounderDatabase,
  reviewerId: string,
  input: unknown,
) {
  const decision = decisionSchema.parse(input);
  const { data, error } = await database.rpc("founder_review_hypothesis", {
    target_hypothesis_id: decision.hypothesisId,
    reviewer: reviewerId,
    review_decision: decision.decision,
    edited_statement: decision.editedStatement ?? null,
    rubric_labels: decision.rubricLabels,
  });
  if (error) throw new Error(`founder review decision: ${error.message}`);
  return data;
}
