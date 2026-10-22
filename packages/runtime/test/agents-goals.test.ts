import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorAdapter } from "../src/connectors.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { CoRuntime } from "../src/runtime.ts";
import { RuntimeWorker } from "../src/worker.ts";
import type { ProviderAdapter, ProviderRequest } from "../src/types.ts";
import { testConfig, testHome } from "./helpers.ts";

function appendOwnerEvidence(runtime: CoRuntime, text: string, at: string, peerId = "motive-fixture"): string {
  const session = runtime.store.ensureSession("test", "imessage", peerId);
  const event = runtime.store.appendEvent({
    tenantId: "test", stream: `session:${session.id}`, type: "message.received", at, payload: { text },
  });
  runtime.store.addMessage("test", session.id, {
    id: `msg_${event.id}`, role: "user", parts: [{ type: "text", text }], phase: "final", createdAt: at,
  }, event.id);
  runtime.store.indexEvidence({
    tenantId: "test", sourceEventId: event.id, kind: "conversation.user", trustClass: "owner",
    content: text, observedAt: at, metadata: { sessionId: session.id },
  });
  return event.id;
}

test("retained agents accept work immediately, preserve one session across follow-ups, and survive restart", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  let runtime = new CoRuntime({ config });
  try {
    const parent = await runtime.turn({
      tenantId: "test", channel: "cli", peerId: "owner",
      text: '[[tool:delegate_task {"name":"researcher","objective":"inspect the premise","deliverable":"one verified finding"}]]',
    });
    const admitted = runtime.agents.list("test")[0];
    assert.ok(admitted);
    assert.equal(admitted.status, "queued");
    assert.equal(admitted.admittedByRunId, parent.runId);

    await new RuntimeWorker(runtime).drain(10);
    const first = runtime.agents.get("test", admitted.id);
    assert.equal(first?.status, "idle");
    assert.ok(first?.lastRunId);
    const firstRun = runtime.store.getRun(first?.lastRunId ?? "", "test");
    assert.equal(firstRun?.sessionId, admitted.sessionId);
    const agentStarted = runtime.store.listEvents("test", { stream: `run:${firstRun?.id}` }).find((event) => event.type === "run.started");
    const agentInstruction = agentStarted?.causationId ? runtime.store.getEvent("test", agentStarted.causationId) : undefined;
    assert.equal(agentInstruction?.type, "agent.instruction_received");
    assert.equal(runtime.store.db.prepare("SELECT trust_class FROM evidence WHERE tenant_id=? AND source_event_id=?")
      .get("test", agentInstruction?.id)?.trust_class, "agent", "retained-agent instructions cannot become owner evidence");

    const queued = runtime.agents.sendFromOwner({ tenantId: "test", targetAgentId: admitted.id, content: "Check one counterexample too.", kind: "follow_up" });
    assert.equal(queued.message.status, "queued");
    assert.equal(runtime.agents.get("test", admitted.id)?.status, "queued");
    await new RuntimeWorker(runtime).drain(10);
    const second = runtime.agents.get("test", admitted.id);
    assert.notEqual(second?.lastRunId, first?.lastRunId);
    assert.equal(runtime.store.getRun(second?.lastRunId ?? "", "test")?.sessionId, admitted.sessionId);
    assert.equal(runtime.agents.messages("test", admitted.id).filter((message) => message.kind === "result").length, 2);

    runtime.close();
    runtime = new CoRuntime({ config });
    assert.equal(runtime.agents.get("test", admitted.id)?.status, "idle");
    assert.equal(runtime.agents.messages("test", admitted.id).filter((message) => message.kind === "result").length, 2);

    const retired = runtime.agents.retire("test", admitted.id);
    assert.equal(retired.status, "retired");
    assert.equal(runtime.agents.messages("test", admitted.id).length >= 4, true);
    assert.throws(() => runtime.agents.sendFromOwner({ tenantId: "test", targetAgentId: admitted.id, content: "more" }), /retired/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("deterministic goal gates cache unchanged failures and complete only from external evidence", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const goal = runtime.goals.create({
      tenantId: "test", objective: "Observe a verified export", successContract: "An export.completed event exists",
      gateType: "event", gateConfig: { eventType: "export.completed", minimumCount: 1 }, maxContinuations: 0,
    });
    const failed = runtime.goals.check("test", goal.id);
    assert.equal(failed.passed, false);
    assert.equal(failed.cached, false);
    const repeated = runtime.goals.check("test", goal.id);
    assert.equal(repeated.passed, false);
    assert.equal(repeated.cached, true);
    assert.equal(runtime.goals.results("test", goal.id).length, 1);

    const evidence = runtime.store.appendEvent({ tenantId: "test", stream: "export", type: "export.completed", payload: { receipt: "verified" } });
    const passed = runtime.goals.check("test", goal.id);
    assert.equal(passed.passed, true);
    assert.deepEqual(passed.evidenceIds, [evidence.id]);
    assert.equal(runtime.goals.get("test", goal.id)?.status, "completed");
    assert.throws(() => runtime.goals.check("test", goal.id), /completed/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("failed changed-state gates continue an assigned agent within fixed budgets but unchanged state stops the loop", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const parent = await runtime.turn({
      tenantId: "test", channel: "cli", peerId: "owner",
      text: '[[tool:delegate_task {"objective":"prepare an export","deliverable":"verified export receipt"}]]',
    });
    const agent = runtime.agents.list("test")[0];
    assert.ok(agent);
    await new RuntimeWorker(runtime).drain(10);

    const goal = runtime.goals.create({
      tenantId: "test", objective: "Finish the export", successContract: "An export.completed event exists",
      gateType: "event", gateConfig: { eventType: "export.completed" }, agentId: agent.id,
      createdByRunId: parent.runId, maxContinuations: 3, maxTokens: 100_000,
    });
    const first = runtime.goals.check("test", goal.id);
    assert.equal(first.continuationQueued, true);
    assert.equal(runtime.goals.get("test", goal.id)?.continuationCount, 1);
    const cached = runtime.goals.check("test", goal.id);
    assert.equal(cached.cached, true);
    assert.equal(cached.continuationQueued, false);
    assert.equal(runtime.goals.get("test", goal.id)?.continuationCount, 1);

    await new RuntimeWorker(runtime).drain(20);
    assert.equal(runtime.goals.get("test", goal.id)?.continuationCount, 1);
    assert.equal(runtime.agents.messages("test", agent.id).filter((message) => message.kind === "follow_up").length, 1);

    runtime.store.appendEvent({ tenantId: "test", stream: "export", type: "export.completed", payload: { receipt: "real" } });
    runtime.goals.enqueueCheck("test", goal.id, "new export evidence");
    await new RuntimeWorker(runtime).drain(10);
    assert.equal(runtime.goals.get("test", goal.id)?.status, "completed");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("conversation-created goals require the owner's exact words and remain revocable through the same relationship", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const historical = runtime.store.appendEvent({
      tenantId: "test", stream: "prototype:old", type: "prototype.shipped", payload: { historical: true },
    });
    const created = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member",
      text: 'I want to ship one real prototype every week. [[tool:goal.create {"objective":"Ship one real prototype every week","successContract":"A verified prototype.shipped event occurs each week","sourceQuote":"I want to ship one real prototype every week","gateType":"event","gateConfig":{"eventType":"prototype.shipped"},"maxContinuations":0}]]',
    }, { allowedTools: ["goal.create"], requiredTools: ["goal.create"] });
    assert.equal(created.status, "completed");
    const goal = runtime.goals.list("test")[0];
    assert.ok(goal);
    const sourceEventId = goal.sourceEventId;
    assert.ok(sourceEventId);
    assert.equal(goal.sourceQuote, "I want to ship one real prototype every week");
    assert.equal(goal.standardsMandateId, undefined);
    assert.equal(runtime.goals.hasActiveStandardsMandateGoals("test"), false);
    assert.equal(runtime.goals.promptContext("test"), "", "a stated intention remains recorded without becoming foreground accountability");
    assert.equal(runtime.store.getEvent("test", sourceEventId)?.type, "message.received");
    assert.ok(Number(goal.gateConfig.afterSeq) > historical.seq);
    assert.equal(runtime.goals.check("test", goal.id).passed, false,
      "an event from before the quoted commitment cannot satisfy the new goal");
    const unmandatedDecision = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member", text: "I might make another plan.",
    });
    const decisionSource = runtime.store.listEvents("test", { type: "message.received" }).at(-1);
    assert.ok(decisionSource);
    assert.throws(() => runtime.goals.prepareRealityCheck({
      tenantId: "test", goalId: goal.id, sourceEventId: decisionSource.id,
      decisionQuote: "I might make another plan", createdByRunId: unmandatedDecision.runId,
    }), /active member-approved standards mandate/);
    assert.equal(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM goal_reality_checks WHERE tenant_id=? AND goal_id=?")
      .get("test", goal.id)!.count, 0);
    assert.throws(() => runtime.goals.create({
      tenantId: "test", objective: "An invented commitment", successContract: "manual", gateType: "manual",
      sourceEventId, sourceQuote: "words the owner never said",
    }), /verbatim quote/);

    const forgedEvent = runtime.store.appendEvent({
      tenantId: "test", stream: "session:forged", type: "message.received", payload: { text: "I want this" },
    });
    const forgedSession = runtime.store.ensureSession("test", "imessage", "forged");
    runtime.store.addMessage("test", forgedSession.id, {
      id: "assistant_goal_forgery", role: "assistant", parts: [{ type: "text", text: "I want this" }],
      phase: "final", createdAt: forgedEvent.at,
    }, forgedEvent.id);
    assert.throws(() => runtime.goals.create({
      tenantId: "test", objective: "Assistant-authored goal", successContract: "manual", gateType: "manual",
      sourceEventId: forgedEvent.id, sourceQuote: "I want this",
    }), /current owner message/);

    const cancelled = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member",
      text: `Stop tracking this goal. [[tool:goal.transition {"goalId":"${goal.id}","action":"cancel","sourceQuote":"Stop tracking this goal"}]]`,
    }, { allowedTools: ["goal.transition"], requiredTools: ["goal.transition"] });
    assert.equal(cancelled.status, "completed");
    const retained = runtime.goals.get("test", goal.id);
    assert.equal(retained?.status, "cancelled");
    assert.equal(retained?.sourceQuote, "I want to ship one real prototype every week");
    const event = runtime.store.listEvents("test", { type: "goal.cancelled" }).at(-1);
    assert.equal((event!.payload as { ownerSourceQuote?: string }).ownerSourceQuote, "Stop tracking this goal");
    assert.equal(runtime.store.getEvent("test", event?.causationId ?? "")?.type, "message.received");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("an explicit event goal gets one receipt-backed arithmetic check and changing the count cannot re-arm it", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const mandate = runtime.office.proposeMandate({
      tenantId: "test", name: "Prototype shipping standard",
      serviceContract: "At relevant owner-stated decision points, show only the dated commitment and recorded prototype count.",
    });
    await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member",
      text: `I will ship four prototypes this month. [[tool:goal.create ${JSON.stringify({
        objective: "Ship four prototypes this month", successContract: "Four verified prototype.shipped events",
        sourceQuote: "I will ship four prototypes this month", standardsMandateId: mandate.id,
        gateType: "event", gateConfig: { eventType: "prototype.shipped", minimumCount: 4 }, maxContinuations: 0,
      })}]]`,
    }, { allowedTools: ["goal.create"], requiredTools: ["goal.create"] });
    const goal = runtime.goals.list("test", "active")[0];
    assert.ok(goal);
    assert.equal(goal.standardsMandateId, mandate.id);
    assert.equal(runtime.goals.promptContext("test"), "", "a proposed mandate grants no accountability permission");
    assert.equal(runtime.goals.hasActiveStandardsMandateGoals("test"), false);

    const requested = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member",
      text: `Yes, activate that standard. [[tool:mandate.activate ${JSON.stringify({ mandateId: mandate.id })}]]`,
    }, { allowedTools: ["mandate.activate"], requiredTools: ["mandate.activate"] });
    assert.equal(requested.status, "waiting_approval");
    assert.ok(requested.approvalId);
    assert.equal(runtime.goals.hasActiveStandardsMandateGoals("test"), false);
    const activated = await runtime.resumeApproval(requested.approvalId, "approved");
    assert.equal(activated.status, "completed");
    assert.equal(runtime.office.getMandate("test", mandate.id)?.status, "active");
    assert.equal(runtime.goals.hasActiveStandardsMandateGoals("test"), true);
    assert.match(runtime.goals.promptContext("test"), new RegExp(`Goal ${goal.id}`));
    runtime.store.appendEvent({ tenantId: "test", stream: "prototype:one", type: "prototype.shipped", payload: { name: "one" } });
    runtime.store.appendEvent({ tenantId: "test", stream: "prototype:two", type: "prototype.shipped", payload: { name: "two" } });

    const first = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member",
      text: `I'm about to write another planning document. [[tool:goal.reality_check ${JSON.stringify({
        goalId: goal.id, decisionQuote: "I'm about to write another planning document",
      })}]]`,
    }, { allowedTools: ["goal.reality_check"], requiredTools: ["goal.reality_check"] });
    assert.equal(first.status, "completed");
    assert.match(first.text, /^\d{4}-\d{2}-\d{2}: “I will ship four prototypes this month”\nSince then: 2\/4 recorded prototype\.shipped events\.$/);
    assert.doesNotMatch(first.text, /avoid|discipline|potential|mock response|done/i);
    assert.equal(runtime.store.listEvents("test", { type: "goal.reality_check_authored" }).length, 1);
    assert.equal(runtime.store.listEvents("test", { type: "goal.reality_check_surfaced" }).length, 0, "a locally-authored check is not a member-facing surface");
    const delivered: string[] = [];
    const connector: ConnectorAdapter = {
      id: "reality-fixture",
      inboundPrincipal: "trusted-system",
      status: () => ({ id: "reality-fixture", inboundConfigured: true, outboundConfigured: true }),
      verifyWebhook: () => true,
      parseWebhook: () => undefined,
      deliver: async (input) => {
        delivered.push(input.content);
        return { provider: "reality-fixture", messageId: "accepted-1" };
      },
    };
    runtime.connectors.register(connector);
    const crashingWorker = new RuntimeWorker(runtime, {
      faultInjector: (point) => {
        if (point === "delivery.after_acceptance_event") throw new Error("crash after durable acceptance");
      },
    });
    const crashingDeliver = (crashingWorker as unknown as {
      deliverConnector(tenantId: string, runId: string, channel: string, peerId: string, content: string, deliveryKey: string): Promise<string>;
    }).deliverConnector.bind(crashingWorker);
    await assert.rejects(crashingDeliver("test", first.runId, "reality-fixture", "member", first.text, "reality-check"), /Injected worker crash/);
    assert.equal(delivered.length, 1);
    assert.equal(runtime.store.listEvents("test", { type: "goal.reality_check_surfaced" }).length, 0, "a crash after provider acceptance is repairable rather than prematurely claimed");
    const recoveredWorker = new RuntimeWorker(runtime);
    const recoveredDeliver = (recoveredWorker as unknown as {
      deliverConnector(tenantId: string, runId: string, channel: string, peerId: string, content: string, deliveryKey: string): Promise<string>;
    }).deliverConnector.bind(recoveredWorker);
    await recoveredDeliver("test", first.runId, "reality-fixture", "member", first.text, "reality-check");
    assert.equal(delivered.length, 1, "recovery repairs the receipt projection without repeating the provider effect");
    const accepted = runtime.store.listEvents("test", { type: "message.delivery_accepted" }).at(-1);
    assert.ok(accepted);
    assert.equal(runtime.store.listEvents("test", { type: "goal.reality_check_accepted" }).length, 1);
    assert.equal(runtime.store.listEvents("test", { type: "goal.reality_check_surfaced" }).length, 0,
      "provider acceptance proves dispatch, not receipt by the member");
    const deliveredStatus = runtime.store.appendEvent({
      tenantId: "test", stream: "connector:reality-fixture", type: "connector.message.delivered",
      correlationId: first.runId, causationId: accepted.id,
      payload: { connectorId: "reality-fixture", externalMessageId: "accepted-1" },
    });
    runtime.reconcileConnectorDeliveryStatus(deliveredStatus);
    const surfaced = runtime.store.listEvents("test", { type: "goal.reality_check_surfaced" });
    assert.equal(surfaced.length, 1);
    assert.equal(surfaced[0]?.causationId, deliveredStatus.id, "the surface claim is caused by authenticated delivered evidence");
    const failedStatus = runtime.store.appendEvent({
      tenantId: "test", stream: "connector:reality-fixture", type: "connector.message.failed",
      correlationId: first.runId, causationId: accepted.id,
      payload: { connectorId: "reality-fixture", externalMessageId: "accepted-1", reason: "provider delivery ledger rejected the destination" },
    });
    runtime.reconcileConnectorDeliveryStatus(failedStatus);
    const failedReality = runtime.store.db.prepare(`SELECT delivery_state,surfaced_at FROM goal_reality_checks
      WHERE tenant_id=? AND run_id=?`).get("test", first.runId) as { delivery_state: string; surfaced_at: string | null };
    assert.equal(failedReality.delivery_state, "failed");
    assert.equal(failedReality.surfaced_at, "", "a later authenticated failure retracts the current surfaced projection without deleting history");
    assert.equal(runtime.store.listEvents("test", { type: "goal.reality_check_delivery_failed" }).length, 1);
    assert.equal(runtime.store.listEvents("test", { type: "goal.reality_check_surfaced" }).length, 1,
      "the prior delivered claim remains immutable historical evidence");
    const receipt = runtime.store.db.prepare(`SELECT id,output_json FROM tool_receipts
      WHERE tenant_id=? AND run_id=? AND tool_name='goal.reality_check' AND status='succeeded'`).get(
      "test", first.runId,
    ) as { id: string; output_json: string };
    const tampered = JSON.parse(receipt.output_json) as Record<string, unknown>;
    tampered.rendered = "You're avoiding the work.";
    runtime.store.db.prepare("UPDATE tool_receipts SET output_json=? WHERE tenant_id=? AND id=?")
      .run(JSON.stringify(tampered), "test", receipt.id);
    const forgedPresentation = runtime.goals.presentationForRun("test", first.runId);
    assert.ok(forgedPresentation);
    assert.throws(() => runtime.goals.claimRealityCheck({
      tenantId: "test", runId: first.runId, messageId: "forged_message", presentation: forgedPresentation,
    }), /does not match its immutable consideration evidence/);
    runtime.store.db.prepare("UPDATE tool_receipts SET output_json=? WHERE tenant_id=? AND id=?")
      .run(receipt.output_json, "test", receipt.id);

    const repeated = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member",
      text: `Maybe I'll make one more plan first. [[tool:goal.reality_check ${JSON.stringify({
        goalId: goal.id, decisionQuote: "Maybe I'll make one more plan first",
      })}]]`,
    }, { allowedTools: ["goal.reality_check"], requiredTools: ["goal.reality_check"] });
    assert.equal(repeated.status, "completed");
    assert.equal(repeated.text, "", "unchanged arithmetic is silence rather than a repeated nag");
    assert.equal(runtime.store.listEvents("test", { type: "goal.reality_check_surfaced" }).length, 1);
    assert.equal(runtime.store.listEvents("test", { stream: `run:${repeated.runId}` })
      .some((event) => event.type === "relationship.response_silenced"), true);

    runtime.store.appendEvent({ tenantId: "test", stream: "prototype:three", type: "prototype.shipped", payload: { name: "three" } });
    const changed = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member",
      text: `I'm choosing what to work on next. [[tool:goal.reality_check ${JSON.stringify({
        goalId: goal.id, decisionQuote: "I'm choosing what to work on next",
      })}]]`,
    }, { allowedTools: ["goal.reality_check"], requiredTools: ["goal.reality_check"] });
    assert.equal(changed.text, "", "changing the arithmetic does not silently re-arm an already-used standard");
    assert.equal(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM goal_reality_checks WHERE tenant_id=? AND goal_id=?")
      .get("test", goal.id)!.count, 1);
    assert.match(runtime.goals.promptContext("test"), new RegExp(`Goal ${goal.id}.*3/4 recorded prototype\\.shipped`, "s"));

    const forged = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member",
      text: "Keep going.",
    });
    const forgedSource = runtime.store.listEvents("test", { type: "message.received" }).at(-1);
    assert.ok(forgedSource);
    assert.throws(() => runtime.goals.prepareRealityCheck({
      tenantId: "test", goalId: goal.id, sourceEventId: forgedSource.id,
      decisionQuote: "I am abandoning the goal", createdByRunId: forged.runId,
    }), /verbatim quote/i);
    assert.equal(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM goal_reality_checks WHERE tenant_id=? AND goal_id=?")
      .get("test", goal.id)!.count, 1);

    runtime.store.appendEvent({ tenantId: "test", stream: "prototype:four", type: "prototype.shipped", payload: { name: "four" } });
    const revocableGoal = runtime.goals.create({
      tenantId: "test", objective: "Exercise revoke-before-delivery", successContract: goal.successContract,
      gateType: "event", gateConfig: goal.gateConfig, sourceEventId: goal.sourceEventId as string,
      sourceQuote: goal.sourceQuote as string, standardsMandateId: mandate.id, maxContinuations: 0,
    });
    const pendingDecision = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member", text: "I might draft one more plan.",
    });
    const pendingSource = runtime.store.listEvents("test", { type: "message.received" }).at(-1);
    assert.ok(pendingSource);
    const preparedBeforePause = runtime.goals.prepareRealityCheck({
      tenantId: "test", goalId: revocableGoal.id, sourceEventId: pendingSource.id,
      decisionQuote: "I might draft one more plan", createdByRunId: pendingDecision.runId,
    });
    assert.equal(preparedBeforePause.shouldSurface, true);
    assert.equal(runtime.goals.authorRealityCheck({
      tenantId: "test", runId: pendingDecision.runId, messageId: "authored-before-pause", presentation: preparedBeforePause,
    }), true);

    const paused = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member",
      text: `Pause that standard. [[tool:mandate.transition ${JSON.stringify({
        mandateId: mandate.id, action: "pause", sourceQuote: "Pause that standard",
      })}]]`,
    }, { allowedTools: ["mandate.transition"], requiredTools: ["mandate.transition"] });
    assert.equal(paused.status, "completed");
    assert.equal(runtime.office.getMandate("test", mandate.id)?.status, "paused");
    assert.equal(runtime.goals.hasActiveStandardsMandateGoals("test"), false);
    assert.equal(runtime.goals.promptContext("test"), "", "pausing the mandate removes accountability context immediately");
    assert.equal(runtime.goals.get("test", goal.id)?.status, "active", "the recorded goal is not erased or mutated");
    assert.equal(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM goal_reality_checks WHERE tenant_id=? AND goal_id=?")
      .get("test", revocableGoal.id)!.count, 1, "authored checks remain durable without becoming a member-facing surface");
    assert.equal(runtime.goals.authorizeAuthoredRealityCheckDelivery({
      tenantId: "test", runId: pendingDecision.runId, content: preparedBeforePause.rendered,
    }), "suppressed", "a mandate revoked before connector delivery suppresses the unsent check");
    assert.equal(runtime.goals.authorizeAuthoredRealityCheckDelivery({
      tenantId: "test", runId: pendingDecision.runId, content: preparedBeforePause.rendered,
    }), "suppressed", "a recovered delivery cannot resurrect a check that was suppressed before sending");
    assert.equal(runtime.store.listEvents("test", { type: "goal.reality_check_surfaced" }).length, 1, "suppression never fabricates delivery");
    assert.equal(runtime.store.db.prepare("SELECT delivery_state FROM goal_reality_checks WHERE tenant_id=? AND run_id=?")
      .get("test", pendingDecision.runId)!.delivery_state, "suppressed");
    assert.equal(runtime.goals.claimRealityCheck({
      tenantId: "test", runId: pendingDecision.runId, messageId: "message_after_pause", presentation: preparedBeforePause,
    }), false, "a pause between preparation and emission closes the race without erasing the consideration");

    const afterPause = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member",
      text: "I'm planning again.",
    });
    const afterPauseSource = runtime.store.listEvents("test", { type: "message.received" }).at(-1);
    assert.ok(afterPauseSource);
    assert.throws(() => runtime.goals.prepareRealityCheck({
      tenantId: "test", goalId: goal.id, sourceEventId: afterPauseSource.id,
      decisionQuote: "I'm planning again", createdByRunId: afterPause.runId,
    }), /active member-approved standards mandate/);
    assert.equal(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM goal_reality_checks WHERE tenant_id=? AND goal_id=?")
      .get("test", goal.id)!.count, 1);

    const retired = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member",
      text: `Retire that standard. [[tool:mandate.transition ${JSON.stringify({
        mandateId: mandate.id, action: "retire", sourceQuote: "Retire that standard",
      })}]]`,
    }, { allowedTools: ["mandate.transition"], requiredTools: ["mandate.transition"] });
    assert.equal(retired.status, "completed");
    assert.equal(runtime.office.getMandate("test", mandate.id)?.status, "retired");
    assert.equal(runtime.goals.promptContext("test"), "");
    assert.equal(runtime.goals.get("test", goal.id)?.sourceQuote, "I will ship four prototypes this month");
    assert.equal(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM goal_reality_checks WHERE tenant_id=? AND goal_id=?")
      .get("test", goal.id)!.count, 1, "retirement preserves the same append-only accountability history");

  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("private goal motives stay evidence-bound, low-confidence, invisible, and revocable at the delivery boundary", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const mandate = runtime.office.proposeMandate({
      tenantId: "test", name: "Prototype decision standard",
      serviceContract: "At a relevant decision, show the owner's dated prototype commitment and recorded count once.",
    });
    runtime.office.transitionMandate("test", mandate.id, "active");
    for (let day = 1; day <= 6; day += 1) {
      runtime.store.appendEvent({
        tenantId: "test", stream: `prototype:historical:${day}`, type: "prototype.shipped",
        at: `2023-09-0${day}T12:00:00.000Z`, payload: { historical: true, day },
      });
    }
    const historicalPeakContextId = appendOwnerEvidence(
      runtime, "That September shipping run made the work feel real and taken seriously.", "2023-09-10T12:00:00.000Z",
    );
    const commitmentId = appendOwnerEvidence(
      runtime, "I will ship four real prototypes this quarter.", "2024-01-02T12:00:00.000Z",
    );
    const middleId = appendOwnerEvidence(
      runtime, "I keep reaching for another planning document when the prototype gets concrete.", "2024-02-10T12:00:00.000Z",
    );
    for (let day = 1; day <= 5; day += 1) {
      appendOwnerEvidence(runtime, `February context ${day} about an unrelated decision.`, `2024-02-0${day}T12:00:00.000Z`);
    }
    const substitutePriorId = appendOwnerEvidence(
      runtime, "The client contract win felt like proof that the work was being taken seriously.", "2024-02-15T12:00:00.000Z",
    );
    const triggerId = appendOwnerEvidence(
      runtime, "After the client contract win, I am about to write another planning document instead of shipping today.", "2024-03-20T12:00:00.000Z",
    );
    const futureId = appendOwnerEvidence(
      runtime, "A future correction that did not exist when the trigger arrived.", "2024-04-20T12:00:00.000Z",
    );
    const goal = runtime.goals.create({
      tenantId: "test", objective: "Ship four real prototypes this quarter",
      successContract: "Four verified prototype.shipped events", gateType: "event",
      gateConfig: { eventType: "prototype.shipped", minimumCount: 4, referenceWindowDays: 90 }, maxContinuations: 0,
      sourceEventId: commitmentId, sourceQuote: "I will ship four real prototypes this quarter",
      standardsMandateId: mandate.id,
    });
    const bundle = runtime.goals.buildMotiveBundle("test", goal.id, triggerId);
    assert.ok(bundle);
    assert.equal(bundle.allowedEventIds.has(commitmentId), true);
    assert.equal(bundle.allowedEventIds.has(historicalPeakContextId), true);
    assert.equal(bundle.allowedEventIds.has(middleId), true);
    assert.equal(bundle.allowedEventIds.has(substitutePriorId), true);
    assert.equal(bundle.allowedEventIds.has(triggerId), true);
    assert.equal(bundle.allowedEventIds.has(futureId), false, "a delayed worker cannot read evidence from after its trigger");
    assert.equal([...bundle.allowedEventIds].filter((eventId) => runtime.store.getEvent("test", eventId)?.at.startsWith("2024-02")).length, 3,
      "one dense recent month cannot crowd the longitudinal bundle");
    assert.equal(bundle.allowedEventIds.size <= 30, true);
    const referencePeakCandidate = [...bundle.referencePeakCandidates.values()][0];
    assert.ok(referencePeakCandidate);
    assert.equal(referencePeakCandidate.count, 6);
    assert.equal(referencePeakCandidate.windowDays, 90);
    assert.equal(referencePeakCandidate.eventIds.length, 6);

    const agentEvent = runtime.store.appendEvent({
      tenantId: "test", stream: "agent:fixture", type: "run.completed", at: "2024-02-20T12:00:00.000Z",
      payload: { output: "The member is afraid of shipping." },
    });
    runtime.store.indexEvidence({
      tenantId: "test", sourceEventId: agentEvent.id, kind: "conversation.assistant", trustClass: "agent",
      content: "The member is afraid of shipping.", observedAt: agentEvent.at,
    });
    assert.throws(() => runtime.goals.proposeMotive({
      tenantId: "test", goalId: goal.id, hypothesis: "Unsupported agent-authored story",
      strongestAlternative: "The work is merely underspecified", falsifier: "The member ships when the work is concrete",
      originClass: "unknown", decisionCues: ["another planning document"],
      evidenceEventIds: [commitmentId, agentEvent.id, triggerId], confidence: 0.5,
      sourceEventId: triggerId, allowedEvidenceEventIds: new Set([...bundle.allowedEventIds, agentEvent.id]),
    }), /not owner-authored evidence/);
    assert.throws(() => runtime.goals.proposeMotive({
      tenantId: "test", goalId: goal.id, hypothesis: "Future-informed story",
      strongestAlternative: "Only evidence available at the trigger should count", falsifier: "The later correction never arrived",
      originClass: "unknown", decisionCues: ["another planning document"],
      evidenceEventIds: [commitmentId, middleId, triggerId, futureId], confidence: 0.5,
      sourceEventId: triggerId, allowedEvidenceEventIds: new Set([...bundle.allowedEventIds, futureId]),
    }), /after the synthesis trigger/);
    assert.throws(() => runtime.goals.proposeMotive({
      tenantId: "test", goalId: goal.id, hypothesis: "Unsupported invented cue",
      strongestAlternative: "Planning may be useful", falsifier: "A plan directly causes a shipped prototype",
      originClass: "mixed", decisionCues: ["career identity crisis"],
      evidenceEventIds: [commitmentId, middleId, triggerId], confidence: 0.5,
      sourceEventId: triggerId, allowedEvidenceEventIds: bundle.allowedEventIds,
    }), /literal phrase from cited owner evidence/);
    assert.throws(() => runtime.goals.proposeMotive({
      tenantId: "test", goalId: goal.id, hypothesis: "A motive with a fabricated substitute",
      strongestAlternative: "No substitution is established", falsifier: "The alternative activity disappears",
      originClass: "unknown", decisionCues: ["another planning document"],
      evidenceEventIds: [commitmentId, substitutePriorId, triggerId], confidence: 0.5,
      substitution: {
        candidate: "An unsupported substitute", strongestAlternative: "The activities are unrelated",
        falsifier: "No repeated tradeoff appears", decisionCues: ["invented status reward"],
        evidenceEventIds: [substitutePriorId, triggerId], confidence: 0.4,
      },
      sourceEventId: triggerId, allowedEvidenceEventIds: bundle.allowedEventIds,
    }), /substitution cue.*literal phrase/i);
    assert.throws(() => runtime.goals.proposeMotive({
      tenantId: "test", goalId: goal.id, hypothesis: "A motive with a forged past peak",
      strongestAlternative: "The past period may be irrelevant", falsifier: "The old pattern does not recur",
      originClass: "unknown", decisionCues: ["another planning document"],
      evidenceEventIds: [historicalPeakContextId, commitmentId, middleId, triggerId], confidence: 0.5,
      referencePeak: {
        candidateId: "peak_00000000000000000000000000000000",
        contextEvidenceEventIds: [historicalPeakContextId, triggerId],
        strongestAlternative: "The old performance served a different purpose", falsifier: "No current condition resembles it", confidence: 0.4,
      },
      sourceEventId: triggerId, allowedEvidenceEventIds: bundle.allowedEventIds,
    }), /exact runtime-counted prior window/i);
    assert.throws(() => runtime.goals.proposeMotive({
      tenantId: "test", goalId: goal.id, hypothesis: "A motive with no historical context for its past peak",
      strongestAlternative: "The past period may be irrelevant", falsifier: "The old pattern does not recur",
      originClass: "unknown", decisionCues: ["another planning document"],
      evidenceEventIds: [commitmentId, middleId, triggerId], confidence: 0.5,
      referencePeak: {
        candidateId: referencePeakCandidate.candidateId, contextEvidenceEventIds: [middleId, triggerId],
        strongestAlternative: "The old performance served a different purpose", falsifier: "No current condition resembles it", confidence: 0.4,
      },
      sourceEventId: triggerId, allowedEvidenceEventIds: bundle.allowedEventIds,
    }), /owner context inside the selected historical window/i);

    const first = runtime.goals.proposeMotive({
      tenantId: "test", goalId: goal.id,
      hypothesis: "PRIVATE_MOTIVE_SENTINEL: planning may be displacing the uncertainty of making the prototype concrete.",
      strongestAlternative: "The next prototype genuinely needs a short plan before implementation.",
      falsifier: "Planning episodes are consistently followed by a shipped prototype within the same work cycle.",
      originClass: "mixed", decisionCues: ["another planning document", "instead of shipping"],
      evidenceEventIds: [historicalPeakContextId, commitmentId, middleId, substitutePriorId, triggerId],
      substitution: {
        candidate: "Recognition from client work may be partly serving the same desire to have the work taken seriously.",
        strongestAlternative: "The contract is simply valuable work and is unrelated to the prototype goal.",
        falsifier: "Contract recognition rises while the member continues choosing and shipping prototypes at the stated rate.",
        decisionCues: ["client contract win"], evidenceEventIds: [substitutePriorId, triggerId], confidence: 0.95,
      },
      referencePeak: {
        candidateId: referencePeakCandidate.candidateId,
        contextEvidenceEventIds: [historicalPeakContextId, triggerId],
        strongestAlternative: "The September run may have served novelty rather than the same desire for serious work.",
        falsifier: "Similar recognition no longer changes prototype shipping choices.", confidence: 0.9,
      },
      confidence: 0.99,
      sourceEventId: triggerId, allowedEvidenceEventIds: bundle.allowedEventIds,
    });
    assert.equal(first.confidence, 0.65, "interpreted motives have a hard confidence ceiling");
    assert.equal(first.substitution?.confidence, 0.55, "a more speculative substitution has a lower hard ceiling");
    assert.equal(first.referencePeak?.confidence, 0.5, "a motive-matched historical reference has the lowest hard ceiling");
    assert.deepEqual(first.referencePeak?.eventIds, referencePeakCandidate.eventIds,
      "the runtime, not the model, fixes the historical arithmetic and evidence IDs");
    assert.equal(runtime.goals.hasActiveStandardsMandateGoals("test", "This article is beautiful."), false);
    assert.equal(runtime.goals.promptContext("test", "This article is beautiful."), "");
    assert.equal(runtime.goals.hasActiveStandardsMandateGoals("test", "Maybe another planning document first."), true);
    assert.equal(runtime.goals.hasActiveStandardsMandateGoals("test", "I am thinking about the client contract win."), true,
      "a literal substitution cue can make the owner's unchanged stated goal relevant");
    const relevantContext = runtime.goals.promptContext("test", "Maybe another planning document first.");
    assert.match(relevantContext, /I will ship four real prototypes this quarter/);
    assert.doesNotMatch(relevantContext, /PRIVATE_MOTIVE_SENTINEL|displacing the uncertainty|client work|strongest alternative/i);
    assert.doesNotMatch(runtime.goals.promptContext("test", "I am thinking about the client contract win."),
      /recognition from client work|desire to have the work taken seriously/i);
    assert.deepEqual(runtime.store.searchEvidence("test", "PRIVATE_MOTIVE_SENTINEL"), []);
    assert.equal(runtime.tools.definitions().some((tool) => /motive/i.test(`${tool.name} ${tool.description}`)), false,
      "the private interpretation has no member-facing model tool");

    const decision = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "motive-fixture",
      text: "I am considering another planning document before I start.",
    });
    const decisionEvent = runtime.store.listEvents("test", { stream: `run:${decision.runId}`, type: "run.started" })[0];
    assert.ok(decisionEvent?.causationId);
    const presentation = runtime.goals.prepareRealityCheck({
      tenantId: "test", goalId: goal.id, sourceEventId: decisionEvent.causationId,
      decisionQuote: "I am considering another planning document before I start", createdByRunId: decision.runId,
    });
    assert.equal(presentation.motiveHypothesisId, first.id);
    assert.doesNotMatch(presentation.rendered, /PRIVATE_MOTIVE_SENTINEL|planning may be displacing/i);
    assert.match(presentation.rendered, /Earlier record: 6 recorded prototype\.shipped events in a 90-day window/);
    assert.deepEqual(presentation.referencePeak, {
      eventType: "prototype.shipped", periodStart: referencePeakCandidate.periodStart,
      periodEnd: referencePeakCandidate.periodEnd, windowDays: 90, count: 6,
    });
    assert.equal(JSON.stringify(presentation).includes(historicalPeakContextId), false,
      "the model-facing tool result gets reference arithmetic, not private why-match evidence");
    assert.doesNotMatch(JSON.stringify(presentation), /September run may have served novelty|Similar recognition no longer/i);
    assert.throws(() => runtime.goals.authorRealityCheck({
      tenantId: "test", runId: decision.runId, messageId: "tampered-peak-check",
      presentation: { ...presentation, referencePeak: { ...presentation.referencePeak!, count: 999 } },
    }), /immutable consideration evidence/);
    assert.equal(runtime.goals.authorRealityCheck({
      tenantId: "test", runId: decision.runId, messageId: "motive-check-authored", presentation,
    }), true);

    const revised = runtime.goals.proposeMotive({
      tenantId: "test", goalId: goal.id,
      hypothesis: "The planning behavior may reflect a missing technical dependency rather than reluctance to ship.",
      strongestAlternative: "Planning is still displacing direct prototype work.",
      falsifier: "The dependency is resolved and planning continues without implementation.",
      originClass: "reasoned", decisionCues: ["prototype gets concrete", "instead of shipping"],
      evidenceEventIds: [historicalPeakContextId, commitmentId, middleId, triggerId],
      referencePeak: {
        candidateId: referencePeakCandidate.candidateId,
        contextEvidenceEventIds: [historicalPeakContextId, triggerId],
        strongestAlternative: "The historical burst reflected a one-off deadline.",
        falsifier: "Another ordinary cycle reaches the same count without the inferred condition.", confidence: 0.45,
      },
      confidence: 0.6,
      sourceEventId: triggerId, allowedEvidenceEventIds: bundle.allowedEventIds,
    });
    const history = runtime.goals.motives("test", goal.id);
    assert.equal(history.length, 2);
    assert.equal(history.find((motive) => motive.id === first.id)?.status, "superseded");
    assert.equal(revised.supersedesId, first.id);
    assert.equal(runtime.goals.activeMotive("test", goal.id)?.id, revised.id);
    assert.equal(runtime.goals.authorizeAuthoredRealityCheckDelivery({
      tenantId: "test", runId: decision.runId, content: presentation.rendered,
    }), "suppressed", "a revised private interpretation cannot silently deliver an already-authored intervention");
    assert.equal(runtime.store.db.prepare(`SELECT motive_hypothesis_id,delivery_state FROM goal_reality_checks
      WHERE tenant_id=? AND run_id=?`).get("test", decision.runId)!.motive_hypothesis_id, first.id);

    runtime.store.db.prepare("UPDATE goal_motive_hypotheses SET reference_peak_json=? WHERE tenant_id=? AND id=?")
      .run("{truncated", "test", revised.id);
    assert.equal(runtime.store.scanCorruptJsonRows("test", 50) >= 1, true);
    assert.equal(runtime.goals.activeMotive("test", goal.id), undefined, "corrupt private state fails closed instead of shaping attention");
    const retainedRejected = runtime.goals.motives("test", goal.id).find((motive) => motive.id === revised.id);
    assert.equal(retainedRejected?.status, "rejected");
    assert.match(retainedRejected?.hypothesis ?? "", /missing technical dependency/, "recovery preserves interpretable history");
    assert.equal(runtime.store.db.prepare(`SELECT COUNT(*) AS count FROM recovery_quarantine
      WHERE tenant_id=? AND record_kind='goal_motive_hypotheses' AND record_id=?`).get("test", revised.id)!.count, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("personal reference windows require explicit comparability and refuse unbounded dense history", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const mandate = runtime.office.proposeMandate({
      tenantId: "test", name: "Bounded reference standard",
      serviceContract: "Use only bounded comparable arithmetic under the explicit standard.",
    });
    runtime.office.transitionMandate("test", mandate.id, "active");
    for (let index = 0; index < 501; index += 1) runtime.store.appendEvent({
      tenantId: "test", stream: `dense:${index}`, type: "dense.output",
      at: new Date(Date.parse("2023-11-01T00:00:00.000Z") + index * 60_000).toISOString(), payload: { index },
    });
    const historicalContextId = appendOwnerEvidence(
      runtime, "That dense November window was driven by a specific launch.", "2023-11-02T00:00:00.000Z", "dense-history",
    );
    const commitmentId = appendOwnerEvidence(
      runtime, "I will record one dense output per month.", "2024-01-02T00:00:00.000Z", "dense-history",
    );
    const triggerId = appendOwnerEvidence(
      runtime, "I am choosing what dense output to record now.", "2024-03-20T00:00:00.000Z", "dense-history",
    );
    const withoutWindow = runtime.goals.create({
      tenantId: "test", objective: "Record a dense output", successContract: "One dense.output event",
      gateType: "event", gateConfig: { eventType: "dense.output", minimumCount: 1 }, maxContinuations: 0,
      sourceEventId: commitmentId, sourceQuote: "I will record one dense output per month", standardsMandateId: mandate.id,
    });
    assert.equal(runtime.goals.buildMotiveBundle("test", withoutWindow.id, triggerId)?.referencePeakCandidates.size, 0,
      "the model cannot invent a comparison duration from natural-language goals");
    assert.throws(() => runtime.goals.create({
      tenantId: "test", objective: "Mismatched weekly reference", successContract: "One dense.output event",
      gateType: "event", gateConfig: { eventType: "dense.output", minimumCount: 1, referenceWindowDays: 7 }, maxContinuations: 0,
      sourceEventId: commitmentId, sourceQuote: "I will record one dense output per month", standardsMandateId: mandate.id,
    }), /must match an explicit horizon in the owner's quoted commitment/i);
    const bounded = runtime.goals.create({
      tenantId: "test", objective: "Record a dense output", successContract: "One dense.output event in 30 days",
      gateType: "event", gateConfig: { eventType: "dense.output", minimumCount: 1, referenceWindowDays: 30 }, maxContinuations: 0,
      sourceEventId: commitmentId, sourceQuote: "I will record one dense output per month", standardsMandateId: mandate.id,
    });
    const bundle = runtime.goals.buildMotiveBundle("test", bounded.id, triggerId);
    assert.ok(bundle?.allowedEventIds.has(historicalContextId));
    assert.equal(bundle?.referencePeakCandidates.size, 0,
      "a history too dense to retain complete peak provenance is refused rather than truncated");
    assert.throws(() => runtime.goals.create({
      tenantId: "test", objective: "Invalid window", successContract: "Invalid",
      gateType: "event", gateConfig: { eventType: "dense.output", referenceWindowDays: 0 },
    }), /referenceWindowDays must be an integer from 1 to 366/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("the motive worker uses a separate critic, retains rejected history without the private story, and respects its cooldown", async () => {
  const home = testHome();
  let commitmentId = "";
  let historicalPeakContextId = "";
  let middleId = "";
  let currentTriggerId = "";
  let referencePeakCandidateId = "";
  let criticAccepts = false;
  const requests: ProviderRequest[] = [];
  const adapter: ProviderAdapter = {
    name: "openai-compatible",
    complete: async (request) => {
      requests.push(request);
      if (request.system.includes("adversarial auditor")) {
        return {
          text: JSON.stringify({ accepted: criticAccepts, reason: criticAccepts ? "bounded by cited evidence" : "unsupported across time", confidence: 0.61 }),
          toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
        };
      }
      return {
        text: JSON.stringify({ candidate: {
          hypothesis: criticAccepts ? "A concrete implementation gap may be causing planning to recur." : "REJECTED_PRIVATE_STORY",
          strongestAlternative: "Planning itself is the chosen work product.",
          falsifier: "Closing the implementation gap does not change the planning pattern.", originClass: "mixed",
          decisionCues: ["another planning document"],
          evidenceEventIds: criticAccepts
            ? [historicalPeakContextId, commitmentId, middleId, currentTriggerId]
            : [commitmentId, middleId, currentTriggerId], confidence: 0.64,
          ...(criticAccepts ? { substitution: {
            candidate: "Planning documents may be becoming a substitute output for implemented prototypes.",
            strongestAlternative: "The plans are necessary inputs to implementation.",
            falsifier: "Each new plan is followed by implementation in the same cycle.",
            decisionCues: ["another planning document"], evidenceEventIds: [middleId, currentTriggerId], confidence: 0.9,
          }, referencePeak: {
            candidateId: referencePeakCandidateId,
            contextEvidenceEventIds: [historicalPeakContextId, currentTriggerId],
            strongestAlternative: "The old burst reflected a deadline rather than the same motive.",
            falsifier: "The current condition recurs without changing implementation volume.", confidence: 0.8,
          } } : {}),
        } }),
        toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      };
    },
  };
  const config = testConfig(home.path);
  const route = { provider: "openai-compatible" as const, model: "motive-fixture", maxOutputTokens: 512, reasoningEffort: "none" as const };
  config.models = { foreground: route, deliberation: route, background: route, critic: route };
  const runtime = new CoRuntime({ config, providers: new ProviderRegistry([adapter]) });
  try {
    for (let day = 1; day <= 6; day += 1) runtime.store.appendEvent({
      tenantId: "test", stream: `prototype:worker-history:${day}`, type: "prototype.shipped",
      at: `2023-09-0${day}T12:00:00.000Z`, payload: { historical: true, day },
    });
    historicalPeakContextId = appendOwnerEvidence(
      runtime, "That September prototype run made the work feel real.", "2023-09-10T12:00:00.000Z", "motive-worker",
    );
    commitmentId = appendOwnerEvidence(runtime, "I will ship four real prototypes this quarter.", "2024-01-02T12:00:00.000Z", "motive-worker");
    middleId = appendOwnerEvidence(runtime, "I keep reaching for another planning document when implementation gets concrete.", "2024-02-10T12:00:00.000Z", "motive-worker");
    const mandate = runtime.office.proposeMandate({
      tenantId: "test", name: "Prototype decision standard",
      serviceContract: "Show the dated commitment and count once at a relevant decision.",
    });
    runtime.office.transitionMandate("test", mandate.id, "active");
    runtime.goals.create({
      tenantId: "test", objective: "Ship four real prototypes this quarter",
      successContract: "Four verified prototype.shipped events", gateType: "event",
      gateConfig: { eventType: "prototype.shipped", minimumCount: 4, referenceWindowDays: 90 }, maxContinuations: 0,
      sourceEventId: commitmentId, sourceQuote: "I will ship four real prototypes this quarter",
      standardsMandateId: mandate.id,
    });
    currentTriggerId = appendOwnerEvidence(
      runtime, "I am considering another planning document before implementing.", "2024-03-20T12:00:00.000Z", "motive-worker",
    );
    referencePeakCandidateId = [...runtime.goals.buildMotiveBundle("test", runtime.goals.list("test")[0]!.id, currentTriggerId)!
      .referencePeakCandidates.keys()][0] ?? "";
    assert.match(referencePeakCandidateId, /^peak_/);
    const releaseId = runtime.releases.assign("test").release.id;
    runtime.store.enqueueJob("test", "goal.motive.synthesize", { sourceEventId: currentTriggerId }, {
      idempotencyKey: `motive:${currentTriggerId}`, releaseId,
    });
    assert.equal(await new RuntimeWorker(runtime).runOnce(), true);
    assert.equal(runtime.goals.motives("test", runtime.goals.list("test")[0]!.id).length, 0);
    const rejected = runtime.store.listEvents("test", { type: "goal.motive_candidate_rejected" });
    assert.equal(rejected.length, 1);
    assert.equal(JSON.stringify(rejected[0]?.payload).includes("REJECTED_PRIVATE_STORY"), false,
      "a rejected private story is not retained as durable personal interpretation");

    criticAccepts = true;
    currentTriggerId = appendOwnerEvidence(
      runtime, "I am still considering another planning document before implementing.", "2024-04-05T12:00:00.000Z", "motive-worker",
    );
    runtime.store.enqueueJob("test", "goal.motive.synthesize", { sourceEventId: currentTriggerId }, {
      idempotencyKey: `motive:${currentTriggerId}`, releaseId,
    });
    assert.equal(await new RuntimeWorker(runtime).runOnce(), true);
    const goal = runtime.goals.list("test")[0]!;
    assert.equal(runtime.goals.activeMotive("test", goal.id)?.confidence, 0.61);
    assert.equal(runtime.goals.activeMotive("test", goal.id)?.substitution?.confidence, 0.55);
    assert.equal(runtime.goals.activeMotive("test", goal.id)?.referencePeak?.confidence, 0.5);
    assert.equal(requests.length, 4);
    assert.match(requests[0]?.system ?? "", /private goal-motive investigator/i);
    assert.match(requests[1]?.system ?? "", /adversarial auditor/i);
    assert.equal(requests.every((request) => request.tools.length === 0), true);

    const withinCooldown = appendOwnerEvidence(
      runtime, "Maybe another planning document tomorrow.", "2024-04-06T12:00:00.000Z", "motive-worker",
    );
    runtime.store.enqueueJob("test", "goal.motive.synthesize", { sourceEventId: withinCooldown }, {
      idempotencyKey: `motive:${withinCooldown}`, releaseId,
    });
    assert.equal(await new RuntimeWorker(runtime).runOnce(), true);
    assert.equal(requests.length, 4, "the private model is not churned on every conversation");
    assert.equal(runtime.goals.motives("test", goal.id).length, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("verified negative feedback retires only the exact private motive that shaped the delivered check", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const peerId = "motive-outcome";
    const mandate = runtime.office.proposeMandate({
      tenantId: "test", name: "Shipping decision standard",
      serviceContract: "Show the dated shipping commitment and recorded count once at a relevant decision.",
    });
    runtime.office.transitionMandate("test", mandate.id, "active");
    const commitmentId = appendOwnerEvidence(runtime, "I will ship three demos this quarter.", "2024-01-02T12:00:00.000Z", peerId);
    const middleId = appendOwnerEvidence(runtime, "Another planning document is tempting when a demo gets concrete.", "2024-02-10T12:00:00.000Z", peerId);
    const triggerId = appendOwnerEvidence(runtime, "I might choose another planning document over the demo.", "2024-03-20T12:00:00.000Z", peerId);
    const goal = runtime.goals.create({
      tenantId: "test", objective: "Ship three demos this quarter", successContract: "Three verified demo.shipped events",
      gateType: "event", gateConfig: { eventType: "demo.shipped", minimumCount: 3 }, maxContinuations: 0,
      sourceEventId: commitmentId, sourceQuote: "I will ship three demos this quarter", standardsMandateId: mandate.id,
    });
    const bundle = runtime.goals.buildMotiveBundle("test", goal.id, triggerId);
    assert.ok(bundle);
    const motive = runtime.goals.proposeMotive({
      tenantId: "test", goalId: goal.id, hypothesis: "Planning may be substituting for resolving demo uncertainty.",
      strongestAlternative: "The demo genuinely requires more design work.",
      falsifier: "Each planning document is followed by a shipped demo in the same cycle.", originClass: "mixed",
      decisionCues: ["another planning document"], evidenceEventIds: [commitmentId, middleId, triggerId],
      confidence: 0.6, sourceEventId: triggerId, allowedEvidenceEventIds: bundle.allowedEventIds,
    });
    const turn = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId,
      text: `I am choosing another planning document now. [[tool:goal.reality_check ${JSON.stringify({
        goalId: goal.id, decisionQuote: "I am choosing another planning document now",
      })}]]`,
    }, { allowedTools: ["goal.reality_check"], requiredTools: ["goal.reality_check"] });
    assert.equal(turn.status, "completed");
    assert.match(turn.text, /0\/3 recorded demo\.shipped events/);

    const connector: ConnectorAdapter = {
      id: "motive-rail", inboundPrincipal: "trusted-system",
      status: () => ({ id: "motive-rail", inboundConfigured: false, outboundConfigured: true }),
      verifyWebhook: () => false, parseWebhook: () => undefined,
      relationship: (target) => ({ channel: "imessage", peerId: target }),
      deliver: async () => ({ provider: "motive-rail", messageId: "motive-check-accepted" }),
    };
    runtime.connectors.register(connector);
    const worker = new RuntimeWorker(runtime);
    const deliver = (worker as unknown as {
      deliverConnector(tenantId: string, runId: string, channel: string, peerId: string, content: string, deliveryKey: string): Promise<string>;
    }).deliverConnector.bind(worker);
    assert.equal(await deliver("test", turn.runId, "motive-rail", peerId, turn.text, "motive-check"), "accepted");

    const feedbackEventId = appendOwnerEvidence(runtime, "That check was annoying and did not help.", "2024-03-21T12:00:00.000Z", peerId);
    const feedback = runtime.outcomes.record({
      tenantId: "test", sessionId: runtime.store.ensureSession("test", "imessage", peerId).id,
      sourceEventId: feedbackEventId, kind: "annoying", evidenceQuote: "That check was annoying",
    });
    assert.equal(runtime.goals.activeMotive("test", goal.id), undefined);
    assert.equal(runtime.goals.motives("test", goal.id)[0]?.status, "rejected");
    const learned = runtime.store.listEvents("test", { type: "product.outcome_learning_recorded" }).at(-1);
    assert.equal((learned!.payload as { appliedToGoalMotive?: boolean }).appliedToGoalMotive, true);
    assert.equal((learned!.payload as { motiveHypothesisId?: string }).motiveHypothesisId, motive.id);
    const outcome = runtime.store.listEvents("test", { type: "goal.motive_outcome_recorded" });
    assert.equal(outcome.length, 1);
    assert.equal((outcome[0]!.payload as { feedbackId?: string }).feedbackId, feedback.id);
    assert.throws(() => runtime.goals.proposeMotive({
      tenantId: "test", goalId: goal.id, hypothesis: motive.hypothesis,
      strongestAlternative: motive.strongestAlternative, falsifier: motive.falsifier, originClass: motive.originClass,
      decisionCues: motive.decisionCues, evidenceEventIds: motive.evidenceEventIds, confidence: motive.confidence,
      sourceEventId: triggerId, allowedEvidenceEventIds: bundle.allowedEventIds,
    }), /cannot quietly reactivate/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("an unmandated stated intention stays recorded without entering foreground accountability context", async () => {
  const home = testHome();
  const requests: ProviderRequest[] = [];
  const adapter: ProviderAdapter = {
    name: "openai-compatible",
    complete: async (request) => {
      requests.push(request);
      const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
      const text = lastUser?.parts.filter((part) => part.type === "text")
        .map((part) => part.type === "text" ? part.text : "").join(" ") ?? "";
      const called = request.messages.some((message) => message.role === "tool"
        && message.parts.some((part) => part.type === "tool_result"));
      if (text === "I will send three customer proposals this week." && !called) {
        return {
          text: "", toolCalls: [{
            id: "call_goal", name: "goal.create", arguments: {
              objective: "Send three customer proposals this week",
              successContract: "Three verified proposal.sent events",
              sourceQuote: "I will send three customer proposals this week",
              gateType: "event", gateConfig: { eventType: "proposal.sent", minimumCount: 3 }, maxContinuations: 0,
            },
          }], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
        };
      }
      return { text: "Understood.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    },
  };
  const config = testConfig(home.path);
  const route = { provider: "openai-compatible" as const, model: "fixture", maxOutputTokens: 512, reasoningEffort: "none" as const };
  config.models = { foreground: route, deliberation: route, background: route, critic: route };
  const runtime = new CoRuntime({ config, providers: new ProviderRegistry([adapter]) });
  try {
    await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member",
      text: "I will send three customer proposals this week.",
    }, { allowedTools: ["goal.create"], requiredTools: ["goal.create"] });
    requests.length = 0;
    const ordinary = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member", text: "This article is beautiful.",
    });
    assert.equal(ordinary.text, "Understood.", "a stated intention remains ordinary conversation without a standards mandate");
    assert.equal(requests.length, 1);
    assert.equal(runtime.goals.list("test", "active").length, 1);
    assert.equal(requests[0]?.tools.some((tool) => tool.name === "goal.reality_check"), false);
    assert.doesNotMatch(requests[0]?.system ?? "", /EXPLICIT OWNER COMMITMENTS/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});
