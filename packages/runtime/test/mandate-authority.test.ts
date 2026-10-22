import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { CoRuntime } from "../src/runtime.ts";
import { testConfig, testHome } from "./helpers.ts";

test("a narrow active mandate can authorize only its exact bounded action and use count", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const allowedPath = `${home.path}/mandated.txt`;
    const authority = {
      version: 1,
      rules: [{ toolName: "file.write", argumentEquals: { path: allowedPath }, maxUses: 1 }],
    };
    const mandate = runtime.office.proposeMandate({
      tenantId: "test", name: "One bounded write", serviceContract: "Allow one reviewed write to this exact local path.", authority,
    });
    runtime.office.transitionMandate("test", mandate.id, "active");

    const completed = await runtime.turn({
      tenantId: "test", channel: "cli", peerId: "operator",
      text: `[[tool:file.write ${JSON.stringify({ path: allowedPath, content: "first" })}]]`,
    }, { allowedTools: ["file.write"], requiredTools: ["file.write"] });
    assert.equal(completed.status, "completed");
    assert.equal(readFileSync(allowedPath, "utf8"), "first");
    assert.equal(runtime.store.listApprovals("test").length, 0);
    const use = runtime.store.db.prepare("SELECT mandate_id,tool_name,arguments_hash,rule_index FROM mandate_authority_uses").get() as Record<string, unknown>;
    assert.equal(use.mandate_id, mandate.id);
    assert.equal(use.tool_name, "file.write");
    assert.equal(use.rule_index, 0);
    assert.equal(JSON.stringify(use).includes("first"), false);
    assert.equal(runtime.store.listEvents("test", { stream: `mandate:${mandate.id}` }).some((event) => event.type === "mandate.authority_claimed"), true);

    const exhausted = await runtime.turn({
      tenantId: "test", channel: "cli", peerId: "operator-2",
      text: `[[tool:file.write ${JSON.stringify({ path: allowedPath, content: "second" })}]]`,
    }, { allowedTools: ["file.write"], requiredTools: ["file.write"] });
    assert.equal(exhausted.status, "waiting_approval");
    assert.equal(readFileSync(allowedPath, "utf8"), "first");

    const otherPath = `${home.path}/outside-mandate.txt`;
    const mismatch = await runtime.turn({
      tenantId: "test", channel: "cli", peerId: "operator-3",
      text: `[[tool:file.write ${JSON.stringify({ path: otherPath, content: "outside" })}]]`,
    }, { allowedTools: ["file.write"], requiredTools: ["file.write"] });
    assert.equal(mismatch.status, "waiting_approval");
    assert.equal(existsSync(otherPath), false);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("paused, retired, expired, malformed, and cross-tenant mandates fail closed", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    assert.throws(() => runtime.office.proposeMandate({
      tenantId: "test", name: "Broad", serviceContract: "This malformed rule must not become authority.",
      authority: { version: 1, rules: [{ toolName: "file.write", argumentEquals: {}, maxUses: 10 }] },
    }), /non-empty argumentEquals/);
    assert.throws(() => runtime.office.proposeMandate({
      tenantId: "test", name: "Unbounded", serviceContract: "This oversized use count must not become authority.",
      authority: { version: 1, rules: [{ toolName: "file.write", argumentEquals: { path: `${home.path}/x` }, maxUses: 1001 }] },
    }), /maxUses/);
    assert.throws(() => runtime.office.proposeMandate({
      tenantId: "test", name: "Recursive authority", serviceContract: "A mandate must never approve more standing authority.",
      authority: { version: 1, rules: [{ toolName: "mandate.activate", argumentEquals: { mandateId: "mnd_other" }, maxUses: 1 }] },
    }), /cannot grant authority to activate another mandate/);

    const target = `${home.path}/revoked.txt`;
    const mandate = runtime.office.proposeMandate({
      tenantId: "test", name: "Revocable", serviceContract: "Allow a bounded write only while this mandate remains active.",
      authority: { version: 1, rules: [{ toolName: "file.write", argumentEquals: { path: target }, maxUses: 5 }] },
    });
    runtime.office.transitionMandate("test", mandate.id, "active");
    runtime.office.transitionMandate("test", mandate.id, "retired");
    const revoked = await runtime.turn({
      tenantId: "test", channel: "cli", peerId: "operator",
      text: `[[tool:file.write ${JSON.stringify({ path: target, content: "no" })}]]`,
    }, { allowedTools: ["file.write"], requiredTools: ["file.write"] });
    assert.equal(revoked.status, "waiting_approval");
    assert.equal(existsSync(target), false);

    const other = runtime.office.proposeMandate({
      tenantId: "other", name: "Other tenant", serviceContract: "Never authorize the configured tenant.",
      authority: { version: 1, rules: [{ toolName: "file.write", argumentEquals: { path: target }, maxUses: 5 }] },
    });
    runtime.office.transitionMandate("other", other.id, "active");
    assert.equal(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM mandate_authority_uses WHERE tenant_id='other'").get()!.count, 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("the owner can activate through an exact approval and revoke through the current conversation", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const mandate = runtime.office.proposeMandate({
      tenantId: "test", name: "Calendar watcher", serviceContract: "Watch the calendar and prepare relevant context.",
      authority: { version: 1, rules: [{ toolName: "clock.now", argumentEquals: { timezone: "UTC" }, maxUses: 10 }] },
    });
    const requested = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member",
      text: `Yes, activate that mandate. [[tool:mandate.activate ${JSON.stringify({ mandateId: mandate.id })}]]`,
    }, { allowedTools: ["mandate.activate"], requiredTools: ["mandate.activate"] });
    assert.equal(requested.status, "waiting_approval");
    assert.ok(requested.approvalId);
    assert.equal(runtime.office.getMandate("test", mandate.id)?.status, "proposed");
    const approval = runtime.store.getApproval(requested.approvalId);
    assert.equal(approval?.toolName, "mandate.activate");
    assert.deepEqual(approval?.arguments, { mandateId: mandate.id });

    const activated = await runtime.resumeApproval(requested.approvalId, "approved");
    assert.equal(activated.status, "completed");
    assert.equal(runtime.office.getMandate("test", mandate.id)?.status, "active");

    const retired = await runtime.turn({
      tenantId: "test", channel: "imessage", peerId: "member",
      text: `Stop watching my calendar. [[tool:mandate.transition ${JSON.stringify({
        mandateId: mandate.id, action: "retire", sourceQuote: "Stop watching my calendar",
      })}]]`,
    }, { allowedTools: ["mandate.transition"], requiredTools: ["mandate.transition"] });
    assert.equal(retired.status, "completed");
    assert.equal(runtime.office.getMandate("test", mandate.id)?.status, "retired");
    const event = runtime.store.listEvents("test", { type: "mandate.retired" }).at(-1);
    assert.equal((event!.payload as { ownerSourceQuote?: string }).ownerSourceQuote, "Stop watching my calendar");
    assert.equal(runtime.store.getEvent("test", event?.causationId ?? "")?.type, "message.received");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a stale concurrent pause cannot resurrect a mandate retired by another database connection", () => {
  const home = testHome();
  const first = new CoRuntime({ config: testConfig(home.path) });
  const second = new CoRuntime({ config: testConfig(home.path) });
  try {
    const mandate = first.office.proposeMandate({
      tenantId: "test", name: "Permanent retirement", serviceContract: "Retirement must win over a stale lifecycle writer.",
      authority: { version: 1, rules: [{ toolName: "clock.now", argumentEquals: { timezone: "UTC" }, maxUses: 10 }] },
    });
    first.office.transitionMandate("test", mandate.id, "active");

    const readThroughSecondConnection = second.office.getMandate.bind(second.office);
    let interleaved = false;
    second.office.getMandate = (tenantId, mandateId) => {
      const stale = readThroughSecondConnection(tenantId, mandateId);
      if (!interleaved) {
        interleaved = true;
        first.office.transitionMandate("test", mandate.id, "retired");
      }
      return stale;
    };

    assert.throws(
      () => second.office.transitionMandate("test", mandate.id, "paused"),
      /changed concurrently from active to retired/,
    );
    assert.equal(first.office.getMandate("test", mandate.id)?.status, "retired");
    assert.equal(first.store.listEvents("test", { stream: `mandate:${mandate.id}`, type: "mandate.paused" }).length, 0);
    assert.equal(first.store.listEvents("test", { stream: `mandate:${mandate.id}`, type: "mandate.retired" }).length, 1);
  } finally {
    first.close();
    second.close();
    home.cleanup();
  }
});

test("mandate revocation rejects invented or cross-tenant owner words and is unavailable backstage", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const mandate = runtime.office.proposeMandate({
      tenantId: "test", name: "Revocation provenance", serviceContract: "Remain active until the actual owner revokes it.",
      authority: { version: 1, rules: [{ toolName: "clock.now", argumentEquals: { timezone: "UTC" }, maxUses: 10 }] },
    });
    runtime.office.transitionMandate("test", mandate.id, "active");
    const foreignEvent = runtime.store.appendEvent({
      tenantId: "other", stream: "session:foreign-proof", type: "message.received", payload: { channel: "imessage" },
    });
    const foreignSession = runtime.store.ensureSession("other", "imessage", "foreign-proof");
    runtime.store.addMessage("other", foreignSession.id, {
      id: "foreign_mandate_message", role: "user", parts: [{ type: "text", text: "Stop this mandate now." }],
      phase: "final", createdAt: foreignEvent.at,
    }, foreignEvent.id);
    assert.throws(() => runtime.office.transitionMandateFromOwner({
      tenantId: "test", mandateId: mandate.id, action: "retire", sourceEventId: foreignEvent.id,
      sourceQuote: "Stop this mandate now",
    }), /current owner message/);

    const ownerEvent = runtime.store.appendEvent({
      tenantId: "test", stream: "session:owner-proof", type: "message.received", payload: { channel: "imessage" },
    });
    const session = runtime.store.ensureSession("test", "imessage", "owner-proof");
    runtime.store.addMessage("test", session.id, {
      id: "owner_mandate_message", role: "user", parts: [{ type: "text", text: "Keep this service running." }],
      phase: "final", createdAt: ownerEvent.at,
    }, ownerEvent.id);
    assert.throws(() => runtime.office.transitionMandateFromOwner({
      tenantId: "test", mandateId: mandate.id, action: "retire", sourceEventId: ownerEvent.id,
      sourceQuote: "Stop this mandate now",
    }), /verbatim quote/);
    assert.equal(runtime.office.getMandate("test", mandate.id)?.status, "active");
    assert.equal(runtime.distribution.backgroundToolNames.includes("mandate.activate"), false);
    assert.equal(runtime.distribution.backgroundToolNames.includes("mandate.transition"), false);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("revocation between a standing-authority claim and effect initiation fails closed", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const target = `${home.path}/revoked-at-boundary.txt`;
    const mandate = runtime.office.proposeMandate({
      tenantId: "test", name: "Boundary revocation", serviceContract: "The exact write is allowed only until this mandate is revoked.",
      authority: { version: 1, rules: [{ toolName: "file.write", argumentEquals: { path: target }, maxUses: 1 }] },
    });
    runtime.office.transitionMandate("test", mandate.id, "active");
    const claim = runtime.office.claimStandingAuthority.bind(runtime.office);
    runtime.office.claimStandingAuthority = (input) => {
      const result = claim(input);
      if (result) runtime.office.transitionMandate("test", mandate.id, "retired");
      return result;
    };

    const result = await runtime.turn({
      tenantId: "test", channel: "cli", peerId: "operator",
      text: `[[tool:file.write ${JSON.stringify({ path: target, content: "must not execute" })}]]`,
    }, { allowedTools: ["file.write"], requiredTools: ["file.write"] });
    assert.equal(result.status, "failed");
    assert.match(result.text, /revoked or expired before the effect began/);
    assert.equal(existsSync(target), false);
    const receipt = runtime.store.db.prepare("SELECT status,effect_state,error FROM tool_receipts WHERE tenant_id=? AND run_id=?")
      .get("test", result.runId) as { status: string; effect_state: string; error: string };
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.effect_state, "failed");
    assert.match(receipt.error, /revoked or expired/);
    assert.equal(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM mandate_authority_uses WHERE tenant_id=? AND mandate_id=?")
      .get("test", mandate.id)!.count, 1, "the claimed authority remains append-only evidence even though no effect began");
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a stale run lease cannot consume standing mandate authority", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const target = `${home.path}/stale-worker.txt`;
    const mandate = runtime.office.proposeMandate({
      tenantId: "test", name: "Lease fenced", serviceContract: "Only the live run owner may consume this authority.",
      authority: { version: 1, rules: [{ toolName: "file.write", argumentEquals: { path: target }, maxUses: 1 }] },
    });
    runtime.office.transitionMandate("test", mandate.id, "active");
    const session = runtime.store.ensureSession("test", "cli", "stale-worker");
    const current = new Date().toISOString();
    runtime.store.createRun({
      id: "run_stale_mandate", tenantId: "test", sessionId: session.id, kind: "background", status: "running", modelRole: "background",
      input: "stale authority", state: {
        system: "test", messages: [], authorityToolNames: ["file.write"], toolNames: ["file.write"],
        modelRoute: { provider: "mock", model: "mock-1", maxOutputTokens: 128, reasoningEffort: "none" },
        iteration: 0, pendingCalls: [], nextToolIndex: 0, depth: 0, tokenBudget: 1_000,
      }, inputTokens: 0, outputTokens: 0, createdAt: current, updatedAt: current,
    });
    const staleLease = runtime.store.acquireRunLease("test", "run_stale_mandate", 1_000);
    assert.ok(staleLease);
    runtime.store.db.prepare("UPDATE runs SET lease_expires_at=? WHERE tenant_id=? AND id=?")
      .run(new Date(Date.now() - 1_000).toISOString(), "test", "run_stale_mandate");
    const replacementLease = runtime.store.acquireRunLease("test", "run_stale_mandate", 30_000);
    assert.ok(replacementLease);
    assert.notEqual(replacementLease, staleLease);

    const staleClaim = runtime.office.claimStandingAuthority({
      tenantId: "test", runId: "run_stale_mandate", runLeaseToken: staleLease,
      toolCallId: "call-stale", toolName: "file.write", arguments: { path: target, content: "no" },
    });
    assert.equal(staleClaim, undefined);
    assert.equal(runtime.store.db.prepare("SELECT COUNT(*) AS count FROM mandate_authority_uses WHERE tenant_id=? AND mandate_id=?")
      .get("test", mandate.id)!.count, 0);
    assert.equal(existsSync(target), false);
  } finally {
    runtime.close();
    home.cleanup();
  }
});
