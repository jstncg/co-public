import { createHmac, randomInt, randomUUID } from "node:crypto";
import { featureFlagsFromEnvironment, phoneLinkRequestSchema, phoneLinkStatusSchema, phoneLinkVerifySchema } from "@co/contracts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

type Environment = Record<string, string | undefined>;
type Dependencies = {
  environment?: Environment;
  fetchImplementation?: typeof fetch;
  now?: Date;
  challengeId?: string;
  code?: string;
};

const e164 = z.string().regex(/^\+[1-9][0-9]{7,14}$/);

function phoneLinkConfiguration(environment: Environment) {
  if (!featureFlagsFromEnvironment(environment).phone_linking) throw new Response("phone linking unavailable", { status: 503 });
  return z.object({
    CO_PHONE_MAPPING_PEPPER: z.string().min(32),
    CO_PHONE_LINK_CHALLENGE_SECRET: z.string().min(32),
  }).parse(environment);
}

function phoneLinkDeliveryConfiguration(environment: Environment) {
  const provider = environment.CO_RAIL?.trim().toLowerCase() || "sendblue";
  if (provider === "linq") {
    return z.object({
      LINQ_API_KEY: z.string().min(8),
      LINQ_FROM_NUMBER: e164,
    }).parse(environment);
  }
  if (provider !== "sendblue") throw new Error(`unsupported CO_RAIL ${JSON.stringify(provider)}`);
  return z.object({
    SENDBLUE_API_KEY_ID: z.string().min(8),
    SENDBLUE_API_SECRET_KEY: z.string().min(8),
    SENDBLUE_FROM_NUMBER: e164,
  }).parse(environment);
}

function digest(secret: string, value: string) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

export async function requestPhoneLink(admin: SupabaseClient, userId: string, unknownInput: unknown, dependencies: Dependencies = {}) {
  const input = phoneLinkRequestSchema.parse(unknownInput);
  const environment = dependencies.environment ?? process.env;
  const config = phoneLinkConfiguration(environment);
  const delivery = phoneLinkDeliveryConfiguration(environment);
  const challengeId = dependencies.challengeId ?? randomUUID();
  const code = dependencies.code ?? randomInt(0, 1_000_000).toString().padStart(6, "0");
  const now = dependencies.now ?? new Date();
  const expiresAt = new Date(now.getTime() + 5 * 60_000).toISOString();
  const phoneHash = digest(config.CO_PHONE_MAPPING_PEPPER, input.phoneNumber);
  const codeHash = digest(config.CO_PHONE_LINK_CHALLENGE_SECRET, `${challengeId}:${code}`);
  const begun = await admin.rpc("begin_transport_phone_link", {
    p_challenge_id: challengeId,
    p_user_id: userId,
    p_phone_hash: phoneHash,
    p_phone_last4: input.phoneNumber.slice(-4),
    p_code_hash: codeHash,
    p_expires_at: expiresAt,
  });
  if (begun.error) throw new Error(`phone-link challenge: ${begun.error.message}`);

  let response: Response;
  const content = `your co verification code is ${code}. it expires in 5 minutes.`;
  try {
    response = "LINQ_API_KEY" in delivery
      ? await (dependencies.fetchImplementation ?? fetch)("https://api.linqapp.com/api/partner/v3/chats", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${delivery.LINQ_API_KEY}` },
          body: JSON.stringify({
            from: delivery.LINQ_FROM_NUMBER,
            to: [input.phoneNumber],
            message: { idempotency_key: `phone-link:${challengeId}`, parts: [{ type: "text", value: content }] },
          }),
          redirect: "error",
        })
      : await (dependencies.fetchImplementation ?? fetch)("https://api.sendblue.com/api/send-message", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "sb-api-key-id": delivery.SENDBLUE_API_KEY_ID,
            "sb-api-secret-key": delivery.SENDBLUE_API_SECRET_KEY,
          },
          body: JSON.stringify({
            number: input.phoneNumber,
            from_number: delivery.SENDBLUE_FROM_NUMBER,
            content,
          }),
          redirect: "error",
        });
  } catch (error) {
    await admin.rpc("cancel_transport_phone_link", { p_challenge_id: challengeId, p_user_id: userId });
    throw error;
  }
  if (!response.ok) {
    await admin.rpc("cancel_transport_phone_link", { p_challenge_id: challengeId, p_user_id: userId });
    throw new Error(`phone-link delivery rejected (${response.status})`);
  }
  return { challengeId, expiresAt, phoneLast4: input.phoneNumber.slice(-4) };
}

export async function verifyPhoneLink(admin: SupabaseClient, userId: string, unknownInput: unknown, dependencies: Dependencies = {}) {
  const input = phoneLinkVerifySchema.parse(unknownInput);
  const config = phoneLinkConfiguration(dependencies.environment ?? process.env);
  const now = dependencies.now ?? new Date();
  const verified = await admin.rpc("verify_transport_phone_link", {
    p_challenge_id: input.challengeId,
    p_user_id: userId,
    p_code_hash: digest(config.CO_PHONE_LINK_CHALLENGE_SECRET, `${input.challengeId}:${input.code}`),
    p_verified_at: now.toISOString(),
  });
  if (verified.error) throw new Error(`phone-link verification: ${verified.error.message}`);
  if (verified.data !== true) throw new Response("invalid or expired code", { status: 422 });
  return { linked: true as const };
}

export async function getPhoneLinkStatus(admin: SupabaseClient, userId: string, environment: Environment = process.env) {
  const result = await admin.rpc("transport_phone_link_status", { p_user_id: userId });
  if (result.error) throw new Error(`phone-link status: ${result.error.message}`);
  const row = Array.isArray(result.data) ? result.data[0] : result.data;
  const providerNumber = environment.CO_RAIL?.trim().toLowerCase() === "linq"
    ? environment.LINQ_FROM_NUMBER
    : environment.SENDBLUE_FROM_NUMBER;
  const handoffNumber = environment.CO_MESSAGE_HANDOFF_NUMBER ?? providerNumber ?? null;
  return phoneLinkStatusSchema.parse({
    linked: Boolean(row),
    phoneLast4: row?.phone_last4 ?? null,
    verifiedAt: row?.verified_at ?? null,
    handoffNumber: handoffNumber ? e164.parse(handoffNumber) : null,
  });
}

export async function unlinkPhone(admin: SupabaseClient, userId: string) {
  const result = await admin.rpc("unlink_transport_phone", { p_user_id: userId });
  if (result.error) throw new Error(`phone unlink: ${result.error.message}`);
  return { linked: false as const };
}
