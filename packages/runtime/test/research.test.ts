import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ProviderRegistry } from "../src/providers.ts";
import { CoRuntime } from "../src/runtime.ts";
import { successfulToolResult } from "../src/tools.ts";
import type { JsonObject, ProviderAdapter, ProviderRequest, ProviderResponse, ToolCallPart, ToolResultPart } from "../src/types.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { testConfig, testHome } from "./helpers.ts";

function response(toolCalls: ToolCallPart[] = [], text = ""): ProviderResponse {
  return { text, toolCalls: toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })), usage: { inputTokens: 10, outputTokens: 10, reasoningTokens: 0 } };
}

function toolResults(request: ProviderRequest): ToolResultPart[] {
  return request.messages.flatMap((message) => message.parts.filter((part): part is ToolResultPart => part.type === "tool_result"));
}

function researchOutput(input: {
  url: string;
  title: string;
  publisher: string;
  creator?: string;
  publishedAt?: string;
  sourceClass: "official" | "secondary";
  coverage?: "fulltext" | "metadata";
  content?: string;
  truncated?: boolean;
}): JsonObject {
  const content = input.content ?? `Complete inspected source content for ${input.url}; this contains enough body text to substantiate the recorded coverage.`;
  return {
    url: input.url, content, ...(input.truncated ? { truncated: true } : {}),
    _coResearchEvidence: {
      version: 1, url: input.url, title: input.title, publisher: input.publisher,
      ...(input.creator ? { creator: input.creator } : {}), ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
      sourceClass: input.sourceClass, coverage: input.coverage ?? "fulltext", complete: true,
      contentSha256: createHash("sha256").update(content).digest("hex"),
    },
  };
}

function scoutProvider(): ProviderAdapter {
  return {
    name: "mock",
    complete: async (request) => {
      const userText = request.messages.findLast((message) => message.role === "user")?.parts
        .filter((part) => part.type === "text").map((part) => part.text).join("\n") ?? "";
      if (!userText.includes("WORLD SCOUT COMMISSION")) {
        if (toolResults(request).some((result) => result.name === "research.commission")) {
          return response([], "I started the research and will return with the evidence-backed result.");
        }
        return response([{
          type: "tool_call", id: "commission", name: "research.commission",
          arguments: {
            kind: "framework", objective: "Find a rigorous framework for deciding when a personal agent should interrupt rather than hold a discovery.",
            whyNow: "The current product decision depends on a defensible attention policy.", minimumIndependentSources: 2, requiredPrimarySources: 1,
          },
        }]);
      }
      const commissionId = userText.match(/WORLD SCOUT COMMISSION (rco_[^\s]+)/)?.[1];
      if (!commissionId) throw new Error("Fixture could not find commission id");
      const results = toolResults(request);
      const has = (name: string, callId: string) => results.some((result) => result.name === name && result.toolCallId === callId);
      const sourceResults = results.filter((result) => result.name === "research.source.record");
      if (!has("world.fetch", "fetch-primary")) {
        return response([{ type: "tool_call", id: "fetch-primary", name: "world.fetch", arguments: { url: "https://official.example/attention-standard" } }]);
      }
      if (sourceResults.length === 0) {
        return response([{
          type: "tool_call", id: "record-primary", name: "research.source.record",
          arguments: {
            commissionId, retrievalToolCallId: "fetch-primary", url: "https://official.example/attention-standard",
            title: "Attention Allocation Standard", publisher: "Official Standards Body", creator: "Standards Working Group",
            sourceClass: "official", coverage: "fulltext",
            claim: "The primary standard requires expected decision value to exceed interruption and switching costs.",
            qualityBasis: "This is the standards body's own normative publication and the complete text was retrieved.",
            limitations: "The standard describes institutional alerts rather than personal agents.",
          },
        }]);
      }
      if (!has("world.fetch", "fetch-independent")) {
        return response([{ type: "tool_call", id: "fetch-independent", name: "world.fetch", arguments: { url: "https://analysis.example/contextual-interruptions" } }]);
      }
      if (sourceResults.length === 1) {
        return response([{
          type: "tool_call", id: "record-independent", name: "research.source.record",
          arguments: {
            commissionId, retrievalToolCallId: "fetch-independent", url: "https://analysis.example/contextual-interruptions",
            title: "Contextual Interruptions in Practice", publisher: "Independent Analysis", creator: "R. Analyst",
            sourceClass: "secondary", coverage: "fulltext",
            claim: "Observed systems perform better when low-urgency discoveries are held until a related decision moment.",
            qualityBasis: "This independent analysis reports its examples and method and is separate from the standard setter.",
            limitations: "The examples are observational and do not isolate every confounding variable.",
          },
        }]);
      }
      if (!results.some((result) => result.name === "research.finding.record")) {
        const sourceIds = sourceResults.map((result) => (result.output as JsonObject).id).filter((value): value is string => typeof value === "string");
        return response([{
          type: "tool_call", id: "record-finding", name: "research.finding.record",
          arguments: {
            commissionId, kind: "framework", title: "Expected decision value, paid in interruption cost",
            summary: "Treat every proactive discovery as an option whose expected effect on a real decision must exceed the attention and switching cost it imposes.",
            mapping: "For Co, urgency and usefulness are insufficient alone: the candidate should connect to a current choice, and otherwise move into held context for that choice.",
            limitations: "Neither source validates a universal numeric threshold for a private personal agent, so calibration still requires member outcomes.",
            changedImplication: "The attention gate should optimize timing against a decision point instead of merely ranking interesting information.",
            counterevidence: "Some rare opportunities decay before a related decision becomes visible, so high option-expiry risk must remain an override.",
            sourceReceiptIds: sourceIds, confidence: 0.82,
          },
        }]);
      }
      return response([], "Recorded the framework with two independently published full-source receipts and one primary source.");
    },
  };
}

function ownerEvent(runtime: CoRuntime, text: string): string {
  const event = runtime.store.appendEvent({ tenantId: "test", stream: "conversation", type: "message.received", payload: { text } });
  runtime.store.indexEvidence({ tenantId: "test", sourceEventId: event.id, kind: "conversation.user", trustClass: "owner", content: text });
  runtime.personalModel.recordThought("test", event.id);
  return event.id;
}

test("WorldScout completes only from independent full sources bound to real read receipts", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path), providers: new ProviderRegistry([scoutProvider()]) });
  runtime.tools.register({
    definition: {
      name: "world.fetch", description: "Fetch a public web source for WorldScout.",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
      risk: "read", tags: ["world-research", "web", "fetch"], idempotent: true,
    },
    execute: async (_context, arguments_) => {
      const url = String(arguments_.url);
      return url.includes("official.example")
        ? researchOutput({ url, title: "Attention Allocation Standard", publisher: "Official Standards Body", creator: "Standards Working Group", sourceClass: "official" })
        : researchOutput({ url, title: "Contextual Interruptions in Practice", publisher: "Independent Analysis", creator: "R. Analyst", sourceClass: "secondary" });
    },
    evaluateResult: successfulToolResult,
  });
  try {
    const foreground = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "+15555550100",
      text: "Research a framework I would respect for deciding when Co should interrupt me.",
    });
    assert.equal(foreground.status, "completed");
    const commission = runtime.research.list("test")[0];
    assert.ok(commission?.workOrderId);
    assert.equal(commission?.status, "running");

    await new RuntimeWorker(runtime, { videoAnalyzer: null }).drain(20);
    const completed = runtime.research.get("test", commission.id);
    assert.equal(completed?.status, "completed");
    const sources = runtime.research.sources("test", commission.id);
    assert.equal(sources.length, 2);
    assert.equal(new Set(sources.map((source) => source.domain)).size, 2);
    assert.equal(sources.filter((source) => source.sourceClass === "official").length, 1);
    assert.ok(sources.every((source) => source.coverage === "fulltext"));
    assert.ok(sources.every((source) => source.retrievalToolName === "world.fetch"));
    const finding = runtime.research.findings("test", commission.id)[0];
    assert.equal(finding?.kind, "framework");
    assert.equal(finding?.sourceReceiptIds.length, 2);
    assert.match(finding?.mapping ?? "", /For Co/);
    assert.match(finding?.changedImplication ?? "", /decision point/);
    assert.equal(runtime.workOrders.get("test", commission.workOrderId as string)?.evidenceIds.length, 5, "retrieval and required outcome receipts remain inspectable");

    const workRun = runtime.workOrders.get("test", commission.workOrderId as string)?.runId;
    assert.ok(workRun);
    assert.throws(() => runtime.research.recordSource({
      tenantId: "test", commissionId: commission.id, runId: workRun as string, retrievalToolCallId: "fetch-primary",
      url: "https://forged.example/not-in-receipt", title: "Forged source", publisher: "Nobody",
      sourceClass: "official", coverage: "fulltext", claim: "This fabricated claim is long enough to pass only the text-length gate.",
      qualityBasis: "This should fail because provenance matters more than the supplied quality description.",
      limitations: "It has no receipt provenance.",
    }), /not present in the bound retrieval output/);

    for (const source of sources) {
      const shared = ownerEvent(runtime, `I keep returning to ${source.url}`);
      runtime.personalModel.recordSource({ tenantId: "test", sourceEventId: shared, url: source.url });
      runtime.personalModel.recordSourceSignal("test", source.url, ownerEvent(runtime, `I endorse ${source.domain}`), "endorsed");
      runtime.personalModel.recordSourceSignal("test", source.url, ownerEvent(runtime, `I acted on ${source.domain}`), "acted");
    }
    assert.throws(() => runtime.research.recordFinding({
      tenantId: "test", commissionId: commission.id, runId: workRun as string, kind: "framework", title: "Affinity-only synthesis",
      summary: "This otherwise complete finding deliberately uses only sources already inside the learned positive affinity set.",
      mapping: "The mapping is sufficiently detailed but it should still fail because source familiarity cannot become a closed boundary.",
      limitations: "The evidence set contains no source outside the established affinity set.",
      changedImplication: "A valid result would need to seek one genuinely independent perspective.",
      counterevidence: "The familiar sources may still be correct, but agreement alone is not independent corroboration.",
      sourceReceiptIds: sources.map((source) => source.id), confidence: 0.8,
    }), /outside the learned positive-affinity set/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("WorldScout fails honestly when no external research tool is configured", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const result = await runtime.turn({
      tenantId: "test", channel: "cli", peerId: "local",
      text: '[[tool:research.commission {"kind":"framework","objective":"Find an externally grounded decision framework."}]]',
    });
    assert.equal(result.status, "completed");
    const receipt = runtime.store.db.prepare("SELECT status,error FROM tool_receipts WHERE tenant_id=? AND run_id=?")
      .get("test", result.runId) as { status: string; error: string };
    assert.equal(receipt.status, "failed");
    assert.match(receipt.error, /configured read-only web\/search\/browser tool/);
    assert.equal(runtime.research.list("test").length, 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("research findings reject same-publisher padding, shallow coverage, missing primary evidence, and truncated retrievals", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const session = runtime.store.ensureSession("test", "internal", "research-adversarial");
    const sourceEvent = ownerEvent(runtime, "Find a framework, but do not let several links from one publisher masquerade as corroboration.");
    const commission = runtime.research.createCommission({
      tenantId: "test", sourceEventId: sourceEvent, sessionId: session.id, kind: "framework",
      objective: "Find a rigorously sourced framework for interruption decisions.", whyNow: "The release depends on the decision rule.",
      retrievalToolNames: ["world.fetch"], minimumIndependentSources: 2, requiredPrimarySources: 2,
      idempotencyKey: "adversarial-research",
    });
    const admission = runtime.workOrders.submit({
      tenantId: "test", objective: "fixture", allowedTools: ["world.fetch", "research.source.record", "research.finding.record"],
      requiredToolNames: ["research.source.record", "research.finding.record"], minimumReceipts: 3,
    });
    runtime.research.bindWorkOrder("test", commission.id, admission.workOrder.id);
    const createdAt = new Date().toISOString();
    runtime.store.createRun({
      id: "run_research_adversarial", tenantId: "test", sessionId: session.id, kind: "background", status: "running",
      modelRole: "deliberation", input: "fixture",
      state: {
        system: "fixture", messages: [], authorityToolNames: ["world.fetch"], toolNames: ["world.fetch"],
        modelRoute: { provider: "mock", model: "mock-1", maxOutputTokens: 128, reasoningEffort: "none" },
        iteration: 0, pendingCalls: [], nextToolIndex: 0, depth: 0, tokenBudget: 1_000,
      },
      inputTokens: 0, outputTokens: 0, createdAt, updatedAt: createdAt,
    });
    runtime.workOrders.bindRun("test", admission.workOrder.id, "run_research_adversarial");
    const lease = runtime.store.acquireRunLease("test", "run_research_adversarial");
    assert.ok(lease);

    const fetched = (toolCallId: string, url: string, output?: JsonObject): string => {
      const defaultClass = toolCallId === "secondary" ? "secondary" : "official";
      const defaultCoverage = toolCallId === "shallow" ? "metadata" : "fulltext";
      const resolvedOutput = output ?? researchOutput({
        url, title: `Source ${toolCallId}`, publisher: new URL(url).hostname,
        sourceClass: defaultClass, coverage: defaultCoverage,
      });
      const claim = runtime.store.claimReceipt({
        tenantId: "test", runId: "run_research_adversarial", runLeaseToken: lease,
        toolCallId, toolName: "world.fetch", arguments: { url }, risk: "read", idempotencyKey: `fetch:${toolCallId}`,
      });
      assert.equal(claim.claimed, true);
      assert.equal(runtime.store.beginReceiptEffect(claim.receipt.id, lease), true);
      assert.equal(runtime.store.finishReceipt({ receiptId: claim.receipt.id, leaseToken: lease, status: "succeeded", evidenceScope: "outcome", output: resolvedOutput }), true);
      return toolCallId;
    };
    const recorded = (toolCallId: string, url: string, sourceClass: "official" | "secondary", observedCoverage: "fulltext" | "metadata") => runtime.research.recordSource({
      tenantId: "test", commissionId: commission.id, runId: "run_research_adversarial", retrievalToolCallId: toolCallId,
      url, title: `Source ${toolCallId}`, publisher: new URL(url).hostname, sourceClass, coverage: observedCoverage,
      claim: `This source supports a concrete claim for the ${toolCallId} adversarial fixture.`,
      qualityBasis: "The fixture binds this classification to a successful read receipt with inspectable content.",
      limitations: "This source covers only its own published evidence.",
    });

    const first = recorded(fetched("same-one", "https://same.example/one"), "https://same.example/one", "official", "fulltext");
    const secondSame = recorded(fetched("same-two", "https://same.example/two"), "https://same.example/two", "official", "fulltext");
    const findingInput = {
      tenantId: "test", commissionId: commission.id, runId: "run_research_adversarial", kind: "framework" as const,
      title: "Adversarial evidence fixture", summary: "A sufficiently detailed summary that cannot compensate for missing evidence quality or independence.",
      mapping: "A sufficiently detailed mapping explains how the proposed framework changes the current product decision.",
      limitations: "The framework may not generalize outside the stated context.",
      changedImplication: "The implementation should change only if its evidence contract passes.",
      counterevidence: "A competing explanation remains plausible and must stay visible.", confidence: 0.8,
    };
    assert.throws(() => runtime.research.recordFinding({ ...findingInput, sourceReceiptIds: [first.id, secondSame.id] }), /independently published/);

    const shallow = recorded(fetched("shallow", "https://shallow.example/result"), "https://shallow.example/result", "official", "metadata");
    assert.throws(() => runtime.research.recordFinding({ ...findingInput, sourceReceiptIds: [first.id, shallow.id] }), /metadata cannot substantiate/);

    const secondary = recorded(fetched("secondary", "https://secondary.example/analysis"), "https://secondary.example/analysis", "secondary", "fulltext");
    assert.throws(() => runtime.research.recordFinding({ ...findingInput, sourceReceiptIds: [first.id, secondary.id] }), /primary-source receipts/);

    fetched("truncated", "https://truncated.example/paper", researchOutput({
      url: "https://truncated.example/paper", title: "Source truncated", publisher: "truncated.example",
      sourceClass: "official", truncated: true,
    }));
    assert.throws(() => recorded("truncated", "https://truncated.example/paper", "official", "fulltext"), /truncated retrieval/);

    const unboundUrl = "https://self-attested.example/paper";
    fetched("self-attested", unboundUrl, { url: unboundUrl, content: "A long body that the model attempts to label as complete without a trusted adapter provenance envelope." });
    assert.throws(
      () => recorded("self-attested", unboundUrl, "official", "fulltext"),
      /adapter evidence envelope/,
      "model-supplied coverage and source class cannot substitute for retrieval provenance",
    );

    const mismatchedUrl = "https://mismatched.example/paper";
    const forged = researchOutput({
      url: mismatchedUrl, title: "Different adapter title", publisher: "mismatched.example", sourceClass: "secondary",
    });
    fetched("mismatched", mismatchedUrl, forged);
    assert.throws(
      () => recorded("mismatched", mismatchedUrl, "official", "fulltext"),
      /does not match the retrieval adapter/,
      "the model cannot promote an adapter-attested secondary source to primary",
    );
  } finally {
    runtime.close();
    home.cleanup();
  }
});
