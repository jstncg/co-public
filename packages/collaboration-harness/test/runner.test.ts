import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AdapterRegistry, CollaborationRunner, InMemoryHarnessMonitor } from "../src/index";
import type { AdapterRequest, HarnessModelAdapter } from "../src/types";

class FakeAdapter implements HarnessModelAdapter {
  readonly provider = "custom" as const;
  active = 0;
  maxActive = 0;

  async estimateInputTokens() { return 10; }

  async complete(request: AdapterRequest) {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await Promise.resolve();
    this.active -= 1;
    const evidence = request.dependencies[0]
      ? { evidence_type: "agent_result" as const, evidence_id: request.dependencies[0].result_id }
      : { evidence_type: request.evidence[0]!.evidence_type, evidence_id: request.evidence[0]!.evidence_id };
    return {
      output: {
        summary: `${request.role.name} completed`,
        findings: [{ statement: "A cited finding.", confidence: 0.8, citations: [evidence] }],
        disagreements: [],
        proposed_next_tasks: [],
      },
      usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 },
      provider_request_id: randomUUID(),
      model: request.model.model,
    };
  }
}

class InvalidOnceAdapter extends FakeAdapter {
  completions = 0;

  override async complete(request: AdapterRequest) {
    const result = await super.complete(request);
    this.completions += 1;
    if (this.completions === 1) {
      result.output.findings[0]!.citations[0] = {
        evidence_type: "artifact",
        evidence_id: randomUUID(),
      };
    }
    return result;
  }
}

const tenant = randomUUID();
const artifact = randomUUID();
const baseRequest = () => ({
  tenant_id: tenant,
  idempotency_key: `collaboration:${randomUUID()}`,
  objective: "Compare independent readings and synthesize only cited findings.",
  evidence_packet: { artifact_ids: [artifact], signal_ids: [], segment_ids: [], context_event_ids: [] },
  agents: [
    {
      id: "researcher", name: "Researcher", objective: "Find supported facts.", instructions: "",
      model: { provider: "custom", model: "fake-a", max_output_tokens: 50, reasoning_effort: null, timeout_ms: 10_000 },
      depends_on: [],
    },
    {
      id: "skeptic", name: "Skeptic", objective: "Find unsupported leaps.", instructions: "",
      model: { provider: "custom", model: "fake-b", max_output_tokens: 50, reasoning_effort: null, timeout_ms: 10_000 },
      depends_on: [],
    },
    {
      id: "synthesizer", name: "Synthesizer", objective: "Reconcile the two.", instructions: "",
      model: { provider: "custom", model: "fake-c", max_output_tokens: 50, reasoning_effort: null, timeout_ms: 10_000 },
      depends_on: ["researcher", "skeptic"],
    },
  ],
  synthesis_agent_id: "synthesizer",
  token_budget: { max_input_tokens: 1_000, max_output_tokens: 1_000, max_total_tokens: 2_000 },
  max_concurrency: 2,
  max_retries_per_task: 0,
});

describe("collaboration harness", () => {
  it("runs independent roles before a cited synthesis and exposes monitor events", async () => {
    const adapter = new FakeAdapter();
    const monitor = new InMemoryHarnessMonitor();
    const runner = new CollaborationRunner(
      new AdapterRegistry().register(adapter),
      { load: async () => [{ evidence_type: "artifact", evidence_id: artifact, text: "Primary evidence." }] },
      monitor,
    );
    const result = await runner.run(baseRequest());
    expect(result.state).toBe("succeeded");
    expect(result.synthesis?.summary).toContain("Synthesizer");
    expect(result.usage).toEqual({ input_tokens: 30, output_tokens: 15, cached_input_tokens: 0 });
    expect(adapter.maxActive).toBe(2);
    expect(monitor.list(result.run_id).map((event) => event.event_type)).toContain("run_completed");
  });

  it("stops before a task whose token reservation would exceed the run budget", async () => {
    const adapter = new FakeAdapter();
    const runner = new CollaborationRunner(
      new AdapterRegistry().register(adapter),
      { load: async () => [{ evidence_type: "artifact", evidence_id: artifact, text: "Primary evidence." }] },
      new InMemoryHarnessMonitor(),
    );
    const request = baseRequest();
    request.token_budget = { max_input_tokens: 20, max_output_tokens: 70, max_total_tokens: 90 };
    const result = await runner.run(request);
    expect(result.state).toBe("budget_exhausted");
    expect(result.tasks.some((task) => task.state === "budget_exhausted")).toBe(true);
  });

  it("reserves aggregate output before concurrent provider calls", async () => {
    const adapter = new FakeAdapter();
    const runner = new CollaborationRunner(
      new AdapterRegistry().register(adapter),
      { load: async () => [{ evidence_type: "artifact", evidence_id: artifact, text: "Primary evidence." }] },
      new InMemoryHarnessMonitor(),
    );
    const request = baseRequest();
    request.token_budget = { max_input_tokens: 1_000, max_output_tokens: 75, max_total_tokens: 1_075 };
    const result = await runner.run(request);
    expect(result.state).toBe("budget_exhausted");
    expect(adapter.maxActive).toBe(1);
    expect(result.tasks.filter((task) => task.state === "budget_exhausted")).toHaveLength(1);
  });

  it("counts rejected attempts and resumes event sequencing on retry", async () => {
    const adapter = new InvalidOnceAdapter();
    const monitor = new InMemoryHarnessMonitor();
    const runner = new CollaborationRunner(
      new AdapterRegistry().register(adapter),
      { load: async () => [{ evidence_type: "artifact", evidence_id: artifact, text: "Primary evidence." }] },
      monitor,
    );
    const request = baseRequest();
    request.agents = [request.agents[0]!];
    request.synthesis_agent_id = "researcher";
    request.max_retries_per_task = 1;
    const result = await runner.run(request, { initialSequence: 7 });
    expect(result.state).toBe("succeeded");
    expect(result.tasks[0]).toMatchObject({
      attempts: 2,
      usage: { input_tokens: 20, output_tokens: 10, cached_input_tokens: 0 },
    });
    expect(result.usage).toEqual({ input_tokens: 20, output_tokens: 10, cached_input_tokens: 0 });
    expect(monitor.list(result.run_id)[0]?.sequence).toBe(7);
  });

  it("rejects dependency cycles before calling a model", async () => {
    const adapter = new FakeAdapter();
    const runner = new CollaborationRunner(
      new AdapterRegistry().register(adapter),
      { load: async () => [{ evidence_type: "artifact", evidence_id: artifact, text: "Primary evidence." }] },
      new InMemoryHarnessMonitor(),
    );
    const request = baseRequest();
    request.agents[0]!.depends_on = ["synthesizer"];
    await expect(runner.run(request)).rejects.toThrow(/cycle/);
  });

  it("fails closed when an evidence loader omits or over-fetches requested evidence", async () => {
    const adapter = new FakeAdapter();
    const missing = new CollaborationRunner(
      new AdapterRegistry().register(adapter),
      { load: async () => [] },
      new InMemoryHarnessMonitor(),
    );
    await expect(missing.run(baseRequest())).rejects.toThrow(/missing.*unauthorized evidence/);

    const extra = new CollaborationRunner(
      new AdapterRegistry().register(adapter),
      { load: async () => [
        { evidence_type: "artifact", evidence_id: artifact, text: "Primary evidence." },
        { evidence_type: "artifact", evidence_id: randomUUID(), text: "Unrequested evidence." },
      ] },
      new InMemoryHarnessMonitor(),
    );
    await expect(extra.run(baseRequest())).rejects.toThrow(/unrequested evidence/);
  });
});
