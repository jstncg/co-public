import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeConfig } from "../src/types.ts";

export function testHome(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "co-test-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function testConfig(path: string): RuntimeConfig {
  const route = { provider: "mock" as const, model: "mock-1", maxOutputTokens: 512, reasoningEffort: "none" as const };
  return {
    environment: "test",
    home: path,
    dbPath: join(path, "runtime.sqlite"),
    tenantId: "test",
    memberPeerIds: ["+15550001111", "+12025559876"],
    distribution: "co",
    timezone: "UTC",
    models: { foreground: route, deliberation: route, background: route, critic: route },
    autonomy: {
      maxIterations: 8,
      maxChildDepth: 2,
      maxConcurrentChildren: 3,
      maxChildrenPerRun: 12,
      maxQueuedChildren: 24,
      maxDailyInterventions: 3,
      interventionCooldownMinutes: 180,
      quietHoursStart: 0,
      quietHoursEnd: 0,
      autoApproveRisks: ["read", "local-write"],
    },
    workspaceRoots: [path],
    skillRoots: [`${path}/skills`],
    learnedSkillRoot: `${path}/learned-skills`,
    plugins: { roots: [`${path}/plugins`], enabled: [] },
    execution: { backend: "none", allowedCommands: [], timeoutMs: 10_000, maxOutputBytes: 100_000, workspaceMode: "read-only" },
    mcpServers: [],
    sensors: [],
    media: {
      analyzer: "none",
      geminiApiKeyEnv: "GEMINI_API_KEY",
      geminiModel: "gemini-3.5-flash-lite",
      youtubeDeferSeconds: 720,
      youtubeMaxWindows: 8,
      maxResourceBytes: 15_000_000,
    },
    browser: { workspaceId: "test-workspace", credentialKeyEnv: "CO_BROWSER_CREDENTIAL_KEY" },
    http: {
      bodyLimitBytes: 2_000_000,
      requestTimeoutMs: 300_000,
      headersTimeoutMs: 15_000,
      keepAliveTimeoutMs: 5_000,
      shutdownGraceMs: 5_000,
      rateLimitWindowMs: 60_000,
      rateLimitMaxRequests: 120,
      maxConnections: 100,
    },
    sendblue: { baseUrl: "https://api.sendblue.co" },
    linq: { baseUrl: "https://api.linqapp.com/api/partner/v3" },
    googleBridge: { baseUrl: "", token: "" },
    email: {
      provider: "none", baseUrl: "https://api.resend.com", verificationTtlMinutes: 10, resendCooldownSeconds: 60,
      maxVerificationAttempts: 5, maxRequestsPerHour: 5, maxRequestsPerDay: 10,
    },
  };
}
