import { isAbsolute, parse as parsePath } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import type { ModelRoute, RuntimeConfig } from "./types.ts";
import { readSecret } from "./secrets.ts";
import { PluginRegistry } from "./plugins.ts";
import { parseCredentialKey } from "./credentials.ts";
import { canonicalMemberPeerId } from "./identity.ts";

export interface ConfigurationIssue {
  code: string;
  message: string;
}

function credentialEnvironment(route: ModelRoute): string | undefined {
  if (route.apiKeyEnv) return route.apiKeyEnv;
  if (route.provider === "openai" || route.provider === "openai-compatible") return "OPENAI_API_KEY";
  if (route.provider === "anthropic") return "ANTHROPIC_API_KEY";
  return undefined;
}

function secureUrl(value: string | undefined): boolean {
  if (!value) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function weakSecret(value: string | undefined): boolean {
  return !value || Buffer.byteLength(value) < 32 || new Set(value).size < 8;
}

export function validateProductionConfig(config: RuntimeConfig, environment: NodeJS.ProcessEnv = process.env): ConfigurationIssue[] {
  if (config.environment !== "production") return [];
  const issues: ConfigurationIssue[] = [];
  const add = (code: string, message: string) => issues.push({ code, message });

  if (!config.profileId) add("profile.required", "Production requires an explicit CO_PROFILE so tenant and workspace scope cannot fall back to developer defaults.");
  if (weakSecret(config.serverToken)) add("http.token", "CO_SERVER_TOKEN must contain at least 32 bytes with non-trivial entropy in production.");
  if (config.dbPath === ":memory:") add("storage.memory", "An in-memory database is not durable enough for production.");
  for (const root of config.workspaceRoots) {
    const parsed = parsePath(root);
    if (!isAbsolute(root) || root === parsed.root) add("workspace.scope", `Workspace root must be an absolute, bounded directory: ${root}`);
    else if (!existsSync(root) || !statSync(root).isDirectory()) add("workspace.missing", `Workspace root does not exist or is not a directory: ${root}`);
    else if (realpathSync(root) === parsePath(realpathSync(root)).root) add("workspace.scope", `Workspace root resolves to an unbounded filesystem root: ${root}`);
  }
  for (const root of config.skillRoots) {
    const parsed = parsePath(root);
    if (!isAbsolute(root) || root === parsed.root || (existsSync(root) && realpathSync(root) === parsePath(realpathSync(root)).root)) {
      add("skills.scope", `Skill root must be an absolute, bounded directory: ${root}`);
    }
  }
  for (const root of config.plugins.roots) {
    const parsed = parsePath(root);
    if (!isAbsolute(root) || root === parsed.root || (existsSync(root) && realpathSync(root) === parsePath(realpathSync(root)).root)) {
      add("plugins.scope", `Plugin root must be an absolute, bounded directory: ${root}`);
    }
  }
  if (config.autonomy.autoApproveRisks.includes("external-write") || config.autonomy.autoApproveRisks.includes("destructive")) {
    add("authority.excessive", "Production defaults may not auto-approve external-write or destructive tools.");
  }

  for (const [role, route] of Object.entries(config.models)) {
    if (route.provider === "auto" || route.provider === "mock" || route.provider === "codex-cli" || route.provider === "claude-code-cli") {
      add(`provider.${role}`, `Production ${role} must use an explicit API provider, not ${route.provider}.`);
      continue;
    }
    if (!secureUrl(route.baseUrl)) add(`provider.${role}.tls`, `Production ${role} base URL must use HTTPS.`);
    if (route.provider === "openai-compatible" && !route.baseUrl) add(`provider.${role}.url`, `OpenAI-compatible ${role} requires an explicit base URL.`);
    const credential = credentialEnvironment(route);
    if (credential && !readSecret(credential, environment)) add(`provider.${role}.credential`, `Production ${role} is missing ${credential} or ${credential}_FILE.`);
  }

  for (const server of config.mcpServers) {
    if (server.transport === "http" && !secureUrl(server.url)) add(`mcp.${server.name}.tls`, `Remote MCP server ${server.name} must use HTTPS in production.`);
  }
  const sensorIds = new Set<string>();
  const sensorTools = new Set<string>();
  for (const sensor of config.sensors) {
    if (sensorIds.has(sensor.id) || sensorTools.has(sensor.runtimeToolName)) {
      add("sensor.collision", `Sensor IDs and runtime tools must be unique: ${sensor.id}`);
      continue;
    }
    sensorIds.add(sensor.id);
    sensorTools.add(sensor.runtimeToolName);
    const server = config.mcpServers.find((candidate) => candidate.name === sensor.mcpServerName);
    if (!server || !server.allowedTools?.includes(sensor.remoteToolName) || server.toolRisks?.[sensor.remoteToolName] !== "read") {
      add(`sensor.${sensor.id}.boundary`, `Sensor ${sensor.id} must map to an explicitly allowlisted MCP tool locally classified as read.`);
    }
    if (!sensor.dataClasses.length || sensor.retentionDays < 1 || sensor.retentionDays > 3_650) {
      add(`sensor.${sensor.id}.disclosure`, `Sensor ${sensor.id} needs bounded data classes and retention disclosure.`);
    }
  }

  try {
    new PluginRegistry(config.plugins.roots).activate(config.plugins.enabled);
  } catch (error) {
    add("plugins.activation", error instanceof Error ? error.message : String(error));
  }

  if (config.execution.backend === "local") add("execution.local", "Production process execution must use an isolated backend; local execution is not accepted.");
  if (config.execution.backend !== "none" && config.execution.allowedCommands.length === 0) add("execution.allowlist", "Enabled process execution requires an explicit command allowlist.");
  if (config.execution.allowedCommands.length > 128 || config.execution.allowedCommands.some((command) => !command || command.length > 512 || command.includes("\0"))) {
    add("execution.allowlist_bounds", "Execution command allowlists may contain at most 128 bounded non-empty commands.");
  }
  if (config.execution.timeoutMs < 1_000 || config.execution.timeoutMs > 3_600_000) add("execution.timeout", "Execution timeout must be between 1 second and 1 hour.");
  if (config.execution.maxOutputBytes < 1_024 || config.execution.maxOutputBytes > 20_000_000) add("execution.output", "Execution output must be bounded between 1 KiB and 20 MB.");
  if (config.execution.backend === "docker" && !config.execution.dockerImage) add("execution.image", "Docker execution requires an explicit image.");
  if (config.execution.backend === "docker" && config.execution.dockerImage && (config.execution.dockerImage.length > 512 || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(config.execution.dockerImage))) {
    add("execution.image_syntax", "Docker execution image references must use bounded registry-safe syntax.");
  }
  if (config.execution.backend === "docker" && config.execution.dockerImage && !/@sha256:[a-f0-9]{64}$/i.test(config.execution.dockerImage)) {
    add("execution.image_pin", "Production Docker execution images must be pinned by sha256 digest.");
  }
  if (config.execution.backend === "docker" && config.workspaceRoots.some((root) => root.includes(",") || root.includes("\n") || root.includes("\r"))) {
    add("execution.workspace_syntax", "Docker execution workspace paths may not contain commas or newlines.");
  }

  const sendblue = config.sendblue;
  const outboundParts = [sendblue.apiKeyId, sendblue.apiSecretKey, sendblue.fromNumber];
  if (outboundParts.some(Boolean) && !outboundParts.every(Boolean)) add("sendblue.partial", "Sendblue outbound configuration must include API key ID, secret key, and from number together.");
  if ((outboundParts.some(Boolean) || sendblue.webhookSecret) && weakSecret(sendblue.webhookSecret)) {
    add("sendblue.webhook", "Configured Sendblue deployments require a webhook secret of at least 32 bytes with non-trivial entropy.");
  }
  if (!secureUrl(sendblue.baseUrl)) add("sendblue.tls", "Sendblue base URL must use HTTPS in production.");
  const linq = config.linq;
  const linqOutbound = [linq.apiKey, linq.fromNumber];
  if (linqOutbound.some(Boolean) && !linqOutbound.every(Boolean)) add("linq.partial", "Linq outbound configuration must include an API key and stable from number together.");
  if ((linqOutbound.some(Boolean) || linq.webhookSecret) && weakSecret(linq.webhookSecret)) {
    add("linq.webhook", "Configured Linq deployments require a webhook secret of at least 32 bytes with non-trivial entropy.");
  }
  if (!secureUrl(linq.baseUrl)) add("linq.tls", "Linq base URL must use HTTPS in production.");
  if ((sendblue.webhookSecret || linq.webhookSecret) && config.memberPeerIds.length === 0) {
    add("connector.member_identity", "Inbound messaging requires at least one explicitly onboarded member phone identity.");
  }
  if (new Set(config.memberPeerIds).size !== config.memberPeerIds.length) {
    add("connector.member_identity_duplicate", "Member phone identities must be unique after canonicalization.");
  }
  for (const peerId of config.memberPeerIds) {
    try {
      if (canonicalMemberPeerId(peerId) !== peerId) throw new Error();
    } catch {
      add("connector.member_identity_invalid", `Member peer must be a canonical direct phone identity: ${peerId}`);
    }
  }
  const email = config.email;
  if (!secureUrl(email.baseUrl)) add("email.tls", "Transactional email base URL must use HTTPS in production.");
  const emailParts = [email.apiKey, email.from, email.otpSecret];
  if (email.provider === "none" && emailParts.some(Boolean)) add("email.provider", "Email settings are present but CO_EMAIL_PROVIDER is none.");
  if (email.provider === "resend") {
    if (!email.apiKey) add("email.credential", "Resend email delivery requires RESEND_API_KEY or RESEND_API_KEY_FILE.");
    if (!email.from || email.from.length > 320 || /[\r\n]/.test(email.from)) add("email.from", "Resend email delivery requires a bounded CO_EMAIL_FROM without newlines.");
    if (weakSecret(email.otpSecret)) add("email.otp_secret", "CO_EMAIL_OTP_SECRET must contain at least 32 bytes with non-trivial entropy when email verification is enabled.");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$/.test(config.browser.workspaceId)) {
    add("browser.workspace", "Browser credential workspace must be an explicit bounded identifier.");
  }
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(config.browser.credentialKeyEnv)) {
    add("browser.key_env", "Browser credential key environment name is invalid.");
  }
  let browserCredentialKey: string | undefined;
  try {
    browserCredentialKey = readSecret(config.browser.credentialKeyEnv, environment);
    if (browserCredentialKey) parseCredentialKey(browserCredentialKey);
  } catch {
    add("browser.credential_key", `Browser credential key ${config.browser.credentialKeyEnv} must resolve unambiguously to exactly 32 bytes of base64 or hex.`);
  }
  if (config.browser.cdpBaseUrl) {
    try {
      const cdp = new URL(config.browser.cdpBaseUrl);
      const loopback = cdp.hostname === "localhost" || cdp.hostname === "127.0.0.1" || cdp.hostname === "::1" || cdp.hostname === "[::1]";
      if ((cdp.protocol !== "https:" && !(cdp.protocol === "http:" && loopback)) || cdp.username || cdp.password || cdp.search || cdp.hash) throw new Error();
    } catch {
      add("browser.cdp_boundary", "Browser CDP discovery must use HTTPS or loopback HTTP and contain no credentials, query, or fragment.");
    }
    if (!browserCredentialKey) add("browser.credential_required", `Browser CDP filling requires ${config.browser.credentialKeyEnv} or ${config.browser.credentialKeyEnv}_FILE.`);
  }
  const configuredSecrets = [config.serverToken, sendblue.apiSecretKey, sendblue.webhookSecret, linq.apiKey, linq.webhookSecret, email.apiKey, email.otpSecret, browserCredentialKey].filter((secret): secret is string => Boolean(secret));
  if (new Set(configuredSecrets).size !== configuredSecrets.length) add("secrets.reused", "Server, connector, provider, and OTP secrets must be distinct.");

  return issues;
}

export class ProductionConfigurationError extends Error {
  readonly issues: ConfigurationIssue[];

  constructor(issues: ConfigurationIssue[]) {
    super(`Production configuration is unsafe:\n${issues.map((issue) => `- [${issue.code}] ${issue.message}`).join("\n")}`);
    this.name = "ProductionConfigurationError";
    this.issues = issues;
  }
}

export function assertProductionConfig(config: RuntimeConfig, environment: NodeJS.ProcessEnv = process.env): void {
  const issues = validateProductionConfig(config, environment);
  if (issues.length) throw new ProductionConfigurationError(issues);
}
