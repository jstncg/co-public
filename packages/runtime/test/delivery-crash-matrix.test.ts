import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorAdapter } from "../src/connectors.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { CoRuntime } from "../src/runtime.ts";
import type { ProviderAdapter, TapbackType } from "../src/types.ts";
import { RuntimeWorker, RuntimeWorkerCrashFault, type RuntimeWorkerFaultContext, type RuntimeWorkerFaultPoint } from "../src/worker.ts";
import { testConfig, testHome } from "./helpers.ts";

const cases: Array<{
  point: RuntimeWorkerFaultPoint;
  stateAfterCrash?: string;
  providerCallsAfterCrash: number;
  recovery: "accepted" | "uncertain";
}> = [
  { point: "delivery.before_intent_persist", providerCallsAfterCrash: 0, recovery: "accepted" },
  { point: "delivery.after_intent_persist", stateAfterCrash: "not_started", providerCallsAfterCrash: 0, recovery: "accepted" },
  { point: "delivery.after_intent_event", stateAfterCrash: "not_started", providerCallsAfterCrash: 0, recovery: "accepted" },
  { point: "delivery.after_effect_begin", stateAfterCrash: "running", providerCallsAfterCrash: 0, recovery: "uncertain" },
  { point: "delivery.after_provider_response", stateAfterCrash: "running", providerCallsAfterCrash: 1, recovery: "uncertain" },
  { point: "delivery.after_acceptance_event", stateAfterCrash: "running", providerCallsAfterCrash: 1, recovery: "accepted" },
  { point: "delivery.after_acceptance_projection", stateAfterCrash: "accepted", providerCallsAfterCrash: 1, recovery: "accepted" },
  { point: "delivery.after_status_reconciliation", stateAfterCrash: "accepted", providerCallsAfterCrash: 1, recovery: "accepted" },
  { point: "delivery.after_member_projection", stateAfterCrash: "accepted", providerCallsAfterCrash: 1, recovery: "accepted" },
];

test("outbound delivery survives the explicit process-crash boundary matrix without duplicate consequences", async (context) => {
  for (const scenario of cases) {
    await context.test(scenario.point, async () => {
      const home = testHome();
      const config = testConfig(home.path);
      let providerCalls = 0;
      const idempotencyKeys: string[] = [];
      let crashedRuntime: CoRuntime | undefined;
      const adapter: ConnectorAdapter = {
        id: "crash-matrix",
        inboundPrincipal: "trusted-system",
        status: () => ({ id: "crash-matrix", inboundConfigured: false, outboundConfigured: true }),
        verifyWebhook: () => false,
        parseWebhook: () => undefined,
        deliver: async (input) => {
          providerCalls += 1;
          idempotencyKeys.push(input.idempotencyKey ?? "");
          if (scenario.point === "delivery.after_status_reconciliation") {
            crashedRuntime?.store.appendEvent({
              id: "early_status_read", tenantId: "test", stream: "connector:crash-matrix",
              type: "connector.message.read", correlationId: "provider-1",
              payload: { connectorId: "crash-matrix", externalMessageId: "provider-1" },
            });
          }
          return { provider: "crash-matrix", messageId: `provider-${providerCalls}` };
        },
      };
      crashedRuntime = new CoRuntime({ config });
      crashedRuntime.connectors.register(adapter);
      let faultContext: RuntimeWorkerFaultContext | undefined;
      const crashedWorker = new RuntimeWorker(crashedRuntime, {
        videoAnalyzer: null,
        faultInjector: (point, details) => {
          if (point !== scenario.point) return;
          faultContext = details;
          throw new Error("simulated process death");
        },
      });

      try {
        await assert.rejects(
          crashedWorker.smokeConnector({
            tenantId: "test", channel: "crash-matrix", peerId: "+15555550123",
            content: "exactly once", idempotencyKey: `matrix:${scenario.point}`,
          }),
          (error: unknown) => error instanceof RuntimeWorkerCrashFault && error.point === scenario.point,
        );
        assert.ok(faultContext);
        assert.equal(providerCalls, scenario.providerCallsAfterCrash);
        assert.equal(crashedRuntime.store.getOutboundDeliveryState("test", faultContext.intentId), scenario.stateAfterCrash);

        const acceptedBeforeRestart = crashedRuntime.store.listEvents("test", { type: "message.delivery_accepted" }).length;
        assert.equal(acceptedBeforeRestart, scenario.point === "delivery.after_acceptance_event"
          || scenario.point === "delivery.after_acceptance_projection"
          || scenario.point === "delivery.after_status_reconciliation"
          || scenario.point === "delivery.after_member_projection" ? 1 : 0);
        if (scenario.point === "delivery.after_status_reconciliation") {
          const status = crashedRuntime.store.db.prepare("SELECT read_at FROM outbound_deliveries WHERE tenant_id=? AND intent_id=?")
            .get("test", faultContext.intentId) as { read_at: string | null };
          assert.ok(status.read_at, "the authenticated early read status committed before the injected crash");
        }
        if (scenario.stateAfterCrash === "not_started" || scenario.stateAfterCrash === "running") {
          crashedRuntime.store.db.prepare("UPDATE outbound_deliveries SET lease_expires_at=? WHERE tenant_id=? AND intent_id=?")
            .run("2000-01-01T00:00:00.000Z", "test", faultContext.intentId);
        }
        // Process death also expires the relationship-level admission owner;
        // recovery may not steal it while a live process could still initiate
        // the exact transport.
        crashedRuntime.store.db.prepare(`UPDATE relationship_admissions SET lease_expires_at=?
          WHERE tenant_id=? AND delivery_intent_id=? AND status='admitted'`)
          .run("2000-01-01T00:00:00.000Z", "test", faultContext.intentId);

        crashedRuntime.close();
        crashedRuntime = undefined;
        const recoveredRuntime = new CoRuntime({ config });
        recoveredRuntime.connectors.register(adapter);
        try {
          const recovered = await new RuntimeWorker(recoveredRuntime, { videoAnalyzer: null }).smokeConnector({
            tenantId: "test", channel: "crash-matrix", peerId: "+15555550123",
            content: "exactly once", idempotencyKey: `matrix:${scenario.point}`,
          });
          assert.equal(recovered.outcome, scenario.recovery);
          assert.equal(recovered.intentId, faultContext.intentId);
          assert.equal(providerCalls, scenario.recovery === "accepted" ? 1 : scenario.providerCallsAfterCrash,
            "recovery may call the provider only when the durable record proves dispatch never began");
          assert.equal(new Set(idempotencyKeys).size, providerCalls ? 1 : 0);

          const finalState = recoveredRuntime.store.getOutboundDeliveryState("test", recovered.intentId);
          assert.equal(finalState, scenario.recovery);
          const acceptedEvents = recoveredRuntime.store.listEvents("test", { type: "message.delivery_accepted" })
            .filter((event) => event.causationId === recovered.intentId);
          assert.equal(acceptedEvents.length, scenario.recovery === "accepted" ? 1 : 0);
          const relationshipMessages = recoveredRuntime.store.db.prepare(`SELECT COUNT(*) AS count,MAX(delivery_state) AS delivery_state FROM messages
            WHERE tenant_id=? AND event_id IN (SELECT id FROM events WHERE tenant_id=? AND causation_id=? AND type='message.delivery_accepted')`)
            .get("test", "test", recovered.intentId) as { count: number; delivery_state: string | null };
          assert.equal(Number(relationshipMessages.count), scenario.recovery === "accepted" ? 1 : 0,
            "the accepted provider consequence projects into the member relationship exactly once");
          if (scenario.point === "delivery.after_status_reconciliation") assert.equal(relationshipMessages.delivery_state, "read");
          if (scenario.recovery === "uncertain") {
            assert.equal(recoveredRuntime.store.listEvents("test", { type: "message.delivery_uncertain" })
              .filter((event) => event.causationId === recovered.intentId).length, 1);
          }
        } finally {
          recoveredRuntime.close();
        }
      } finally {
        crashedRuntime?.close();
        home.cleanup();
      }
    });
  }
});

test("native reactions survive every delivery crash boundary without duplicate effects or empty text", async (context) => {
  for (const scenario of cases) {
    await context.test(scenario.point, async () => {
      const home = testHome();
      const config = testConfig(home.path);
      let connectorCalls = 0;
      const idempotencyKeys: string[] = [];
      const model: ProviderAdapter = {
        name: "mock",
        complete: async () => ({ text: "Context received.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } }),
      };
      const connector: ConnectorAdapter = {
        id: "reaction-matrix", inboundPrincipal: "trusted-system",
        status: () => ({ id: "reaction-matrix", inboundConfigured: false, outboundConfigured: true }),
        verifyWebhook: () => false, parseWebhook: () => undefined,
        relationship: (peerId) => ({ channel: "imessage", peerId }),
        deliver: async (input) => {
          connectorCalls += 1;
          idempotencyKeys.push(input.idempotencyKey ?? "");
          return input.reaction
            ? { provider: "reaction-matrix", targetMessageId: input.reaction.targetMessageId, reactionType: input.reaction.type }
            : { provider: "reaction-matrix", messageId: `unexpected-${connectorCalls}` };
        },
      };
      let crashedRuntime: CoRuntime | undefined = new CoRuntime({ config, providers: new ProviderRegistry([model]) });
      crashedRuntime.connectors.register(connector);
      const turn = await crashedRuntime.turn({
        tenantId: "test", channel: "reaction-matrix", peerId: "+15555550123",
        text: "A small update.", externalId: "reaction-target",
      });
      const reaction = { type: "emphasize" as TapbackType, targetMessageId: "reaction-target" };
      let faultContext: RuntimeWorkerFaultContext | undefined;
      const crashedWorker = new RuntimeWorker(crashedRuntime, {
        videoAnalyzer: null,
        faultInjector: (point, details) => {
          if (point !== scenario.point) return;
          faultContext = details;
          throw new Error("simulated process death");
        },
      });
      const crashedDeliver = (crashedWorker as unknown as {
        deliverConnector(
          tenantId: string, runId: string, channel: string, peerId: string, content: string, deliveryKey: string,
          replyTo?: string, allowInFlight?: boolean, reaction?: { type: TapbackType; targetMessageId: string },
        ): Promise<string>;
      }).deliverConnector.bind(crashedWorker);

      try {
        await assert.rejects(
          crashedDeliver("test", turn.runId, "reaction-matrix", "+15555550123", "", "reaction-matrix",
            "reaction-target", false, reaction),
          (error: unknown) => error instanceof RuntimeWorkerCrashFault && error.point === scenario.point,
        );
        assert.ok(faultContext);
        assert.equal(connectorCalls, scenario.providerCallsAfterCrash);
        assert.equal(crashedRuntime.store.getOutboundDeliveryState("test", faultContext.intentId), scenario.stateAfterCrash);
        if (scenario.stateAfterCrash === "not_started" || scenario.stateAfterCrash === "running") {
          crashedRuntime.store.db.prepare("UPDATE outbound_deliveries SET lease_expires_at=? WHERE tenant_id=? AND intent_id=?")
            .run("2000-01-01T00:00:00.000Z", "test", faultContext.intentId);
        }

        crashedRuntime.close();
        crashedRuntime = undefined;
        const recoveredRuntime = new CoRuntime({ config, providers: new ProviderRegistry([model]) });
        recoveredRuntime.connectors.register(connector);
        try {
          const recoveredWorker = new RuntimeWorker(recoveredRuntime, { videoAnalyzer: null });
          const recoveredDeliver = (recoveredWorker as unknown as {
            deliverConnector(
              tenantId: string, runId: string, channel: string, peerId: string, content: string, deliveryKey: string,
              replyTo?: string, allowInFlight?: boolean, reaction?: { type: TapbackType; targetMessageId: string },
            ): Promise<string>;
          }).deliverConnector.bind(recoveredWorker);
          const outcome = await recoveredDeliver(
            "test", turn.runId, "reaction-matrix", "+15555550123", "", "reaction-matrix",
            "reaction-target", false, reaction,
          );
          assert.equal(outcome, scenario.recovery);
          assert.equal(connectorCalls, scenario.recovery === "accepted" ? 1 : scenario.providerCallsAfterCrash);
          assert.equal(new Set(idempotencyKeys).size, connectorCalls ? 1 : 0);
          const accepted = recoveredRuntime.store.listEvents("test", { type: "message.reaction_accepted" })
            .filter((event) => event.causationId === faultContext?.intentId);
          assert.equal(accepted.length, scenario.recovery === "accepted" ? 1 : 0);
          const session = recoveredRuntime.store.getRun(turn.runId, "test")?.sessionId;
          assert.ok(session);
          const messages = recoveredRuntime.store.listMessages("test", session);
          const reactions = messages.flatMap((message) => message.parts.filter((part) => part.type === "reaction"));
          assert.equal(reactions.length, scenario.recovery === "accepted" ? 1 : 0);
          if (reactions[0]) assert.deepEqual(reactions[0], { type: "reaction", reaction: "emphasize", targetMessageId: "reaction-target" });
          assert.equal(messages.some((message) => message.role === "assistant"
            && message.parts.some((part) => part.type === "text" && !part.text.trim())), false);
          assert.equal(recoveredRuntime.store.listEvents("test", { type: "relationship.reaction_sent" }).length,
            scenario.recovery === "accepted" ? 1 : 0);
        } finally {
          recoveredRuntime.close();
        }
      } finally {
        crashedRuntime?.close();
        home.cleanup();
      }
    });
  }
});
