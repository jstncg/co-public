import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ArtifactExtraction,
  ImmediateResponse,
  WhyQuestion,
  MemoryUpdate,
  PatternCandidate,
  RadarAssessment,
  MovePlan,
  OutcomeUpdate,
} from "@co/contracts";
import { MockProvider, makeProvider, type ArtifactInput, type EvidenceItem } from "../src/index";

const provider = new MockProvider();

const textArtifact: ArtifactInput = {
  source_type: "article",
  coverage: "text",
  raw_text: "Recommendation systems do not merely predict preference; they train it by controlling exposure.",
};

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("makeProvider returns mock when OPENAI_API_KEY absent", () => {
  assert.ok(makeProvider({}) instanceof MockProvider);
});

test("extractArtifact output is contract-valid and honest about coverage", async () => {
  const full = await provider.extractArtifact(textArtifact);
  ArtifactExtraction.parse(full);
  assert.ok(full.media_access_confidence > 0.5);

  const urlOnly = await provider.extractArtifact({ source_type: "url", coverage: "url_only" });
  ArtifactExtraction.parse(urlOnly);
  assert.ok(urlOnly.media_access_confidence <= 0.3);
  assert.ok(urlOnly.uncertainties.length > 0);
});

test("immediate response: remember mode echoes the user's why", async () => {
  const extraction = await provider.extractArtifact(textArtifact);
  const res = await provider.generateImmediateResponse({
    artifact: { ...textArtifact, why_annotation: "The room mattered more than the pottery" },
    extraction,
    register: "direct",
  });
  ImmediateResponse.parse(res);
  assert.equal(res.mode, "remember");
  assert.ok(res.response.includes("the room mattered more than the pottery"));
  assert.ok(res.response.split(/\s+/).length <= 80);
});

test("immediate response: quiet mode when media is unavailable", async () => {
  const artifact: ArtifactInput = { source_type: "short_video", coverage: "unavailable" };
  const extraction = await provider.extractArtifact(artifact);
  const res = await provider.generateImmediateResponse({ artifact, extraction, register: "warm" });
  ImmediateResponse.parse(res);
  assert.equal(res.mode, "quiet");
  assert.equal(res.response, "saved. i don't have a useful connection yet.");
});

test("why question adapts to content and stays contract-valid", async () => {
  const extraction = await provider.extractArtifact(textArtifact);
  const general = await provider.proposeWhyQuestion({ artifact: textArtifact, extraction });
  WhyQuestion.parse(general);
  assert.ok(general.options.includes("keep me posted"));

  const social = await provider.proposeWhyQuestion({
    artifact: { source_type: "social_post", coverage: "text", raw_text: "dinner with the ceramics people" },
    extraction: { ...extraction, content_mood: null },
  });
  WhyQuestion.parse(social);
  assert.equal(social.prompt, "what pulled you in?");
});

test("memory update records why as user_statement", async () => {
  const artifact = { ...textArtifact, why_annotation: "keep me posted on Andera" };
  const extraction = await provider.extractArtifact({ ...artifact, raw_text: "Andera builds systems tools" });
  const update = await provider.updateMemory({ artifact, extraction, existing_observations: [], active_threads: [{ title: "systems thinking" }] });
  MemoryUpdate.parse(update);
  assert.ok(update.observations_to_add.some((o) => o.observation_type === "user_statement" && o.confidence >= 0.9));
  assert.ok(update.watch_suggestion, "keep-me-posted why should yield a watch suggestion");
});

test("proposePatterns respects §13.3 thresholds: <3 evidence → nothing", async () => {
  const evidence: EvidenceItem[] = [
    { id: uuid(1), kind: "artifact", statement: "pottery class reel", occurred_at: "2026-06-01" },
    { id: uuid(2), kind: "artifact", statement: "pottery wheel video", occurred_at: "2026-06-02" },
  ];
  assert.deepEqual(await provider.proposePatterns({ evidence }), []);
});

test("proposePatterns: single-day evidence → nothing", async () => {
  const evidence: EvidenceItem[] = [1, 2, 3].map((n) => ({
    id: uuid(n), kind: "artifact" as const, statement: "pottery moment", occurred_at: "2026-06-01",
  }));
  assert.deepEqual(await provider.proposePatterns({ evidence }), []);
});

test("proposePatterns: 3+ moments across 2+ days → one valid candidate", async () => {
  const evidence: EvidenceItem[] = [
    { id: uuid(1), kind: "artifact", statement: "pottery class with friends", occurred_at: "2026-06-01" },
    { id: uuid(2), kind: "artifact", statement: "communal pottery dinner", occurred_at: "2026-06-03" },
    { id: uuid(3), kind: "annotation", statement: "pottery book club", occurred_at: "2026-06-05" },
  ];
  const patterns = await provider.proposePatterns({ evidence });
  assert.equal(patterns.length, 1);
  const candidate = PatternCandidate.parse(patterns[0]);
  assert.equal(candidate.supporting_evidence_ids.length, 3);
  assert.ok(candidate.alternative_explanations.length >= 1);
});

test("proposePatterns: explicit contradiction keeps confidence below send threshold", async () => {
  const evidence: EvidenceItem[] = [
    { id: uuid(1), kind: "artifact", statement: "running trail photo", occurred_at: "2026-06-01" },
    { id: uuid(2), kind: "artifact", statement: "running sunrise photo", occurred_at: "2026-06-03" },
    { id: uuid(3), kind: "artifact", statement: "running race photo", occurred_at: "2026-06-05" },
  ];
  const contradicting: EvidenceItem[] = [
    { id: uuid(9), kind: "annotation", statement: "i like the photography, not running", occurred_at: "2026-06-05" },
  ];
  const [candidate] = await provider.proposePatterns({ evidence, contradicting_evidence: contradicting });
  assert.ok(candidate);
  assert.ok(candidate.confidence <= 0.3);
  assert.deepEqual(candidate.contradicting_evidence_ids, [uuid(9)]);
});

test("rankRadar: desired event + explicit evidence → send with cited why_user", async () => {
  const res = await provider.rankRadar({
    watch: { display_name: "Andera", entity_type: "company", desired_event_types: ["launch"], excluded_event_types: [] },
    event: { event_type: "launch", title: "Andera launched", source_url: "https://andera.dev/launch", source_published_at: "2026-06-08T15:00:00Z" },
    user_evidence: [{ id: uuid(5), kind: "annotation", statement: "you wanted to stay close to their work" }],
  });
  RadarAssessment.parse(res);
  assert.equal(res.send_recommendation, "send");
  assert.ok(res.why_user.includes("stay close to their work"));
  assert.ok(res.source_facts.some((f) => f.includes("andera.dev")));
});

test("rankRadar: no explicit evidence → discard, high creepiness", async () => {
  const res = await provider.rankRadar({
    watch: { display_name: "Andera", entity_type: "company", desired_event_types: [], excluded_event_types: [] },
    event: { event_type: "launch", title: "Andera launched", source_url: "https://andera.dev/launch" },
    user_evidence: [],
  });
  RadarAssessment.parse(res);
  assert.equal(res.send_recommendation, "discard");
  assert.ok(res.creepiness_risk >= 0.5);
});

test("rankRadar: already-sent event → discard", async () => {
  const res = await provider.rankRadar({
    watch: { display_name: "Andera", entity_type: "company", desired_event_types: ["launch"], excluded_event_types: [] },
    event: { event_type: "launch", title: "Andera launched", source_url: "https://andera.dev/launch" },
    user_evidence: [{ id: uuid(5), kind: "annotation", statement: "stay close to their work" }],
    previously_sent_summaries: ["andera launched — public launch post"],
  });
  assert.equal(res.send_recommendation, "discard");
});

test("planMove: preparation has no external effect and the user takes the final action", async () => {
  const plan = await provider.planMove({
    origin: "radar",
    context: "Andera launched and the user wanted to stay close",
    desired_move_type: "congratulate",
    evidence: [{ id: uuid(5), kind: "annotation", statement: "their early prototypes" }],
    authority: { requires_user_final_action: true, allowed_move_types: ["congratulate", "open_source"] },
  });
  MovePlan.parse(plan);
  assert.equal(plan.final_user_action_required, true);
  assert.equal(plan.external_effect, false);
  assert.equal(plan.private_context_disclosed, false);
});

test("evaluateOutcome maps results to hypothesis directions", async () => {
  const hypotheses = [{ id: uuid(7), statement: "recurring creative rooms matter", confidence: 0.5 }];
  const good = await provider.evaluateOutcome({
    move: { move_type: "start_small_experiment", title: "ceramics course" },
    outcome: { result: "yes", value_rating: "the people", would_repeat: true },
    hypotheses,
  });
  OutcomeUpdate.parse(good);
  assert.equal(good.hypothesis_adjustments[0]?.direction, "strengthen");

  const bad = await provider.evaluateOutcome({
    move: { move_type: "start_small_experiment", title: "ceramics course" },
    outcome: { result: "decided against it" },
    hypotheses,
  });
  assert.equal(bad.hypothesis_adjustments[0]?.direction, "weaken");
});

test("embed is deterministic, normalized, right dimension", async () => {
  const small = new MockProvider({ embeddingDim: 32 });
  const [a1] = await small.embed(["pottery"]);
  const [a2, b] = await small.embed(["pottery", "running"]);
  assert.equal(a1!.length, 32);
  assert.deepEqual(a1, a2);
  assert.notDeepEqual(a1, b);
  const norm = Math.sqrt(a1!.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9);
});
