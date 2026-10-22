import { randomUUID } from "node:crypto";
import {
  collaborationRunRequestSchema,
  harnessAgentOutputSchema,
  harnessEventSchema,
  harnessUsageSchema,
  type AgentRole,
  type HarnessEvent,
  type HarnessUsage,
} from "@co/contracts";
import { AdapterRegistry } from "./adapters";
import type {
  AgentDependencyResult,
  HarnessEventSink,
  HarnessEvidenceLoader,
  HarnessRunResult,
  HarnessTaskResult,
} from "./types";

const ZERO_USAGE: HarnessUsage = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };

function addUsage(left: HarnessUsage, right: HarnessUsage): HarnessUsage {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    output_tokens: left.output_tokens + right.output_tokens,
    cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
  };
}

function assertAcyclic(agents: AgentRole[]) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error(`collaboration graph contains a cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.depends_on ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const agent of agents) visit(agent.id);
}

function errorClass(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
  if (error instanceof Error) return error.name || "Error";
  return "unknown";
}

export class CollaborationRunner {
  constructor(
    readonly adapters: AdapterRegistry,
    readonly evidenceLoader: HarnessEvidenceLoader,
    readonly eventSink: HarnessEventSink,
  ) {}

  async run(
    unknownRequest: unknown,
    options: { signal?: AbortSignal; runId?: string; initialSequence?: number } = {},
  ): Promise<HarnessRunResult> {
    const request = collaborationRunRequestSchema.parse(unknownRequest);
    assertAcyclic(request.agents);
    const runId = options.runId ?? randomUUID();
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    const evidence = await this.evidenceLoader.load(request.evidence_packet, request.tenant_id);
    const requestedEvidence = new Set([
      ...request.evidence_packet.artifact_ids.map((id) => `artifact:${id}`),
      ...request.evidence_packet.segment_ids.map((id) => `segment:${id}`),
      ...request.evidence_packet.signal_ids.map((id) => `signal:${id}`),
      ...request.evidence_packet.context_event_ids.map((id) => `context_event:${id}`),
    ]);
    const allowedEvidence = new Set<string>();
    let evidenceCharacters = 0;
    for (const item of evidence) {
      const key = `${item.evidence_type}:${item.evidence_id}`;
      if (!requestedEvidence.has(key)) throw new Error("evidence loader returned unrequested evidence");
      if (allowedEvidence.has(key)) throw new Error("evidence loader returned duplicate evidence");
      if (!item.text.trim() || item.text.length > 50_000) throw new Error("evidence item has invalid text");
      allowedEvidence.add(key);
      evidenceCharacters += item.text.length + JSON.stringify(item.metadata ?? {}).length;
    }
    if ([...requestedEvidence].some((key) => !allowedEvidence.has(key))) {
      throw new Error("evidence packet contains missing, empty, deleted, invalidated, or unauthorized evidence");
    }
    if (evidenceCharacters > 400_000) throw new Error("evidence packet exceeds the collaboration content limit");
    const tasksByAgent = new Map(request.agents.map((agent) => [agent.id, randomUUID()]));
    const results = new Map<string, HarnessTaskResult>();
    let sequence = options.initialSequence ?? 0;
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("initial event sequence must be a nonnegative integer");
    let usage = { ...ZERO_USAGE };
    let reservedInputTokens = 0;
    let reservedOutputTokens = 0;
    let budgetExhausted = false;

    const reserveAttempt = (estimatedInputTokens: number, maxOutputTokens: number) => {
      const projectedInput = usage.input_tokens + reservedInputTokens + estimatedInputTokens;
      const projectedOutput = usage.output_tokens + reservedOutputTokens + maxOutputTokens;
      const projectedTotal = projectedInput + projectedOutput;
      if (
        projectedInput > request.token_budget.max_input_tokens ||
        projectedOutput > request.token_budget.max_output_tokens ||
        projectedTotal > request.token_budget.max_total_tokens
      ) return false;
      reservedInputTokens += estimatedInputTokens;
      reservedOutputTokens += maxOutputTokens;
      return true;
    };

    const releaseAttempt = (estimatedInputTokens: number, maxOutputTokens: number) => {
      reservedInputTokens -= estimatedInputTokens;
      reservedOutputTokens -= maxOutputTokens;
    };

    const emit = async (
      eventType: HarnessEvent["event_type"],
      state: HarnessEvent["state"],
      agentId: string | null = null,
      eventUsage: HarnessUsage | null = null,
      detail: HarnessEvent["detail"] = {},
    ) => {
      const event = harnessEventSchema.parse({
        sequence: sequence++,
        event_type: eventType,
        run_id: runId,
        task_id: agentId ? tasksByAgent.get(agentId) ?? null : null,
        agent_id: agentId,
        state,
        usage: eventUsage,
        occurred_at: new Date().toISOString(),
        detail,
      });
      await this.eventSink.append(event);
    };

    await emit("run_queued", "queued");
    await emit("run_started", "running");

    const runTask = async (agent: AgentRole): Promise<HarnessTaskResult> => {
      const taskId = tasksByAgent.get(agent.id)!;
      const dependencyResults = agent.depends_on.map((id) => results.get(id));
      if (dependencyResults.some((result) => !result || result.state !== "succeeded")) {
        await emit("task_cancelled", "skipped", agent.id, null, { reason: "dependency_not_succeeded" });
        return {
          task_id: taskId, agent_id: agent.id, state: "skipped", result_id: null,
          output: null, usage: { ...ZERO_USAGE }, attempts: 0, error_class: "dependency_not_succeeded",
        };
      }
      const dependencies: AgentDependencyResult[] = dependencyResults.map((result) => ({
        result_id: result!.result_id!,
        agent_id: result!.agent_id,
        output: result!.output!,
      }));
      let adapter: ReturnType<AdapterRegistry["resolve"]>;
      let estimatedInput: number;
      const adapterBase = { runObjective: request.objective, role: agent, evidence, dependencies, model: agent.model };
      await emit("task_queued", "queued", agent.id);
      try {
        adapter = this.adapters.resolve(agent.model.provider);
        estimatedInput = await adapter.estimateInputTokens(adapterBase);
        if (!Number.isSafeInteger(estimatedInput) || estimatedInput < 0) {
          throw new Error(`adapter returned an invalid input-token estimate for ${agent.id}`);
        }
      } catch (error) {
        await emit("task_failed", "failed", agent.id, null, { error_class: errorClass(error) });
        return {
          task_id: taskId, agent_id: agent.id, state: "failed", result_id: null,
          output: null, usage: { ...ZERO_USAGE }, attempts: 0, error_class: errorClass(error),
        };
      }

      let attempts = 0;
      let taskUsage = { ...ZERO_USAGE };
      while (attempts <= request.max_retries_per_task) {
        if (signal.aborted) {
          await emit("task_cancelled", "cancelled", agent.id);
          return {
            task_id: taskId, agent_id: agent.id, state: "cancelled", result_id: null,
            output: null, usage: taskUsage, attempts, error_class: "cancelled",
          };
        }
        if (!reserveAttempt(estimatedInput, agent.model.max_output_tokens)) {
          budgetExhausted = true;
          await emit("budget_exhausted", "budget_exhausted", agent.id, null, {
            estimated_input_tokens: estimatedInput,
            reserved_output_tokens: agent.model.max_output_tokens,
          });
          return {
            task_id: taskId, agent_id: agent.id, state: "budget_exhausted", result_id: null,
            output: null, usage: taskUsage, attempts, error_class: "token_budget",
          };
        }
        attempts += 1;
        let reservationHeld = true;
        await emit(attempts === 1 ? "task_started" : "task_retrying", "running", agent.id, null, { attempt: attempts });
        try {
          const completed = await adapter.complete({ ...adapterBase, signal });
          releaseAttempt(estimatedInput, agent.model.max_output_tokens);
          reservationHeld = false;
          usage = addUsage(usage, completed.usage);
          taskUsage = addUsage(taskUsage, completed.usage);
          const budgetExceeded =
            usage.input_tokens > request.token_budget.max_input_tokens ||
            usage.output_tokens > request.token_budget.max_output_tokens ||
            usage.input_tokens + usage.output_tokens > request.token_budget.max_total_tokens;
          if (budgetExceeded) {
            budgetExhausted = true;
            await emit("budget_exhausted", "budget_exhausted", agent.id, completed.usage, {
              reason: "provider_usage_exceeded_reservation",
            });
          }
          const parsed = harnessAgentOutputSchema.parse(completed.output);
          for (const finding of parsed.findings) {
            for (const citation of finding.citations) {
              const key = `${citation.evidence_type}:${citation.evidence_id}`;
              const dependencyCitation = citation.evidence_type === "agent_result" &&
                dependencies.some((dependency) => dependency.result_id === citation.evidence_id);
              if (!allowedEvidence.has(key) && !dependencyCitation) throw new Error(`uncited or unavailable evidence: ${key}`);
            }
          }
          const resultId = randomUUID();
          await emit("task_completed", "succeeded", agent.id, completed.usage, {
            provider: adapter.provider,
            model: completed.model,
            provider_request_id: completed.provider_request_id,
          });
          if (budgetExceeded) {
            controller.abort("token budget exhausted");
          }
          return {
            task_id: taskId, agent_id: agent.id, state: "succeeded", result_id: resultId,
            output: parsed, usage: taskUsage, attempts, error_class: null,
          };
        } catch (error) {
          if (reservationHeld) {
            releaseAttempt(estimatedInput, agent.model.max_output_tokens);
            reservationHeld = false;
          }
          if (signal.aborted) {
            await emit("task_cancelled", "cancelled", agent.id);
            return {
              task_id: taskId, agent_id: agent.id, state: "cancelled", result_id: null,
              output: null, usage: taskUsage, attempts, error_class: "cancelled",
            };
          }
          if (attempts > request.max_retries_per_task) {
            await emit("task_failed", "failed", agent.id, null, { error_class: errorClass(error) });
            return {
              task_id: taskId, agent_id: agent.id, state: "failed", result_id: null,
              output: null, usage: taskUsage, attempts, error_class: errorClass(error),
            };
          }
        }
      }
      throw new Error("unreachable collaboration retry state");
    };

    const pending = new Set(request.agents.map((agent) => agent.id));
    while (pending.size > 0 && !signal.aborted) {
      if (budgetExhausted) break;
      const ready = request.agents.filter((agent) =>
        pending.has(agent.id) && agent.depends_on.every((dependency) => results.has(dependency))
      );
      if (ready.length === 0) throw new Error("collaboration graph made no progress");
      for (let index = 0; index < ready.length; index += request.max_concurrency) {
        const wave = ready.slice(index, index + request.max_concurrency);
        const settled = await Promise.all(wave.map(async (agent) => [agent.id, await runTask(agent)] as const));
        for (const [agentId, result] of settled) {
          results.set(agentId, result);
          pending.delete(agentId);
        }
        if (budgetExhausted) break;
      }
    }

    const terminalState: HarnessRunResult["state"] = budgetExhausted
      ? "budget_exhausted"
      : signal.aborted
        ? "cancelled"
        : [...results.values()].some((result) => result.state === "failed")
          ? "failed"
          : "succeeded";
    if (terminalState === "cancelled") await emit("run_cancelled", "cancelled", null, usage);
    else if (terminalState === "failed") await emit("run_failed", "failed", null, usage);
    else if (terminalState === "budget_exhausted") await emit("budget_exhausted", "budget_exhausted", null, usage);
    else await emit("run_completed", "succeeded", null, usage);

    const synthesis = results.get(request.synthesis_agent_id)?.output ?? null;
    return {
      run_id: runId,
      state: terminalState,
      tasks: request.agents.map((agent) => results.get(agent.id) ?? {
        task_id: tasksByAgent.get(agent.id)!, agent_id: agent.id, state: "cancelled" as const,
        result_id: null, output: null, usage: { ...ZERO_USAGE }, attempts: 0,
        error_class: terminalState,
      }),
      usage: harnessUsageSchema.parse(usage),
      synthesis,
    };
  }
}
