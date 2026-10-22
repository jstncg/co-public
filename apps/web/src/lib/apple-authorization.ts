import { createPrivateKey, sign } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const inputSchema = z.object({ authorizationCode: z.string().min(8).max(2_048) }).strict();

type AppleConfiguration = {
  teamId: string;
  keyId: string;
  clientId: string;
  privateKeyBase64: string;
};

type Dependencies = {
  environment?: Record<string, string | undefined>;
  fetchImplementation?: typeof fetch;
  now?: Date;
};

function configuration(environment: Record<string, string | undefined>): AppleConfiguration {
  const parsed = z.object({
    APPLE_TEAM_ID: z.string().min(10),
    APPLE_KEY_ID: z.string().min(10),
    APPLE_CLIENT_ID: z.string().min(3),
    APPLE_PRIVATE_KEY_BASE64: z.string().min(40),
  }).parse(environment);
  return {
    teamId: parsed.APPLE_TEAM_ID,
    keyId: parsed.APPLE_KEY_ID,
    clientId: parsed.APPLE_CLIENT_ID,
    privateKeyBase64: parsed.APPLE_PRIVATE_KEY_BASE64,
  };
}

const base64url = (value: string | Uint8Array) => Buffer.from(value).toString("base64url");

export function createAppleClientSecret(config: AppleConfiguration, now = new Date()) {
  const issuedAt = Math.floor(now.getTime() / 1_000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: config.keyId, typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: config.teamId,
    iat: issuedAt,
    exp: issuedAt + 300,
    aud: "https://appleid.apple.com",
    sub: config.clientId,
  }));
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey(Buffer.from(config.privateKeyBase64, "base64").toString("utf8"));
  const signature = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64url(signature)}`;
}

async function appleTokenRequest(
  path: "token" | "revoke",
  parameters: Record<string, string>,
  config: AppleConfiguration,
  dependencies: Dependencies,
) {
  const response = await (dependencies.fetchImplementation ?? fetch)(`https://appleid.apple.com/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: createAppleClientSecret(config, dependencies.now), ...parameters }),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Apple ${path} rejected (${response.status})`);
  return response;
}

export async function saveAppleAuthorization(
  admin: SupabaseClient,
  userId: string,
  unknownInput: unknown,
  dependencies: Dependencies = {},
) {
  const input = inputSchema.parse(unknownInput);
  const config = configuration(dependencies.environment ?? process.env);
  const response = await appleTokenRequest("token", {
    grant_type: "authorization_code",
    code: input.authorizationCode,
  }, config, dependencies);
  const tokens = z.object({ refresh_token: z.string().min(8) }).passthrough().parse(await response.json());
  const stored = await admin.schema("private").from("apple_credentials").upsert({
    user_id: userId,
    refresh_token: tokens.refresh_token,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (stored.error) throw new Error(`Apple credential storage: ${stored.error.message}`);
  return { stored: true as const };
}

export async function revokeStoredAppleAuthorization(
  admin: SupabaseClient,
  userId: string,
  dependencies: Dependencies = {},
) {
  const config = configuration(dependencies.environment ?? process.env);
  const selected = await admin.schema("private").from("apple_credentials")
    .select("refresh_token").eq("user_id", userId).maybeSingle<{ refresh_token: string }>();
  if (selected.error) throw new Error(`Apple credential lookup: ${selected.error.message}`);
  if (!selected.data) return false;
  await appleTokenRequest("revoke", {
    token: selected.data.refresh_token,
    token_type_hint: "refresh_token",
  }, config, dependencies);
  return true;
}
