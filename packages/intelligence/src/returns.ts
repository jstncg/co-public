export type ReturnArtifact = {
  id: string;
  capturedAt: string;
  title: string | null;
  text: string | null;
  note: string | null;
};

const stopwords = new Set(["about", "after", "again", "because", "before", "being", "from", "have", "into", "just", "that", "their", "then", "there", "these", "they", "this", "through", "want", "what", "when", "where", "which", "with", "would", "your"]);

function terms(artifact: ReturnArtifact) {
  return new Set(`${artifact.title ?? ""} ${artifact.text ?? ""} ${artifact.note ?? ""}`
    .toLocaleLowerCase().match(/[a-z0-9]{4,}/g)?.filter((term) => !stopwords.has(term)).slice(0, 200) ?? []);
}

export function selectReturnCandidate(trigger: ReturnArtifact, older: ReturnArtifact[]) {
  const triggerTerms = terms(trigger);
  const triggerTime = Date.parse(trigger.capturedAt);
  if (triggerTerms.size === 0 || !Number.isFinite(triggerTime)) return null;
  const ranked = older.flatMap((candidate) => {
    const ageDays = (triggerTime - Date.parse(candidate.capturedAt)) / 86_400_000;
    if (!Number.isFinite(ageDays) || ageDays < 1 || candidate.id === trigger.id) return [];
    const overlap = [...terms(candidate)].filter((term) => triggerTerms.has(term));
    if (overlap.length === 0) return [];
    return [{ candidate, overlap: overlap.slice(0, 3), score: overlap.length + Math.min(ageDays, 30) / 100 }];
  }).sort((left, right) => right.score - left.score);
  const match = ranked[0];
  if (!match) return null;
  const oldLabel = match.candidate.title?.trim() || "an earlier save";
  const triggerLabel = trigger.title?.trim() || "what you just saved";
  return {
    oldArtifactId: match.candidate.id,
    reason: `The older receipt and ${triggerLabel} both touch ${match.overlap.join(", ")}.`,
    copy: `You saved ${oldLabel} earlier. It may be useful again now; the new trigger overlaps with it around ${match.overlap.join(", ")}.`,
    overlap: match.overlap,
  };
}

