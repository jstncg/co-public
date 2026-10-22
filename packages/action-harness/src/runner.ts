import { randomUUID } from "node:crypto";
import {
  actionApprovalClaimSchema,
  actionEventSchema,
  actionExecutorManifestSchema,
  actionExecutorResultSchema,
  actionInputClaimSchema,
  actionResumeRequestSchema,
  actionRunRequestSchema,
  actionRunSnapshotSchema,
} from "@co/contracts";
import type {
  ActionBlocker,
  ActionEvent,
  ActionExecutorResult,
  ActionResumeRequest,
  ActionRunRequest,
  ActionRunSnapshot,
} from "@co/contracts";
import { hashActionRequest } from "./hash";
import type { ActionExecutorRegistry } from "./registry";
import type { ActionExecutionContext, ActionRunJournal, ActionRunnerDependencies } from "./types";

function messageFor(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 1_000) : "action executor failed";
}

function waitingState(blocker: ActionBlocker): ActionRunSnapshot["state"] {
  if (blocker.type === "approval") return "waiting_for_approval";
  if (blocker.type === "user_input") return "waiting_for_input";
  return "waiting_for_vault";
}

export class ActionRunner {
  readonly #now: () => Date;
  readonly #idFactory: () => string;

  constructor(
    private readonly executors: ActionExecutorRegistry,
    private readonly journal: ActionRunJournal,
    private readonly dependencies: ActionRunnerDependencies = {},
  ) {
    this.#now = dependencies.now ?? (() => new Date());
    this.#idFactory = dependencies.idFactory ?? randomUUID;
  }

  async start(unknownRequest: unknown, options: { signal?: AbortSignal } = {}) {
    const request = actionRunRequestSchema.parse(unknownRequest);
    const now = this.#now();
    if (new Date(request.expires_at) <= now) throw new Error("action request has expired");
    const executor = this.#resolveExecutor(request);
    const runId = this.#idFactory();
    const requestHash = hashActionRequest(request);
    const createdAt = now.toISOString();
    let snapshot: ActionRunSnapshot = {
      version: "action-snapshot.v1",
      run_id: runId,
      request,
      request_hash: requestHash,
      state: "queued",
      next_sequence: 0,
      checkpoint_ref: null,
      blocker: null,
      receipt: null,
      failure: null,
      approval_ids: [],
      active_approval_fingerprint: null,
      resolved_input_refs: [],
      resolved_vault_refs: [],
      created_at: createdAt,
      updated_at: createdAt,
    };
    const initialized = await this.journal.initialize(snapshot);
    if (!initialized.created) {
      if (initialized.snapshot.request_hash !== requestHash)
        throw new Error("action idempotency collision");
      return actionRunSnapshotSchema.parse(initialized.snapshot);
    }
    snapshot = await this.#emit(snapshot, "action_queued", "queued", {
      worker_kind: request.assignment.worker_kind,
      effect: request.assignment.effect,
    });
    try {
      await this.#verifyVaultReferences(snapshot);
    } catch (error) {
      return this.#fail(snapshot, "vault_reference_invalid", messageFor(error), false);
    }
    snapshot = await this.#emit(snapshot, "action_started", "running", {
      adapter: request.assignment.adapter,
    });
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) return this.#cancelSnapshot(snapshot, executor, null);
    let result: ActionExecutorResult;
    try {
      result = actionExecutorResultSchema.parse(
        await executor.begin(this.#context(snapshot, signal)),
      );
    } catch (error) {
      return this.#fail(snapshot, "executor_error", messageFor(error), false);
    }
    return this.#settle(snapshot, result);
  }

  async resume(
    unknownSnapshot: unknown,
    unknownResolution: unknown,
    options: { signal?: AbortSignal } = {},
  ) {
    let snapshot = await this.#loadCanonicalSnapshot(unknownSnapshot);
    const resolution = actionResumeRequestSchema.parse(unknownResolution);
    this.#assertSnapshotIntegrity(snapshot);
    if (
      !["waiting_for_approval", "waiting_for_input", "waiting_for_vault"].includes(snapshot.state)
    ) {
      throw new Error(`cannot resume action in ${snapshot.state} state`);
    }
    if (new Date(snapshot.request.expires_at) <= this.#now())
      return this.#fail(snapshot, "request_expired", "action request expired", false);
    const blocker = snapshot.blocker;
    if (!blocker) throw new Error("waiting action has no blocker");
    if (blocker.type !== "vault_setup" && new Date(blocker.expires_at) <= this.#now()) {
      return this.#fail(snapshot, "blocker_expired", "action blocker expired", false);
    }
    if (resolution.type !== blocker.type)
      throw new Error("resolution does not match the active blocker");
    const checkpointRef = snapshot.checkpoint_ref;
    if (!checkpointRef) throw new Error("waiting action has no browser checkpoint");
    snapshot = await this.#validateResolution(snapshot, resolution);
    const executor = this.#resolveExecutor(snapshot.request);
    snapshot = await this.#emit(
      snapshot,
      "action_resumed",
      "running",
      {
        resolution_type: resolution.type,
      },
      { checkpoint_ref: null, blocker: null },
    );
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) return this.#cancelSnapshot(snapshot, executor, checkpointRef);
    let result: ActionExecutorResult;
    try {
      result = actionExecutorResultSchema.parse(
        await executor.resume(this.#context(snapshot, signal), checkpointRef, resolution),
      );
    } catch (error) {
      return this.#fail(snapshot, "executor_error", messageFor(error), false);
    }
    return this.#settle(snapshot, result);
  }

  async cancel(unknownSnapshot: unknown) {
    const snapshot = await this.#loadCanonicalSnapshot(unknownSnapshot);
    if (["succeeded", "failed", "cancelled"].includes(snapshot.state)) return snapshot;
    const executor = this.#resolveExecutor(snapshot.request);
    return this.#cancelSnapshot(snapshot, executor, snapshot.checkpoint_ref);
  }

  async reconcile(unknownSnapshot: unknown, options: { signal?: AbortSignal } = {}) {
    let snapshot = await this.#loadCanonicalSnapshot(unknownSnapshot);
    if (snapshot.state !== "running")
      throw new Error(`cannot reconcile action in ${snapshot.state} state`);
    if (new Date(snapshot.request.expires_at) <= this.#now())
      return this.#fail(snapshot, "request_expired", "action request expired", false);
    const executor = this.#resolveExecutor(snapshot.request);
    snapshot = await this.#emit(snapshot, "action_recovering", "running", {
      adapter: snapshot.request.assignment.adapter,
    });
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) return this.#cancelSnapshot(snapshot, executor, snapshot.checkpoint_ref);
    let result: ActionExecutorResult;
    try {
      result = actionExecutorResultSchema.parse(
        await executor.reconcile(this.#context(snapshot, signal), snapshot.checkpoint_ref),
      );
    } catch (error) {
      return this.#fail(snapshot, "reconciliation_error", messageFor(error), true);
    }
    return this.#settle(snapshot, result);
  }

  #resolveExecutor(request: ActionRunRequest) {
    const executor = this.executors.resolve(
      request.assignment.worker_kind,
      request.assignment.adapter,
    );
    const manifest = actionExecutorManifestSchema.parse(executor.manifest);
    const unsupported = request.assignment.capabilities.filter(
      (capability) => !manifest.supported_capabilities.includes(capability),
    );
    if (unsupported.length > 0)
      throw new Error(`executor does not support capabilities: ${unsupported.join(", ")}`);
    if (request.assignment.worker_kind === "browser" && manifest.network_policy !== "allowlist") {
      throw new Error("browser executor does not enforce an origin allowlist");
    }
    return executor;
  }

  async #verifyVaultReferences(snapshot: ActionRunSnapshot) {
    if (snapshot.request.assignment.vault_refs.length === 0) return;
    if (!this.dependencies.vaultVerifier) throw new Error("vault references require a verifier");
    for (const reference of snapshot.request.assignment.vault_refs) {
      const valid = await this.dependencies.vaultVerifier.verify(reference, {
        tenant_id: snapshot.request.tenant_id,
        run_id: snapshot.run_id,
        source_move_id: snapshot.request.source_move_id,
      });
      if (!valid) throw new Error(`vault reference unavailable for purpose: ${reference.purpose}`);
    }
  }

  async #validateResolution(snapshot: ActionRunSnapshot, resolution: ActionResumeRequest) {
    const now = this.#now();
    if (resolution.type === "approval") {
      if (snapshot.blocker?.type !== "approval")
        throw new Error("approval does not match the active blocker");
      const blocker = snapshot.blocker;
      if (!this.dependencies.approvalVerifier)
        throw new Error("approval resolution requires a verifier");
      const unknownClaim = await this.dependencies.approvalVerifier.verify(resolution.approval_id);
      if (!unknownClaim) throw new Error("approval unavailable");
      const claim = actionApprovalClaimSchema.parse(unknownClaim);
      const required = snapshot.request.assignment.approval_bound_capabilities;
      const matches =
        claim.approval_id === resolution.approval_id &&
        claim.tenant_id === snapshot.request.tenant_id &&
        claim.run_id === snapshot.run_id &&
        claim.source_move_id === snapshot.request.source_move_id &&
        claim.request_hash === snapshot.request_hash &&
        claim.step_id === blocker.step_id &&
        claim.effect_fingerprint === blocker.effect_fingerprint &&
        claim.effect === snapshot.request.assignment.effect &&
        required.every((capability) => claim.approved_capabilities.includes(capability)) &&
        !snapshot.approval_ids.includes(claim.approval_id) &&
        new Date(claim.approved_at) <= now &&
        new Date(claim.expires_at) > now;
      if (!matches) throw new Error("approval is not bound to this exact action");
      return {
        ...snapshot,
        approval_ids: [...snapshot.approval_ids, claim.approval_id],
        active_approval_fingerprint: claim.effect_fingerprint,
      };
    }
    if (resolution.type === "user_input") {
      const blocker = snapshot.blocker;
      if (blocker?.type !== "user_input")
        throw new Error("user input does not match the active blocker");
      if (!this.dependencies.inputVerifier)
        throw new Error("user input resolution requires a verifier");
      const unknownClaim = await this.dependencies.inputVerifier.verify(resolution.input_ref);
      if (!unknownClaim) throw new Error("user input unavailable");
      const claim = actionInputClaimSchema.parse(unknownClaim);
      const matches =
        claim.input_ref === resolution.input_ref &&
        claim.tenant_id === snapshot.request.tenant_id &&
        claim.run_id === snapshot.run_id &&
        claim.challenge_id === resolution.challenge_id &&
        claim.challenge_id === blocker.challenge_id &&
        new Date(claim.expires_at) > now;
      if (!matches) throw new Error("user input is not bound to this challenge");
      return {
        ...snapshot,
        resolved_input_refs: [
          ...snapshot.resolved_input_refs,
          {
            challenge_id: claim.challenge_id,
            input_ref: claim.input_ref,
          },
        ],
      };
    }
    const blocker = snapshot.blocker;
    if (blocker?.type !== "vault_setup")
      throw new Error("vault setup does not match the active blocker");
    if (!this.dependencies.vaultVerifier)
      throw new Error("vault setup resolution requires a verifier");
    if (
      resolution.vault_ref.kind !== blocker.kind ||
      resolution.vault_ref.purpose !== blocker.purpose
    ) {
      throw new Error("vault reference does not match the requested item");
    }
    const valid = await this.dependencies.vaultVerifier.verify(resolution.vault_ref, {
      tenant_id: snapshot.request.tenant_id,
      run_id: snapshot.run_id,
      source_move_id: snapshot.request.source_move_id,
    });
    if (!valid) throw new Error("vault reference unavailable");
    return {
      ...snapshot,
      resolved_vault_refs: [...snapshot.resolved_vault_refs, resolution.vault_ref],
    };
  }

  async #settle(
    snapshot: ActionRunSnapshot,
    result: ActionExecutorResult,
  ): Promise<ActionRunSnapshot> {
    if (result.kind === "failed")
      return this.#fail(snapshot, result.code, result.message, result.retryable);
    if (result.kind === "blocked") {
      const executor = this.#resolveExecutor(snapshot.request);
      if (!executor.manifest.supports_pause_resume) {
        return this.#fail(
          snapshot,
          "pause_resume_unsupported",
          "executor returned a blocker without resumable session support",
          false,
        );
      }
      if (result.blocker.type === "approval") {
        if (result.blocker.request_hash !== snapshot.request_hash) {
          return this.#fail(
            snapshot,
            "approval_binding_mismatch",
            "executor requested approval for a different action",
            false,
          );
        }
        if (snapshot.request.assignment.authority !== "execute_after_approval") {
          return this.#fail(
            snapshot,
            "approval_not_permitted",
            "this action is not eligible for execution approval",
            false,
          );
        }
      }
      return this.#emit(
        snapshot,
        "action_blocked",
        waitingState(result.blocker),
        { blocker_type: result.blocker.type },
        {
          checkpoint_ref: result.checkpoint_ref,
          blocker: result.blocker,
          receipt: null,
          failure: null,
          ...(result.blocker.type === "approval" ? { active_approval_fingerprint: null } : {}),
        },
      );
    }
    const receipt = result.receipt;
    const exactReceipt =
      receipt.run_id === snapshot.run_id &&
      receipt.source_move_id === snapshot.request.source_move_id &&
      receipt.request_hash === snapshot.request_hash &&
      receipt.effect === snapshot.request.assignment.effect;
    if (!exactReceipt)
      return this.#fail(
        snapshot,
        "receipt_binding_mismatch",
        "executor receipt does not match this action",
        false,
      );
    if (receipt.outcome !== "completed" || receipt.verification.status !== "verified") {
      return this.#fail(
        snapshot,
        "outcome_unverified",
        "executor could not verify completion",
        receipt.outcome === "unknown",
      );
    }
    const external = ["reversible_external", "consequential"].includes(
      snapshot.request.assignment.effect,
    );
    if (external && snapshot.approval_ids.length === 0) {
      return this.#fail(
        snapshot,
        "approval_missing",
        "external completion had no bound approval",
        false,
      );
    }
    if (external && receipt.approval_fingerprint !== snapshot.active_approval_fingerprint) {
      return this.#fail(
        snapshot,
        "approval_receipt_mismatch",
        "completion did not match the approved effect",
        false,
      );
    }
    if (!external && receipt.approval_fingerprint !== null) {
      return this.#fail(
        snapshot,
        "unexpected_approval_receipt",
        "non-external completion carried an approval fingerprint",
        false,
      );
    }
    if (
      snapshot.request.assignment.effect === "reversible_external" &&
      !receipt.rollback?.available
    ) {
      return this.#fail(
        snapshot,
        "rollback_missing",
        "reversible action completed without a rollback receipt",
        false,
      );
    }
    return this.#emit(
      snapshot,
      "action_completed",
      "succeeded",
      {
        effect: receipt.effect,
        evidence_count: receipt.evidence.length,
        rollback_available: receipt.rollback?.available ?? false,
      },
      {
        checkpoint_ref: null,
        blocker: null,
        receipt,
        failure: null,
        resolved_input_refs: [],
        resolved_vault_refs: [],
        active_approval_fingerprint: null,
      },
    );
  }

  async #fail(snapshot: ActionRunSnapshot, code: string, message: string, retryable: boolean) {
    return this.#emit(
      snapshot,
      "action_failed",
      "failed",
      { code, retryable },
      {
        checkpoint_ref: null,
        blocker: null,
        receipt: null,
        failure: { code, message, retryable },
        resolved_input_refs: [],
        resolved_vault_refs: [],
        active_approval_fingerprint: null,
      },
    );
  }

  async #cancelSnapshot(
    snapshot: ActionRunSnapshot,
    executor: ReturnType<ActionExecutorRegistry["resolve"]>,
    checkpointRef: string | null,
  ) {
    const cancelled = await this.#emit(
      snapshot,
      "action_cancelled",
      "cancelled",
      {},
      {
        checkpoint_ref: null,
        blocker: null,
        receipt: null,
        failure: null,
        resolved_input_refs: [],
        resolved_vault_refs: [],
        active_approval_fingerprint: null,
      },
    );
    try {
      await executor.cancel(this.#contextWithoutSignal(snapshot), checkpointRef);
    } catch {
      // Cancellation is authoritative in Co even if a remote worker is already gone.
    }
    return cancelled;
  }

  #assertSnapshotIntegrity(snapshot: ActionRunSnapshot) {
    if (hashActionRequest(snapshot.request) !== snapshot.request_hash)
      throw new Error("action snapshot request hash mismatch");
  }

  async #loadCanonicalSnapshot(unknownSnapshot: unknown) {
    const candidate = actionRunSnapshotSchema.parse(unknownSnapshot);
    this.#assertSnapshotIntegrity(candidate);
    const stored = await this.journal.load(candidate.request.tenant_id, candidate.run_id);
    if (!stored) throw new Error("action run not found");
    const canonical = actionRunSnapshotSchema.parse(stored);
    this.#assertSnapshotIntegrity(canonical);
    if (JSON.stringify(canonical) !== JSON.stringify(candidate))
      throw new Error("action snapshot is stale or tampered");
    return canonical;
  }

  #context(snapshot: ActionRunSnapshot, signal: AbortSignal): ActionExecutionContext {
    return { ...this.#contextWithoutSignal(snapshot), signal };
  }

  #contextWithoutSignal(snapshot: ActionRunSnapshot): Omit<ActionExecutionContext, "signal"> {
    const approved = snapshot.active_approval_fingerprint !== null;
    const authorizedCapabilities = snapshot.request.assignment.capabilities.filter(
      (capability) =>
        approved || !snapshot.request.assignment.approval_bound_capabilities.includes(capability),
    );
    const {
      capabilities: _capabilities,
      approval_bound_capabilities: _approvalBound,
      ...assignment
    } = snapshot.request.assignment;
    const vaultRefs = [...assignment.vault_refs, ...snapshot.resolved_vault_refs].filter(
      (reference, index, all) =>
        all.findIndex((candidate) => candidate.id === reference.id) === index,
    );
    return {
      run_id: snapshot.run_id,
      tenant_id: snapshot.request.tenant_id,
      source_move_id: snapshot.request.source_move_id,
      request_hash: snapshot.request_hash,
      active_approval_fingerprint: snapshot.active_approval_fingerprint,
      objective: snapshot.request.objective,
      assignment: {
        ...assignment,
        vault_refs: vaultRefs,
        authorized_capabilities: authorizedCapabilities,
      },
      resolved_input_refs: snapshot.resolved_input_refs,
    };
  }

  async #emit(
    snapshot: ActionRunSnapshot,
    eventType: ActionEvent["event_type"],
    state: ActionEvent["state"],
    detail: ActionEvent["detail"] = {},
    patch: Partial<
      Pick<
        ActionRunSnapshot,
        | "checkpoint_ref"
        | "blocker"
        | "receipt"
        | "failure"
        | "approval_ids"
        | "resolved_input_refs"
        | "resolved_vault_refs"
        | "active_approval_fingerprint"
      >
    > = {},
  ) {
    const occurredAt = this.#now().toISOString();
    const event = actionEventSchema.parse({
      sequence: snapshot.next_sequence,
      event_type: eventType,
      run_id: snapshot.run_id,
      state,
      occurred_at: occurredAt,
      detail,
    });
    const nextSnapshot = actionRunSnapshotSchema.parse({
      ...snapshot,
      ...patch,
      state,
      next_sequence: snapshot.next_sequence + 1,
      updated_at: occurredAt,
    });
    await this.journal.commit(
      {
        state: snapshot.state,
        next_sequence: snapshot.next_sequence,
        updated_at: snapshot.updated_at,
      },
      event,
      nextSnapshot,
    );
    return nextSnapshot;
  }
}
