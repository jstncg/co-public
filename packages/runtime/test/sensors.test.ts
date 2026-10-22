import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CoRuntime } from "../src/runtime.ts";
import { createRuntimeServer } from "../src/server.ts";
import { SensorConsentManager } from "../src/sensors.ts";
import type { SensorConfig } from "../src/types.ts";
import { testConfig, testHome } from "./helpers.ts";

function calendarSensor(): SensorConfig {
  return {
    id: "fixture.calendar", pluginId: "fixture", displayName: "Fixture calendar", kind: "calendar",
    purpose: "Notice relevant schedule changes without editing the calendar.", dataClasses: ["calendar.events"], retentionDays: 30,
    mcpServerName: "calendar", remoteToolName: "remote-ping", runtimeToolName: "mcp_calendar_remote-ping",
  };
}

test("plugin sensor reads require descriptor-bound progressive consent and revoke immediately", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  const fixture = fileURLToPath(new URL("./fixtures/mcp-server.ts", import.meta.url));
  config.mcpServers = [{
    name: "calendar", transport: "stdio", command: process.execPath, args: [fixture], allowedTools: ["remote-ping"],
    toolRisks: { "remote-ping": "read" }, timeoutMs: 5_000,
  }];
  config.sensors = [calendarSensor()];
  const runtime = new CoRuntime({ config });
  try {
    await runtime.initialize();
    const sensor = runtime.sensors.get("test", "fixture.calendar");
    assert.equal(sensor?.consentStatus, "ungranted");

    const deniedRead = await runtime.turn({
      tenantId: "test", channel: "cli", peerId: "operator-ungranted",
      text: "[[tool:mcp_calendar_remote-ping {}]]",
    }, { allowedTools: ["mcp_calendar_remote-ping"], requiredTools: ["mcp_calendar_remote-ping"] });
    assert.equal(deniedRead.status, "completed");
    const deniedReceipt = runtime.store.db.prepare("SELECT status,error FROM tool_receipts WHERE run_id=?").get(deniedRead.runId) as { status: string; error: string };
    assert.equal(deniedReceipt.status, "failed");
    assert.match(deniedReceipt.error, /explicit consent/);

    const permission = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "+15555550100",
      text: `[[tool:sensor.consent.grant ${JSON.stringify({ sensorId: sensor?.id, descriptorHash: sensor?.descriptorHash })}]]`,
    }, { allowedTools: ["sensor.consent.grant"], requiredTools: ["sensor.consent.grant"] });
    assert.equal(permission.status, "waiting_approval");
    assert.equal(runtime.sensors.get("test", "fixture.calendar")?.consentStatus, "ungranted");
    const granted = await runtime.resumeApproval(permission.approvalId as string, "approved");
    assert.equal(granted.status, "completed");
    assert.equal(runtime.sensors.get("test", "fixture.calendar")?.consentStatus, "granted", JSON.stringify(
      runtime.store.db.prepare("SELECT tool_name,status,error,output_json FROM tool_receipts WHERE run_id=?").all(permission.runId),
    ));

    const allowedRead = await runtime.turn({
      tenantId: "test", channel: "cli", peerId: "operator-granted",
      text: "[[tool:mcp_calendar_remote-ping {}]]",
    }, { allowedTools: ["mcp_calendar_remote-ping"], requiredTools: ["mcp_calendar_remote-ping"] });
    assert.equal(allowedRead.status, "completed");
    const allowedReceipt = runtime.store.db.prepare("SELECT status,output_json FROM tool_receipts WHERE run_id=?").get(allowedRead.runId) as { status: string; output_json: string };
    assert.equal(allowedReceipt.status, "succeeded");
    assert.match(allowedReceipt.output_json, /pong/);
    const sensorEvents = runtime.store.listEvents("test", { stream: `run:${allowedRead.runId}` })
      .filter((event) => event.type.startsWith("tool."));
    assert.equal(JSON.stringify(sensorEvents).includes("pong"), false, "the append-only ledger stores sensor-result digests, not retained raw data");

    runtime.store.db.prepare("UPDATE tool_receipts SET completed_at=? WHERE run_id=?")
      .run("2000-01-01T00:00:00.000Z", allowedRead.runId);
    runtime.store.db.prepare("UPDATE tool_receipts SET completed_at=?,arguments_json=?,error=? WHERE run_id=?")
      .run("2000-01-01T00:00:00.000Z", JSON.stringify({ privateCursor: "sensitive-calendar-cursor" }),
        "provider rejected sensitive-calendar-detail", deniedRead.runId);
    assert.equal(runtime.sensors.enforceRetention("test", new Date("2026-09-04T00:00:00.000Z")), 2);
    const expiredReceipt = runtime.store.db.prepare("SELECT arguments_json,output_json,status FROM tool_receipts WHERE run_id=?")
      .get(allowedRead.runId) as { arguments_json: string; output_json: string | null; status: string };
    assert.equal(expiredReceipt.output_json, null);
    assert.equal((JSON.parse(expiredReceipt.arguments_json) as { expired: boolean }).expired, true);
    assert.equal(expiredReceipt.status, "succeeded", "expiry removes sensor data without rewriting the historical outcome");
    const expiredFailure = runtime.store.db.prepare("SELECT arguments_json,output_json,error,status FROM tool_receipts WHERE run_id=?")
      .get(deniedRead.runId) as { arguments_json: string; output_json: string | null; error: string; status: string };
    assert.equal((JSON.parse(expiredFailure.arguments_json) as { expired: boolean }).expired, true);
    assert.equal(expiredFailure.output_json, null);
    assert.doesNotMatch(expiredFailure.error, /sensitive-calendar/);
    assert.match(expiredFailure.error, /^Sensor error data expired; sha256:/);
    assert.equal(expiredFailure.status, "failed", "failed sensor reads expire data without rewriting their outcome");
    const expiry = runtime.store.listEvents("test", { type: "sensor.data_expired" });
    assert.equal(expiry.length, 2);
    assert.equal(JSON.stringify(expiry).includes("pong"), false);
    assert.equal(JSON.stringify(expiry).includes("sensitive-calendar"), false);
    assert.equal(runtime.sensors.enforceRetention("test", new Date("2026-09-04T00:00:00.000Z")), 0, "expiry is idempotent");

    runtime.sensors.revoke("test", "fixture.calendar");
    assert.throws(() => runtime.sensors.requireGranted("test", "fixture.calendar"), /explicit consent/);
    const consentEvents = runtime.store.listEvents("test", { stream: "sensor-consent:fixture.calendar" });
    assert.deepEqual(consentEvents.map((event) => event.type), ["sensor.consent_granted", "sensor.consent_revoked"]);
  } finally {
    await runtime.shutdown();
    home.cleanup();
  }
});

test("sensor consent becomes stale when a plugin changes what the grant covers", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: { ...testConfig(home.path), sensors: [calendarSensor()] } });
  try {
    const original = runtime.sensors.get("test", "fixture.calendar");
    assert.ok(original);
    runtime.sensors.grant({ tenantId: "test", sensorId: "fixture.calendar", expectedDescriptorHash: original.descriptorHash });
    const changed = new SensorConsentManager(runtime.store, [{ ...calendarSensor(), dataClasses: ["calendar.events", "calendar.attendees"] }]);
    assert.equal(changed.get("test", "fixture.calendar")?.consentStatus, "stale");
    assert.throws(() => changed.requireGranted("test", "fixture.calendar"), /stale/);
    assert.throws(() => changed.grant({
      tenantId: "test", sensorId: "fixture.calendar", expectedDescriptorHash: original.descriptorHash,
    }), /changed before consent/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("the authenticated sensor API binds grants to the descriptor the operator reviewed", async () => {
  const home = testHome();
  const config = { ...testConfig(home.path), sensors: [calendarSensor()], serverToken: "sensor-api-token" };
  const runtime = new CoRuntime({ config });
  const server = createRuntimeServer(runtime);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const authorization = { authorization: "Bearer sensor-api-token" };
    assert.equal((await fetch(`${base}/v1/sensors`)).status, 401);
    const listed = await (await fetch(`${base}/v1/sensors`, { headers: authorization })).json() as Array<{ id: string; descriptorHash: string; consentStatus: string }>;
    assert.equal(listed[0]?.consentStatus, "ungranted");

    const wrong = await fetch(`${base}/v1/sensors/fixture.calendar/actions`, {
      method: "POST", headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ action: "grant", descriptorHash: "0".repeat(64) }),
    });
    assert.equal(wrong.status, 409);
    const granted = await fetch(`${base}/v1/sensors/fixture.calendar/actions`, {
      method: "POST", headers: { ...authorization, "content-type": "application/json" },
      body: JSON.stringify({ action: "grant", descriptorHash: listed[0]?.descriptorHash }),
    });
    assert.equal(granted.status, 200);
    assert.equal((await granted.json() as { consentStatus: string }).consentStatus, "granted");
    const revoked = await fetch(`${base}/v1/sensors/fixture.calendar/actions`, {
      method: "POST", headers: { ...authorization, "content-type": "application/json" }, body: JSON.stringify({ action: "revoke" }),
    });
    assert.equal((await revoked.json() as { consentStatus: string }).consentStatus, "revoked");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.shutdown();
    home.cleanup();
  }
});
