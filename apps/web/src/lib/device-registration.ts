import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const deviceRegistrationSchema = z.object({
  deviceId: z.uuid(),
  // Apple treats device tokens as variable-length binary values; require 16–100 bytes of lowercase hex.
  apnsToken: z.string().regex(/^(?:[a-f0-9]{2}){16,100}$/),
  apnsEnvironment: z.enum(["sandbox", "production"]),
  appVersion: z.string().trim().min(1).max(40),
  osVersion: z.string().trim().min(1).max(80),
}).strict();

export async function registerDevice(admin: SupabaseClient, userId: string, input: unknown) {
  const device = deviceRegistrationSchema.parse(input);
  const result = await admin.rpc("register_apns_device", {
    p_user_id: userId,
    p_device_id: device.deviceId,
    p_apns_token: device.apnsToken,
    p_apns_environment: device.apnsEnvironment,
    p_app_version: device.appVersion,
    p_os_version: device.osVersion,
  });
  if (result.error) throw new Error(`device registration: ${result.error.message}`);
  return { registered: true as const };
}
