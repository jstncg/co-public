import { describe, expect, it, vi } from "vitest";
import { startCollaboration } from "./collaboration-service";

const userId = "a1111111-bbbb-4111-8111-cccccccccccc";
const artifactId = "b2222222-cccc-4222-8222-dddddddddddd";

const request = {
  tenant_id: "c3333333-dddd-4333-8333-eeeeeeeeeeee",
  idempotency_key: "collaboration:test:one",
  objective: "Produce one cited reading.",
  evidence_packet: { artifact_ids: [artifactId], signal_ids: [], segment_ids: [] },
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

describe("collaboration service", () => {
  it("fails closed behind its feature flag", async () => {
    await expect(
      startCollaboration({} as never, userId, request, {
        environment: { FEATURE_COLLABORATION_HARNESS: "false" },
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("overwrites caller tenant scope and dispatches the validated run", async () => {
    const rpc = vi.fn(async () => ({
      data: {
        run_id: "d4444444-eeee-4444-8444-ffffffffffff",
        state: "queued",
        created_at: "2026-07-30T12:00:00Z",
        deduped: false,
      },
      error: null,
    }));
    const admin = { rpc };
    const dispatch = vi.fn(async () => {});
    const result = await startCollaboration(admin as never, userId, request, {
      environment: { FEATURE_COLLABORATION_HARNESS: "true" },
      dispatch,
    });
    expect(rpc).toHaveBeenCalledWith("enqueue_collaboration_run", {
      p_user_id: userId,
      p_request_payload: expect.objectContaining({ tenant_id: userId }),
    });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: userId }));
    expect(result).toMatchObject({ state: "queued", deduped: false });
  });

  it("rejects an idempotency key reused for different work", async () => {
    const admin = {
      rpc: vi.fn(async () => ({
        data: null,
        error: { code: "22000", message: "collaboration idempotency collision" },
      })),
    };
    const dispatch = vi.fn(async () => {});
    await expect(
      startCollaboration(admin as never, userId, request, {
        environment: { FEATURE_COLLABORATION_HARNESS: "true" },
        dispatch,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(dispatch).not.toHaveBeenCalled();
  });
});
