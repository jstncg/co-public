import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ActionApprovalClaim,
  ActionExecutorResult,
  ActionInputClaim,
  ActionRunRequest,
} from "@co/contracts";
import {
  ActionExecutorRegistry,
  ActionRunner,
  hashActionRequest,
  InMemoryActionJournal,
  InMemoryActionMonitor,
} from "../src/index";
import type { ActionExecutionContext, ActionExecutor } from "../src/index";

const tenantId = "11111111-1111-4111-8111-111111111111";
const moveId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const approvalId = "44444444-4444-4444-8444-444444444444";
const inputRef = "55555555-5555-4555-8555-555555555555";
const vaultRef = "66666666-6666-4666-8666-666666666666";
const now = new Date("2026-08-29T16:00:00Z");

function baseRequest(overrides: Partial<ActionRunRequest["assignment"]> = {}): ActionRunRequest {
  return {
    version: "action-run.v1",
    tenant_id: tenantId,
    source_move_id: moveId,
    idempotency_key: `action:${randomUUID()}`,
    objective: "Prepare the selected reservation and stop at the final commitment.",
    assignment: {
      worker_kind: "browser",
      adapter: "fake_browser",
      effect: "reversible_external",
      authority: "execute_after_approval",
      capabilities: ["web.navigate", "web.read", "web.submit"],
      approval_bound_capabilities: ["web.submit"],
      target: {
        start_url: "https://book.example.test/start",
        allowed_origins: ["https://book.example.test"],
      },
      public_input: { party_size: 2, date: "2026-09-01" },
      vault_refs: [],
      ...overrides,
    },
    expires_at: "2026-08-29T17:00:00Z",
  };
}

function receipt(context: ActionExecutionContext, overrides: Record<string, unknown> = {}) {
  return {
    run_id: context.run_id,
    source_move_id: context.source_move_id,
    request_hash: context.request_hash,
    approval_fingerprint: context.active_approval_fingerprint,
    effect: context.assignment.effect,
    outcome: "completed",
    summary: "Reservation completed and independently re-read from the confirmation page.",
    verification: {
      status: "verified",
      method: "confirmation_page",
      checked_at: now.toISOString(),
    },
    evidence: [
      {
        kind: "provider_receipt",
        ref: "confirmation:abc123",
        label: "Confirmation number",
        captured_at: now.toISOString(),
      },
    ],
    rollback: {
      available: true,
      expires_at: "2026-08-30T16:00:00Z",
      instruction: "Cancel with confirmation abc123.",
    },
    completed_at: now.toISOString(),
    ...overrides,
  };
}

class ApprovalExecutor implements ActionExecutor {
  readonly manifest = {
    worker_kind: "browser" as const,
    adapter: "fake_browser",
    supported_capabilities: ["web.navigate", "web.read", "web.submit"],
    can_message_user: false as const,
    secret_transport: "opaque_refs" as const,
    untrusted_content: "data_only" as const,
    capability_enforcement: "per_invocation" as const,
    network_policy: "allowlist" as const,
    supports_pause_resume: true,
    supports_reconciliation: true as const,
  };
  resumeCalls = 0;
  resolution: unknown;
  completionOverride: Record<string, unknown> = {};
  beginCapabilities: string[] = [];
  resumeCapabilities: string[] = [];

  async begin(context: ActionExecutionContext): Promise<ActionExecutorResult> {
    this.beginCapabilities = context.assignment.authorized_capabilities;
    return {
      kind: "blocked",
      checkpoint_ref: "checkpoint:approval:one",
      blocker: {
        type: "approval",
        step_id: "submit_reservation",
        prompt: "Confirm this exact reservation.",
        request_hash: context.request_hash,
        effect_fingerprint: "b".repeat(64),
        expires_at: "2026-08-29T16:30:00Z",
      },
    };
  }

  async resume(
    context: ActionExecutionContext,
    _checkpoint: string,
    resolution: unknown,
  ): Promise<ActionExecutorResult> {
    this.resumeCalls += 1;
    this.resolution = resolution;
    this.resumeCapabilities = context.assignment.authorized_capabilities;
    return {
      kind: "completed",
      receipt: receipt(context, this.completionOverride),
    } as ActionExecutorResult;
  }

  async cancel(_context: Omit<ActionExecutionContext, "signal">, _checkpoint: string | null) {}

  async reconcile(context: ActionExecutionContext): Promise<ActionExecutorResult> {
    return {
      kind: "completed",
      receipt: receipt(context, this.completionOverride),
    } as ActionExecutorResult;
  }
}

function runnerFor(
  executor: ActionExecutor,
  claims: { approval?: ActionApprovalClaim; input?: ActionInputClaim } = {},
) {
  const monitor = new InMemoryActionMonitor();
  const runner = new ActionRunner(new ActionExecutorRegistry().register(executor), monitor, {
    now: () => now,
    idFactory: () => runId,
    approvalVerifier: { verify: async () => claims.approval ?? null },
    inputVerifier: { verify: async () => claims.input ?? null },
    vaultVerifier: {
      verify: async (reference, scope) => reference.id === vaultRef && scope.tenant_id === tenantId,
    },
  });
  return { runner, monitor };
}

describe("governed action harness", () => {
  it("resumes the same isolated worker only after an exact approval and records a verified receipt", async () => {
    const executor = new ApprovalExecutor();
    const request = baseRequest();
    const requestHash = hashActionRequest(request);
    const claims: { approval?: ActionApprovalClaim } = {};
    const { runner, monitor } = runnerFor(executor, claims);
    const blocked = await runner.start(request);
    expect(blocked).toMatchObject({
      state: "waiting_for_approval",
      checkpoint_ref: "checkpoint:approval:one",
    });
    claims.approval = {
      approval_id: approvalId,
      tenant_id: tenantId,
      run_id: runId,
      source_move_id: moveId,
      request_hash: requestHash,
      step_id: "submit_reservation",
      effect_fingerprint: "b".repeat(64),
      effect: "reversible_external",
      approved_capabilities: request.assignment.approval_bound_capabilities,
      approved_at: "2026-08-29T15:59:00Z",
      expires_at: "2026-08-29T16:20:00Z",
    };
    const completed = await runner.resume(blocked, { type: "approval", approval_id: approvalId });
    expect(completed).toMatchObject({
      state: "succeeded",
      checkpoint_ref: null,
      blocker: null,
      approval_ids: [approvalId],
      receipt: { verification: { status: "verified" }, rollback: { available: true } },
    });
    expect(executor.resolution).toEqual({ type: "approval", approval_id: approvalId });
    expect(executor.beginCapabilities).toEqual(["web.navigate", "web.read"]);
    expect(executor.resumeCapabilities).toEqual(["web.navigate", "web.read", "web.submit"]);
    expect(monitor.list(runId).map((event) => event.event_type)).toEqual([
      "action_queued",
      "action_started",
      "action_blocked",
      "action_resumed",
      "action_completed",
    ]);
    expect(
      monitor.list(runId).every((event) => !JSON.stringify(event).includes("party_size")),
    ).toBe(true);
  });

  it("rejects an approval bound to another request before the worker can resume", async () => {
    const executor = new ApprovalExecutor();
    const request = baseRequest();
    const claims: { approval?: ActionApprovalClaim } = {};
    const { runner } = runnerFor(executor, claims);
    const blocked = await runner.start(request);
    claims.approval = {
      approval_id: approvalId,
      tenant_id: tenantId,
      run_id: runId,
      source_move_id: moveId,
      request_hash: "a".repeat(64),
      step_id: "submit_reservation",
      effect_fingerprint: "b".repeat(64),
      effect: "reversible_external",
      approved_capabilities: request.assignment.approval_bound_capabilities,
      approved_at: "2026-08-29T15:59:00Z",
      expires_at: "2026-08-29T16:20:00Z",
    };
    await expect(
      runner.resume(blocked, { type: "approval", approval_id: approvalId }),
    ).rejects.toThrow(/not bound to this exact action/);
    expect(executor.resumeCalls).toBe(0);
  });

  it("fails closed when completion is unverified or a reversible act has no rollback", async () => {
    const request = baseRequest({
      effect: "prepare",
      authority: "prepare",
      approval_bound_capabilities: [],
    });
    class CompletionExecutor extends ApprovalExecutor {
      override async begin(context: ActionExecutionContext): Promise<ActionExecutorResult> {
        return {
          kind: "completed",
          receipt: receipt(context, {
            effect: "prepare",
            verification: {
              status: "unverified",
              method: "worker_claim",
              checked_at: now.toISOString(),
            },
            rollback: null,
          }),
        } as ActionExecutorResult;
      }
    }
    const { runner } = runnerFor(new CompletionExecutor());
    await expect(runner.start(request)).resolves.toMatchObject({
      state: "failed",
      failure: { code: "outcome_unverified" },
      receipt: null,
    });

    const external = new ApprovalExecutor();
    external.completionOverride = { rollback: null };
    const externalRequest = baseRequest();
    const claims: { approval?: ActionApprovalClaim } = {};
    const harness = runnerFor(external, claims);
    const blocked = await harness.runner.start(externalRequest);
    claims.approval = {
      approval_id: approvalId,
      tenant_id: tenantId,
      run_id: runId,
      source_move_id: moveId,
      request_hash: hashActionRequest(externalRequest),
      effect: "reversible_external",
      step_id: "submit_reservation",
      effect_fingerprint: "b".repeat(64),
      approved_capabilities: externalRequest.assignment.approval_bound_capabilities,
      approved_at: "2026-08-29T15:59:00Z",
      expires_at: "2026-08-29T16:20:00Z",
    };
    await expect(
      harness.runner.resume(blocked, { type: "approval", approval_id: approvalId }),
    ).resolves.toMatchObject({ state: "failed", failure: { code: "rollback_missing" } });
  });

  it("rejects a completion receipt for a different approved effect", async () => {
    const executor = new ApprovalExecutor();
    executor.completionOverride = { approval_fingerprint: "c".repeat(64) };
    const request = baseRequest();
    const claims: { approval?: ActionApprovalClaim } = {};
    const { runner } = runnerFor(executor, claims);
    const blocked = await runner.start(request);
    claims.approval = {
      approval_id: approvalId,
      tenant_id: tenantId,
      run_id: runId,
      source_move_id: moveId,
      request_hash: hashActionRequest(request),
      step_id: "submit_reservation",
      effect_fingerprint: "b".repeat(64),
      effect: "reversible_external",
      approved_capabilities: request.assignment.approval_bound_capabilities,
      approved_at: "2026-08-29T15:59:00Z",
      expires_at: "2026-08-29T16:20:00Z",
    };
    await expect(
      runner.resume(blocked, { type: "approval", approval_id: approvalId }),
    ).resolves.toMatchObject({ state: "failed", failure: { code: "approval_receipt_mismatch" } });
  });

  it("passes sensitive challenges and credentials only as opaque references", async () => {
    class SensitiveExecutor extends ApprovalExecutor {
      readonly seen: unknown[] = [];
      readonly seenInputRefs: unknown[] = [];
      override async begin(): Promise<ActionExecutorResult> {
        return {
          kind: "blocked",
          checkpoint_ref: "checkpoint:user-input:one",
          blocker: {
            type: "user_input",
            challenge_id: "login-otp",
            input_kind: "otp",
            prompt: "Enter the code from the provider.",
            expires_at: "2026-08-29T16:10:00Z",
          },
        };
      }
      override async resume(
        context: ActionExecutionContext,
        _checkpoint: string,
        resolution: unknown,
      ): Promise<ActionExecutorResult> {
        this.seen.push(resolution);
        this.seenInputRefs.push(context.resolved_input_refs);
        return {
          kind: "completed",
          receipt: receipt(context, { effect: "prepare", rollback: null }),
        } as ActionExecutorResult;
      }
    }
    const executor = new SensitiveExecutor();
    const request = baseRequest({
      effect: "prepare",
      authority: "prepare",
      approval_bound_capabilities: [],
    });
    const claims = {
      input: {
        input_ref: inputRef,
        tenant_id: tenantId,
        run_id: runId,
        challenge_id: "login-otp",
        expires_at: "2026-08-29T16:10:00Z",
      },
    };
    const { runner } = runnerFor(executor, claims);
    const blocked = await runner.start(request);
    await expect(
      runner.resume(blocked, {
        type: "user_input",
        challenge_id: "login-otp",
        input_ref: inputRef,
      }),
    ).resolves.toMatchObject({ state: "succeeded" });
    expect(executor.seen).toEqual([
      { type: "user_input", challenge_id: "login-otp", input_ref: inputRef },
    ]);
    expect(executor.seenInputRefs).toEqual([[{ challenge_id: "login-otp", input_ref: inputRef }]]);
    expect(JSON.stringify(executor.seen)).not.toContain("123456");
  });

  it("adds a tenant-verified vault handle to the resumed worker without exposing a secret", async () => {
    class VaultExecutor extends ApprovalExecutor {
      seenVaultRefs: unknown;
      override async begin(): Promise<ActionExecutorResult> {
        return {
          kind: "blocked",
          checkpoint_ref: "checkpoint:vault-setup:one",
          blocker: {
            type: "vault_setup",
            kind: "credential",
            purpose: "reservation account",
            prompt: "Connect the reservation account.",
          },
        };
      }
      override async resume(context: ActionExecutionContext): Promise<ActionExecutorResult> {
        this.seenVaultRefs = context.assignment.vault_refs;
        return {
          kind: "completed",
          receipt: receipt(context, { effect: "prepare", rollback: null }),
        } as ActionExecutorResult;
      }
    }
    const executor = new VaultExecutor();
    const request = baseRequest({
      effect: "prepare",
      authority: "prepare",
      approval_bound_capabilities: [],
    });
    const { runner } = runnerFor(executor);
    const blocked = await runner.start(request);
    await expect(
      runner.resume(blocked, {
        type: "vault_setup",
        vault_ref: { id: vaultRef, kind: "credential", purpose: "reservation account" },
      }),
    ).resolves.toMatchObject({ state: "succeeded" });
    expect(executor.seenVaultRefs).toEqual([
      { id: vaultRef, kind: "credential", purpose: "reservation account" },
    ]);
    expect(JSON.stringify(executor.seenVaultRefs)).not.toMatch(/password|token|secret/i);
  });

  it("cancels a persistent checkpoint and keeps cancellation inspectable", async () => {
    const executor = new ApprovalExecutor();
    let cancelledCheckpoint: string | null | undefined;
    executor.cancel = async (_context, checkpoint) => {
      cancelledCheckpoint = checkpoint;
    };
    const { runner, monitor } = runnerFor(executor);
    const blocked = await runner.start(baseRequest());
    const cancelled = await runner.cancel(blocked);
    expect(cancelled).toMatchObject({ state: "cancelled", checkpoint_ref: null, blocker: null });
    expect(cancelledCheckpoint).toBe("checkpoint:approval:one");
    expect(monitor.list(runId).at(-1)?.event_type).toBe("action_cancelled");
  });

  it("deduplicates starts and can reconcile a worker after a coordinator crash", async () => {
    class RecoverableExecutor extends ApprovalExecutor {
      begins = 0;
      reconciliations = 0;
      override async begin(context: ActionExecutionContext): Promise<ActionExecutorResult> {
        this.begins += 1;
        return super.begin(context);
      }
      override async reconcile(context: ActionExecutionContext): Promise<ActionExecutorResult> {
        this.reconciliations += 1;
        return {
          kind: "completed",
          receipt: receipt(context, { effect: "prepare", rollback: null }),
        } as ActionExecutorResult;
      }
    }
    const executor = new RecoverableExecutor();
    const { runner, monitor } = runnerFor(executor);
    const request = baseRequest();
    const first = await runner.start(request);
    const duplicate = await runner.start(request);
    expect(duplicate).toEqual(first);
    expect(executor.begins).toBe(1);

    const interrupted = {
      ...first,
      state: "running" as const,
      checkpoint_ref: null,
      blocker: null,
    };
    // Simulate the atomic journal state that existed immediately before a process died.
    const journalState = await monitor.load(tenantId, runId);
    expect(journalState?.state).toBe("waiting_for_approval");
    await expect(runner.reconcile(interrupted)).rejects.toThrow(/stale or tampered/);
    expect(executor.reconciliations).toBe(0);

    const recoveryRequest = baseRequest({
      effect: "prepare",
      authority: "prepare",
      approval_bound_capabilities: [],
    });
    const recoveryRunId = "77777777-7777-4777-8777-777777777777";
    const recoverySnapshot = {
      version: "action-snapshot.v1" as const,
      run_id: recoveryRunId,
      request: recoveryRequest,
      request_hash: hashActionRequest(recoveryRequest),
      state: "running" as const,
      next_sequence: 0,
      checkpoint_ref: null,
      blocker: null,
      receipt: null,
      failure: null,
      approval_ids: [],
      active_approval_fingerprint: null,
      resolved_input_refs: [],
      resolved_vault_refs: [],
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    const recoveryJournal = new InMemoryActionJournal();
    await recoveryJournal.initialize(recoverySnapshot);
    const recoveryRunner = new ActionRunner(
      new ActionExecutorRegistry().register(executor),
      recoveryJournal,
      { now: () => now },
    );
    await expect(recoveryRunner.reconcile(recoverySnapshot)).resolves.toMatchObject({
      state: "succeeded",
    });
    expect(executor.reconciliations).toBe(1);
    expect(recoveryJournal.list(recoveryRunId).map((event) => event.event_type)).toEqual([
      "action_recovering",
      "action_completed",
    ]);
  });
});
