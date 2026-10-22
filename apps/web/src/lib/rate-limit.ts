import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const resultSchema = z.object({
  allowed: z.boolean(),
  retry_after_seconds: z.number().int().nonnegative(),
  current_count: z.number().int().positive(),
});

export type RateLimitPolicy = {
  bucket: string;
  limit: number;
  windowSeconds: number;
};

export async function enforceUserRateLimit(
  admin: SupabaseClient,
  userId: string,
  policy: RateLimitPolicy,
) {
  const result = await admin.rpc("claim_api_rate_limit", {
    p_scope_key: `user:${userId}`,
    p_bucket: policy.bucket,
    p_limit: policy.limit,
    p_window_seconds: policy.windowSeconds,
  });
  if (result.error) throw new Error(`rate limit unavailable: ${result.error.message}`);
  const parsed = resultSchema.parse(Array.isArray(result.data) ? result.data[0] : result.data);
  if (!parsed.allowed) {
    throw Response.json({ error: "rate_limited" }, {
      status: 429,
      headers: { "retry-after": String(parsed.retry_after_seconds) },
    });
  }
  return parsed;
}

