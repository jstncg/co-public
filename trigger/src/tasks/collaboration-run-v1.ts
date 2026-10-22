import { createHash } from "node:crypto";
import { task } from "@trigger.dev/sdk/v3";
import {
  AdapterRegistry,
  AnthropicHarnessAdapter,
  CollaborationRunner,
  OpenAIHarnessAdapter,
  type HarnessEventSink,
  type HarnessEvidenceLoader,
} from "@co/collaboration-harness";
import {
  collaborationRunRequestSchema,
  type CollaborationRunRequest,
  type HarnessEvent,
} from "@co/contracts";
import { z } from "zod";
import { loadContextEvidence } from "../lib/context-evidence";
import { serviceDb } from "../lib/db";

export type CollaborationRunV1Payload = CollaborationRunRequest;

const runStateSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "budget_exhausted",
]);
const enqueuedRunSchema = z.object({
  run_id: z.uuid(),
  state: runStateSchema,
  deduped: z.boolean(),
});
const claimedRunSchema = z
  .object({
    claimed: z.boolean(),
    run_id: z.uuid(),
    state: runStateSchema,
    lease_token: z.uuid().optional(),
  })
  .superRefine((claim, context) => {
    if (claim.claimed && !claim.lease_token) {
      context.addIssue({
        code: "custom",
        path: ["lease_token"],
        message: "claimed run has no lease token",
      });
    }
  });

class CollaborationLeaseLostError extends Error {
  constructor() {
    super("collaboration run lease lost");
    this.name = "CollaborationLeaseLostError";
  }
}

export async function runCollaborationV1(unknownPayload: unknown) {
  const payload = collaborationRunRequestSchema.parse(unknownPayload);
  const db = serviceDb();
  const enqueuedResult = await db.rpc("enqueue_collaboration_run", {
    p_user_id: payload.tenant_id,
    p_request_payload: payload,
  });
  if (enqueuedResult.error) throw enqueuedResult.error;
  const enqueued = enqueuedRunSchema.parse(enqueuedResult.data);
  const runId = enqueued.run_id;
  const longestAttemptSeconds = Math.ceil(
    Math.max(...payload.agents.map((agent) => agent.model.timeout_ms)) / 1_000,
  );
  const leaseSeconds = Math.min(1_800, Math.max(120, longestAttemptSeconds + 60));
  const claimResult = await db.rpc("claim_collaboration_run", {
    p_user_id: payload.tenant_id,
    p_run_id: runId,
    p_request_payload: payload,
    p_lease_seconds: leaseSeconds,
  });
  if (claimResult.error) throw claimResult.error;
  const claim = claimedRunSchema.parse(claimResult.data);
  if (!claim.claimed) return { runId, state: claim.state, deduped: true };
  if (!claim.lease_token) throw new Error("claimed collaboration run has no lease token");
  const leaseToken = claim.lease_token;
  const renewLease = async () => {
    const renewed = await db.rpc("renew_collaboration_run_lease", {
      p_user_id: payload.tenant_id,
      p_run_id: runId,
      p_lease_token: leaseToken,
      p_lease_seconds: leaseSeconds,
    });
    if (renewed.error) throw renewed.error;
    if (renewed.data !== true) throw new CollaborationLeaseLostError();
  };
  let accountedUsage = { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 };

  try {
    const taskRows = payload.agents.map((agent) => ({
      user_id: payload.tenant_id,
      run_id: runId,
      agent_id: agent.id,
      agent_name: agent.name,
      objective: agent.objective,
      instructions: agent.instructions,
      provider: agent.model.provider,
      model: agent.model.model,
      max_output_tokens: agent.model.max_output_tokens,
      reasoning_effort: agent.model.reasoning_effort,
      timeout_ms: agent.model.timeout_ms,
      depends_on: agent.depends_on,
      state: "queued",
    }));
    const insertedTasks = await db
      .from("collaboration_tasks")
      .upsert(taskRows, {
        onConflict: "run_id,agent_id",
        ignoreDuplicates: true,
      })
      .select("id,agent_id");
    if (insertedTasks.error) throw insertedTasks.error;
    const allTasks = await db.from("collaboration_tasks").select("id,agent_id").eq("run_id", runId);
    if (allTasks.error) throw allTasks.error;
    const taskIdByAgent = new Map(
      (allTasks.data ?? []).map((row) => [String(row.agent_id), String(row.id)]),
    );

    const evidenceLoader: HarnessEvidenceLoader = {
      load: async (packet, tenantId) => {
        const evidence: Awaited<ReturnType<HarnessEvidenceLoader["load"]>> = [];
        if (packet.artifact_ids.length > 0) {
          const rows = await db
            .from("artifacts")
            .select("id,title,raw_text,transcript,user_note,source_type,source_coverage")
            .eq("user_id", tenantId)
            .in("id", packet.artifact_ids)
            .is("deleted_at", null);
          if (rows.error) throw rows.error;
          evidence.push(
            ...(rows.data ?? [])
              .map((row) => ({
                evidence_type: "artifact" as const,
                evidence_id: String(row.id),
                text: String(
                  row.user_note ?? row.transcript ?? row.raw_text ?? row.title ?? "",
                ).slice(0, 8_000),
                metadata: {
                  source_type: String(row.source_type),
                  coverage: String(row.source_coverage),
                },
              }))
              .filter((item) => item.text.length > 0),
          );
        }
        if (packet.segment_ids.length > 0) {
          const rows = await db
            .from("artifact_segments")
            .select("id,text,start_seconds,end_seconds,speaker_relation")
            .eq("user_id", tenantId)
            .in("id", packet.segment_ids);
          if (rows.error) throw rows.error;
          evidence.push(
            ...(rows.data ?? []).map((row) => ({
              evidence_type: "segment" as const,
              evidence_id: String(row.id),
              text: String(row.text).slice(0, 8_000),
              metadata: {
                start_seconds: row.start_seconds === null ? null : Number(row.start_seconds),
                end_seconds: row.end_seconds === null ? null : Number(row.end_seconds),
                speaker_relation: String(row.speaker_relation),
              },
            })),
          );
        }
        if (packet.signal_ids.length > 0) {
          const rows = await db
            .from("signal_candidates")
            .select("id,statement,signal_type,subject_relation,confidence")
            .eq("user_id", tenantId)
            .in("id", packet.signal_ids)
            .neq("status", "invalidated");
          if (rows.error) throw rows.error;
          evidence.push(
            ...(rows.data ?? []).map((row) => ({
              evidence_type: "signal" as const,
              evidence_id: String(row.id),
              text: String(row.statement).slice(0, 2_000),
              metadata: {
                signal_type: String(row.signal_type),
                subject_relation: String(row.subject_relation),
                confidence: Number(row.confidence),
              },
            })),
          );
        }
        if (packet.context_event_ids.length > 0) {
          const rows = await loadContextEvidence(db, tenantId, packet.context_event_ids);
          evidence.push(...rows.map((row) => row.harness));
        }
        const found = new Set(evidence.map((item) => `${item.evidence_type}:${item.evidence_id}`));
        const expected = [
          ...packet.artifact_ids.map((id) => `artifact:${id}`),
          ...packet.segment_ids.map((id) => `segment:${id}`),
          ...packet.signal_ids.map((id) => `signal:${id}`),
          ...packet.context_event_ids.map((id) => `context_event:${id}`),
        ];
        if (expected.some((key) => !found.has(key))) {
          throw new Error(
            "evidence packet contains missing, empty, deleted, invalidated, or unauthorized evidence",
          );
        }
        return evidence;
      },
    };

    const eventSink: HarnessEventSink = {
      append: async (event: HarnessEvent) => {
        await renewLease();
        const inserted = await db.from("collaboration_events").insert({
          user_id: payload.tenant_id,
          run_id: runId,
          task_id: event.agent_id ? (taskIdByAgent.get(event.agent_id) ?? null) : null,
          sequence: event.sequence,
          event_type: event.event_type,
          agent_id: event.agent_id,
          state: event.state,
          usage: event.usage,
          detail: event.detail,
          occurred_at: event.occurred_at,
        });
        if (inserted.error) throw inserted.error;
        if (event.agent_id) {
          const state =
            event.event_type === "task_completed"
              ? "succeeded"
              : event.event_type === "task_failed"
                ? "failed"
                : event.event_type === "task_cancelled"
                  ? event.state
                  : event.event_type === "budget_exhausted"
                    ? "budget_exhausted"
                    : event.event_type === "task_started" || event.event_type === "task_retrying"
                      ? "running"
                      : "queued";
          const updated = await db
            .from("collaboration_tasks")
            .update({
              state,
              ...(event.usage
                ? {
                    input_tokens: event.usage.input_tokens,
                    output_tokens: event.usage.output_tokens,
                    cached_input_tokens: event.usage.cached_input_tokens,
                  }
                : {}),
            })
            .eq("run_id", runId)
            .eq("agent_id", event.agent_id)
            .neq("state", "cancelled");
          if (updated.error) throw updated.error;
        }
      },
    };

    const adapters = new AdapterRegistry();
    if (process.env.OPENAI_API_KEY)
      adapters.register(new OpenAIHarnessAdapter(process.env.OPENAI_API_KEY));
    if (process.env.ANTHROPIC_API_KEY)
      adapters.register(new AnthropicHarnessAdapter(process.env.ANTHROPIC_API_KEY));
    const requiredProviders = new Set(payload.agents.map((agent) => agent.model.provider));
    for (const provider of requiredProviders) adapters.resolve(provider);

    const latestEvent = await db
      .from("collaboration_events")
      .select("sequence")
      .eq("run_id", runId)
      .eq("user_id", payload.tenant_id)
      .order("sequence", { ascending: false })
      .limit(1)
      .maybeSingle<{ sequence: number }>();
    if (latestEvent.error) throw latestEvent.error;
    const result = await new CollaborationRunner(adapters, evidenceLoader, eventSink).run(payload, {
      runId,
      initialSequence: (latestEvent.data?.sequence ?? -1) + 1,
    });
    accountedUsage = result.usage;
    const currentRun = await db
      .from("collaboration_runs")
      .select("state")
      .eq("id", runId)
      .eq("user_id", payload.tenant_id)
      .single<{ state: string }>();
    if (currentRun.error) throw currentRun.error;
    if (currentRun.data.state === "cancelled") {
      const cancelledTasks = await db
        .from("collaboration_tasks")
        .update({
          state: "cancelled",
          error_class: "evidence_invalidated",
          completed_at: new Date().toISOString(),
        })
        .eq("run_id", runId)
        .eq("user_id", payload.tenant_id);
      if (cancelledTasks.error) throw cancelledTasks.error;
      return { runId, state: "cancelled" as const, deduped: enqueued.deduped };
    }
    for (const taskResult of result.tasks) {
      const taskId = taskIdByAgent.get(taskResult.agent_id);
      if (!taskId) continue;
      const updated = await db
        .from("collaboration_tasks")
        .update({
          state: taskResult.state,
          attempts: taskResult.attempts,
          input_tokens: taskResult.usage.input_tokens,
          output_tokens: taskResult.usage.output_tokens,
          cached_input_tokens: taskResult.usage.cached_input_tokens,
          error_class: taskResult.error_class,
          completed_at: new Date().toISOString(),
        })
        .eq("id", taskId)
        .neq("state", "cancelled");
      if (updated.error) throw updated.error;
      if (taskResult.output && taskResult.result_id) {
        const serialized = JSON.stringify(taskResult.output);
        const stored = await db.from("collaboration_results").upsert(
          {
            id: taskResult.result_id,
            user_id: payload.tenant_id,
            run_id: runId,
            task_id: taskId,
            output: taskResult.output,
            output_hash: createHash("sha256").update(serialized).digest("hex"),
          },
          { onConflict: "task_id" },
        );
        if (stored.error) throw stored.error;
      }
    }
    const completed = await db.rpc("finish_collaboration_run", {
      p_user_id: payload.tenant_id,
      p_run_id: runId,
      p_lease_token: leaseToken,
      p_state: result.state,
      p_input_tokens: result.usage.input_tokens,
      p_output_tokens: result.usage.output_tokens,
      p_cached_input_tokens: result.usage.cached_input_tokens,
    });
    if (completed.error) throw completed.error;
    if (completed.data !== true) throw new CollaborationLeaseLostError();
    return { runId, state: result.state, deduped: enqueued.deduped };
  } catch (error) {
    const afterError = await db
      .from("collaboration_runs")
      .select("state")
      .eq("id", runId)
      .eq("user_id", payload.tenant_id)
      .maybeSingle<{ state: string }>();
    if (!afterError.error && afterError.data?.state === "cancelled") {
      const cancelledTasks = await db
        .from("collaboration_tasks")
        .update({
          state: "cancelled",
          error_class: "evidence_invalidated",
          completed_at: new Date().toISOString(),
        })
        .eq("run_id", runId)
        .eq("user_id", payload.tenant_id);
      if (cancelledTasks.error) throw cancelledTasks.error;
      return { runId, state: "cancelled" as const, deduped: enqueued.deduped };
    }
    if (error instanceof CollaborationLeaseLostError && afterError.data) {
      return { runId, state: runStateSchema.parse(afterError.data.state), deduped: true };
    }
    const failed = await db.rpc("finish_collaboration_run", {
      p_user_id: payload.tenant_id,
      p_run_id: runId,
      p_lease_token: leaseToken,
      p_state: "failed",
      p_input_tokens: accountedUsage.input_tokens,
      p_output_tokens: accountedUsage.output_tokens,
      p_cached_input_tokens: accountedUsage.cached_input_tokens,
    });
    if (failed.error) throw failed.error;
    if (failed.data !== true) throw new CollaborationLeaseLostError();
    throw error;
  }
}

export const collaborationRunV1 = task({
  id: "collaboration-run-v1",
  run: runCollaborationV1,
});
