import assert from "node:assert/strict";
import test from "node:test";
import { EmailProviderError, EmailVerificationError, EmailVerificationManager, ResendEmailAdapter, normalizeEmail, type EmailDeliveryAdapter, type EmailDeliveryInput, type EmailDeliveryResult } from "../src/email.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { CoRuntime } from "../src/runtime.ts";
import { createRuntimeServer } from "../src/server.ts";
import { SqliteStore } from "../src/store.ts";
import type { EmailConfig, ProviderAdapter } from "../src/types.ts";
import { testConfig, testHome } from "./helpers.ts";

class CapturingEmailAdapter implements EmailDeliveryAdapter {
  readonly provider = "resend" as const;
  readonly deliveries: EmailDeliveryInput[] = [];
  error?: EmailProviderError;

  configured(): boolean { return true; }
  async send(input: EmailDeliveryInput): Promise<EmailDeliveryResult> {
    this.deliveries.push(input);
    if (this.error) throw this.error;
    return { provider: "resend", messageId: `email_${this.deliveries.length}` };
  }

  code(index = 0): string {
    const code = this.deliveries[index]?.text.match(/\b\d{6}\b/)?.[0];
    assert.ok(code);
    return code;
  }
}

function emailConfig(): EmailConfig {
  return {
    provider: "resend", apiKey: "provider-secret", from: "Co <verify@example.com>", baseUrl: "https://api.resend.com",
    otpSecret: "otp-secret-with-more-than-thirty-two-bytes-123", verificationTtlMinutes: 10, resendCooldownSeconds: 60,
    maxVerificationAttempts: 3, maxRequestsPerHour: 5, maxRequestsPerDay: 10,
  };
}

test("email verification never persists or returns the code and enables idempotent verified delivery", async () => {
  const home = testHome();
  const store = new SqliteStore(`${home.path}/runtime.sqlite`);
  const adapter = new CapturingEmailAdapter();
  const manager = new EmailVerificationManager(store, emailConfig(), adapter, { generateCode: () => "123456" });
  try {
    const challenge = await manager.request({ tenantId: "test", email: "Owner@Example.com", purpose: "contact", idempotencyKey: "request-1" });
    assert.equal(challenge.status, "sent");
    assert.equal(adapter.deliveries.length, 1);
    assert.equal(adapter.deliveries[0]?.idempotencyKey, `email-verification/${challenge.id}`);
    assert.equal(JSON.stringify(manager.challengeJson(challenge)).includes("123456"), false);
    assert.notEqual(challenge.codeDigest, "123456");
    assert.equal((store.db.prepare("SELECT code_digest FROM email_verification_challenges WHERE id=?").get(challenge.id) as { code_digest: string }).code_digest.includes("123456"), false);
    const eventText = JSON.stringify(store.listEvents("test", { stream: `email-verification:${challenge.id}` }));
    assert.equal(eventText.includes("123456"), false);
    assert.equal(eventText.includes("owner@example.com"), false);

    const duplicate = await manager.request({ tenantId: "test", email: "owner@example.com", purpose: "contact", idempotencyKey: "request-1" });
    assert.equal(duplicate.id, challenge.id);
    assert.equal(adapter.deliveries.length, 1);

    assert.throws(() => manager.verify("test", challenge.id, "000000"), (error) => error instanceof EmailVerificationError && error.httpStatus === 401);
    const identity = manager.verify("test", challenge.id, "123456");
    assert.match(identity.id, /^email_/);
    assert.deepEqual(manager.identityJson(identity), {
      identityId: identity.id, maskedEmail: "o***@example.com", status: "active",
      verifiedAt: identity.verifiedAt, updatedAt: identity.updatedAt, sourceChallengeId: challenge.id,
    });
    assert.equal(manager.verify("test", challenge.id, "123456").id, identity.id);

    const delivered = await manager.sendToIdentity({
      tenantId: "test", identityId: identity.id, subject: "Your brief", content: "Prepared and ready.", idempotencyKey: "send-1",
    });
    assert.equal(delivered.providerMessageId, "email_2");
    assert.equal(adapter.deliveries.length, 2);
    assert.equal((await manager.sendToIdentity({ tenantId: "test", identityId: identity.id, subject: "Your brief", content: "Prepared and ready.", idempotencyKey: "send-1" })).providerMessageId, "email_2");
    assert.equal(adapter.deliveries.length, 2);
    await assert.rejects(() => manager.sendToIdentity({ tenantId: "test", identityId: identity.id, subject: "Changed", content: "Prepared and ready.", idempotencyKey: "send-1" }), /reused with different content/);
    await assert.rejects(() => manager.sendToIdentity({ tenantId: "test", identityId: identity.id, subject: "Header\nBcc: victim@example.com", content: "No", idempotencyKey: "send-newline" }), /may not contain newlines/);
    manager.revokeIdentity("test", identity.id);
    await assert.rejects(() => manager.sendToIdentity({ tenantId: "test", identityId: identity.id, subject: "No", content: "No", idempotencyKey: "send-2" }), /revoked/);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("email normalization is conservative about ambiguous local parts", () => {
  assert.equal(normalizeEmail(" Owner+tag@Example.com "), "owner+tag@example.com");
  assert.throws(() => normalizeEmail("owner..tag@example.com"), /invalid/);
  assert.throws(() => normalizeEmail(".owner@example.com"), /invalid/);
  assert.throws(() => normalizeEmail("owner@localhost"), /invalid/);
});

test("email verification locks repeated guesses, expires, and preserves uncertain delivery challenges", async () => {
  const home = testHome();
  const store = new SqliteStore(`${home.path}/runtime.sqlite`);
  const adapter = new CapturingEmailAdapter();
  let current = new Date("2026-08-24T20:00:00.000Z");
  const manager = new EmailVerificationManager(store, emailConfig(), adapter, { now: () => current, generateCode: () => "654321" });
  try {
    const locked = await manager.request({ tenantId: "test", email: "lock@example.com", idempotencyKey: "lock-1" });
    assert.throws(() => manager.verify("test", locked.id, "000000"), (error) => error instanceof EmailVerificationError && error.httpStatus === 401);
    assert.throws(() => manager.verify("test", locked.id, "111111"), (error) => error instanceof EmailVerificationError && error.httpStatus === 401);
    assert.throws(() => manager.verify("test", locked.id, "222222"), (error) => error instanceof EmailVerificationError && error.httpStatus === 423);
    assert.throws(() => manager.verify("test", locked.id, "654321"), (error) => error instanceof EmailVerificationError && error.httpStatus === 423);

    current = new Date(current.getTime() + 61_000);
    const expiring = await manager.request({ tenantId: "test", email: "expire@example.com", idempotencyKey: "expire-1" });
    current = new Date(current.getTime() + 11 * 60_000);
    assert.throws(() => manager.verify("test", expiring.id, "654321"), (error) => error instanceof EmailVerificationError && error.httpStatus === 410);
    assert.equal(manager.getChallenge("test", expiring.id)?.status, "expired");

    current = new Date(current.getTime() + 61_000);
    adapter.error = new EmailProviderError("network ended after submit", true);
    let uncertainId = "";
    await assert.rejects(
      () => manager.request({ tenantId: "test", email: "uncertain@example.com", idempotencyKey: "uncertain-1" }),
      (error) => {
        assert.ok(error instanceof EmailVerificationError);
        uncertainId = error.challengeId ?? "";
        return error.httpStatus === 503 && Boolean(uncertainId);
      },
    );
    assert.equal(manager.getChallenge("test", uncertainId)?.status, "delivery_uncertain");
    assert.equal(manager.verify("test", uncertainId, "654321").status, "active", "a code that arrived across an uncertain boundary remains usable");
  } finally {
    store.close();
    home.cleanup();
  }
});

test("Resend adapter uses the HTTPS email endpoint, bearer auth, and provider idempotency", async () => {
  const originalFetch = globalThis.fetch;
  let request: { url: string; init?: RequestInit } | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    request = { url: String(url), ...(init ? { init } : {}) };
    return new Response(JSON.stringify({ id: "provider-message" }), { status: 200 });
  }) as typeof fetch;
  try {
    const adapter = new ResendEmailAdapter(emailConfig());
    assert.deepEqual(await adapter.send({ to: "owner@example.com", subject: "Code", text: "Body", idempotencyKey: "verification/1" }), { provider: "resend", messageId: "provider-message" });
    assert.equal(request?.url, "https://api.resend.com/emails");
    const headers = request?.init?.headers as Record<string, string>;
    assert.equal(headers.authorization, "Bearer provider-secret");
    assert.equal(headers["idempotency-key"], "verification/1");
    assert.deepEqual(JSON.parse(String(request?.init?.body)), { from: "Co <verify@example.com>", to: ["owner@example.com"], subject: "Code", text: "Body" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Resend response-body failures preserve whether the HTTP status made delivery ambiguous", async () => {
  const originalFetch = globalThis.fetch;
  const brokenBody = (status: number): Response => new Response(new ReadableStream({
    start(controller) { controller.error(new Error("response stream reset")); },
  }), { status });
  try {
    const adapter = new ResendEmailAdapter(emailConfig());
    globalThis.fetch = (async () => brokenBody(200)) as typeof fetch;
    await assert.rejects(
      adapter.send({ to: "owner@example.com", subject: "Code", text: "Body", idempotencyKey: "body-200" }),
      (error) => error instanceof EmailProviderError && error.uncertain,
    );
    globalThis.fetch = (async () => brokenBody(400)) as typeof fetch;
    await assert.rejects(
      adapter.send({ to: "owner@example.com", subject: "Code", text: "Body", idempotencyKey: "body-400" }),
      (error) => error instanceof EmailProviderError && !error.uncertain,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("verified email definite rejection and ambiguous failure produce matching events and tool receipts", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.email = emailConfig();
  const adapter = new CapturingEmailAdapter();
  const runtime = new CoRuntime({ config, emailDelivery: adapter });
  try {
    const challenge = await runtime.email.request({ tenantId: "test", email: "owner@example.com", idempotencyKey: "receipt-identity" });
    const identity = runtime.email.verify("test", challenge.id, adapter.code());
    const execute = async (error: EmailProviderError, subject: string): Promise<void> => {
      adapter.error = error;
      const call = `[[tool:email.send_verified ${JSON.stringify({ identityId: identity.id, subject, content: "Important update" })}]]`;
      const waiting = await runtime.turn({ tenantId: "test", channel: "cli", peerId: `operator-${subject}`, text: call }, {
        allowedTools: ["email.send_verified"], requiredTools: ["email.send_verified"],
      });
      assert.equal(waiting.status, "waiting_approval");
      const approval = runtime.store.getApproval(waiting.approvalId as string);
      await runtime.resumeApproval(waiting.approvalId as string, "approved");
      const receipt = runtime.store.getReceipt("test", waiting.runId, approval?.toolCallId as string);
      assert.equal(receipt?.status, error.uncertain ? "uncertain" : "failed");
      assert.equal(receipt?.effectState, error.uncertain ? "uncertain" : "failed");
    };

    await execute(new EmailProviderError("recipient rejected", false), "Definite");
    assert.equal(runtime.store.listEvents("test", { type: "email.delivery_failed" }).length, 1);
    assert.equal(runtime.store.listEvents("test", { type: "email.delivery_uncertain" }).length, 0);

    await execute(new EmailProviderError("connection ended after submit", true), "Ambiguous");
    assert.equal(runtime.store.listEvents("test", { type: "email.delivery_failed" }).length, 1);
    assert.equal(runtime.store.listEvents("test", { type: "email.delivery_uncertain" }).length, 1);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("agent-requested verification crosses approval and exposes no OTP to the model", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.email = emailConfig();
  const adapter = new CapturingEmailAdapter();
  const provider: ProviderAdapter = {
    name: "mock",
    complete: async (request) => {
      const toolResult = request.messages.flatMap((message) => message.parts).find((part) => part.type === "tool_result");
      return toolResult
        ? { text: `Verification requested: ${JSON.stringify(toolResult.output)}`, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } }
        : { text: "", toolCalls: [{ id: "request-email", name: "email.verification.request", arguments: { email: "owner@example.com" } }], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    },
  };
  const runtime = new CoRuntime({ config, providers: new ProviderRegistry([provider]), emailDelivery: adapter });
  try {
    const turn = await runtime.turn({ tenantId: "test", channel: "cli", peerId: "owner", text: "Send a verification code to owner@example.com" });
    assert.equal(turn.status, "waiting_approval");
    assert.equal(adapter.deliveries.length, 0);
    assert.ok(turn.approvalId);
    const completed = await runtime.resumeApproval(turn.approvalId, "approved");
    assert.equal(completed.status, "completed");
    assert.equal(adapter.deliveries.length, 1);
    assert.equal(completed.text.includes(adapter.code()), false);
    const receipt = runtime.store.db.prepare("SELECT tool_name,risk,status FROM tool_receipts WHERE run_id=?").get(turn.runId) as { tool_name: string; risk: string; status: string };
    assert.deepEqual({ ...receipt }, { tool_name: "email.verification.request", risk: "external-write", status: "succeeded" });
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("authenticated HTTP lifecycle requests, inspects, verifies, and revokes a masked identity", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.email = emailConfig();
  config.serverToken = "http-email-test-token";
  const adapter = new CapturingEmailAdapter();
  const runtime = new CoRuntime({ config, emailDelivery: adapter });
  const server = createRuntimeServer(runtime);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const authorization = { authorization: `Bearer ${config.serverToken}` };
    assert.equal((await fetch(`${base}/v1/email-identities`)).status, 401);
    const request = await fetch(`${base}/v1/email-verifications`, {
      method: "POST", headers: { ...authorization, "content-type": "application/json", "idempotency-key": "http-email-1" },
      body: JSON.stringify({ email: "owner@example.com", purpose: "onboarding" }),
    });
    assert.equal(request.status, 202);
    const challenge = await request.json() as { challengeId: string; maskedEmail: string };
    assert.equal(challenge.maskedEmail, "o***@example.com");
    assert.equal(JSON.stringify(challenge).includes(adapter.code()), false);
    const duplicate = await fetch(`${base}/v1/email-verifications`, {
      method: "POST", headers: { ...authorization, "content-type": "application/json", "idempotency-key": "http-email-1" },
      body: JSON.stringify({ email: "OWNER@example.com", purpose: "onboarding" }),
    });
    assert.equal((await duplicate.json() as { challengeId: string }).challengeId, challenge.challengeId);
    assert.equal(adapter.deliveries.length, 1);
    const verified = await fetch(`${base}/v1/email-verifications/${challenge.challengeId}/actions`, {
      method: "POST", headers: { ...authorization, "content-type": "application/json" }, body: JSON.stringify({ action: "verify", code: adapter.code() }),
    });
    assert.equal(verified.status, 200);
    const identity = await verified.json() as { identityId: string; maskedEmail: string };
    assert.equal(identity.maskedEmail, "o***@example.com");
    const listed = await (await fetch(`${base}/v1/email-identities`, { headers: authorization })).text();
    assert.equal(listed.includes("owner@example.com"), false);
    assert.equal(listed.includes(adapter.code()), false);
    const revoked = await fetch(`${base}/v1/email-identities/${identity.identityId}/actions`, {
      method: "POST", headers: { ...authorization, "content-type": "application/json" }, body: JSON.stringify({ action: "revoke" }),
    });
    assert.equal((await revoked.json() as { status: string }).status, "revoked");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    home.cleanup();
  }
});
