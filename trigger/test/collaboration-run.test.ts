import { afterEach, describe, expect, it, vi } from "vitest";
import { setDbForTesting } from "../src/lib/db";
import { runCollaborationV1 } from "../src/tasks/collaboration-run-v1";

const userId = "a1111111-bbbb-4111-8111-cccccccccccc";
const runId = "b2222222-cccc-4222-8222-dddddddddddd";

const request = {
  tenant_id: userId,
  idempotency_key: "collaboration:test:lease",
  objective: "Produce one cited reading.",
  evidence_packet: {
    artifact_ids: ["c3333333-dddd-4333-8333-eeeeeeeeeeee"],
    signal_ids: [],
    segment_ids: [],
    context_event_ids: [],
  },
  agents: [
    {
      id: "reader",
      name: "Reader",
      objective: "Read the evidence.",
      instructions: "",
      model: {
        provider: "openai",
        model: "configured-model",
        max_output_tokens: 400,
        reasoning_effort: "low",
        timeout_ms: 30_000,
      },
      depends_on: [],
    },
  ],
  synthesis_agent_id: "reader",
  token_budget: {
    max_input_tokens: 2_000,
    max_output_tokens: 500,
    max_total_tokens: 2_500,
  },
  max_concurrency: 1,
  max_retries_per_task: 0,
};

afterEach(() => setDbForTesting(undefined));

describe("collaboration run ownership", () => {
  it("returns an existing terminal run without touching tasks or providers", async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "enqueue_collaboration_run") {
        return { data: { run_id: runId, state: "succeeded", deduped: true }, error: null };
      }
      if (name === "claim_collaboration_run") {
        return { data: { claimed: false, run_id: runId, state: "succeeded" }, error: null };
      }
      throw new Error(`unexpected RPC: ${name}`);
    });
    const from = vi.fn(() => {
      throw new Error("terminal dedupe must not query collaboration tasks");
    });
    setDbForTesting({ rpc, from } as never);

    await expect(runCollaborationV1(request)).resolves.toEqual({
      runId,
      state: "succeeded",
      deduped: true,
    });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(from).not.toHaveBeenCalled();
  });

  it("does not execute while another worker owns a live run lease", async () => {
    const rpc = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === "enqueue_collaboration_run") {
        expect(input.p_request_payload).toMatchObject({ tenant_id: userId });
        return { data: { run_id: runId, state: "running", deduped: true }, error: null };
      }
      if (name === "claim_collaboration_run") {
        expect(input).toMatchObject({
          p_user_id: userId,
          p_run_id: runId,
          p_lease_seconds: 120,
        });
        return { data: { claimed: false, run_id: runId, state: "running" }, error: null };
      }
      throw new Error(`unexpected RPC: ${name}`);
    });
    const from = vi.fn(() => {
      throw new Error("unowned worker must not query collaboration tasks");
    });
    setDbForTesting({ rpc, from } as never);

    await expect(runCollaborationV1(request)).resolves.toEqual({
      runId,
      state: "running",
      deduped: true,
    });
    expect(from).not.toHaveBeenCalled();
  });
});
