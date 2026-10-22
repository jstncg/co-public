import type {
  ActionApprovalClaim,
  ActionEvent,
  ActionExecutorManifest,
  ActionExecutorResult,
  ActionInputClaim,
  ActionResumeRequest,
  ActionRunRequest,
  ActionRunSnapshot,
  VaultReference,
} from "@co/contracts";

export type ActionExecutionContext = {
  run_id: string;
  tenant_id: string;
  source_move_id: string;
  request_hash: string;
  active_approval_fingerprint: string | null;
  objective: string;
  assignment: Omit<
    ActionRunRequest["assignment"],
    "capabilities" | "approval_bound_capabilities"
  > & {
    authorized_capabilities: string[];
  };
  resolved_input_refs: Array<{ challenge_id: string; input_ref: string }>;
  signal: AbortSignal;
};

export interface ActionExecutor {
  readonly manifest: ActionExecutorManifest;
  begin(context: ActionExecutionContext): Promise<ActionExecutorResult>;
  resume(
    context: ActionExecutionContext,
    checkpointRef: string,
    resolution: ActionResumeRequest,
  ): Promise<ActionExecutorResult>;
  reconcile(
    context: ActionExecutionContext,
    checkpointRef: string | null,
  ): Promise<ActionExecutorResult>;
  cancel(
    context: Omit<ActionExecutionContext, "signal">,
    checkpointRef: string | null,
  ): Promise<void>;
}

export interface ActionApprovalVerifier {
  verify(approvalId: string): Promise<ActionApprovalClaim | null>;
}

export interface ActionInputVerifier {
  verify(inputRef: string): Promise<ActionInputClaim | null>;
}

export interface VaultReferenceVerifier {
  verify(
    reference: VaultReference,
    scope: { tenant_id: string; run_id: string; source_move_id: string },
  ): Promise<boolean>;
}

export interface ActionRunJournal {
  initialize(
    snapshot: ActionRunSnapshot,
  ): Promise<{ created: boolean; snapshot: ActionRunSnapshot }>;
  commit(
    expected: Pick<ActionRunSnapshot, "state" | "next_sequence" | "updated_at">,
    event: ActionEvent,
    snapshot: ActionRunSnapshot,
  ): Promise<void>;
  load(tenantId: string, runId: string): Promise<ActionRunSnapshot | null>;
}

export type ActionRunnerDependencies = {
  approvalVerifier?: ActionApprovalVerifier;
  inputVerifier?: ActionInputVerifier;
  vaultVerifier?: VaultReferenceVerifier;
  now?: () => Date;
  idFactory?: () => string;
};
