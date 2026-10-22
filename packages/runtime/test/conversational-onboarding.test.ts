import assert from "node:assert/strict";
import test from "node:test";
import { ProviderRegistry } from "../src/providers.ts";
import { CoRuntime } from "../src/runtime.ts";
import type { ProviderAdapter, ProviderRequest, ProviderResponse, SensorConfig } from "../src/types.ts";
import { testConfig, testHome } from "./helpers.ts";

const calendar: SensorConfig = {
  id: "calendar.read", pluginId: "calendar", displayName: "Read-only calendar", kind: "calendar",
  purpose: "Notice schedule conflicts and relevant timing.", dataClasses: ["calendar.events"], retentionDays: 14,
  mcpServerName: "calendar", remoteToolName: "list-events", runtimeToolName: "mcp_calendar_list-events",
};

class ConversationalOnboardingProvider implements ProviderAdapter {
  readonly name = "mock" as const;
  readonly systems: string[] = [];
  descriptorHash = "";

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    this.systems.push(request.system);
    const userIndex = request.messages.findLastIndex((message) => message.role === "user");
    const text = request.messages[userIndex]?.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join(" ") ?? "";
    const hasToolResult = request.messages.slice(userIndex + 1).some((message) => message.parts.some((part) => part.type === "tool_result"));
    const response = (text_: string, toolCalls: ProviderResponse["toolCalls"] = []): ProviderResponse => ({
      text: text_, toolCalls, usage: { inputTokens: 20, outputTokens: 12, reasoningTokens: 0 },
    });
    if (/remember.+concise/i.test(text)) {
      if (!hasToolResult) {
        assert.ok(request.tools.some((tool) => tool.name === "memory.remember"));
        return response("", [{ id: "remember_maya", name: "memory.remember", arguments: {
          kind: "preference", statement: "Maya prefers concise updates.", confidence: 1, salience: 0.8,
        } }]);
      }
      return response("Got it — concise updates, and nothing else assumed.");
    }
    if (/calendar/i.test(text)) {
      if (!hasToolResult) {
        assert.ok(request.tools.some((tool) => tool.name === "sensor.consent.grant"));
        return response("", [{ id: "grant_calendar", name: "sensor.consent.grant", arguments: {
          sensorId: calendar.id, descriptorHash: this.descriptorHash,
        } }]);
      }
      return response("Calendar reading is enabled for conflict and timing checks. You can revoke it any time.");
    }
    return response("I’m here. Send me whatever is useful.");
  }
}

test("a fresh non-founder relationship starts in conversation and adds data access only through explicit progressive consent", async () => {
  const home = testHome();
  const config = { ...testConfig(home.path), tenantId: "maya", sensors: [calendar] };
  const provider = new ConversationalOnboardingProvider();
  const runtime = new CoRuntime({ config, providers: new ProviderRegistry([provider]) });
  try {
    provider.descriptorHash = runtime.sensors.get("maya", calendar.id)?.descriptorHash ?? "";
    const first = await runtime.turn({
      tenantId: "maya", channel: "imessage", peerId: "+15555550123",
      text: "Hi, I’m Maya. Please remember that I prefer concise updates. Don’t connect anything else.", externalId: "maya-1",
    });
    assert.equal(first.status, "completed");
    assert.equal(first.text, "Got it — concise updates, and nothing else assumed.");
    assert.equal(runtime.memory.list("maya", { status: "active" })[0]?.statement, "Maya prefers concise updates.");
    assert.equal(runtime.sensors.get("maya", calendar.id)?.consentStatus, "ungranted");
    assert.ok(provider.systems.every((system) => !/Dennis|Donna/i.test(system)));
    assert.match(provider.systems[0] ?? "", /Do not turn a new relationship into an intake questionnaire/);

    const permission = await runtime.turn({
      tenantId: "maya", channel: "imessage", peerId: "+15555550123",
      text: "You can read my calendar when it helps you catch conflicts and timing.", externalId: "maya-2",
    });
    assert.equal(permission.status, "waiting_approval");
    assert.equal(runtime.sensors.get("maya", calendar.id)?.consentStatus, "ungranted");
    const approved = await runtime.resumeApproval(permission.approvalId as string, "approved");
    assert.equal(approved.status, "completed");
    assert.equal(runtime.sensors.get("maya", calendar.id)?.consentStatus, "granted");
    assert.equal(runtime.store.listEvents("maya", { stream: `sensor-consent:${calendar.id}` })[0]?.causationId,
      runtime.store.listEvents("maya", { type: "message.received" })[1]?.id);

    assert.equal(runtime.memory.list("founder", { status: "active" }).length, 0);
    assert.equal(runtime.sensors.get("founder", calendar.id)?.consentStatus, "ungranted");
  } finally {
    await runtime.shutdown();
    home.cleanup();
  }
});
