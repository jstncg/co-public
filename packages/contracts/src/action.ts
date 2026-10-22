import { z } from "zod";

export const actionWorkerKinds = ["browser", "api", "human"] as const;
export const actionEffectClasses = [
  "observe",
  "prepare",
  "reversible_external",
  "consequential",
] as const;
export const actionAuthorityModes = ["observe", "prepare", "execute_after_approval"] as const;
export const actionRunStates = [
  "queued",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "waiting_for_vault",
  "succeeded",
  "failed",
  "cancelled",
] as const;

const capabilitySchema = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_.-]*$/, "capability must be namespaced");

const secretShapedKey =
  /(^|[-_])(password|passwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|authorization|cookie|session[-_]?cookie|otp|one[-_]?time[-_]?code|cvv|cvc|card[-_]?number)([-_]|$)/i;
const secretShapedValue =
  /(\b(?:password|passwd|otp|one[- ]?time[- ]?code|api[- ]?key|access[- ]?token|refresh[- ]?token|authorization|cookie|cvv|cvc)\b\s*[:=]\s*\S{3,}|\bBearer\s+\S{8,}|\bAIza[0-9A-Za-z_-]{20,}|\bsk-[0-9A-Za-z_-]{16,})/i;

function secretSafeText(schema: z.ZodString) {
  return schema.superRefine((value, context) => {
    if (secretShapedValue.test(value)) {
      context.addIssue({
        code: "custom",
        message: "credential material must use an opaque reference",
      });
    }
  });
}

function inspectPublicInput(
  value: unknown,
  context: z.RefinementCtx,
  path: PropertyKey[] = [],
  depth = 0,
) {
  if (depth > 8) {
    context.addIssue({ code: "custom", path, message: "public input exceeds maximum depth" });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 200)
      context.addIssue({ code: "custom", path, message: "public input array is too large" });
    value.forEach((item, index) => inspectPublicInput(item, context, [...path, index], depth + 1));
    return;
  }
  if (typeof value === "string" && secretShapedValue.test(value)) {
    context.addIssue({
      code: "custom",
      path,
      message: "credential material must use an opaque vault reference",
    });
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 200)
      context.addIssue({ code: "custom", path, message: "public input object is too large" });
    for (const [key, item] of entries) {
      if (key.length > 80)
        context.addIssue({
          code: "custom",
          path: [...path, key],
          message: "public input key is too long",
        });
      if (secretShapedKey.test(key)) {
        context.addIssue({
          code: "custom",
          path: [...path, key],
          message: "credential material must use an opaque vault reference",
        });
      }
      inspectPublicInput(item, context, [...path, key], depth + 1);
    }
  }
}

export const actionPublicInputSchema = z
  .record(z.string(), z.json())
  .default({})
  .superRefine((value, context) => {
    if (JSON.stringify(value).length > 40_000) {
      context.addIssue({ code: "custom", message: "public input exceeds 40KB" });
    }
    inspectPublicInput(value, context);
  });

export const vaultReferenceSchema = z
  .object({
    id: z.uuid(),
    kind: z.enum(["credential", "auth_session", "identity", "address", "payment"]),
    purpose: z.string().trim().min(1).max(160),
  })
  .strict();

const httpsOriginSchema = z.url().superRefine((value, context) => {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:")
    context.addIssue({ code: "custom", message: "origin must use https" });
  if (parsed.origin !== value)
    context.addIssue({
      code: "custom",
      message: "allowed origin cannot contain a path, query, or fragment",
    });
});

export const actionTargetSchema = z
  .object({
    start_url: z.url().nullable().default(null),
    allowed_origins: z.array(httpsOriginSchema).max(16).default([]),
  })
  .strict();

export const actionAssignmentSchema = z
  .object({
    worker_kind: z.enum(actionWorkerKinds),
    adapter: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z][a-z0-9_-]*$/),
    effect: z.enum(actionEffectClasses),
    authority: z.enum(actionAuthorityModes),
    capabilities: z.array(capabilitySchema).min(1).max(32),
    approval_bound_capabilities: z.array(capabilitySchema).max(32).default([]),
    target: actionTargetSchema,
    public_input: actionPublicInputSchema,
    vault_refs: z.array(vaultReferenceSchema).max(16).default([]),
  })
  .strict()
  .superRefine((assignment, context) => {
    if (new Set(assignment.capabilities).size !== assignment.capabilities.length) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "capabilities must be unique",
      });
    }
    if (
      new Set(assignment.approval_bound_capabilities).size !==
      assignment.approval_bound_capabilities.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["approval_bound_capabilities"],
        message: "approval-bound capabilities must be unique",
      });
    }
    if (
      assignment.approval_bound_capabilities.some(
        (capability) => !assignment.capabilities.includes(capability),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["approval_bound_capabilities"],
        message: "approval-bound capabilities must be part of the assignment",
      });
    }
    if (
      new Set(assignment.target.allowed_origins).size !== assignment.target.allowed_origins.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["target", "allowed_origins"],
        message: "allowed origins must be unique",
      });
    }
    if (
      new Set(assignment.vault_refs.map((reference) => reference.id)).size !==
      assignment.vault_refs.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["vault_refs"],
        message: "vault references must be unique",
      });
    }
    if (assignment.worker_kind === "browser") {
      if (!assignment.target.start_url) {
        context.addIssue({
          code: "custom",
          path: ["target", "start_url"],
          message: "browser work requires a known start URL",
        });
      } else {
        const start = new URL(assignment.target.start_url);
        if (start.protocol !== "https:") {
          context.addIssue({
            code: "custom",
            path: ["target", "start_url"],
            message: "browser work requires https",
          });
        }
        if (!assignment.target.allowed_origins.includes(start.origin)) {
          context.addIssue({
            code: "custom",
            path: ["target", "allowed_origins"],
            message: "start URL origin must be explicitly allowed",
          });
        }
        if (
          start.username ||
          start.password ||
          [...start.searchParams.keys()].some((key) => secretShapedKey.test(key))
        ) {
          context.addIssue({
            code: "custom",
            path: ["target", "start_url"],
            message: "browser URL cannot contain credentials",
          });
        }
      }
    } else if (assignment.target.start_url || assignment.target.allowed_origins.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "only browser workers may receive web targets",
      });
    }
    if (assignment.authority === "observe" && assignment.effect !== "observe") {
      context.addIssue({
        code: "custom",
        path: ["authority"],
        message: "observe authority cannot create effects",
      });
    }
    if (assignment.authority === "prepare" && !["observe", "prepare"].includes(assignment.effect)) {
      context.addIssue({
        code: "custom",
        path: ["authority"],
        message: "prepare authority cannot create external state",
      });
    }
    if (
      ["reversible_external", "consequential"].includes(assignment.effect) &&
      assignment.authority !== "execute_after_approval"
    ) {
      context.addIssue({
        code: "custom",
        path: ["authority"],
        message: "external effects require approval-bound authority",
      });
    }
    if (
      assignment.authority === "execute_after_approval" &&
      assignment.approval_bound_capabilities.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["approval_bound_capabilities"],
        message: "execution authority must name capabilities withheld until approval",
      });
    }
    if (
      assignment.authority !== "execute_after_approval" &&
      assignment.approval_bound_capabilities.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["approval_bound_capabilities"],
        message: "only execution authority may reserve approval-bound capabilities",
      });
    }
  });

export const actionRunRequestSchema = z
  .object({
    version: z.literal("action-run.v1"),
    tenant_id: z.uuid(),
    source_move_id: z.uuid(),
    idempotency_key: z.string().trim().min(16).max(240),
    objective: secretSafeText(z.string().trim().min(1).max(4_000)),
    assignment: actionAssignmentSchema,
    expires_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export const actionExecutorManifestSchema = z
  .object({
    worker_kind: z.enum(actionWorkerKinds),
    adapter: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z][a-z0-9_-]*$/),
    supported_capabilities: z.array(capabilitySchema).min(1).max(128),
    can_message_user: z.literal(false),
    secret_transport: z.literal("opaque_refs"),
    untrusted_content: z.literal("data_only"),
    capability_enforcement: z.literal("per_invocation"),
    network_policy: z.enum(["none", "allowlist"]),
    supports_pause_resume: z.boolean(),
    supports_reconciliation: z.literal(true),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.worker_kind === "browser" && manifest.network_policy !== "allowlist") {
      context.addIssue({
        code: "custom",
        path: ["network_policy"],
        message: "browser workers must enforce an origin allowlist",
      });
    }
  });

export const actionApprovalClaimSchema = z
  .object({
    approval_id: z.uuid(),
    tenant_id: z.uuid(),
    run_id: z.uuid(),
    source_move_id: z.uuid(),
    request_hash: z.string().regex(/^[a-f0-9]{64}$/),
    step_id: z.string().trim().min(1).max(160),
    effect_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    effect: z.enum(actionEffectClasses),
    approved_capabilities: z.array(capabilitySchema).min(1).max(32),
    approved_at: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export const actionInputClaimSchema = z
  .object({
    input_ref: z.uuid(),
    tenant_id: z.uuid(),
    run_id: z.uuid(),
    challenge_id: z.string().trim().min(1).max(160),
    expires_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export const actionBlockerSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("approval"),
      step_id: z.string().trim().min(1).max(160),
      prompt: secretSafeText(z.string().trim().min(1).max(600)),
      request_hash: z.string().regex(/^[a-f0-9]{64}$/),
      effect_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      expires_at: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      type: z.literal("user_input"),
      challenge_id: z.string().trim().min(1).max(160),
      input_kind: z.enum(["otp", "captcha", "passkey", "choice", "confirmation"]),
      prompt: secretSafeText(z.string().trim().min(1).max(600)),
      expires_at: z.iso.datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      type: z.literal("vault_setup"),
      kind: vaultReferenceSchema.shape.kind,
      purpose: z.string().trim().min(1).max(160),
      prompt: secretSafeText(z.string().trim().min(1).max(600)),
    })
    .strict(),
]);

export const actionResumeRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approval"), approval_id: z.uuid() }).strict(),
  z
    .object({
      type: z.literal("user_input"),
      challenge_id: z.string().trim().min(1).max(160),
      input_ref: z.uuid(),
    })
    .strict(),
  z.object({ type: z.literal("vault_setup"), vault_ref: vaultReferenceSchema }).strict(),
]);

export const actionEvidenceSchema = z
  .object({
    kind: z.enum(["external_id", "url", "screenshot", "artifact", "provider_receipt"]),
    ref: secretSafeText(z.string().trim().min(1).max(2_000)),
    label: secretSafeText(z.string().trim().min(1).max(240)),
    captured_at: z.iso.datetime({ offset: true }),
  })
  .strict();

export const actionExecutorReceiptSchema = z
  .object({
    run_id: z.uuid(),
    source_move_id: z.uuid(),
    request_hash: z.string().regex(/^[a-f0-9]{64}$/),
    approval_fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    effect: z.enum(actionEffectClasses),
    outcome: z.enum(["completed", "not_completed", "unknown"]),
    summary: secretSafeText(z.string().trim().min(1).max(2_000)),
    verification: z
      .object({
        status: z.enum(["verified", "unverified"]),
        method: z.string().trim().min(1).max(240),
        checked_at: z.iso.datetime({ offset: true }),
      })
      .strict(),
    evidence: z.array(actionEvidenceSchema).min(1).max(32),
    rollback: z
      .object({
        available: z.boolean(),
        expires_at: z.iso.datetime({ offset: true }).nullable(),
        instruction: secretSafeText(z.string().trim().min(1).max(600)).nullable(),
      })
      .strict()
      .nullable(),
    completed_at: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (receipt.rollback?.available && !receipt.rollback.instruction) {
      context.addIssue({
        code: "custom",
        path: ["rollback", "instruction"],
        message: "available rollback requires an instruction",
      });
    }
    if (
      receipt.rollback &&
      !receipt.rollback.available &&
      (receipt.rollback.expires_at || receipt.rollback.instruction)
    ) {
      context.addIssue({
        code: "custom",
        path: ["rollback"],
        message: "unavailable rollback cannot advertise a deadline or instruction",
      });
    }
  });

export const actionExecutorResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("completed"), receipt: actionExecutorReceiptSchema }).strict(),
  z
    .object({
      kind: z.literal("blocked"),
      checkpoint_ref: z.string().trim().min(16).max(1_000),
      blocker: actionBlockerSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("failed"),
      code: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .regex(/^[a-z][a-z0-9_.-]*$/),
      message: secretSafeText(z.string().trim().min(1).max(1_000)),
      retryable: z.boolean(),
    })
    .strict(),
]);

export const actionEventSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    event_type: z.enum([
      "action_queued",
      "action_started",
      "action_blocked",
      "action_resumed",
      "action_recovering",
      "action_completed",
      "action_failed",
      "action_cancelled",
    ]),
    run_id: z.uuid(),
    state: z.enum(actionRunStates),
    occurred_at: z.iso.datetime({ offset: true }),
    detail: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .default({}),
  })
  .strict();

export const actionFailureSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z][a-z0-9_.-]*$/),
    message: secretSafeText(z.string().trim().min(1).max(1_000)),
    retryable: z.boolean(),
  })
  .strict();

export const actionRunSnapshotSchema = z
  .object({
    version: z.literal("action-snapshot.v1"),
    run_id: z.uuid(),
    request: actionRunRequestSchema,
    request_hash: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(actionRunStates),
    next_sequence: z.number().int().nonnegative(),
    checkpoint_ref: z.string().trim().min(16).max(1_000).nullable(),
    blocker: actionBlockerSchema.nullable(),
    receipt: actionExecutorReceiptSchema.nullable(),
    failure: actionFailureSchema.nullable(),
    approval_ids: z.array(z.uuid()).max(32),
    active_approval_fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    resolved_input_refs: z
      .array(
        z
          .object({
            challenge_id: z.string().trim().min(1).max(160),
            input_ref: z.uuid(),
          })
          .strict(),
      )
      .max(32),
    resolved_vault_refs: z.array(vaultReferenceSchema).max(16),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const waiting = ["waiting_for_approval", "waiting_for_input", "waiting_for_vault"].includes(
      snapshot.state,
    );
    const hasCheckpoint = Boolean(snapshot.checkpoint_ref);
    const hasBlocker = Boolean(snapshot.blocker);
    if (waiting !== (hasCheckpoint && hasBlocker) || hasCheckpoint !== hasBlocker) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "waiting state requires exactly one blocker and checkpoint",
      });
    }
    if ((snapshot.state === "succeeded") !== Boolean(snapshot.receipt)) {
      context.addIssue({
        code: "custom",
        path: ["receipt"],
        message: "only a succeeded run may have a receipt",
      });
    }
    if ((snapshot.state === "failed") !== Boolean(snapshot.failure)) {
      context.addIssue({
        code: "custom",
        path: ["failure"],
        message: "only a failed run may have a failure",
      });
    }
    if (
      new Set(snapshot.resolved_input_refs.map((reference) => reference.input_ref)).size !==
      snapshot.resolved_input_refs.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["resolved_input_refs"],
        message: "resolved input references must be unique",
      });
    }
    if (
      new Set(snapshot.resolved_vault_refs.map((reference) => reference.id)).size !==
      snapshot.resolved_vault_refs.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["resolved_vault_refs"],
        message: "resolved vault references must be unique",
      });
    }
  });

export type ActionWorkerKind = (typeof actionWorkerKinds)[number];
export type ActionEffectClass = (typeof actionEffectClasses)[number];
export type ActionAuthorityMode = (typeof actionAuthorityModes)[number];
export type ActionRunState = (typeof actionRunStates)[number];
export type VaultReference = z.infer<typeof vaultReferenceSchema>;
export type ActionAssignment = z.infer<typeof actionAssignmentSchema>;
export type ActionRunRequest = z.infer<typeof actionRunRequestSchema>;
export type ActionExecutorManifest = z.infer<typeof actionExecutorManifestSchema>;
export type ActionApprovalClaim = z.infer<typeof actionApprovalClaimSchema>;
export type ActionInputClaim = z.infer<typeof actionInputClaimSchema>;
export type ActionBlocker = z.infer<typeof actionBlockerSchema>;
export type ActionResumeRequest = z.infer<typeof actionResumeRequestSchema>;
export type ActionExecutorReceipt = z.infer<typeof actionExecutorReceiptSchema>;
export type ActionExecutorResult = z.infer<typeof actionExecutorResultSchema>;
export type ActionEvent = z.infer<typeof actionEventSchema>;
export type ActionFailure = z.infer<typeof actionFailureSchema>;
export type ActionRunSnapshot = z.infer<typeof actionRunSnapshotSchema>;
