import { evaluateInterruption, sendAPNs, isWithinQuietHours, type APNsConfiguration, type CallbackType } from "@co/notifications";
import { createClient } from "@supabase/supabase-js";
import { task } from "@trigger.dev/sdk/v3";
import { z } from "zod";

const payloadSchema = z.object({
  callbackId: z.uuid(),
  userId: z.uuid(),
  resourceVersion: z.literal("callback-delivery.v1"),
});

const callbackSchema = z.object({
  id: z.uuid(), callback_type: z.enum(["pattern", "radar", "reminder", "weekly", "outcome", "return", "event_anchor", "second_opinion", "reflection", "absence"]),
  resource_id: z.uuid(), scheduled_at: z.string(), sent_at: z.string().nullable(),
});

const configurationSchema = z.object({
  APNS_TEAM_ID: z.string().min(10), APNS_KEY_ID: z.string().min(10),
  APNS_BUNDLE_ID: z.string().min(3), APNS_PRIVATE_KEY_BASE64: z.string().min(40),
});

export const deliverCallbackTask = task({
  id: "deliver-callback-v1",
  retry: { maxAttempts: 5, factor: 2, minTimeoutInMs: 1_000, maxTimeoutInMs: 60_000, randomize: true },
  run: async (unknownPayload) => {
    const payload = payloadSchema.parse(unknownPayload);
    if (process.env.FEATURE_NOTIFICATIONS !== "true") return { status: "disabled" };
    const url = z.url().parse(process.env.NEXT_PUBLIC_SUPABASE_URL);
    const serviceKey = z.string().min(20).parse(process.env.SUPABASE_SERVICE_ROLE_KEY);
    const environment = configurationSchema.parse(process.env);
    const configuration: APNsConfiguration = {
      teamId: environment.APNS_TEAM_ID,
      keyId: environment.APNS_KEY_ID,
      bundleId: environment.APNS_BUNDLE_ID,
      privateKeyBase64: environment.APNS_PRIVATE_KEY_BASE64,
    };
    const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const callbackResult = await admin.from("callbacks").select("id,callback_type,resource_id,scheduled_at,sent_at")
      .eq("id", payload.callbackId).eq("user_id", payload.userId).single();
    if (callbackResult.error) throw callbackResult.error;
    const callback = callbackSchema.parse(callbackResult.data);
    if (callback.sent_at) return { status: "already_sent" };
    const now = new Date();
    if (new Date(callback.scheduled_at) > now) return { status: "not_due" };

    const profile = await admin.from("profiles").select("timezone,quiet_hours_start,quiet_hours_end,proactive_weekly_cap")
      .eq("id", payload.userId).single();
    if (profile.error) throw profile.error;
    const proactiveTypes: CallbackType[] = ["pattern", "radar", "weekly", "outcome", "return", "event_anchor", "second_opinion", "reflection", "absence"];
    const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const [sent, unread] = await Promise.all([
      admin.from("callbacks").select("id", { count: "exact", head: true })
        .eq("user_id", payload.userId).in("callback_type", proactiveTypes)
        .not("sent_at", "is", null).gte("sent_at", since),
      admin.from("callbacks").select("id", { count: "exact", head: true })
        .eq("user_id", payload.userId).in("callback_type", proactiveTypes)
        .not("sent_at", "is", null).is("opened_at", null).neq("id", callback.id),
    ]);
    if (sent.error) throw sent.error;
    if (unread.error) throw unread.error;
    const policy = evaluateInterruption({
      callbackType: callback.callback_type,
      withinQuietHours: isWithinQuietHours(now, profile.data.timezone, profile.data.quiet_hours_start, profile.data.quiet_hours_end),
      proactiveSentThisWeek: sent.count ?? 0,
      weeklyCap: profile.data.proactive_weekly_cap,
      hasUnreadProactive: (unread.count ?? 0) > 0,
    });
    if (policy.decision === "inbox_only") {
      const suppressed = await admin.from("callbacks").update({ inbox_only_at: now.toISOString(), suppression_reason: policy.reason })
        .eq("id", callback.id).eq("user_id", payload.userId).is("sent_at", null);
      if (suppressed.error) throw suppressed.error;
      return { status: "inbox_only", reason: policy.reason };
    }

    const devices = await admin.from("devices").select("id,apns_token,apns_environment")
      .eq("user_id", payload.userId).not("apns_token", "is", null);
    if (devices.error) throw devices.error;
    let delivered = 0;
    for (const device of devices.data ?? []) {
      const response = await sendAPNs({
        token: device.apns_token,
        environment: device.apns_environment,
        callbackType: callback.callback_type as CallbackType,
        resourceId: callback.resource_id,
        configuration,
        now,
      });
      if (response.status === 200) delivered += 1;
      else if (response.status === 410 || response.reason === "BadDeviceToken" || response.reason === "Unregistered") {
        await admin.from("devices").update({ apns_token: null }).eq("id", device.id).eq("user_id", payload.userId);
      } else {
        throw new Error(`APNs rejected callback: ${response.status} ${response.reason ?? "unknown"}`);
      }
    }
    if (delivered === 0) {
      await admin.from("callbacks").update({ inbox_only_at: now.toISOString(), suppression_reason: "no_registered_device" })
        .eq("id", callback.id).eq("user_id", payload.userId).is("sent_at", null);
      return { status: "inbox_only", reason: "no_registered_device" };
    }
    const updated = await admin.from("callbacks").update({ sent_at: now.toISOString() })
      .eq("id", callback.id).eq("user_id", payload.userId).is("sent_at", null);
    if (updated.error) throw updated.error;
    return { status: "sent", devices: delivered };
  },
});
