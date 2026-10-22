/** service-role supabase client — WORKERS ONLY. the ios/web clients never see this key (goal.md §25.3). */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type Db = SupabaseClient;

let cached: Db | undefined;

/** test seam: inject a fake client so task run functions can be exercised without supabase. */
export function setDbForTesting(db: Db | undefined): void {
  cached = db;
}

export function serviceDb(env: Record<string, string | undefined> = process.env): Db {
  if (cached) return cached;
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (workers only — never bundle into clients)");
  }
  cached = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return cached;
}

/** throw on postgrest error — tasks rely on trigger.dev retries for transient failures. */
export function must<T>(result: { data: T | null; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  if (result.data === null) throw new Error(`${what}: no data`);
  return result.data;
}
