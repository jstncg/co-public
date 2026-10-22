import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const openSchema = z.object({
  callbackType: z.enum(["pattern", "radar", "reminder", "weekly", "outcome", "return", "event_anchor", "second_opinion", "reflection", "absence"]),
  resourceId: z.uuid(),
}).strict();

export async function markCallbackOpened(admin: SupabaseClient, userId: string, unknownInput: unknown, now = new Date()) {
  const input = openSchema.parse(unknownInput);
  const result = await admin.from("callbacks").update({ opened_at: now.toISOString() })
    .eq("user_id", userId).eq("callback_type", input.callbackType).eq("resource_id", input.resourceId)
    .not("sent_at", "is", null).is("opened_at", null).select("id");
  if (result.error) throw new Error(`callback open: ${result.error.message}`);
  return { opened: (result.data?.length ?? 0) > 0 };
}

