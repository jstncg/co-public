import assert from "node:assert/strict";
import test from "node:test";
import { CoRuntime } from "../src/runtime.ts";
import { testConfig, testHome } from "./helpers.ts";

function ownerEvidence(runtime: CoRuntime, at: string, text: string): string {
  const event = runtime.store.appendEvent({ tenantId: "test", stream: "conversation", type: "message.received", at, payload: { text } });
  runtime.store.indexEvidence({ tenantId: "test", sourceEventId: event.id, kind: "conversation.user", trustClass: "owner", content: text, observedAt: at });
  runtime.personalModel.recordThought("test", event.id);
  return event.id;
}

test("owner messages become evidence-backed thoughts without turning shared sources into endorsements", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const turn = await runtime.turn({ tenantId: "test", channel: "imessage", peerId: "member", text: "This source keeps pulling me back to the same design question." });
    const sourceEvent = runtime.store.listEvents("test", { stream: `session:${turn.sessionId}`, type: "message.received" })[0];
    assert.ok(sourceEvent);
    assert.equal(runtime.personalModel.nodes("test", "thought").length, 1);

    const artifactEvent = runtime.store.appendEvent({
      tenantId: "test", stream: "artifact:test", type: "artifact.enriched", causationId: sourceEvent.id,
      payload: { url: "https://example.com/essay?utm_source=test", title: "A useful essay" },
    });
    const source = runtime.personalModel.recordSource({
      tenantId: "test", sourceEventId: sourceEvent.id, artifactEventId: artifactEvent.id,
      url: "https://example.com/essay?utm_source=test", title: "A useful essay", author: "A. Researcher",
    });
    const afterShare = runtime.personalModel.sourceAffinities("test")[0];
    assert.equal(afterShare?.source.id, source.id);
    assert.equal(afterShare?.score, 0, "sharing is attention, not endorsement");
    assert.equal(runtime.personalModel.formatForPrompt("test"), "", "one neutral share cannot become a source prior");

    const secondShare = ownerEvidence(runtime, "2026-05-01T12:00:00.000Z", "Another piece from the same researcher is relevant here.");
    const secondArtifact = runtime.store.appendEvent({
      tenantId: "test", stream: "artifact:test-2", type: "artifact.enriched", causationId: secondShare,
      payload: { url: "https://example.com/another-essay", title: "Another useful essay" },
    });
    runtime.personalModel.recordSource({
      tenantId: "test", sourceEventId: secondShare, artifactEventId: secondArtifact.id,
      url: "https://example.com/another-essay", title: "Another useful essay", author: "A. Researcher",
    });
    assert.equal(runtime.personalModel.nodes("test", "source").length, 1, "articles aggregate to the known author rather than fragmenting by URL");

    const conflictingMetadata = ownerEvidence(runtime, "2026-06-01T12:00:00.000Z", "The same URL arrived with conflicting metadata.");
    const stableSource = runtime.personalModel.recordSource({
      tenantId: "test", sourceEventId: conflictingMetadata,
      url: "https://example.com/essay", author: "Incorrect Later Attribution",
    });
    assert.equal(stableSource.id, source.id, "a URL alias cannot silently move accumulated affinity to another source");
    assert.equal(runtime.personalModel.nodes("test", "source").length, 1);

    const endorsed = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member",
      text: '[[tool:source.affinity.record {"source":"https://example.com/essay","kind":"endorsed"}]]',
    });
    const receipt = runtime.store.db.prepare("SELECT tool_name,status FROM tool_receipts WHERE tenant_id=? AND run_id=?")
      .get("test", endorsed.runId) as { tool_name: string; status: string };
    assert.equal(receipt.tool_name, "source.affinity.record");
    assert.equal(receipt.status, "succeeded");
    const beforeCombinedSignal = runtime.personalModel.sourceAffinities("test")[0];
    const combinedSignalEvent = ownerEvidence(runtime, "2026-06-15T12:00:00.000Z", "I endorsed this source and used it in the same decision.");
    runtime.personalModel.recordSourceSignal("test", "https://example.com/essay", combinedSignalEvent, "endorsed");
    runtime.personalModel.recordSourceSignal("test", "https://example.com/essay", combinedSignalEvent, "acted");
    const afterCombinedSignal = runtime.personalModel.sourceAffinities("test")[0];
    assert.equal(afterCombinedSignal?.signalCount, (beforeCombinedSignal?.signalCount ?? 0) + 1,
      "two labels attached to one real event contribute one bounded affinity vote");
    assert.equal((runtime.store.db.prepare("SELECT COUNT(*) AS count FROM source_affinity_signals WHERE tenant_id=? AND source_event_id=?")
      .get("test", combinedSignalEvent) as { count: number }).count, 2, "the raw labels remain inspectable");
    const revisited = ownerEvidence(runtime, "2026-07-01T12:00:00.000Z", "I went back to that essay while revising the system.");
    runtime.personalModel.recordSourceSignal("test", "https://example.com/another-essay", revisited, "revisited");
    const learned = runtime.personalModel.sourceAffinities("test")[0];
    assert.equal(learned?.positiveCount, 3);
    assert.equal(learned?.signalCount, 6);
    assert.match(runtime.personalModel.formatForPrompt("test"), /A\. Researcher/);
    assert.equal(runtime.store.listEvents("test", { type: "source.affinity_recorded" }).length, 7, "raw affinity evidence is retained even when its projection is deduplicated");

    const beforeRebuildEvents = runtime.store.listEvents("test", { limit: 1_000 }).length;
    const report = runtime.personalModel.rebuild("test", runtime.perception);
    assert.equal(report.sources, 3);
    assert.equal(runtime.personalModel.nodes("test", "source").length, 1);
    assert.equal(runtime.personalModel.sourceAffinities("test")[0]?.positiveCount, 3);
    assert.equal(runtime.personalModel.sourceAffinities("test")[0]?.signalCount, 6);
    assert.equal(runtime.store.listEvents("test", { limit: 1_000 }).length, beforeRebuildEvents, "rebuilding a projection does not rewrite the event ledger");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("latent theses connect dated thoughts to concepts and preserve rejected history", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const march = ownerEvidence(runtime, "2026-03-04T18:00:00.000Z", "I rejected the prestigious project because its premise felt borrowed.");
    const may = ownerEvidence(runtime, "2026-05-12T18:00:00.000Z", "The smaller project became energizing once I controlled its taste.");
    const july = ownerEvidence(runtime, "2026-07-19T18:00:00.000Z", "My energy returned after I rewrote the premise in my own words.");
    const hypothesis = runtime.perception.propose({
      tenantId: "test", sourceEventId: july, topicKey: "authorship-vs-status",
      statement: "Authorship of the premise appears to predict energy better than external project status.",
      rationale: "Three separated choices show the same tradeoff.", confidence: 0.9, specificity: 0.9,
      novelty: 0.85, perceptualValue: 0.9, genericity: 0.1, sensitivity: 0.1, interruptionCost: 0.2,
      alternativeExplanations: ["Collaborator quality may explain the energy shift."],
      evidence: [march, may, july].map((eventId) => ({ eventId, relation: "supports" as const, rationale: "Owner evidence." })),
    });
    const thesis = runtime.personalModel.recordLatentThesis(hypothesis, runtime.perception.evidence("test", hypothesis.id));
    assert.equal(thesis.kind, "latent_thesis");
    assert.equal(runtime.personalModel.nodes("test", "concept").length, 1);
    assert.equal(runtime.personalModel.nodes("test", "thought").length, 3);
    assert.equal(runtime.personalModel.edges("test").filter((edge) => edge.toNodeId === thesis.id && edge.relation === "supports").length, 3);

    const correction = ownerEvidence(runtime, "2026-08-01T18:00:00.000Z", "The collaborators were the actual difference.");
    const rejected = runtime.perception.recordFeedback({
      tenantId: "test", hypothesisId: hypothesis.id, sourceEventId: correction, kind: "corrected", note: "Collaborator quality, not authorship.",
    });
    runtime.personalModel.updateLatentThesisStatus("test", hypothesis.id, rejected.status, rejected.confidence);
    assert.equal(runtime.personalModel.nodes("test", "latent_thesis")[0]?.status, "rejected");
    assert.equal(runtime.personalModel.edges("test").length >= 4, true, "correction does not erase the reasoning graph");
    assert.ok(runtime.store.getEvent("test", march));
    assert.ok(runtime.store.getEvent("test", correction));

    const beforeRebuildEvents = runtime.store.listEvents("test", { limit: 1_000 }).length;
    const report = runtime.personalModel.rebuild("test", runtime.perception);
    assert.equal(report.latentTheses, 1);
    assert.equal(runtime.personalModel.nodes("test", "latent_thesis")[0]?.status, "rejected");
    assert.equal(runtime.personalModel.edges("test").filter((edge) => edge.toNodeId === thesis.id && edge.relation === "supports").length, 3);
    assert.equal(runtime.store.listEvents("test", { limit: 1_000 }).length, beforeRebuildEvents);
  } finally {
    runtime.close();
    home.cleanup();
  }
});
