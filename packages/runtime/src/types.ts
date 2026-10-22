export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ProviderName = "auto" | "openai" | "anthropic" | "openai-compatible" | "codex-cli" | "claude-code-cli" | "mock";
export type ModelRole = "foreground" | "deliberation" | "background" | "critic";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type RuntimeEnvironment = "development" | "test" | "production";
export type ExecutionBackendName = "none" | "local" | "docker";

export interface HttpConfig {
  bodyLimitBytes: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  keepAliveTimeoutMs: number;
  shutdownGraceMs: number;
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  maxConnections: number;
}

export interface ModelRoute {
  provider: ProviderName;
  model: string;
  maxOutputTokens: number;
  reasoningEffort: ReasoningEffort;
  baseUrl?: string;
  apiKeyEnv?: string;
  /** Operator-supplied pricing, pinned with a behavior release. The runtime
   * performs a conservative preflight against this ceiling before every call;
   * it never guesses current vendor pricing. */
  costCeiling?: ModelCostCeiling;
}

export interface ModelCostCeiling {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  maxRequestUsd: number;
}

export interface AutonomyConfig {
  maxIterations: number;
  maxChildDepth: number;
  maxConcurrentChildren: number;
  maxChildrenPerRun: number;
  maxQueuedChildren: number;
  maxDailyInterventions: number;
  interventionCooldownMinutes: number;
  quietHoursStart: number;
  quietHoursEnd: number;
  autoApproveRisks: ToolRisk[];
}

export interface SendblueConfig {
  apiKeyId?: string;
  apiSecretKey?: string;
  fromNumber?: string;
  webhookSecret?: string;
  baseUrl: string;
}

export interface LinqConfig {
  apiKey?: string;
  fromNumber?: string;
  webhookSecret?: string;
  baseUrl: string;
}

export type EmailProviderName = "none" | "resend";

export interface EmailConfig {
  provider: EmailProviderName;
  apiKey?: string;
  from?: string;
  baseUrl: string;
  otpSecret?: string;
  verificationTtlMinutes: number;
  resendCooldownSeconds: number;
  maxVerificationAttempts: number;
  maxRequestsPerHour: number;
  maxRequestsPerDay: number;
}

export type MediaAnalyzerName = "auto" | "gemini" | "none";

export interface MediaConfig {
  analyzer: MediaAnalyzerName;
  /** Gemini perception is independent of the conversational provider. */
  foreground?: "gemini" | "native";
  geminiApiKeyEnv: string;
  geminiModel: string;
  youtubeDeferSeconds: number;
  youtubeMaxWindows: number;
  maxResourceBytes: number;
}

export interface BrowserConfig {
  workspaceId: string;
  credentialKeyEnv: string;
  cdpBaseUrl?: string;
}

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  allowedTools?: string[];
  defaultRisk?: ToolRisk;
  toolRisks?: Record<string, ToolRisk>;
  timeoutMs?: number;
}

export type SensorKind = "calendar" | "email" | "call" | "file" | "browser" | "location";

export interface SensorConfig {
  id: string;
  pluginId: string;
  displayName: string;
  kind: SensorKind;
  purpose: string;
  dataClasses: string[];
  retentionDays: number;
  mcpServerName: string;
  remoteToolName: string;
  runtimeToolName: string;
}

export interface PluginConfig {
  roots: string[];
  enabled: string[];
}

export interface ExecutionConfig {
  backend: ExecutionBackendName;
  allowedCommands: string[];
  timeoutMs: number;
  maxOutputBytes: number;
  workspaceMode: "read-only" | "read-write";
  dockerImage?: string;
}

export interface RuntimeConfig {
  environment: RuntimeEnvironment;
  /** Compose-only migration rehearsal. Never grants tool or delivery authority. */
  mode?: "live" | "shadow";
  embeddings?: {
    model: string;
    apiKeyEnv: string;
    dimensions: number;
    maxCallsPerDay: number;
  };
  home: string;
  dbPath: string;
  tenantId: string;
  /** Canonical direct-message identities allowed to exercise member authority. */
  memberPeerIds: string[];
  profileId?: string;
  distribution: string;
  distributionConfigPath?: string;
  timezone: string;
  location?: string;
  models: Record<ModelRole, ModelRoute>;
  autonomy: AutonomyConfig;
  workspaceRoots: string[];
  skillRoots: string[];
  learnedSkillRoot: string;
  plugins: PluginConfig;
  execution: ExecutionConfig;
  mcpServers: McpServerConfig[];
  sensors: SensorConfig[];
  media: MediaConfig;
  browser: BrowserConfig;
  serverToken?: string;
  http: HttpConfig;
  sendblue: SendblueConfig;
  linq: LinqConfig;
  email: EmailConfig;
  /** Loopback bridge to the Python router's Google integration. Empty strings mean not
   *  configured, and the calendar/mail tools are then never registered at all. */
  googleBridge: { baseUrl: string; token: string };
}

export type RuntimeRole = "user" | "assistant" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  arguments: JsonObject;
}

/** Persist provenance only; data is hydrated from tenant-scoped originals for
 * a provider request, never from an arbitrary model-supplied URL. */
export interface ImagePart {
  type: "image";
  sourceEventId: string;
  attachmentId: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data?: string;
}

/** Audio is resolved below the model boundary; never persist inline bytes here. */
export interface AudioPart {
  type: "audio";
  sourceEventId: string;
  attachmentId: string;
  mimeType: string;
}

export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  name: string;
  output: JsonValue;
  isError: boolean;
}

export interface ProviderStatePart {
  type: "provider_state";
  provider: "openai" | "anthropic";
  data: JsonObject;
}

export interface ReactionPart {
  type: "reaction";
  reaction: TapbackType;
  targetMessageId: string;
}

export type MessagePart = TextPart | ImagePart | AudioPart | ToolCallPart | ToolResultPart | ProviderStatePart | ReactionPart;

export interface RuntimeMessage {
  id: string;
  role: RuntimeRole;
  parts: MessagePart[];
  createdAt: string;
  phase?: "commentary" | "final";
}

export interface ToolSchema {
  type: "object";
  properties: Record<string, JsonObject>;
  required?: string[];
  additionalProperties?: boolean;
}

export type ToolRisk = "read" | "local-write" | "external-write" | "destructive";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  risk: ToolRisk;
  tags: string[];
  idempotent: boolean;
  strict?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface ProviderRequest {
  route: ModelRoute;
  system: string;
  messages: RuntimeMessage[];
  tools: ToolDefinition[];
  tenantId: string;
}

export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** Present only when the selected route pins an operator-supplied pricing
   * envelope. Values are estimates, never vendor invoices. */
  cost?: {
    estimatedUsd: number;
    preflightUpperBoundUsd: number;
    requestCeilingUsd: number;
  };
  providerResponseId?: string;
  raw?: JsonValue;
  stateParts?: ProviderStatePart[];
}

export interface ProviderAdapter {
  name: Exclude<ProviderName, "auto">;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}

export interface EventRecord<T extends JsonValue = JsonValue> {
  seq: number;
  id: string;
  tenantId: string;
  stream: string;
  type: string;
  at: string;
  correlationId?: string;
  causationId?: string;
  payload: T;
}

export type RunStatus = "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

export interface RunRecord {
  id: string;
  tenantId: string;
  sessionId: string;
  parentRunId?: string;
  kind: "foreground" | "background" | "child";
  status: RunStatus;
  modelRole: ModelRole;
  provider?: string;
  model?: string;
  releaseId?: string;
  releaseDigest?: string;
  releaseLabel?: string;
  rolloutId?: string;
  releaseCohort?: "stable" | "canary";
  input: string;
  output?: string;
  state?: RunState;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunState {
  system: string;
  messages: RuntimeMessage[];
  /** Shared, durable allowance for one repair of an omitted answer or unsupported promise. */
  responseRepairReason?: "owed_answer_omitted" | "unbacked_future_promise";
  /** Durable provenance for the run input. Synthetic work and schedule prompts
   * must never be promoted into owner-authored evidence during recovery. */
  inputPrincipal?: "member" | "agent";
  inputKind?: "conversation.user" | "schedule.instruction" | "work.instruction" | "agent.instruction";
  /** Immutable rollout identity selected when the run was admitted. Recovery
   * never reassigns a run after promotion or rollback. */
  release?: {
    id: string;
    digest: string;
    label: string;
    rolloutId: string;
    cohort: "stable" | "canary";
  };
  /** Per-run authority policy is pinned with the prompt and model route. The
   * runtime configuration remains the upper bound on auto-approval. */
  policyAutoApproveRisks?: ToolRisk[];
  /** The complete tool authority granted to this run. This may be wider than the
   * bounded set of schemas exposed to the model for a particular iteration. */
  authorityToolNames?: string[];
  toolNames: string[];
  /** Persisted route prevents a configuration change from switching providers or
   * models while a durable run is being resumed. */
  modelRoute?: ModelRoute;
  iteration: number;
  pendingCalls: ToolCall[];
  nextToolIndex: number;
  depth: number;
  tokenBudget: number;
  /** Cumulative operator-priced estimate for completed provider calls in this
   * run. The immutable model.completed events remain authoritative after the
   * resumable state is cleared. */
  estimatedCostUsd?: number;
}

export interface RunResult {
  runId: string;
  sessionId: string;
  status: RunStatus;
  text: string;
  reaction?: TapbackType;
  approvalId?: string;
  usage: Usage;
}

export type TapbackType = "like" | "love" | "laugh" | "emphasize" | "question";

export type MemoryKind = "identity" | "preference" | "pattern" | "fact" | "goal" | "commitment" | "episode" | "correction";
export type MemoryStatus = "active" | "superseded" | "retired" | "proposed";

export interface MemoryRecord {
  id: string;
  tenantId: string;
  kind: MemoryKind;
  statement: string;
  confidence: number;
  salience: number;
  status: MemoryStatus;
  validFrom: string;
  validTo?: string;
  observedAt: string;
  lastConfirmedAt?: string;
  sourceEventId: string;
  supersedesId?: string;
  userConfirmed: boolean;
}

export interface MemoryContext {
  carried: MemoryRecord[];
  retrieved: MemoryRecord[];
}

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface JobRecord {
  id: string;
  tenantId: string;
  type: string;
  status: JobStatus;
  releaseId?: string;
  subjectType?: string;
  subjectId?: string;
  payload: JsonObject;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  lockedAt?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Distribution {
  id: string;
  displayName: string;
  systemPrompt: string;
  foregroundToolNames: string[];
  backgroundToolNames: string[];
}

export interface InboundMessage {
  tenantId: string;
  channel: string;
  peerId: string;
  /** Stable relationship identity, independent of the transport carrying this turn. */
  relationship?: { channel: string; peerId: string };
  text: string;
  /** Exact transport references are retained below the model boundary. Chat
   * text contains only opaque attachment markers; background enrichment is
   * responsible for dereferencing these URLs. */
  attachments?: InboundAttachment[];
  externalId?: string;
  metadata?: JsonObject;
}

export interface InboundAttachment {
  id: string;
  url: string;
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
}
