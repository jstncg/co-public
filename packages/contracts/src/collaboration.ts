import { z } from "zod";

export const harnessProviders = ["openai", "anthropic", "custom"] as const;
export const harnessRunStates = ["queued", "running", "succeeded", "failed", "cancelled", "budget_exhausted"] as const;
export const harnessTaskStates = ["queued", "running", "succeeded", "failed", "cancelled", "skipped", "budget_exhausted"] as const;

export const tokenBudgetSchema = z.object({
  max_input_tokens: z.number().int().positive().max(2_000_000),
  max_output_tokens: z.number().int().positive().max(200_000),
  max_total_tokens: z.number().int().positive().max(2_000_000),
}).strict().superRefine((budget, context) => {
  if (budget.max_total_tokens > budget.max_input_tokens + budget.max_output_tokens) {
    context.addIssue({ code: "custom", path: ["max_total_tokens"], message: "cannot exceed input plus output budgets" });
  }
});

export const agentModelConfigSchema = z.object({
  provider: z.enum(harnessProviders),
  model: z.string().trim().min(1).max(160),
  max_output_tokens: z.number().int().positive().max(200_000),
  reasoning_effort: z.enum(["none", "low", "medium", "high", "xhigh", "max"]).nullable().default(null),
  timeout_ms: z.number().int().min(1_000).max(900_000).default(120_000),
}).strict();

export const agentRoleSchema = z.object({
  id: z.string().trim().min(1).max(80).regex(/^[a-z][a-z0-9_-]*$/),
  name: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(2_000),
  instructions: z.string().max(12_000),
  model: agentModelConfigSchema,
  depends_on: z.array(z.string().min(1).max(80)).max(32).default([]),
}).strict();

export const collaborationRunRequestSchema = z.object({
  tenant_id: z.string().uuid(),
  idempotency_key: z.string().trim().min(16).max(240),
  objective: z.string().trim().min(1).max(4_000),
  evidence_packet: z.object({
    artifact_ids: z.array(z.string().uuid()).max(100),
    signal_ids: z.array(z.string().uuid()).max(250),
    segment_ids: z.array(z.string().uuid()).max(500),
    context_event_ids: z.array(z.string().uuid()).max(250).default([]),
  }).strict().refine(
    (packet) =>
      packet.artifact_ids.length +
      packet.signal_ids.length +
      packet.segment_ids.length +
      packet.context_event_ids.length > 0,
    "evidence packet must contain at least one id",
  ),
  agents: z.array(agentRoleSchema).min(1).max(32),
  synthesis_agent_id: z.string().min(1).max(80),
  token_budget: tokenBudgetSchema,
  max_concurrency: z.number().int().min(1).max(16).default(4),
  max_retries_per_task: z.number().int().min(0).max(3).default(1),
}).strict().superRefine((run, context) => {
  const ids = new Set(run.agents.map((agent) => agent.id));
  if (ids.size !== run.agents.length) context.addIssue({ code: "custom", path: ["agents"], message: "agent ids must be unique" });
  if (!ids.has(run.synthesis_agent_id)) context.addIssue({ code: "custom", path: ["synthesis_agent_id"], message: "must name an agent in this run" });
  for (const [index, agent] of run.agents.entries()) {
    if (agent.model.provider === "anthropic" && agent.model.reasoning_effort === "xhigh") {
      context.addIssue({
        code: "custom",
        path: ["agents", index, "model", "reasoning_effort"],
        message: "xhigh is not an Anthropic effort value",
      });
    }
    for (const dependency of agent.depends_on) {
      if (!ids.has(dependency)) context.addIssue({ code: "custom", path: ["agents", index, "depends_on"], message: `unknown dependency: ${dependency}` });
      if (dependency === agent.id) context.addIssue({ code: "custom", path: ["agents", index, "depends_on"], message: "agent cannot depend on itself" });
    }
  }
});

export const harnessEvidenceCitationSchema = z.object({
  evidence_type: z.enum(["artifact", "segment", "signal", "context_event", "agent_result"]),
  evidence_id: z.string().uuid(),
}).strict();

export const harnessAgentOutputSchema = z.object({
  summary: z.string().trim().min(1).max(8_000),
  findings: z.array(z.object({
    statement: z.string().trim().min(1).max(1_000),
    confidence: z.number().min(0).max(1),
    citations: z.array(harnessEvidenceCitationSchema).min(1).max(24),
  }).strict()).max(50),
  disagreements: z.array(z.string().trim().min(1).max(1_000)).max(20),
  proposed_next_tasks: z.array(z.string().trim().min(1).max(500)).max(12),
}).strict();

export const harnessUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cached_input_tokens: z.number().int().nonnegative().default(0),
}).strict();

export const harnessEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  event_type: z.enum([
    "run_queued", "run_started", "task_queued", "task_started", "task_retrying",
    "task_completed", "task_failed", "task_cancelled", "budget_warning",
    "budget_exhausted", "run_completed", "run_failed", "run_cancelled",
  ]),
  run_id: z.string().uuid(),
  task_id: z.string().uuid().nullable(),
  agent_id: z.string().max(80).nullable(),
  state: z.enum([...harnessRunStates, ...harnessTaskStates]),
  usage: harnessUsageSchema.nullable(),
  occurred_at: z.iso.datetime({ offset: true }),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
}).strict();

export type TokenBudget = z.infer<typeof tokenBudgetSchema>;
export type AgentModelConfig = z.infer<typeof agentModelConfigSchema>;
export type AgentRole = z.infer<typeof agentRoleSchema>;
export type CollaborationRunRequest = z.infer<typeof collaborationRunRequestSchema>;
export type HarnessAgentOutput = z.infer<typeof harnessAgentOutputSchema>;
export type HarnessUsage = z.infer<typeof harnessUsageSchema>;
export type HarnessEvent = z.infer<typeof harnessEventSchema>;
