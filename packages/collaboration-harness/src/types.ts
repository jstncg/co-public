import type {
  AgentModelConfig,
  AgentRole,
  CollaborationRunRequest,
  HarnessAgentOutput,
  HarnessEvent,
  HarnessUsage,
} from "@co/contracts";

export type HarnessEvidenceItem = {
  evidence_type: "artifact" | "segment" | "signal" | "context_event";
  evidence_id: string;
  text: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export type AgentDependencyResult = {
  result_id: string;
  agent_id: string;
  output: HarnessAgentOutput;
};

export type AdapterRequest = {
  runObjective: string;
  role: AgentRole;
  evidence: HarnessEvidenceItem[];
  dependencies: AgentDependencyResult[];
  model: AgentModelConfig;
  signal: AbortSignal;
};

export type AdapterResult = {
  output: HarnessAgentOutput;
  usage: HarnessUsage;
  provider_request_id: string | null;
  model: string;
};

export interface HarnessModelAdapter {
  readonly provider: AgentModelConfig["provider"];
  estimateInputTokens(request: Omit<AdapterRequest, "signal">): Promise<number>;
  complete(request: AdapterRequest): Promise<AdapterResult>;
}

export interface HarnessEvidenceLoader {
  load(request: CollaborationRunRequest["evidence_packet"], tenantId: string): Promise<HarnessEvidenceItem[]>;
}

export interface HarnessEventSink {
  append(event: HarnessEvent): Promise<void>;
}

export type HarnessTaskResult = {
  task_id: string;
  agent_id: string;
  state: "succeeded" | "failed" | "cancelled" | "skipped" | "budget_exhausted";
  result_id: string | null;
  output: HarnessAgentOutput | null;
  usage: HarnessUsage;
  attempts: number;
  error_class: string | null;
};

export type HarnessRunResult = {
  run_id: string;
  state: "succeeded" | "failed" | "cancelled" | "budget_exhausted";
  tasks: HarnessTaskResult[];
  usage: HarnessUsage;
  synthesis: HarnessAgentOutput | null;
};
