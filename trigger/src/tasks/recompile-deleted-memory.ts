import { createModelProvider, type PipelineModelProvider } from "@co/model-gateway";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { schedules } from "@trigger.dev/sdk/v3";
import { z } from "zod";
import { compilePattern } from "./compile-patterns";

type RecompileJob = { job_id: string; user_id: string };
type Compiler = (admin: SupabaseClient, userId: string, provider: PipelineModelProvider) => Promise<unknown>;

export async function drainDeletionRecompiles(
  admin: SupabaseClient,
  provider: PipelineModelProvider = createModelProvider(),
  compiler: Compiler = compilePattern,
) {
  const claimed = await admin.schema("private").rpc("claim_pattern_recompile_jobs", { p_limit: 10 });
  if (claimed.error) throw claimed.error;
  const results = [];
  for (const job of (claimed.data ?? []) as RecompileJob[]) {
    try {
      const result = await compiler(admin, job.user_id, provider);
      const completed = await admin.schema("private").from("job_runs").update({ status: "succeeded", updated_at: new Date().toISOString() }).eq("id", job.job_id);
      if (completed.error) throw completed.error;
      results.push({ jobId: job.job_id, status: "succeeded", result });
    } catch (error) {
      const failed = await admin.schema("private").from("job_runs").update({
        status: "failed", error_class: error instanceof Error ? error.name : "unknown", updated_at: new Date().toISOString(),
      }).eq("id", job.job_id);
      if (failed.error) throw failed.error;
      results.push({ jobId: job.job_id, status: "failed" });
    }
  }
  return results;
}

export const recompileDeletedMemoryTask = schedules.task({
  id: "recompile-deleted-memory-v1",
  cron: "* * * * *",
  run: async () => {
    if (process.env.FEATURE_PATTERN_COMPILATION !== "true") return { status: "disabled" };
    const admin = createClient(
      z.url().parse(process.env.NEXT_PUBLIC_SUPABASE_URL),
      z.string().min(20).parse(process.env.SUPABASE_SERVICE_ROLE_KEY),
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    return { status: "processed", jobs: await drainDeletionRecompiles(admin) };
  },
});
