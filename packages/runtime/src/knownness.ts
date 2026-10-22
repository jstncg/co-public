import type { EvidenceRecord, SqliteStore } from "./store.ts";

const STOP = new Set([
  "about", "after", "again", "also", "because", "before", "being", "could", "from", "have", "into", "just", "more", "most",
  "that", "their", "there", "these", "they", "this", "those", "through", "very", "what", "when", "where", "which", "while", "with",
  "would", "your", "youre", "it's", "its", "the", "and", "but", "for", "are", "was", "were", "has", "had", "will",
]);

const NEGATORS = new Set(["not", "never", "no", "dont", "doesnt", "didnt", "isnt", "wasnt", "wont", "cant"]);

function orderedTokens(value: string): string[] {
  return (value.toLowerCase().normalize("NFKC").replace(/[’']/g, "").match(/[\p{L}\p{N}]+/gu) ?? []);
}

function negatedTerms(value: string): Set<string> {
  const ordered = orderedTokens(value);
  const out = new Set<string>();
  for (let index = 0; index < ordered.length; index += 1) {
    if (!NEGATORS.has(ordered[index] ?? "")) continue;
    for (const term of ordered.slice(index + 1, index + 4)) {
      if (term.length > 2 && !STOP.has(term) && !NEGATORS.has(term)) out.add(term);
    }
  }
  return out;
}

function polarityConflict(left: string, right: string): boolean {
  const rightTokens = tokens(right);
  const shared = [...tokens(left)].filter((term) => rightTokens.has(term) && !NEGATORS.has(term));
  if (shared.length < 1) return false;
  const leftNegated = negatedTerms(left);
  const rightNegated = negatedTerms(right);
  return shared.some((term) => leftNegated.has(term) !== rightNegated.has(term));
}

function tokens(value: string): Set<string> {
  return new Set((value.toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token.length > 2 && !STOP.has(token)));
}

function overlap(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  const containment = intersection / Math.min(a.size, b.size);
  const jaccard = intersection / (a.size + b.size - intersection);
  return Math.min(1, containment * 0.72 + jaccard * 0.28);
}

function sameStatement(left: string, right: string): boolean {
  // Preserve word order, pronouns, numbers, short names, and negation. Token
  // overlap cannot establish equivalence, even when it scores 1.0.
  const normalize = (value: string): string => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return normalize(left) === normalize(right);
}

export type KnownnessStatus = "new" | "known" | "uncertain";

export interface KnownnessDecision {
  status: KnownnessStatus;
  score: number;
  reason: string;
  matchedSourceEventId?: string;
  polarityConflict?: boolean;
}

/**
 * A local, zero-model-call veto over claims Co is considering surfacing. It is
 * intentionally conservative: owner evidence can prove that something is
 * already known; prior delivered text can prove Co already said it; neither
 * source can prove novelty merely because search returned nothing.
 */
export class KnownnessGate {
  private readonly store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  evaluate(tenantId: string, content: string, sourceEventId: string, claimedNovelty: number): KnownnessDecision {
    const clean = content.replace(/\s+/g, " ").trim();
    if (!clean || tokens(clean).size < 1) return { status: "uncertain", score: 0, reason: "candidate is too slight to establish a useful delta" };
    let evidence: EvidenceRecord[] = [];
    let retrievalFailed = false;
    try { evidence = this.store.searchEvidence(tenantId, clean, { limit: 24, trustClasses: ["owner", "agent"] }); } catch { retrievalFailed = true; }
    const ownerMatches = evidence
      .filter((item) => item.trustClass === "owner" && item.sourceEventId !== sourceEventId)
      .map((item) => ({ score: overlap(clean, item.content), sourceEventId: item.sourceEventId, conflict: polarityConflict(clean, item.content), exact: sameStatement(clean, item.content) }))
      .sort((left, right) => right.score - left.score);
    const agentMatches = evidence
      .filter((item) => item.trustClass === "agent" && item.sourceEventId !== sourceEventId)
      .map((item) => ({ score: overlap(clean, item.content), sourceEventId: item.sourceEventId, conflict: polarityConflict(clean, item.content), exact: sameStatement(clean, item.content) }))
      .sort((left, right) => right.score - left.score);
    const deliveredRows = this.store.db.prepare(`SELECT content FROM interventions
      WHERE tenant_id=? AND (delivered_at IS NOT NULL OR read_at IS NOT NULL) AND failed_at IS NULL AND content IS NOT NULL
      ORDER BY COALESCE(read_at,delivered_at) DESC LIMIT 200`).all(tenantId) as Array<{ content: string }>;
    const deliveredMatches = deliveredRows.map((row) => ({ score: overlap(clean, String(row.content)), conflict: polarityConflict(clean, String(row.content)), exact: sameStatement(clean, String(row.content)) }))
      .sort((left, right) => right.score - left.score);
    const delivered = deliveredMatches[0];
    const deliveredScore = delivered?.score ?? 0;
    const owner = ownerMatches[0];
    if (owner?.conflict && owner.score >= 0.55) {
      return { status: "uncertain", score: owner.score, reason: "candidate reverses the polarity of closely matching owner evidence", matchedSourceEventId: owner.sourceEventId, polarityConflict: true };
    }
    const exactOwner = ownerMatches.find((match) => match.exact);
    if (exactOwner) {
      return { status: "known", score: 1, reason: "candidate exactly restates the member's own prior evidence", matchedSourceEventId: exactOwner.sourceEventId };
    }
    const priorAgent = agentMatches[0];
    if (priorAgent?.conflict && priorAgent.score >= 0.65) {
      return { status: "uncertain", score: priorAgent.score, reason: "candidate reverses the polarity of closely matching prior Co text", matchedSourceEventId: priorAgent.sourceEventId, polarityConflict: true };
    }
    const exactAgent = agentMatches.find((match) => match.exact);
    if (exactAgent) {
      return { status: "known", score: 1, reason: "Co already authored exactly the same message", matchedSourceEventId: exactAgent.sourceEventId };
    }
    if (delivered?.conflict && deliveredScore >= 0.65) {
      return { status: "uncertain", score: deliveredScore, reason: "candidate reverses the polarity of a closely matching delivered message", polarityConflict: true };
    }
    if (deliveredMatches.some((match) => match.exact)) {
      return { status: "known", score: 1, reason: "exactly the same message was already delivered" };
    }
    const strongest = Math.max(owner?.score ?? 0, priorAgent?.score ?? 0, deliveredScore);
    if (!retrievalFailed && claimedNovelty >= 0.55 && strongest < 0.45 && (evidence.length > 0 || deliveredRows.length > 0)) {
      return { status: "new", score: strongest, reason: "retrieved comparison evidence supports a materially different candidate" };
    }
    const matchedSourceEventId = (owner?.score ?? 0) >= (priorAgent?.score ?? 0) ? owner?.sourceEventId : priorAgent?.sourceEventId;
    return {
      status: "uncertain",
      score: strongest,
      reason: retrievalFailed ? "evidence retrieval failed, so novelty is unresolved"
        : evidence.length === 0 && deliveredRows.length === 0 ? "no comparable evidence was retrieved, which cannot establish novelty"
          : claimedNovelty < 0.55 ? "the candidate does not make a strong novelty claim" : "available evidence does not establish whether the semantic delta is new",
      ...(matchedSourceEventId ? { matchedSourceEventId } : {}),
    };
  }
}
