import { createHash } from "node:crypto";
import { collaborationRunRequestSchema, featureFlagsFromEnvironment } from "@co/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { HttpStatusError } from "./http-status-error";

type StartDependencies = {
  environment?: Record<string, string | undefined>;
  dispatch?: (request: ReturnType<typeof collaborationRunRequestSchema.parse>) => Promise<void>;
};

function hostedModelAllowed(
  environment: Record<string, string | undefined>,
  provider: "openai" | "anthropic",
  model: string,
) {
  const key = provider === "openai" ? "CO_HARNESS_OPENAI_MODELS" : "CO_HARNESS_ANTHROPIC_MODELS";
  const configured = (environment[key] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (configured.length === 0) return environment.NODE_ENV !== "production";
  return configured.includes(model);
}

async function dispatchWithTrigger(
  request: ReturnType<typeof collaborationRunRequestSchema.parse>,
) {
  const dispatchKey = createHash("sha256")
    .update(request.tenant_id)
    .update("\0")
    .update(request.idempotency_key)
    .digest("hex");
  await tasks.trigger("collaboration-run-v1", request, {
    idempotencyKey: `collaboration:${dispatchKey}`,
  });
}

const queuedRunSchema = z.object({
  run_id: z.uuid(),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "budget_exhausted"]),
  created_at: z.iso.datetime({ offset: true }),
  deduped: z.boolean(),
});

export async function startCollaboration(
  admin: SupabaseClient,
  userId: string,
  unknownInput: unknown,
  dependencies: StartDependencies = {},
) {
  const environment = dependencies.environment ?? process.env;
  if (!featureFlagsFromEnvironment(environment).collaboration_harness) {
    throw new HttpStatusError(503, "collaboration harness unavailable");
  }
  const request = collaborationRunRequestSchema.parse({
    ...(unknownInput as Record<string, unknown>),
    tenant_id: userId,
  });
  if (request.agents.some((agent) => agent.model.provider === "custom")) {
    throw new HttpStatusError(
      400,
      "custom providers are available through the library adapter registry, not the hosted API",
    );
  }
  if (request.agents.length > 16 || request.token_budget.max_total_tokens > 500_000) {
    throw new HttpStatusError(400, "hosted collaboration run exceeds the agent or token limit");
  }
  if (
    request.agents.some(
      (agent) =>
        agent.model.provider !== "custom" &&
        !hostedModelAllowed(environment, agent.model.provider, agent.model.model),
    )
  ) {
    throw new HttpStatusError(400, "collaboration model is not enabled for this deployment");
  }
  const queued = await admin.rpc("enqueue_collaboration_run", {
    p_user_id: userId,
    p_request_payload: request,
  });
  if (queued.error?.code === "22000") {
    throw new HttpStatusError(409, "idempotency key belongs to a different collaboration request");
  }
  if (queued.error) throw queued.error;
  const run = queuedRunSchema.parse(queued.data);
  // A failed run remains inspectable. Retrying with a new idempotency key creates a new
  // append-only run instead of silently replacing partial results from the failed one.
  if (!run.deduped || run.state === "queued") {
    await (dependencies.dispatch ?? dispatchWithTrigger)(request);
  }
  return {
    runId: run.run_id,
    state: run.state,
    createdAt: run.created_at,
    deduped: run.deduped,
  };
}

export async function monitorCollaboration(
  admin: SupabaseClient,
  userId: string,
  runId: string,
  afterSequence = -1,
) {
  const run = await admin
    .from("collaboration_runs")
    .select(
      "id,objective,state,token_budget,input_tokens,output_tokens,cached_input_tokens,max_concurrency,cancel_requested_at,started_at,completed_at,created_at",
    )
    .eq("id", runId)
    .eq("user_id", userId)
    .single();
  if (run.error) throw new HttpStatusError(404, "collaboration run not found");
  const [tasksResult, eventsResult, resultsResult] = await Promise.all([
    admin
      .from("collaboration_tasks")
      .select(
        "id,agent_id,agent_name,provider,model,state,attempts,input_tokens,output_tokens,cached_input_tokens,error_class,started_at,completed_at",
      )
      .eq("run_id", runId)
      .eq("user_id", userId)
      .order("created_at"),
    admin
      .from("collaboration_events")
      .select("sequence,event_type,task_id,agent_id,state,usage,detail,occurred_at")
      .eq("run_id", runId)
      .eq("user_id", userId)
      .gt("sequence", afterSequence)
      .order("sequence")
      .limit(500),
    admin
      .from("collaboration_results")
      .select("id,task_id,output,output_hash,created_at")
      .eq("run_id", runId)
      .eq("user_id", userId),
  ]);
  if (tasksResult.error) throw tasksResult.error;
  if (eventsResult.error) throw eventsResult.error;
  if (resultsResult.error) throw resultsResult.error;
  return {
    run: run.data,
    tasks: tasksResult.data ?? [],
    events: eventsResult.data ?? [],
    results: resultsResult.data ?? [],
    nextSequence: (eventsResult.data ?? []).at(-1)?.sequence ?? afterSequence,
  };
}
