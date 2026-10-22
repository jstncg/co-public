import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { stableId } from "../src/id.ts";
import { CoRuntime } from "../src/runtime.ts";
import { testConfig, testHome } from "./helpers.ts";

function environment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1", CO_ENV: "test", CO_HOME: home, CO_TENANT: "cli-delivery",
    CO_PROVIDER: "mock", CO_FOREGROUND_PROVIDER: "mock", CO_DELIBERATION_PROVIDER: "mock", CO_BACKGROUND_PROVIDER: "mock",
    CO_CRITIC_PROVIDER: "mock", CO_MEDIA_ANALYZER: "none",
  };
}

test("co delivery reconcile closes an uncertain effect from the CLI without rewriting its history", () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.tenantId = "cli-delivery";
  const runtime = new CoRuntime({ config });
  const intentId = stableId("evt", "cli-delivery-reconcile");
  const requestDigest = stableId("delivery", "cli-delivery-reconcile");
  try {
    runtime.store.appendEvent({
      id: intentId, tenantId: config.tenantId, stream: "run:cli-delivery", type: "message.delivery_started",
      correlationId: "cli-delivery", payload: { channel: "fixture", peerId: "member", content: "CLI proof", requestDigest },
    });
    runtime.store.registerLegacyUncertainOutboundDelivery({
      tenantId: config.tenantId, intentId, requestDigest, channel: "fixture", peerId: "member", error: "ambiguous provider close",
    });
    runtime.close();

    const incomplete = spawnSync(process.execPath, ["src/cli.ts", "delivery", "reconcile", intentId, "--decision", "accepted", "--reason", "provider checked"], {
      cwd: process.cwd(), env: environment(home.path), encoding: "utf8", timeout: 5_000,
    });
    assert.notEqual(incomplete.status, 0);
    assert.match(incomplete.stderr, /requires --provider-id/);

    const command = spawnSync(process.execPath, [
      "src/cli.ts", "delivery", "reconcile", intentId, "--decision", "accepted",
      "--reason", "Exact message found in the provider ledger", "--provider-id", "provider-cli-1",
    ], { cwd: process.cwd(), env: environment(home.path), encoding: "utf8", timeout: 5_000 });
    assert.equal(command.status, 0, command.stderr);
    assert.equal((JSON.parse(command.stdout) as { state: string }).state, "accepted");

    const reopened = new CoRuntime({ config });
    try {
      assert.equal(reopened.store.getOutboundDeliveryState(config.tenantId, intentId), "accepted");
      const history = reopened.store.db.prepare(`SELECT prior_state,decision,provider_message_id,reason
        FROM outbound_delivery_reconciliations WHERE tenant_id=? AND intent_id=?`).get(config.tenantId, intentId) as {
          prior_state: string; decision: string; provider_message_id: string; reason: string;
        };
      assert.deepEqual({ ...history }, {
        prior_state: "uncertain", decision: "accepted", provider_message_id: "provider-cli-1",
        reason: "Exact message found in the provider ledger",
      });
      assert.equal(reopened.store.listEvents(config.tenantId, { type: "message.delivery_started" }).length, 1);
      assert.equal(reopened.store.listEvents(config.tenantId, { type: "message.delivery_reconciled" }).length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    try { runtime.close(); } catch { /* already closed before the CLI opened the same database */ }
    home.cleanup();
  }
});
