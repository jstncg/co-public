import assert from "node:assert/strict";
import { chmodSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { validateProductionConfig } from "../src/production.ts";
import { readSecret } from "../src/secrets.ts";
import { SqliteStore } from "../src/store.ts";
import { testConfig, testHome } from "./helpers.ts";

test("production validation fails closed on implicit identity, authentication, mock providers, and excessive authority", () => {
  const home = testHome();
  try {
    const config = testConfig(home.path);
    config.environment = "production";
    config.autonomy.autoApproveRisks.push("external-write");
    const codes = validateProductionConfig(config, {}).map((issue) => issue.code);
    assert.ok(codes.includes("profile.required"));
    assert.ok(codes.includes("http.token"));
    assert.ok(codes.includes("provider.foreground"));
    assert.ok(codes.includes("authority.excessive"));
  } finally {
    home.cleanup();
  }
});

test("a fully explicit neutral single-tenant cell passes production validation", () => {
  const home = testHome();
  try {
    const config = testConfig(home.path);
    config.environment = "production";
    config.profileId = "account";
    config.serverToken = "0123456789abcdef".repeat(4);
    const route = { provider: "openai" as const, model: "test-model", maxOutputTokens: 512, reasoningEffort: "none" as const };
    config.models = { foreground: route, deliberation: route, background: route, critic: route };
    assert.deepEqual(validateProductionConfig(config, { OPENAI_API_KEY: "provider-key" }), []);
  } finally {
    home.cleanup();
  }
});

test("production messaging requires explicit canonical member principals", () => {
  const home = testHome();
  try {
    const config = testConfig(home.path);
    config.environment = "production";
    config.profileId = "account";
    config.serverToken = "0123456789abcdef".repeat(4);
    const route = { provider: "openai" as const, model: "test-model", maxOutputTokens: 512, reasoningEffort: "none" as const };
    config.models = { foreground: route, deliberation: route, background: route, critic: route };
    config.sendblue.webhookSecret = "sendblue-webhook-secret-with-entropy-123456";
    config.memberPeerIds = [];
    let codes = validateProductionConfig(config, { OPENAI_API_KEY: "provider-key" }).map((issue) => issue.code);
    assert.ok(codes.includes("connector.member_identity"));
    config.memberPeerIds = ["member", "+15550001111", "+15550001111"];
    codes = validateProductionConfig(config, { OPENAI_API_KEY: "provider-key" }).map((issue) => issue.code);
    assert.ok(codes.includes("connector.member_identity_invalid"));
    assert.ok(codes.includes("connector.member_identity_duplicate"));
    config.memberPeerIds = ["+15550001111"];
    codes = validateProductionConfig(config, { OPENAI_API_KEY: "provider-key" }).map((issue) => issue.code);
    assert.equal(codes.includes("connector.member_identity"), false);
    assert.equal(codes.includes("connector.member_identity_invalid"), false);
  } finally {
    home.cleanup();
  }
});

test("production validation rejects missing selected plugins and unsafe execution images", () => {
  const home = testHome();
  try {
    const config = testConfig(home.path);
    config.environment = "production";
    config.profileId = "account";
    config.serverToken = "0123456789abcdef".repeat(4);
    const route = { provider: "openai" as const, model: "test-model", maxOutputTokens: 512, reasoningEffort: "none" as const };
    config.models = { foreground: route, deliberation: route, background: route, critic: route };
    config.plugins.enabled = ["missing"];
    config.execution = {
      backend: "docker", allowedCommands: ["node"], timeoutMs: 10_000, maxOutputBytes: 100_000,
      workspaceMode: "read-only", dockerImage: `--privileged@sha256:${"a".repeat(64)}`,
    };
    const codes = validateProductionConfig(config, { OPENAI_API_KEY: "provider-key" }).map((issue) => issue.code);
    assert.ok(codes.includes("plugins.activation"));
    assert.ok(codes.includes("execution.image_syntax"));
  } finally {
    home.cleanup();
  }
});

test("production email verification requires a complete TLS provider and a distinct strong OTP secret", () => {
  const home = testHome();
  try {
    const config = testConfig(home.path);
    config.environment = "production";
    config.profileId = "account";
    config.serverToken = "0123456789abcdef".repeat(4);
    const route = { provider: "openai" as const, model: "test-model", maxOutputTokens: 512, reasoningEffort: "none" as const };
    config.models = { foreground: route, deliberation: route, background: route, critic: route };
    const { apiKey: _apiKey, ...emailWithoutCredential } = emailConfigForProduction();
    config.email = { ...emailWithoutCredential, otpSecret: "short", baseUrl: "http://api.example.com" };
    const codes = validateProductionConfig(config, { OPENAI_API_KEY: "provider-key" }).map((issue) => issue.code);
    assert.ok(codes.includes("email.credential"));
    assert.ok(codes.includes("email.otp_secret"));
    assert.ok(codes.includes("email.tls"));
    config.email = emailConfigForProduction();
    assert.deepEqual(validateProductionConfig(config, { OPENAI_API_KEY: "provider-key" }), []);
  } finally {
    home.cleanup();
  }
});

test("production browser credentials require a workspace-bound key and a bounded CDP endpoint", () => {
  const home = testHome();
  try {
    const config = testConfig(home.path);
    config.environment = "production";
    config.profileId = "account";
    config.serverToken = "0123456789abcdef".repeat(4);
    const route = { provider: "openai" as const, model: "test-model", maxOutputTokens: 512, reasoningEffort: "none" as const };
    config.models = { foreground: route, deliberation: route, background: route, critic: route };
    config.browser = { workspaceId: "account-browser", credentialKeyEnv: "BROWSER_VAULT_KEY", cdpBaseUrl: "http://127.0.0.1:9222" };

    let codes = validateProductionConfig(config, { OPENAI_API_KEY: "provider-key" }).map((issue) => issue.code);
    assert.ok(codes.includes("browser.credential_required"));

    codes = validateProductionConfig(config, { OPENAI_API_KEY: "provider-key", BROWSER_VAULT_KEY: "too-short" }).map((issue) => issue.code);
    assert.ok(codes.includes("browser.credential_key"));

    config.browser.cdpBaseUrl = "http://browser.example.com:9222?token=secret";
    codes = validateProductionConfig(config, { OPENAI_API_KEY: "provider-key", BROWSER_VAULT_KEY: Buffer.alloc(32, 11).toString("base64") }).map((issue) => issue.code);
    assert.ok(codes.includes("browser.cdp_boundary"));

    config.browser.cdpBaseUrl = "http://127.0.0.1:9222";
    assert.deepEqual(validateProductionConfig(config, {
      OPENAI_API_KEY: "provider-key", BROWSER_VAULT_KEY: Buffer.alloc(32, 11).toString("base64"),
    }), []);
  } finally {
    home.cleanup();
  }
});

test("production sensor declarations cannot bypass explicit local read classification", () => {
  const home = testHome();
  try {
    const config = testConfig(home.path);
    config.environment = "production";
    config.profileId = "account";
    config.serverToken = "0123456789abcdef".repeat(4);
    const route = { provider: "openai" as const, model: "test-model", maxOutputTokens: 512, reasoningEffort: "none" as const };
    config.models = { foreground: route, deliberation: route, background: route, critic: route };
    config.mcpServers = [{ name: "mail", transport: "http", url: "https://mcp.example.com", allowedTools: ["messages.list"] }];
    config.sensors = [{
      id: "mail.inbox", pluginId: "mail", displayName: "Inbox", kind: "email", purpose: "Notice important new mail.",
      dataClasses: ["email.messages"], retentionDays: 30, mcpServerName: "mail", remoteToolName: "messages.list", runtimeToolName: "mcp_mail_messages_list",
    }];
    let codes = validateProductionConfig(config, { OPENAI_API_KEY: "provider-key" }).map((issue) => issue.code);
    assert.ok(codes.includes("sensor.mail.inbox.boundary"));
    config.mcpServers[0]!.toolRisks = { "messages.list": "read" };
    codes = validateProductionConfig(config, { OPENAI_API_KEY: "provider-key" }).map((issue) => issue.code);
    assert.equal(codes.includes("sensor.mail.inbox.boundary"), false);
  } finally {
    home.cleanup();
  }
});

function emailConfigForProduction() {
  return {
    provider: "resend" as const, apiKey: "resend-provider-secret-value", from: "Co <verify@example.com>", baseUrl: "https://api.resend.com",
    otpSecret: "distinct-email-otp-secret-with-entropy-123456", verificationTtlMinutes: 10, resendCooldownSeconds: 60,
    maxVerificationAttempts: 5, maxRequestsPerHour: 5, maxRequestsPerDay: 10,
  };
}

test("secrets can be mounted as files and conflicting sources fail closed", () => {
  const home = testHome();
  try {
    const path = join(home.path, "secret");
    writeFileSync(path, "mounted-secret\n", { mode: 0o600 });
    assert.equal(readSecret("SERVICE_TOKEN", { SERVICE_TOKEN_FILE: path }), "mounted-secret");
    assert.throws(() => readSecret("SERVICE_TOKEN", { SERVICE_TOKEN: "inline", SERVICE_TOKEN_FILE: path }), /Set only one/);
  } finally {
    home.cleanup();
  }
});

test("SQLite storage uses private file permissions", { skip: process.platform === "win32" }, () => {
  const home = testHome();
  const path = join(home.path, "private.sqlite");
  try {
    const store = new SqliteStore(path, { synchronous: "FULL" });
    store.close();
    assert.equal(statSync(path).mode & 0o777, 0o600);
    chmodSync(path, 0o600);
  } finally {
    home.cleanup();
  }
});
