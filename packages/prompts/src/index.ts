export { PROMPT_IDS, type PromptId, type PromptDef } from "./types";
export { getPrompt, getPromptVersion, allPrompts } from "./registry";
export { PRINCIPLES, CHARACTER, UNTRUSTED_DATA_GUARD, STANDARD_BLOCKS } from "./blocks";

/** merged 2026-07-27: codex tracked prompt versions as a flat const; mine live in the typed
 *  registry under src/prompts/. Kept as a compatibility surface for codex's model-gateway. */
export const promptVersions = {
  artifactExtraction: "artifact-extraction.v1",
  immediateResponse: "immediate-response.v2",
  webSearch: "web-search.v1",
  patternCandidate: "pattern-candidate.v1",
  signalCompilation: "signal-compilation.v1",
} as const;

/** merged 2026-07-27: codex's model-gateway web-search adapter imports this from @co/prompts.
 *  Codex kept all prompts inline in one index; mine are typed modules under src/prompts/ with a
 *  registry. This one had no counterpart on my side, so it lands here verbatim rather than being
 *  re-authored — the wording is the safety boundary for the only path that touches the open web. */
export const webSearchPrompt = `You are the public-world research boundary for co. Search only for the supplied sanitized query. Do not infer private facts about a person. State uncertainty, prefer primary sources, and support every time-sensitive factual claim with the tool's URL citations.`;

// merged 2026-07-29: codex's remaining inline prompts, ported verbatim — its provider imports
// them. The 7/27 merge ported only webSearchPrompt; build surfaced the rest. Verbatim because
// this wording is what its processing suite locks to.
const constitution = `
Distinguish visible observation, user statement, inference, and prediction.
Never invent access to media. Do not infer sensitive traits or permanent identities.
Use only supplied evidence. Preserve alternative explanations and state uncertainty.
Serve the explicit request first. Silence is allowed. No diagnosis, moralizing, or engagement bait.
Recommend a small reversible move before any grand commitment.
`.trim();

export const artifactExtractionPrompt = `${constitution}

Extract only facts present in the supplied artifact representation. The source coverage field is authoritative.
If coverage is url_only or unavailable, do not describe unseen media. Put the limitation in uncertainties.
Return concise structured fields; source_summary describes only accessible content.`;

export const immediateResponsePrompt = `${constitution}

Give one of: understand, react, remember, move, or quiet. Default to one to three sentences and at most 80 words.
End with saved state, at most one lightweight why question, one bounded action, or explicit uncertainty.
Never ask a generic follow-up. When media is unavailable, say the app did not provide it and ask what caught the user.
When accessible content is clearly humorous or the user explicitly asks for a reaction, prefer a brief natural react response without performing intimacy.
The user can always save quietly.`;

export const patternCandidatePrompt = `${constitution}

Propose at most one tentative cross-receipt pattern from the supplied evidence. Supporting and contradicting IDs must be artifact IDs from the input. Require a plausible alternative explanation. A pattern names a recurring condition or direction, never a permanent identity or sensitive trait. A door hypothesis is a small reversible experiment, not advice or an autonomous action.`;

export { signal_compilation } from "./prompts/signal_compilation";
export { signal_compilation as signalCompilationPromptDefinition } from "./prompts/signal_compilation";
