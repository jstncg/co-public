import assert from "node:assert/strict";
import test from "node:test";
import { PerceptionManager } from "../src/perception.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { CoRuntime } from "../src/runtime.ts";
import { createRuntimeServer } from "../src/server.ts";
import { SqliteStore } from "../src/store.ts";
import { RuntimeWorker } from "../src/worker.ts";
import type { ProviderAdapter } from "../src/types.ts";
import { testConfig, testHome } from "./helpers.ts";

function ownerEvent(store: SqliteStore, at: string, text: string): string {
  const event = store.appendEvent({ tenantId: "test", stream: "conversation", type: "message.received", at, payload: { text } });
  store.indexEvidence({ tenantId: "test", sourceEventId: event.id, kind: "conversation.user", trustClass: "owner", content: text, observedAt: at });
  return event.id;
}

test("perception hypotheses mature only across dated owner evidence and preserve correction history", () => {
  const home = testHome();
  const store = new SqliteStore(`${home.path}/runtime.sqlite`);
  const perception = new PerceptionManager(store);
  try {
    const march = ownerEvent(store, "2026-03-04T18:00:00.000Z", "I turned down the prestigious project because its premise felt borrowed.");
    const may = ownerEvent(store, "2026-05-12T18:00:00.000Z", "The smaller project became energizing once I controlled its taste.");
    const july = ownerEvent(store, "2026-07-19T18:00:00.000Z", "I worried I was unambitious, then recovered energy after rewriting the premise in my own words.");
    const hypothesis = perception.propose({
      tenantId: "test", sourceEventId: july, topicKey: "authorship-vs-status",
      statement: "Energy appears to follow authorship of the premise more reliably than the external status of the project.",
      rationale: "Three choices across five months show energy returning after the work becomes self-authored.",
      confidence: 0.84, specificity: 0.88, novelty: 0.78, perceptualValue: 0.9, genericity: 0.12, sensitivity: 0.25, interruptionCost: 0.3,
      alternativeExplanations: ["The smaller projects may simply have had better collaborators."],
      evidence: [
        { eventId: march, relation: "supports", rationale: "Rejected status when the premise felt borrowed." },
        { eventId: may, relation: "supports", rationale: "Energy rose with control over taste." },
        { eventId: july, relation: "supports", rationale: "Rewriting the premise preceded renewed energy." },
      ],
    });
    assert.equal(hypothesis.status, "ready");
    assert.doesNotMatch(perception.formatForPrompt("test"), /Energy appears to follow authorship/);
    assert.equal(perception.evidence("test", hypothesis.id).filter((item) => item.relation === "supports" && item.trustClass === "owner").length, 3);

    const correction = ownerEvent(store, "2026-08-01T18:00:00.000Z", "That interpretation misses it; the collaborators were the actual difference.");
    const rejected = perception.recordFeedback({ tenantId: "test", hypothesisId: hypothesis.id, sourceEventId: correction, kind: "corrected", note: "Collaborator quality, not authorship." });
    assert.equal(rejected.status, "rejected");
    assert.equal(store.getEvent("test", march)?.payload !== undefined, true);
    assert.equal(store.getEvent("test", correction)?.payload !== undefined, true);
    assert.match(perception.formatForPrompt("test"), /do not repeat/i);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("perception leaves recent or generic stories in a non-surfacing state", () => {
  const home = testHome();
  const store = new SqliteStore(`${home.path}/runtime.sqlite`);
  const perception = new PerceptionManager(store);
  try {
    const first = ownerEvent(store, "2026-08-20T18:00:00.000Z", "I had a slow day and thought a lot.");
    const second = ownerEvent(store, "2026-08-21T18:00:00.000Z", "I spent another afternoon thinking.");
    const third = ownerEvent(store, "2026-08-22T18:00:00.000Z", "I was reflective again today.");
    const hypothesis = perception.propose({
      tenantId: "test", sourceEventId: third, topicKey: "reflection",
      statement: "The person is reflective and sometimes spends meaningful time thinking before acting.",
      rationale: "Three recent messages mention reflection.",
      confidence: 0.9, specificity: 0.45, novelty: 0.2, perceptualValue: 0.35, genericity: 0.82, sensitivity: 0.2, interruptionCost: 0.5,
      alternativeExplanations: ["This may be a short-lived week rather than a stable pattern."],
      evidence: [first, second, third].map((eventId) => ({ eventId, relation: "supports" as const, rationale: "Recent reflective episode." })),
    });
    assert.equal(hypothesis.status, "maturing");
    assert.equal(perception.list("test", { status: "ready" }).length, 0);
    const recentButSpecific = perception.propose({
      tenantId: "test", sourceEventId: third, topicKey: "recent-specific-story",
      statement: "This week's reflection consistently replaced a previously planned afternoon action block.",
      rationale: "Three owner events describe the same concrete tradeoff, but only across three recent days.",
      confidence: 0.9, specificity: 0.9, novelty: 0.85, perceptualValue: 0.9, genericity: 0.08, sensitivity: 0.1, interruptionCost: 0.2,
      alternativeExplanations: ["An unusual short-term event may have changed the schedule."],
      evidence: [first, second, third].map((eventId) => ({ eventId, relation: "supports" as const, rationale: "Recent instance." })),
    });
    assert.equal(recentButSpecific.status, "maturing");
    const bundle = perception.buildBundle("test", third);
    assert.equal(bundle.ownerEventIds.has(second), true);
    assert.equal(bundle.ownerEventIds.has(third), true);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("a dense recent month cannot erase older owner evidence from retrieval or synthesis", () => {
  const home = testHome();
  const store = new SqliteStore(`${home.path}/runtime.sqlite`);
  const perception = new PerceptionManager(store);
  try {
    const older = ownerEvent(store, "2025-09-03T12:00:00.000Z", "Orchard decisions improve when the premise is self-authored.");
    let trigger = "";
    for (let index = 0; index < 400; index += 1) {
      trigger = ownerEvent(
        store,
        `2026-09-${String((index % 28) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
        `Orchard recent note ${index}: the current interface needs another small adjustment.`,
      );
    }
    const matches = store.searchEvidence("test", "Orchard premise", { limit: 8, trustClasses: ["owner"] });
    assert.equal(matches.some((item) => item.sourceEventId === older), true);
    const bundle = perception.buildBundle("test", trigger);
    assert.equal(bundle.ownerEventIds.has(older), true);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("an older rejected interpretation remains a relevant semantic tombstone", () => {
  const home = testHome();
  const store = new SqliteStore(`${home.path}/runtime.sqlite`);
  const perception = new PerceptionManager(store);
  try {
    const oldSource = ownerEvent(store, "2025-01-01T00:00:00.000Z", "Orchard was constrained by timing, not fear.");
    const old = perception.propose({
      tenantId: "test", sourceEventId: oldSource, topicKey: "orchard-fear",
      statement: "The Orchard hesitation was caused by fear of visibility.", rationale: "An early interpretation.",
      confidence: 0.4, specificity: 0.9, novelty: 0.8, perceptualValue: 0.8, genericity: 0.1, sensitivity: 0.3, interruptionCost: 0.2,
      alternativeExplanations: ["Timing was the actual constraint."],
      evidence: [{ eventId: oldSource, relation: "supports", rationale: "Initial evidence." }],
    });
    perception.recordFeedback({ tenantId: "test", hypothesisId: old.id, sourceEventId: oldSource, kind: "rejected", note: "Timing, not fear." });
    for (let index = 0; index < 8; index += 1) {
      const source = ownerEvent(store, `2026-0${index + 1}-02T00:00:00.000Z`, `Correction ${index} concerned a separate topic.`);
      const item = perception.propose({
        tenantId: "test", sourceEventId: source, topicKey: `separate-${index}`,
        statement: `Unrelated rejected interpretation number ${index}.`, rationale: "Fixture interpretation.",
        confidence: 0.4, specificity: 0.8, novelty: 0.8, perceptualValue: 0.8, genericity: 0.1, sensitivity: 0.1, interruptionCost: 0.1,
        alternativeExplanations: ["Another explanation."], evidence: [{ eventId: source, relation: "supports", rationale: "Fixture." }],
      });
      perception.recordFeedback({ tenantId: "test", hypothesisId: item.id, sourceEventId: source, kind: "rejected", note: "Rejected fixture." });
    }
    const prompt = perception.formatForPrompt("test", "What did Orchard teach us about visibility?");
    assert.match(prompt, /Orchard hesitation was caused by fear of visibility/);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("separate generation, counterevidence, criticism, and composition produce an inspectable ready insight", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  const route = { provider: "openai-compatible" as const, model: "test-model", maxOutputTokens: 1_000, reasoningEffort: "none" as const };
  config.models = { foreground: route, deliberation: route, background: route, critic: route };
  const ids: string[] = [];
  let hiddenCounterevidenceId = "";
  let futureCounterevidenceId = "";
  let counterVerificationPrompt = "";
  let relationshipComposerPrompt = "";
  let semanticKnownnessPrompt = "";
  let providerCalls = 0;
  const adapter: ProviderAdapter = {
    name: "openai-compatible",
    complete: async (request) => {
      providerCalls += 1;
      const response = request.system.includes("private inquiry planner")
        ? {
          admit: true,
          question: "Does control over a project's premise explain the member's energy better than external status or collaborator quality?",
          concreteBenefit: "Distinguishing these explanations could change which future projects the member accepts and how they shape them.",
          answerability: "records",
          competingHypotheses: ["Authorship of the premise drives energy.", "Collaborator quality or project size drives energy."],
          falsifiers: ["Find owner evidence where energy remained high despite a borrowed premise or low despite authorship."],
          retrievalPlan: ["Compare temporally separated owner statements and retrieve contrary collaborator evidence."],
          stopCondition: "Stop after one independent counterevidence retrieval and one adversarial review.",
        }
        : request.system.includes("follow-through planner")
        ? {
          disposition: "discard", kind: "none", title: "No warranted follow-through",
          objective: "Preserve the insight without manufacturing a task from a piece of personal reflection.",
          rationale: "The accepted perception adds understanding but creates no justified reversible work by itself.",
          memberDelta: "The perception changes the interpretation of prior choices but does not establish a practical action to take now.",
          content: "", confidence: 0.8, novelty: 0.7, usefulness: 0.6, urgency: 0,
        }
        : request.system.includes("counterevidence research planner")
        ? { strongestAlternative: "Collaborator quality may explain the energy shift.", searchQuery: "collaborator quality", reason: "Different collaborators could explain the energy shift." }
        : request.system.includes("counterevidence verifier")
          ? (() => {
            counterVerificationPrompt = request.messages.flatMap((message) => message.parts)
              .flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
            return { strongestAlternative: "Collaborator quality may explain the energy shift.", contradictingEventIds: [hiddenCounterevidenceId], reason: "The older owner evidence explicitly attributes energy to collaborator quality." };
          })()
        : request.system.includes("semantic knownness verifier")
          ? (() => {
            semanticKnownnessPrompt = request.messages.flatMap((message) => message.parts)
              .flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
            return { relation: "restatement", matchedEventId: ids[2], reason: "The polished wording repeats the owner's existing conclusion about agency and energy." };
          })()
        : request.system.includes("adversarial perception critic")
          ? { accepted: true, reason: "specific and longitudinal", confidence: 0.92, specificity: 0.95, novelty: 0.9, perceptualValue: 0.96, genericity: 0.04, sensitivity: 0.1, interruptionCost: 0.1 }
          : request.system.includes("relationship composer")
            ? (() => {
              relationshipComposerPrompt = request.messages.flatMap((message) => message.parts)
                .flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
              return {
                send: true, surfaceText: "Agency over inception seems more animating than external validation.", memberDelta: 0.92,
                whyNow: "The current trigger revives a live project-selection distinction.",
                bestQuietAlternative: "Retain the pattern until the member next discusses choosing or shaping a project.",
                reason: "The current trigger makes the long-running contrast newly useful.",
              };
            })()
            : { candidates: [{
          topicKey: "authorship-vs-status",
          statement: "Authorship of the premise has predicted energy more consistently than external project status.",
          rationale: "The same distinction appears across three separated decisions.",
          evidence: ids.map((eventId) => ({ eventId, relation: "supports", rationale: "Owner described the tradeoff." })),
          alternativeExplanations: ["Collaborator quality may explain the energy shift."],
          confidence: 0.9, specificity: 0.94, novelty: 0.88, perceptualValue: 0.95, genericity: 0.05, sensitivity: 0.1, interruptionCost: 0.1,
        }] };
      return { text: JSON.stringify(response), toolCalls: [], usage: { inputTokens: 10, outputTokens: 10, reasoningTokens: 0 } };
    },
  };
  const runtime = new CoRuntime({ config, providers: new ProviderRegistry([adapter]) });
  try {
    hiddenCounterevidenceId = ownerEvent(runtime.store, "2026-01-02T18:00:00.000Z", "Collaborator quality on Atlas determined whether it felt alive.");
    ownerEvent(runtime.store, "2026-01-20T18:00:00.000Z", "A later January note about an unrelated trip.");
    ownerEvent(runtime.store, "2026-01-25T18:00:00.000Z", "Another later January note about an unrelated book.");
    ids.push(
      ownerEvent(runtime.store, "2026-03-04T18:00:00.000Z", "I rejected the prestigious project because its premise felt borrowed."),
      ownerEvent(runtime.store, "2026-05-12T18:00:00.000Z", "I chose the smaller project where I controlled the taste."),
      ownerEvent(runtime.store, "2026-07-19T18:00:00.000Z", "My energy returned after I rewrote the premise in my own words."),
    );
    futureCounterevidenceId = ownerEvent(runtime.store, "2027-01-02T18:00:00.000Z", "Collaborator quality later became decisive again.");
    const session = runtime.store.ensureSession("test", "cli", "p");
    runtime.store.addMessage("test", session.id, {
      id: "current_relationship_trigger",
      role: "user",
      parts: [{ type: "text", text: "My energy returned after I rewrote the premise in my own words." }],
      createdAt: "2026-07-19T18:00:00.000Z",
    }, ids[2]);
    runtime.store.enqueueJob("test", "perception.synthesize", {
      sourceEventId: ids[2] as string, sessionId: session.id, channel: "cli", peerId: "p",
    });
    assert.equal(await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce(), true);
    const insights = runtime.perception.list("test", { status: "ready" });
    assert.equal(insights.length, 1);
    assert.equal(runtime.perception.evidence("test", insights[0]?.id as string)
      .some((item) => item.eventId === hiddenCounterevidenceId && item.relation === "contradicts"), true,
    "the counterevidence pass must be able to attach evidence absent from the generator's initial bundle");
    assert.equal(runtime.perception.evidence("test", insights[0]?.id as string)
      .some((item) => item.eventId === futureCounterevidenceId), false,
    "counterevidence retrieval must not leak evidence dated after the trigger checkpoint");
    assert.doesNotMatch(counterVerificationPrompt, new RegExp(futureCounterevidenceId),
      "future evidence must not enter the counterevidence verifier prompt");
    const synthesis = runtime.store.listEvents("test", { type: "perception.synthesis_completed" })[0];
    const synthesisPayload = synthesis?.payload as { counterevidenceRetrieved?: number } | undefined;
    assert.equal(synthesisPayload?.counterevidenceRetrieved, 1);
    const inquiry = runtime.inquiries.forSource("test", ids[2] as string);
    assert.equal(inquiry?.status, "resolved");
    assert.equal(inquiry?.foregroundDisposition, "suppressed", "known output must lose to the quiet alternative");
    assert.equal(runtime.inquiries.foregroundDecisions("test", inquiry?.id as string).length, 1);
    const intervention = runtime.store.db.prepare("SELECT decision,hypothesis_id FROM interventions WHERE tenant_id='test'").get() as { decision: string; hypothesis_id: string };
    assert.equal(intervention.decision, "silence", "a semantic paraphrase of owner evidence must not become an interruption");
    assert.equal(intervention.hypothesis_id, insights[0]?.id);
    assert.match(relationshipComposerPrompt, /CURRENT RELATIONSHIP CONTEXT/);
    assert.match(relationshipComposerPrompt, /My energy returned after I rewrote the premise in my own words\./);
    assert.match(semanticKnownnessPrompt, /semantic comparison/i);
    assert.match(semanticKnownnessPrompt, new RegExp(ids[0] as string));
    const semanticChecks = runtime.store.listEvents("test", { type: "perception.semantic_knownness_checked" });
    assert.equal(semanticChecks.length, 1);
    assert.equal((semanticChecks[0]!.payload as { status?: string }).status, "known");
    assert.equal(providerCalls, 7);
    const withinCooldown = ownerEvent(runtime.store, "2026-08-20T18:00:00.000Z", "A new but nearby conversation detail should be observed without another immediate synthesis pass.");
    runtime.store.enqueueJob("test", "perception.synthesize", { sourceEventId: withinCooldown, sessionId: session.id, channel: "cli", peerId: "p" });
    assert.equal(await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce(), true);
    assert.equal(providerCalls, 8, "the previously accepted insight receives one separate no-tools consequence pass");
    assert.equal(runtime.consequences.list("test")[0]?.status, "discarded");
    assert.equal(await new RuntimeWorker(runtime, { videoAnalyzer: null }).runOnce(), true);
    assert.equal(providerCalls, 8);
    assert.equal(runtime.store.listEvents("test", { type: "perception.synthesis_deferred" }).length, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("HTTP exposes insight provenance and records explicit correction", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  const server = createRuntimeServer(runtime);
  try {
    const first = ownerEvent(runtime.store, "2026-03-04T18:00:00.000Z", "I rejected the prestigious but borrowed premise.");
    const second = ownerEvent(runtime.store, "2026-05-12T18:00:00.000Z", "I chose the project whose taste I controlled.");
    const third = ownerEvent(runtime.store, "2026-07-19T18:00:00.000Z", "Rewriting the premise restored my energy.");
    const insight = runtime.perception.propose({
      tenantId: "test", sourceEventId: third, topicKey: "authorship-vs-status",
      statement: "Self-authored premises appear to predict energy better than external status.", rationale: "Repeated across three dated choices.",
      confidence: 0.9, specificity: 0.9, novelty: 0.8, perceptualValue: 0.9, genericity: 0.1, sensitivity: 0.1, interruptionCost: 0.2,
      alternativeExplanations: ["Collaborators may be the underlying cause."],
      evidence: [first, second, third].map((eventId) => ({ eventId, relation: "supports" as const, rationale: "Owner evidence." })),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const listed = await fetch(`${base}/v1/insights?status=ready`);
    assert.equal(listed.status, 200);
    assert.equal((await listed.json() as unknown[]).length, 1);
    const detail = await fetch(`${base}/v1/insights/${insight.id}`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json() as { evidence: unknown[] }).evidence.length >= 3, true);
    const corrected = await fetch(`${base}/v1/insights/${insight.id}/feedback`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "corrected", note: "It was collaborator quality." }),
    });
    assert.equal(corrected.status, 200);
    assert.equal((await corrected.json() as { status: string }).status, "rejected");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    home.cleanup();
  }
});
