import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, parse as parsePath, relative, resolve } from "node:path";
import { DependencyError } from "./dependency-errors.ts";
import type { MemoryStore } from "./memory.ts";
import type { ExecutionManager } from "./execution.ts";
import type { SqliteStore } from "./store.ts";
import { bridgeConfig, holdCalendar, holdOutcome, listCalendar, searchMail } from "./google.ts";
import type { Scheduler } from "./scheduler.ts";
import type { SkillLearningManager } from "./skill-learning.ts";
import type { RetainedAgentManager } from "./agents.ts";
import type { GoalGateType, GoalManager } from "./goals.ts";
import type { RefinementKind, RefinementManager, RefinementScope } from "./refinements.ts";
import type { OfficeManager, PromiseStatus } from "./office.ts";
import type { PersonalModel, SourceAffinitySignalKind } from "./personal-model.ts";
import type { ResearchKind, ResearchManager, ResearchSourceClass, ResearchCoverage } from "./research.ts";
import type { ScoutManager, ScoutStatus } from "./scouts.ts";
import type { SensorConsentManager } from "./sensors.ts";
import type { CredentialBroker } from "./credentials.ts";
import type { EmailVerificationManager } from "./email.ts";
import type { ProductOutcomeManager, MemberOutcomeKind, ContextAdvantage } from "./product-outcomes.ts";
import type { JsonObject, JsonValue, MemoryKind, RuntimeConfig, ToolCall, ToolDefinition } from "./types.ts";

export interface ToolExecutionContext {
  tenantId: string;
  sessionId: string;
  runId: string;
  sourceEventId: string;
  depth: number;
  authorityToolNames: string[];
  /** Stable across recovery. Effectful adapters must pass this through to the
   * downstream service whenever that service supports idempotency keys. */
  idempotencyKey: string;
  receiptId: string;
}

export type ToolOutcomeStatus = "succeeded" | "failed" | "uncertain";

export interface ToolOutcome {
  status: ToolOutcomeStatus;
  error?: string;
  evidenceScope?: "request" | "outcome";
}

export interface RuntimeTool {
  definition: ToolDefinition;
  execute(context: ToolExecutionContext, arguments_: JsonObject): Promise<JsonValue>;
  /** Interpret the tool's domain result. Returning JSON is never, by itself,
   * proof that the requested operation succeeded. */
  evaluateResult(output: JsonValue): ToolOutcome;
}

export interface DurableFileWriteSeams {
  syncTemporary?: (path: string) => void;
  rename?: (from: string, to: string) => void;
  syncDirectory?: (path: string) => void;
}

export type DelegateHandler = (context: ToolExecutionContext, arguments_: JsonObject) => Promise<JsonValue>;
export type WorkSubmitHandler = (context: ToolExecutionContext, arguments_: JsonObject) => Promise<JsonValue>;
export type ConsequenceWorkSubmitHandler = (context: ToolExecutionContext, arguments_: JsonObject) => Promise<JsonValue>;
export type ResearchCommissionHandler = (context: ToolExecutionContext, arguments_: JsonObject) => Promise<JsonValue>;
export type ScoutCreateHandler = (context: ToolExecutionContext, arguments_: JsonObject) => Promise<JsonValue>;

type BuiltinRuntimeTool = Omit<RuntimeTool, "evaluateResult"> & { evaluateResult?: RuntimeTool["evaluateResult"] };

export function successfulToolResult(_output: JsonValue): ToolOutcome {
  return { status: "succeeded", evidenceScope: "outcome" };
}

function acceptedRequestResult(_output: JsonValue): ToolOutcome {
  return { status: "succeeded", evidenceScope: "request" };
}

/** Only for synchronous local commits whose manager throws on failed storage.
 * This proves that a record exists, not that its claims are true or delivered. */
function persistedRecordResult(key = "id"): RuntimeTool["evaluateResult"] {
  return (output) => {
    const result = resultObject(output);
    return typeof result[key] === "string" && Boolean(String(result[key]).trim()) && !result.error
      ? { status: "succeeded", evidenceScope: "outcome" }
      : { status: "failed", evidenceScope: "request", error: "Local persistence returned no record identity" };
  };
}

function researchCommissionResult(output: JsonValue): ToolOutcome {
  const result = resultObject(output);
  return result.accepted === true && typeof result.commissionId === "string" && typeof result.workOrderId === "string"
    ? { status: "succeeded", evidenceScope: "request" }
    : { status: "failed", error: typeof result.error === "string" ? result.error : "Research commission was not admitted" };
}

function scoutCreateResult(output: JsonValue): ToolOutcome {
  const result = resultObject(output);
  return result.accepted === true && typeof result.scoutId === "string"
    ? { status: "succeeded", evidenceScope: "request" }
    : { status: "failed", error: typeof result.error === "string" ? result.error : "Persistent scout was not admitted" };
}

function scoutObservationResult(output: JsonValue): ToolOutcome {
  const result = resultObject(output);
  return result.recorded === true && typeof result.observationId === "string"
    ? { status: "succeeded", evidenceScope: "outcome" }
    : { status: "failed", error: typeof result.error === "string" ? result.error : "Scout observation was not recorded" };
}

function credentialFillResult(output: JsonValue): ToolOutcome {
  const result = resultObject(output);
  return result.screenshotMasked === true && typeof result.credentialId === "string" && Array.isArray(result.filledFields)
    ? { status: "succeeded", evidenceScope: "outcome" }
    : { status: "failed", error: "Browser credential fill was not completely masked and confirmed" };
}

function resultObject(output: JsonValue): JsonObject {
  return output !== null && typeof output === "object" && !Array.isArray(output) ? output : {};
}

function processToolResult(output: JsonValue): ToolOutcome {
  const result = resultObject(output);
  const cleanupUncertain = result.terminationCleanup === "uncertain";
  if (cleanupUncertain) return { status: "uncertain", error: "Process termination could not be confirmed" };
  if (result.timedOut === true) return { status: "failed", error: "Process timed out" };
  if (result.truncated === true) return { status: "failed", error: "Process output exceeded its configured bound" };
  if (result.signal !== null && result.signal !== undefined) return { status: "failed", error: `Process exited after signal ${String(result.signal)}` };
  if (typeof result.exitCode !== "number" || result.exitCode !== 0) {
    return { status: "failed", error: `Process exited with code ${String(result.exitCode)}` };
  }
  return { status: "succeeded", evidenceScope: "outcome" };
}

function delegationToolResult(output: JsonValue): ToolOutcome {
  const results = Array.isArray(resultObject(output).agents)
    ? resultObject(output).agents as JsonValue[]
    : [output];
  const failures = results.map(resultObject).filter((result) => result.status === "failed" || typeof result.error === "string");
  if (failures.length) {
    const first = failures[0];
    return { status: "failed", error: typeof first?.error === "string" ? first.error : "One or more delegated tasks were not admitted" };
  }
  return { status: "succeeded", evidenceScope: "request" };
}

function schema(properties: Record<string, JsonObject>, required: string[] = []): ToolDefinition["inputSchema"] {
  return { type: "object", properties, required, additionalProperties: false };
}

function asString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function asNumber(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function inside(path: string, roots: string[]): string {
  const target = resolve(path);
  const canonical = (candidate: string): string => {
    if (existsSync(candidate)) return realpathSync(candidate);
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    return resolve(canonical(parent), basename(candidate));
  };
  for (const root of roots) {
    const rootPath = canonical(resolve(root));
    if (rootPath === parsePath(rootPath).root) continue;
    const compareTarget = canonical(target);
    const rel = relative(rootPath, compareTarget);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return compareTarget;
  }
  throw new Error(`Path is outside configured workspace roots: ${target}`);
}

function syncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

/** Durable single-file replacement with an explicit post-rename uncertainty
 * boundary. Injected seams exist only so crash/error composition can execute in
 * tests; production callers use fsync + atomic rename + directory fsync. */
export function writeFileDurably(path: string, content: string, seams: DurableFileWriteSeams = {}): { path: string; bytes: number; overwritten: boolean } {
  const overwritten = existsSync(path);
  if (overwritten && lstatSync(path).isSymbolicLink()) throw new Error("Refusing to replace a symbolic link");
  const temporary = `${dirname(path)}/.${basename(path)}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let renamed = false;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    (seams.syncTemporary ?? syncPath)(temporary);
    (seams.rename ?? renameSync)(temporary, path);
    renamed = true;
    (seams.syncDirectory ?? syncPath)(dirname(path));
  } catch (error) {
    if (renamed) throw new DependencyError({
      service: "filesystem",
      kind: "unknown",
      message: `The file rename completed, but durable directory persistence could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
      retryable: false,
      uncertain: true,
    });
    throw error;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { path, bytes: Buffer.byteLength(content), overwritten };
}

function validationError(value: JsonValue | undefined, spec: JsonObject, path: string): string | undefined {
  const type = spec.type;
  if (type === "string" && typeof value !== "string") return `${path} must be a string`;
  if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return `${path} must be a finite number`;
  if (type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value))) return `${path} must be an integer`;
  if (type === "boolean" && typeof value !== "boolean") return `${path} must be a boolean`;
  if (type === "array" && !Array.isArray(value)) return `${path} must be an array`;
  if (type === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) return `${path} must be an object`;
  if (Array.isArray(spec.enum) && !spec.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
    return `${path} must be one of the declared enum values`;
  }
  if (typeof value === "number") {
    if (typeof spec.minimum === "number" && value < spec.minimum) return `${path} must be at least ${spec.minimum}`;
    if (typeof spec.maximum === "number" && value > spec.maximum) return `${path} must be at most ${spec.maximum}`;
  }
  if (typeof value === "string") {
    if (typeof spec.minLength === "number" && value.length < spec.minLength) return `${path} is too short`;
    if (typeof spec.maxLength === "number" && value.length > spec.maxLength) return `${path} is too long`;
    if (typeof spec.pattern === "string" && !new RegExp(spec.pattern, "u").test(value)) return `${path} does not match the required pattern`;
  }
  if (Array.isArray(value)) {
    if (typeof spec.minItems === "number" && value.length < spec.minItems) return `${path} has too few items`;
    if (typeof spec.maxItems === "number" && value.length > spec.maxItems) return `${path} has too many items`;
    const itemSpec = spec.items;
    if (itemSpec && typeof itemSpec === "object" && !Array.isArray(itemSpec)) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validationError(value[index], itemSpec as JsonObject, `${path}[${index}]`);
        if (error) return error;
      }
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = spec.properties && typeof spec.properties === "object" && !Array.isArray(spec.properties) ? spec.properties as JsonObject : {};
    const required = Array.isArray(spec.required) ? spec.required.filter((item): item is string => typeof item === "string") : [];
    for (const name of required) if (!(name in value)) return `${path}.${name} is required`;
    for (const [name, item] of Object.entries(value)) {
      const childSpec = properties[name];
      if (childSpec && typeof childSpec === "object" && !Array.isArray(childSpec)) {
        const error = validationError(item, childSpec as JsonObject, `${path}.${name}`);
        if (error) return error;
      } else if (spec.additionalProperties === false) return `${path}.${name} is not allowed`;
    }
  }
  return undefined;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RuntimeTool>();

  register(tool: RuntimeTool): void {
    if (this.tools.has(tool.definition.name)) throw new Error(`Duplicate tool ${tool.definition.name}`);
    this.tools.set(tool.definition.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): RuntimeTool | undefined {
    return this.tools.get(name);
  }

  definitions(names?: string[]): ToolDefinition[] {
    const selected = names ? names.flatMap((name) => {
      const tool = this.tools.get(name);
      return tool ? [tool] : [];
    }) : [...this.tools.values()];
    return selected.map((tool) => tool.definition);
  }

  select(query: string, preferred: string[], maximum = 12, allowedNames?: string[]): ToolDefinition[] {
    const normalizedQuery = query.toLowerCase();
    const words = new Set(normalizedQuery.split(/[^a-z0-9]+/).filter(Boolean));
    const preferredSet = new Set(preferred);
    const preferenceOrder = new Map(preferred.map((name, index) => [name, index]));
    const allowed = allowedNames ? new Set(allowedNames) : undefined;
    return [...this.tools.values()]
      .filter((tool) => !allowed || allowed.has(tool.definition.name))
      .map((tool) => {
        const haystack = `${tool.definition.name} ${tool.definition.description} ${tool.definition.tags.join(" ")}`.toLowerCase();
        const matches = [...words].filter((word) => word.length > 2 && haystack.includes(word)).length;
        const exactName = normalizedQuery.includes(tool.definition.name.toLowerCase()) ? 1_000 : 0;
        return { tool, score: exactName + matches * 10 + (preferredSet.has(tool.definition.name) ? 1 : 0), preference: preferenceOrder.get(tool.definition.name) ?? Number.MAX_SAFE_INTEGER };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.preference - right.preference || left.tool.definition.name.localeCompare(right.tool.definition.name))
      .slice(0, maximum)
      .map((item) => item.tool.definition);
  }

  validate(call: ToolCall, allowedNames?: readonly string[]): RuntimeTool {
    if (allowedNames && !allowedNames.includes(call.name)) {
      throw new Error(`Tool is outside this run's authority: ${call.name}`);
    }
    const tool = this.tools.get(call.name);
    if (!tool) throw new Error(`Unknown or unavailable tool: ${call.name}`);
    const required = tool.definition.inputSchema.required ?? [];
    for (const name of required) if (!(name in call.arguments)) throw new Error(`${call.name}: missing required argument ${name}`);
    if (tool.definition.inputSchema.additionalProperties === false) {
      for (const name of Object.keys(call.arguments)) if (!(name in tool.definition.inputSchema.properties)) throw new Error(`${call.name}: unexpected argument ${name}`);
    }
    for (const [name, value] of Object.entries(call.arguments)) {
      const spec = tool.definition.inputSchema.properties[name];
      const error = spec ? validationError(value, spec, name) : undefined;
      if (error) throw new Error(`${call.name}: ${error}`);
    }
    return tool;
  }
}

export function createBuiltinTools(input: {
  config: RuntimeConfig;
  store: SqliteStore;
  memory: MemoryStore;
  scheduler: Scheduler;
  skillLearning: SkillLearningManager;
  execution: ExecutionManager;
  agents: RetainedAgentManager;
  goals: GoalManager;
  refinements: RefinementManager;
  office: OfficeManager;
  personalModel: PersonalModel;
  research: ResearchManager;
  scouts: ScoutManager;
  sensors: SensorConsentManager;
  credentials: CredentialBroker;
  email: EmailVerificationManager;
  outcomes: ProductOutcomeManager;
  delegate: DelegateHandler;
  submitWork: WorkSubmitHandler;
  submitConsequenceWork: ConsequenceWorkSubmitHandler;
  commissionResearch: ResearchCommissionHandler;
  createScout: ScoutCreateHandler;
}): ToolRegistry {
  const toolRegistry = new ToolRegistry();
  // An unclassified result proves only request execution, never an outcome.
  // Third-party and test tools must always declare their own
  // outcome contract when registering directly with ToolRegistry.
  const registry = {
    register(tool: BuiltinRuntimeTool): void {
      toolRegistry.register({ ...tool, evaluateResult: tool.evaluateResult ?? acceptedRequestResult });
    },
    unregister(name: string): void { toolRegistry.unregister(name); },
  };

  registry.register({
    definition: {
      name: "outcome.feedback.record",
      description: "Record explicit member feedback about Co's immediately preceding substantive message. Use only when the current owner message directly and unambiguously says the prior response was a useful surprise, useful, obvious/repetitive, annoying, or neutral. Supply a short verbatim evidenceQuote from that owner message; the runtime verifies it, selects the prior message, and preserves the owner message as provenance. Never use this to grade your own work, infer praise from continued conversation, or treat silence as approval. Mark context advantage yes/no only when the member explicitly says longitudinal knowledge did or did not matter, with a separate contextEvidenceQuote.",
      inputSchema: schema({
        kind: { type: "string", enum: ["useful_surprise", "useful", "obvious", "annoying", "neutral"] },
        contextAdvantage: { type: "string", enum: ["yes", "no", "unknown"] },
        evidenceQuote: { type: "string", minLength: 2, maxLength: 240 },
        contextEvidenceQuote: { type: "string", minLength: 2, maxLength: 240 },
      }, ["kind", "evidenceQuote"]),
      risk: "local-write", tags: ["feedback", "useful", "helpful", "surprise", "wow", "great", "good", "obvious", "repetitive", "annoying", "bad", "missed", "context"], idempotent: true,
    },
    execute: async (context, arguments_) => input.outcomes.asJson(input.outcomes.record({
      tenantId: context.tenantId, sessionId: context.sessionId, sourceEventId: context.sourceEventId,
      kind: asString(arguments_.kind, "kind") as MemberOutcomeKind,
      evidenceQuote: asString(arguments_.evidenceQuote, "evidenceQuote"),
      ...(typeof arguments_.contextEvidenceQuote === "string"
        ? { contextEvidenceQuote: arguments_.contextEvidenceQuote } : {}),
      ...(typeof arguments_.contextAdvantage === "string"
        ? { contextAdvantage: arguments_.contextAdvantage as ContextAdvantage } : {}),
    })),
  });

  registry.register({
    definition: {
      name: "sensor.list",
      description: "List configured calendar, email, call, file, browser, and location senses with their purpose, data classes, retention declaration, exact descriptor hash, and current consent state. Listing does not read the underlying source.",
      inputSchema: schema({}), risk: "read", tags: ["sensor", "consent", "calendar", "email", "call", "file", "browser", "location"], idempotent: true,
    },
    execute: async (context) => ({ sensors: input.sensors.list(context.tenantId).map((sensor) => input.sensors.asJson(sensor)) as unknown as JsonValue }),
  });

  registry.register({
    definition: {
      name: "sensor.consent.grant",
      description: "Request explicit permission for one configured read-only sense exactly as described by its current descriptor hash. This is a permission change and therefore pauses for approval; approval grants no write authority and becomes stale if the plugin descriptor changes.",
      inputSchema: schema({
        sensorId: { type: "string", minLength: 1, maxLength: 129 },
        descriptorHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      }, ["sensorId", "descriptorHash"]),
      risk: "external-write", tags: ["sensor", "consent", "grant", "permission", "calendar", "email", "call", "file", "browser", "location"], idempotent: true,
    },
    execute: async (context, arguments_) => input.sensors.asJson(input.sensors.grant({
      tenantId: context.tenantId, sensorId: asString(arguments_.sensorId, "sensorId"),
      expectedDescriptorHash: asString(arguments_.descriptorHash, "descriptorHash"),
      sourceEventId: context.sourceEventId, createdByRunId: context.runId,
    })),
  });

  registry.register({
    definition: {
      name: "sensor.consent.revoke",
      description: "Revoke one previously granted sense. The underlying source becomes unreadable immediately while consent history remains auditable.",
      inputSchema: schema({ sensorId: { type: "string", minLength: 1, maxLength: 129 } }, ["sensorId"]),
      risk: "external-write", tags: ["sensor", "consent", "revoke", "permission", "stop"], idempotent: true,
    },
    execute: async (context, arguments_) => input.sensors.asJson(input.sensors.revoke(context.tenantId, asString(arguments_.sensorId, "sensorId"))),
  });

  registry.register({
    definition: {
      name: "credential.list",
      description: "List opaque active login handles, their exact allowed origins, and available field names. Secret values and ciphertext are never returned to the model.",
      inputSchema: schema({ limit: { type: "integer", minimum: 1, maximum: 100 } }),
      risk: "read", tags: ["credential", "login", "browser", "account", "vault"], idempotent: true,
    },
    execute: async (context, arguments_) => ({
      credentials: input.credentials.list(context.tenantId, Math.max(1, Math.min(100, asNumber(arguments_.limit, 50))))
        .filter((credential) => credential.status === "active").map((credential) => input.credentials.asJson(credential)) as unknown as JsonValue,
    }),
  });

  registry.register({
    definition: {
      name: "browser.credential.fill",
      description: "Fill selected login fields in an existing browser page from an opaque credential handle. The runtime rechecks the exact origin, injects secrets below the model over CDP, CSS-masks filled fields before any later screenshot, and returns only field names. This never submits the form.",
      inputSchema: schema({
        credentialId: { type: "string", minLength: 1, maxLength: 256 },
        targetId: { type: "string", minLength: 1, maxLength: 256 },
        selectors: { type: "object" },
      }, ["credentialId", "targetId", "selectors"]),
      risk: "external-write", tags: ["credential", "login", "browser", "fill", "authentication"], idempotent: false,
    },
    execute: async (context, arguments_) => input.credentials.fill({
      tenantId: context.tenantId, credentialId: asString(arguments_.credentialId, "credentialId"),
      targetId: asString(arguments_.targetId, "targetId"), selectors: resultObject(arguments_.selectors as JsonValue),
    }) as unknown as JsonValue,
    evaluateResult: credentialFillResult,
  });

  registry.register({
    definition: {
      name: "email.verification.request",
      description: "Send a short-lived one-time verification code to an email address the user explicitly supplied. The runtime generates and protects the code; the model never receives it. This does not authenticate a session by itself.",
      inputSchema: schema({
        email: { type: "string", minLength: 3, maxLength: 254 },
        purpose: { type: "string", minLength: 1, maxLength: 128 },
      }, ["email"]),
      risk: "external-write", tags: ["email", "verification", "verify", "code", "otp", "address", "contact"], idempotent: true,
    },
    execute: async (context, arguments_) => {
      const email = asString(arguments_.email, "email");
      const purpose = typeof arguments_.purpose === "string" ? arguments_.purpose : "contact";
      const challenge = await input.email.request({
        tenantId: context.tenantId, email, purpose,
        idempotencyKey: context.idempotencyKey,
      });
      return input.email.challengeJson(challenge);
    },
    evaluateResult: acceptedRequestResult,
  });

  registry.register({
    definition: {
      name: "email.identity.list",
      description: "List verified email identities by opaque ID and masked address. Verification codes and full addresses are not exposed to the model.",
      inputSchema: schema({}), risk: "read", tags: ["email", "identity", "verified", "contact", "list"], idempotent: true,
    },
    execute: async (context) => ({ identities: input.email.listIdentities(context.tenantId).map((identity) => input.email.identityJson(identity)) }),
  });

  registry.register({
    definition: {
      name: "email.send_verified",
      description: "Send an email to an already-verified identity using its opaque ID. This cannot address an arbitrary unverified recipient and always crosses the external-write approval boundary.",
      inputSchema: schema({
        identityId: { type: "string", minLength: 1, maxLength: 128 },
        subject: { type: "string", minLength: 1, maxLength: 998 },
        content: { type: "string", minLength: 1, maxLength: 100000 },
      }, ["identityId", "subject", "content"]),
      risk: "external-write", tags: ["email", "send", "message", "verified", "contact"], idempotent: true,
    },
    execute: async (context, arguments_) => input.email.sendToIdentity({
      tenantId: context.tenantId, identityId: asString(arguments_.identityId, "identityId"),
      subject: asString(arguments_.subject, "subject"), content: asString(arguments_.content, "content"),
      idempotencyKey: context.idempotencyKey, sourceEventId: context.sourceEventId,
    }),
    evaluateResult: acceptedRequestResult,
  });

  registry.register({
    definition: {
      name: "work.submit",
      description: "Hand off a concrete outcome to a durable asynchronous work order that acts with bounded tools, pauses for approvals, and reports receipt-backed completion. Use when useful work can continue after the current reply.",
      inputSchema: schema({
        objective: { type: "string", minLength: 1, maxLength: 20000 },
        successContract: { type: "string", minLength: 1, maxLength: 10000 },
        evidencePolicy: { type: "string", enum: ["run", "tool", "external-write"] },
        minimumReceipts: { type: "integer", minimum: 1, maximum: 1000 },
        requiredToolNames: { type: "array", items: { type: "string" }, maxItems: 12 },
        modelRole: { type: "string", enum: ["foreground", "deliberation", "background", "critic"] },
        tokenBudget: { type: "integer", minimum: 256, maximum: 100000 },
        allowedTools: { type: "array", items: { type: "string" }, maxItems: 256 },
      }, ["objective"]),
      risk: "local-write", tags: ["work", "do", "handle", "execute", "outcome", "asynchronous", "background"], idempotent: true,
    },
    execute: input.submitWork,
    evaluateResult: acceptedRequestResult,
  });

  registry.register({
    definition: {
      name: "consequence.work.submit",
      description: "Turn an existing prepared consequence into a durable receipt-gated work order only when the current owner message explicitly asks to proceed. The sourceQuote must be copied from that request. Work cannot exceed the current run's tools, and consequential effects still pause for approval unless a narrow mandate applies.",
      inputSchema: schema({
        consequenceId: { type: "string", minLength: 1, maxLength: 128 },
        sourceQuote: { type: "string", minLength: 2, maxLength: 480 },
        successContract: { type: "string", minLength: 1, maxLength: 10000 },
        evidencePolicy: { type: "string", enum: ["run", "tool", "external-write"] },
        minimumReceipts: { type: "integer", minimum: 1, maximum: 1000 },
        requiredToolNames: { type: "array", items: { type: "string" }, maxItems: 12 },
        modelRole: { type: "string", enum: ["foreground", "deliberation", "background", "critic"] },
        tokenBudget: { type: "integer", minimum: 256, maximum: 100000 },
        allowedTools: { type: "array", items: { type: "string" }, maxItems: 256 },
      }, ["consequenceId", "sourceQuote"]),
      risk: "local-write", tags: ["consequence", "prepared", "proceed", "execute", "work", "do", "send", "schedule"], idempotent: true,
    },
    execute: input.submitConsequenceWork,
    evaluateResult: acceptedRequestResult,
  });

  registry.register({
    definition: {
      name: "mandate.propose",
      description: "Propose a standing service contract for operator review. A proposal grants no authority and cannot approve itself.",
      inputSchema: schema({ name: { type: "string", minLength: 1, maxLength: 256 }, serviceContract: { type: "string", minLength: 1, maxLength: 5000 }, authority: { type: "object" }, delivery: { type: "object" } }, ["name", "serviceContract"]),
      risk: "local-write", tags: ["mandate", "service", "standing", "proactive", "institution"], idempotent: false,
    },
    execute: async (context, arguments_) => input.office.proposeMandate({
      tenantId: context.tenantId, name: asString(arguments_.name, "name"), serviceContract: asString(arguments_.serviceContract, "serviceContract"),
      authority: arguments_.authority !== null && typeof arguments_.authority === "object" && !Array.isArray(arguments_.authority) ? arguments_.authority as JsonObject : {},
      delivery: arguments_.delivery !== null && typeof arguments_.delivery === "object" && !Array.isArray(arguments_.delivery) ? arguments_.delivery as JsonObject : {},
      sourceEventId: context.sourceEventId, createdByRunId: context.runId,
    }) as unknown as JsonValue,
  });

  registry.register({
    definition: {
      name: "mandate.activate",
      description: "Activate one already-proposed or paused standing service mandate. This grants future bounded action authority and therefore always requires review of the exact mandate ID through the approval path; a mandate cannot authorize this tool.",
      inputSchema: schema({ mandateId: { type: "string", minLength: 1, maxLength: 128 } }, ["mandateId"]),
      risk: "external-write", tags: ["mandate", "service", "standing", "authority", "activate", "approve", "permission"], idempotent: true,
    },
    execute: async (context, arguments_) => input.office.transitionMandate(
      context.tenantId, asString(arguments_.mandateId, "mandateId"), "active",
    ) as unknown as JsonValue,
  });

  registry.register({
    definition: {
      name: "mandate.transition",
      description: "Immediately pause or permanently retire a standing mandate when the owner directly asks in the current message. Resuming authority is deliberately excluded and must use mandate.activate with a new approval.",
      inputSchema: schema({
        mandateId: { type: "string", minLength: 1, maxLength: 128 },
        action: { type: "string", enum: ["pause", "retire"] },
        sourceQuote: { type: "string", minLength: 2, maxLength: 480 },
      }, ["mandateId", "action", "sourceQuote"]),
      risk: "local-write", tags: ["mandate", "service", "standing", "authority", "pause", "retire", "stop", "revoke"], idempotent: true,
    },
    execute: async (context, arguments_) => {
      const action = asString(arguments_.action, "action");
      if (action !== "pause" && action !== "retire") throw new Error(`Unknown mandate transition ${action}`);
      return input.office.transitionMandateFromOwner({
        tenantId: context.tenantId, mandateId: asString(arguments_.mandateId, "mandateId"), action,
        sourceEventId: context.sourceEventId, sourceQuote: asString(arguments_.sourceQuote, "sourceQuote"),
      }) as unknown as JsonValue;
    },
  });

  registry.register({
    definition: {
      name: "promise.accept",
      description: "Persist a future burden Co is explicitly accepting before telling the user it will happen. A real due time is required; attach a work order when completion requires background execution.",
      inputSchema: schema({
        objective: { type: "string", minLength: 1, maxLength: 10000 },
        dueAt: { type: "string", minLength: 20, maxLength: 64 },
        workOrderId: { type: "string", minLength: 1, maxLength: 128 },
      }, ["objective", "dueAt"]),
      risk: "local-write", tags: ["promise", "follow-up", "later", "deadline", "remember", "responsibility"], idempotent: true,
    },
    execute: async (context, arguments_) => input.office.acceptPromise({
      tenantId: context.tenantId, sourceEventId: context.sourceEventId, sessionId: context.sessionId,
      objective: asString(arguments_.objective, "objective"), dueAt: asString(arguments_.dueAt, "dueAt"), createdByRunId: context.runId,
      ...(typeof arguments_.workOrderId === "string" ? { workOrderId: arguments_.workOrderId } : {}),
    }) as unknown as JsonValue,
  });

  registry.register({
    definition: {
      name: "promise.list",
      description: "List Co's accepted and overdue future burdens. This is distinct from the user's own goals or accountability commitments.",
      inputSchema: schema({ status: { type: "string", enum: ["accepted", "overdue", "completed", "released"] }, limit: { type: "integer", minimum: 1, maximum: 100 } }),
      risk: "read", tags: ["promise", "follow-up", "later", "deadline", "responsibility", "list"], idempotent: true,
    },
    execute: async (context, arguments_) => {
      const statuses: PromiseStatus[] = arguments_.status === "accepted" || arguments_.status === "overdue" || arguments_.status === "completed" || arguments_.status === "released" ? [arguments_.status] : ["accepted", "overdue"];
      return { promises: input.office.listPromises(context.tenantId, statuses, Math.max(1, Math.min(100, asNumber(arguments_.limit, 50)))) as unknown as JsonValue };
    },
  });

  registry.register({
    definition: {
      name: "source.affinity.record",
      description: "Record an explicit user response to a previously observed source. Sharing alone is stored as neutral attention; use this only when the user directly revisits, endorses, dismisses, rejects, or acts on the source.",
      inputSchema: schema({
        source: { type: "string", minLength: 1, maxLength: 4_000 },
        kind: { type: "string", enum: ["revisited", "endorsed", "dismissed", "rejected", "acted"] },
      }, ["source", "kind"]),
      risk: "local-write", tags: ["source", "affinity", "taste", "endorsed", "rejected", "revisited", "acted"], idempotent: true,
    },
    execute: async (context, arguments_) => input.personalModel.recordSourceSignal(
      context.tenantId, asString(arguments_.source, "source"), context.sourceEventId,
      asString(arguments_.kind, "kind") as SourceAffinitySignalKind,
    ) as unknown as JsonValue,
  });

  registry.register({
    definition: {
      name: "research.commission",
      description: "Commission durable WorldScout research when current external facts, a precise outside framework, a person, source, or opportunity could materially change the situation. Research runs asynchronously and must bind final claims to independent primary-source read receipts.",
      inputSchema: schema({
        kind: { type: "string", enum: ["fact", "framework", "person", "opportunity", "source"] },
        objective: { type: "string", minLength: 1, maxLength: 12000 },
        whyNow: { type: "string", minLength: 1, maxLength: 4000 },
        minimumIndependentSources: { type: "integer", minimum: 2, maximum: 8 },
        requiredPrimarySources: { type: "integer", minimum: 1, maximum: 8 },
        tokenBudget: { type: "integer", minimum: 1000, maximum: 100000 },
      }, ["kind", "objective"]),
      risk: "local-write", tags: ["research", "world", "scout", "framework", "person", "opportunity", "find"], idempotent: true,
    },
    execute: input.commissionResearch,
    evaluateResult: researchCommissionResult,
  });

  registry.register({
    evaluateResult: persistedRecordResult(),
    definition: {
      name: "research.source.record",
      description: "Bind one externally retrieved source and one supported claim to the exact successful read tool call that produced it. Search snippets and metadata may be recorded for discovery but cannot substantiate a final finding.",
      inputSchema: schema({
        commissionId: { type: "string", minLength: 1, maxLength: 128 },
        retrievalToolCallId: { type: "string", minLength: 1, maxLength: 256 },
        url: { type: "string", minLength: 8, maxLength: 4000 },
        title: { type: "string", minLength: 2, maxLength: 1000 },
        publisher: { type: "string", minLength: 2, maxLength: 500 },
        creator: { type: "string", maxLength: 500 },
        publishedAt: { type: "string", maxLength: 64 },
        sourceClass: { type: "string", enum: ["official", "first_party", "primary_research", "secondary", "journalism", "community", "unknown"] },
        coverage: { type: "string", enum: ["search_result", "metadata", "fulltext", "multimodal", "repository", "document"] },
        claim: { type: "string", minLength: 20, maxLength: 4000 },
        qualityBasis: { type: "string", minLength: 20, maxLength: 2000 },
        limitations: { type: "string", minLength: 10, maxLength: 2000 },
      }, ["commissionId", "retrievalToolCallId", "url", "title", "publisher", "sourceClass", "coverage", "claim", "qualityBasis", "limitations"]),
      risk: "local-write", tags: ["research", "source", "citation", "provenance", "receipt", "primary"], idempotent: true,
    },
    execute: async (context, arguments_) => input.research.recordSource({
      tenantId: context.tenantId, commissionId: asString(arguments_.commissionId, "commissionId"), runId: context.runId,
      retrievalToolCallId: asString(arguments_.retrievalToolCallId, "retrievalToolCallId"), url: asString(arguments_.url, "url"),
      title: asString(arguments_.title, "title"), publisher: asString(arguments_.publisher, "publisher"),
      ...(typeof arguments_.creator === "string" ? { creator: arguments_.creator } : {}),
      ...(typeof arguments_.publishedAt === "string" ? { publishedAt: arguments_.publishedAt } : {}),
      sourceClass: asString(arguments_.sourceClass, "sourceClass") as ResearchSourceClass,
      coverage: asString(arguments_.coverage, "coverage") as ResearchCoverage,
      claim: asString(arguments_.claim, "claim"), qualityBasis: asString(arguments_.qualityBasis, "qualityBasis"),
      limitations: asString(arguments_.limitations, "limitations"),
    }) as unknown as JsonValue,
  });

  registry.register({
    definition: {
      name: "scout.create",
      description: "Create a durable read-only recurring scout over one explicitly selected MCP or sensor tool. It records only changed observations and never gains write authority or a separate member-facing voice.",
      inputSchema: schema({
        name: { type: "string", minLength: 1, maxLength: 256 },
        objective: { type: "string", minLength: 20, maxLength: 4000 },
        readToolName: { type: "string", minLength: 1, maxLength: 256 },
        readArguments: { type: "object" },
        everyMinutes: { type: "integer", minimum: 5, maximum: 43200 },
        firstRunAt: { type: "string", maxLength: 64 },
        wakeMode: { type: "string", enum: ["poll", "event", "hybrid"] },
        freshnessMinutes: { type: "integer", minimum: 5, maximum: 129600 },
        expiresAt: { type: "string", maxLength: 64 },
      }, ["name", "objective", "readToolName", "readArguments", "everyMinutes"]),
      risk: "local-write", tags: ["scout", "watch", "monitor", "continuous", "calendar", "email", "event", "change"], idempotent: true,
    },
    execute: input.createScout,
    evaluateResult: scoutCreateResult,
  });

  registry.register({
    definition: {
      name: "scout.observation.record",
      description: "Bind one scheduled scout observation to the exact confirmed read receipt from that scout's current work-order run. The runtime computes change from canonical receipt output.",
      inputSchema: schema({
        scoutId: { type: "string", minLength: 1, maxLength: 128 },
        retrievalToolCallId: { type: "string", minLength: 1, maxLength: 256 },
        summary: { type: "string", minLength: 20, maxLength: 4000 },
      }, ["scoutId", "retrievalToolCallId", "summary"]),
      risk: "local-write", tags: ["scout", "observation", "receipt", "change", "sensor"], idempotent: true,
    },
    execute: async (context, arguments_) => {
      const observation = input.scouts.recordObservation({
        tenantId: context.tenantId, scoutId: asString(arguments_.scoutId, "scoutId"), runId: context.runId,
        retrievalToolCallId: asString(arguments_.retrievalToolCallId, "retrievalToolCallId"),
        summary: asString(arguments_.summary, "summary"),
      });
      return { recorded: true, observationId: observation.id, changed: observation.changed, sourceEventId: observation.sourceEventId ?? null };
    },
    evaluateResult: scoutObservationResult,
  });

  registry.register({
    definition: {
      name: "scout.list",
      description: "List persistent read-only scouts and their current health without loading raw sensor output.",
      inputSchema: schema({ limit: { type: "integer", minimum: 1, maximum: 100 } }),
      risk: "read", tags: ["scout", "watch", "monitor", "status", "health"], idempotent: true,
    },
    execute: async (context, arguments_) => ({ scouts: input.scouts.list(context.tenantId, Math.max(1, Math.min(100, asNumber(arguments_.limit, 50))))
      .map((scout) => input.scouts.asJson(scout, false)) as unknown as JsonValue }),
  });

  registry.register({
    definition: {
      name: "scout.transition",
      description: "Pause, resume, or permanently retire a persistent scout. History and observations are retained. A scout automatically stopped for repeated failure requires operator repair acknowledgment and cannot be resumed by this tool.",
      inputSchema: schema({ scoutId: { type: "string", minLength: 1, maxLength: 128 }, action: { type: "string", enum: ["pause", "resume", "retire"] } }, ["scoutId", "action"]),
      risk: "local-write", tags: ["scout", "watch", "pause", "resume", "retire", "cancel"], idempotent: true,
    },
    execute: async (context, arguments_) => {
      const action = asString(arguments_.action, "action");
      const status: ScoutStatus = action === "pause" ? "paused" : action === "resume" ? "active" : "retired";
      return input.scouts.asJson(input.scouts.transition(context.tenantId, asString(arguments_.scoutId, "scoutId"), status));
    },
  });

  registry.register({
    evaluateResult: persistedRecordResult(),
    definition: {
      name: "research.finding.record",
      description: "Record the audited result of a WorldScout commission. It must map the finding to the member's actual situation, state limits and counterevidence, explain what changes, and cite enough independent full sources including primary evidence.",
      inputSchema: schema({
        commissionId: { type: "string", minLength: 1, maxLength: 128 },
        kind: { type: "string", enum: ["fact", "framework", "person", "opportunity", "source"] },
        title: { type: "string", minLength: 4, maxLength: 1000 },
        summary: { type: "string", minLength: 40, maxLength: 10000 },
        mapping: { type: "string", minLength: 40, maxLength: 10000 },
        limitations: { type: "string", minLength: 20, maxLength: 5000 },
        changedImplication: { type: "string", minLength: 20, maxLength: 5000 },
        counterevidence: { type: "string", minLength: 20, maxLength: 5000 },
        sourceReceiptIds: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 24 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      }, ["commissionId", "kind", "title", "summary", "mapping", "limitations", "changedImplication", "counterevidence", "sourceReceiptIds", "confidence"]),
      risk: "local-write", tags: ["research", "finding", "framework", "mapping", "implication", "counterevidence"], idempotent: true,
    },
    execute: async (context, arguments_) => input.research.recordFinding({
      tenantId: context.tenantId, commissionId: asString(arguments_.commissionId, "commissionId"), runId: context.runId,
      kind: asString(arguments_.kind, "kind") as ResearchKind, title: asString(arguments_.title, "title"),
      summary: asString(arguments_.summary, "summary"), mapping: asString(arguments_.mapping, "mapping"),
      limitations: asString(arguments_.limitations, "limitations"), changedImplication: asString(arguments_.changedImplication, "changedImplication"),
      counterevidence: asString(arguments_.counterevidence, "counterevidence"),
      sourceReceiptIds: Array.isArray(arguments_.sourceReceiptIds) ? arguments_.sourceReceiptIds.filter((item): item is string => typeof item === "string") : [],
      confidence: asNumber(arguments_.confidence, 0),
    }) as unknown as JsonValue,
  });

  registry.register({
    definition: {
      name: "matter.create",
      description: "Open a durable matter for an evolving situation that benefits from evidence, prepared work, or ongoing watch. Do not turn ordinary reflection into an accountability loop.",
      inputSchema: schema({ title: { type: "string", minLength: 1, maxLength: 512 }, summary: { type: "string", minLength: 1, maxLength: 10000 }, priority: { type: "integer", minimum: 0, maximum: 100 }, mandateId: { type: "string" }, status: { type: "string", enum: ["active", "watching", "waiting"] } }, ["title", "summary"]),
      risk: "local-write", tags: ["matter", "case", "watch", "project", "situation", "ongoing"], idempotent: false,
    },
    execute: async (context, arguments_) => input.office.createMatter({
      tenantId: context.tenantId, title: asString(arguments_.title, "title"), summary: asString(arguments_.summary, "summary"),
      sourceEventId: context.sourceEventId, createdByRunId: context.runId,
      ...(typeof arguments_.priority === "number" ? { priority: arguments_.priority } : {}),
      ...(typeof arguments_.mandateId === "string" ? { mandateId: arguments_.mandateId } : {}),
      ...(arguments_.status === "active" || arguments_.status === "watching" || arguments_.status === "waiting" ? { status: arguments_.status } : {}),
    }) as unknown as JsonValue,
  });

  registry.register({
    definition: {
      name: "matter.update",
      description: "Update a durable matter and attach the current source event as evidence without deleting its prior history.",
      inputSchema: schema({ matterId: { type: "string" }, summary: { type: "string", minLength: 1, maxLength: 10000 }, priority: { type: "integer", minimum: 0, maximum: 100 }, status: { type: "string", enum: ["active", "watching", "waiting", "completed", "archived"] } }, ["matterId"]),
      risk: "local-write", tags: ["matter", "case", "update", "evidence", "complete"], idempotent: false,
    },
    execute: async (context, arguments_) => input.office.updateMatter(context.tenantId, asString(arguments_.matterId, "matterId"), {
      evidenceEventId: context.sourceEventId,
      ...(typeof arguments_.summary === "string" ? { summary: arguments_.summary } : {}),
      ...(typeof arguments_.priority === "number" ? { priority: arguments_.priority } : {}),
      ...(arguments_.status === "active" || arguments_.status === "watching" || arguments_.status === "waiting" || arguments_.status === "completed" || arguments_.status === "archived" ? { status: arguments_.status } : {}),
    }) as unknown as JsonValue,
  });

  registry.register({
    evaluateResult: persistedRecordResult(),
    definition: {
      name: "artifact.prepare",
      description: "Prepare a durable brief, draft, research note, or plan for later review. Preparation is local and does not send or publish anything.",
      inputSchema: schema({ kind: { type: "string", minLength: 1, maxLength: 64 }, title: { type: "string", minLength: 1, maxLength: 512 }, content: { type: "string", minLength: 1, maxLength: 100000 }, matterId: { type: "string" }, mandateId: { type: "string" }, sourceEventIds: { type: "array", items: { type: "string" }, maxItems: 64 } }, ["kind", "title", "content"]),
      risk: "local-write", tags: ["artifact", "prepare", "draft", "brief", "research", "plan"], idempotent: false,
    },
    execute: async (context, arguments_) => input.office.prepareArtifact({
      tenantId: context.tenantId, kind: asString(arguments_.kind, "kind"), title: asString(arguments_.title, "title"), content: asString(arguments_.content, "content"),
      createdByRunId: context.runId,
      sourceEventIds: [...new Set([context.sourceEventId, ...(Array.isArray(arguments_.sourceEventIds) ? arguments_.sourceEventIds.filter((item): item is string => typeof item === "string") : [])])],
      ...(typeof arguments_.matterId === "string" ? { matterId: arguments_.matterId } : {}),
      ...(typeof arguments_.mandateId === "string" ? { mandateId: arguments_.mandateId } : {}),
    }) as unknown as JsonValue,
  });

  registry.register({
    definition: {
      name: "inbox.hold",
      description: "Hold a relevant item in Co's inbox with a reason and delivery mode. This does not notify the user; it reduces interruption until the operator reviews the inbox.",
      inputSchema: schema({ title: { type: "string", minLength: 1, maxLength: 512 }, content: { type: "string", minLength: 1, maxLength: 10000 }, reason: { type: "string", minLength: 1, maxLength: 2000 }, mode: { type: "string", enum: ["hold", "context", "digest", "ask", "interrupt"] }, priority: { type: "integer", minimum: 0, maximum: 100 }, matterId: { type: "string" }, artifactId: { type: "string" } }, ["title", "content", "reason"]),
      risk: "local-write", tags: ["inbox", "attention", "hold", "digest", "proactive", "interrupt"], idempotent: false,
    },
    execute: async (context, arguments_) => input.office.raiseAttention({
      tenantId: context.tenantId, title: asString(arguments_.title, "title"), content: asString(arguments_.content, "content"), reason: asString(arguments_.reason, "reason"), sourceEventId: context.sourceEventId,
      ...(arguments_.mode === "hold" || arguments_.mode === "context" || arguments_.mode === "digest" || arguments_.mode === "ask" || arguments_.mode === "interrupt" ? { mode: arguments_.mode } : {}),
      ...(typeof arguments_.priority === "number" ? { priority: arguments_.priority } : {}),
      ...(typeof arguments_.matterId === "string" ? { matterId: arguments_.matterId } : {}),
      ...(typeof arguments_.artifactId === "string" ? { artifactId: arguments_.artifactId } : {}),
    }) as unknown as JsonValue,
  });

  registry.register({
    definition: {
      name: "office.today",
      description: "Read a compact projection of held attention, prepared work, active matters, standing mandates, near-term calendar evidence, approvals, and background work.",
      inputSchema: schema({}), risk: "read", tags: ["today", "office", "briefing", "inbox", "calendar", "prepared"], idempotent: true,
    },
    execute: async (context) => input.office.today(context.tenantId),
  });

  registry.register({
    definition: {
      name: "mandate.list",
      description: "List standing service mandates and their operator-controlled lifecycle state.",
      inputSchema: schema({ status: { type: "string", enum: ["proposed", "active", "paused", "retired"] }, limit: { type: "integer", minimum: 1, maximum: 100 } }),
      risk: "read", tags: ["mandate", "service", "standing", "authority", "proactive"], idempotent: true,
    },
    execute: async (context, arguments_) => {
      const status = arguments_.status === "proposed" || arguments_.status === "active" || arguments_.status === "paused" || arguments_.status === "retired" ? arguments_.status : undefined;
      return { mandates: input.office.listMandates(context.tenantId, status, Math.max(1, Math.min(100, asNumber(arguments_.limit, 50)))) as unknown as JsonValue };
    },
  });

  registry.register({
    definition: {
      name: "matter.list",
      description: "List durable evolving matters, including what Co is actively handling, watching, or waiting on.",
      inputSchema: schema({ status: { type: "string", enum: ["active", "watching", "waiting", "completed", "archived"] }, limit: { type: "integer", minimum: 1, maximum: 100 } }),
      risk: "read", tags: ["matter", "case", "monitor", "watch", "ongoing", "status"], idempotent: true,
    },
    execute: async (context, arguments_) => {
      const status = arguments_.status === "active" || arguments_.status === "watching" || arguments_.status === "waiting" || arguments_.status === "completed" || arguments_.status === "archived" ? arguments_.status : undefined;
      return { matters: input.office.listMatters(context.tenantId, status, Math.max(1, Math.min(100, asNumber(arguments_.limit, 50)))) as unknown as JsonValue };
    },
  });

  registry.register({
    definition: {
      name: "artifact.list_prepared",
      description: "List prepared local briefs, drafts, research, and plans without loading their full content.",
      inputSchema: schema({ limit: { type: "integer", minimum: 1, maximum: 100 } }),
      risk: "read", tags: ["artifact", "prepared", "brief", "draft", "research", "plan", "work"], idempotent: true,
    },
    execute: async (context, arguments_) => ({
      artifacts: input.office.listArtifacts(context.tenantId, undefined, Math.max(1, Math.min(100, asNumber(arguments_.limit, 50)))).map(({ content, ...artifact }) => ({ ...artifact, preview: content.slice(0, 500) })) as unknown as JsonValue,
    }),
  });

  registry.register({
    definition: {
      name: "artifact.read_prepared",
      description: "Read one prepared local artifact by ID. Reading it does not mark it used or send it anywhere.",
      inputSchema: schema({ artifactId: { type: "string" } }, ["artifactId"]),
      risk: "read", tags: ["artifact", "prepared", "read", "brief", "draft"], idempotent: true,
    },
    execute: async (context, arguments_) => {
      const artifact = input.office.getArtifact(context.tenantId, asString(arguments_.artifactId, "artifactId"));
      if (!artifact) throw new Error("Prepared artifact not found");
      return artifact as unknown as JsonValue;
    },
  });

  registry.register({
    definition: {
      name: "inbox.list",
      description: "List useful items held for review because they did not justify an interruption or lacked an authorized delivery path.",
      inputSchema: schema({ limit: { type: "integer", minimum: 1, maximum: 100 } }),
      risk: "read", tags: ["inbox", "attention", "held", "digest", "review"], idempotent: true,
    },
    execute: async (context, arguments_) => ({ inbox: input.office.listAttention(context.tenantId, "open", Math.max(1, Math.min(100, asNumber(arguments_.limit, 50)))) as unknown as JsonValue }),
  });

  registry.register({
    definition: {
      name: "schedule.create",
      description: "Create a durable one-time or interval task. The worker materializes due tasks even after a process restart.",
      inputSchema: schema({ name: { type: "string" }, prompt: { type: "string" }, runAt: { type: "string" }, everyMinutes: { type: "integer", minimum: 1 }, channel: { type: "string" }, peerId: { type: "string" } }, ["name", "prompt"]),
      risk: "local-write", tags: ["schedule", "reminder", "later", "every", "daily", "recurring"], idempotent: false,
    },
    execute: async (context, arguments_) => input.scheduler.asJson(input.scheduler.create({
      tenantId: context.tenantId, name: asString(arguments_.name, "name"), prompt: asString(arguments_.prompt, "prompt"),
      channel: typeof arguments_.channel === "string" ? arguments_.channel : "cli",
      peerId: typeof arguments_.peerId === "string" ? arguments_.peerId : "local",
      ...(typeof arguments_.runAt === "string" ? { runAt: arguments_.runAt } : {}),
      ...(typeof arguments_.everyMinutes === "number" ? { everyMinutes: arguments_.everyMinutes } : {}),
    })),
  });

  registry.register({
    definition: {
      name: "schedule.list",
      description: "List durable active schedules for this user.",
      inputSchema: schema({}), risk: "read", tags: ["schedule", "reminder", "jobs"], idempotent: true,
    },
    execute: async (context) => ({ schedules: input.scheduler.list(context.tenantId, "active").map((record) => input.scheduler.asJson(record)) }),
  });

  registry.register({
    definition: {
      name: "schedule.cancel",
      description: "Cancel a durable schedule by ID.",
      inputSchema: schema({ scheduleId: { type: "string" } }, ["scheduleId"]), risk: "local-write", tags: ["schedule", "cancel", "reminder"], idempotent: true,
    },
    execute: async (context, arguments_) => input.scheduler.asJson(input.scheduler.cancel(context.tenantId, asString(arguments_.scheduleId, "scheduleId"))),
  });

  registry.register({
    definition: {
      name: "clock.now",
      description: "Return the exact current date and time in the user's configured timezone and the configured location precision.",
      inputSchema: schema({}), risk: "read", tags: ["time", "date", "timezone", "location"], idempotent: true,
    },
    execute: async () => ({
      utc: new Date().toISOString(),
      timezone: input.config.timezone,
      local: new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeStyle: "long", timeZone: input.config.timezone }).format(new Date()),
      location: input.config.location ?? "unknown",
    }),
  });

  registry.register({
    definition: {
      name: "memory.recall",
      description: "Recall provenance-bearing, non-superseded memories relevant to a topic. Use when prior context could materially change the answer.",
      inputSchema: schema({ query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, ["query"]),
      risk: "read", tags: ["memory", "history", "preference", "person", "project"], idempotent: true,
    },
    execute: async (context, arguments_) => {
      const result = await input.memory.recall(context.tenantId, asString(arguments_.query, "query"), Math.max(1, Math.min(20, asNumber(arguments_.limit, 8))));
      return { retrievalMode: result.mode, memories: result.memories.map((memory) => ({
        id: memory.id, kind: memory.kind, statement: memory.statement, confidence: memory.confidence,
        observedAt: memory.observedAt, sourceEventId: memory.sourceEventId, userConfirmed: memory.userConfirmed,
      })) };
    },
  });

  registry.register({
    definition: {
      name: "history.search",
      description: "Search dated excerpts from prior conversations, imported local logs, and ingested sources. Use when the answer should be grounded across time rather than in the latest exchange.",
      inputSchema: schema({ query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 30 }, includeUntrusted: { type: "boolean" } }, ["query"]),
      risk: "read", tags: ["history", "conversation", "logs", "evidence", "past", "longitudinal"], idempotent: true,
    },
    execute: async (context, arguments_) => {
      const query = asString(arguments_.query, "query");
      const limit = Math.max(1, Math.min(30, asNumber(arguments_.limit, 8)));
      const semantic = await input.memory.semantic?.search(context.tenantId, "evidence", query, { limit, includeUntrusted: arguments_.includeUntrusted === true });
      const lexical = input.store.searchEvidence(context.tenantId, query, {
        limit, trustClasses: arguments_.includeUntrusted === true ? ["owner", "agent", "untrusted"] : ["owner", "agent"],
      }).map((record) => ({
        sourceEventId: record.sourceEventId, kind: record.kind, trustClass: record.trustClass,
        observedAt: record.observedAt, excerpt: record.excerpt || record.content.slice(0, 1_000), metadata: record.metadata,
      }));
      const vectorHits = (semantic?.hits ?? []).map((hit) => ({
        sourceEventId: hit.sourceEventId, evidenceId: hit.id, trustClass: hit.trustClass,
        observedAt: hit.observedAt, excerpt: hit.content.slice(0, 1_000), similarity: hit.score,
      }));
      return { retrievalMode: semantic?.mode === "semantic" ? "hybrid" : "lexical",
        evidence: [...vectorHits, ...lexical].filter((record, index, all) => all.findIndex((item) => item.sourceEventId === record.sourceEventId) === index).slice(0, limit) };
    },
  });

  registry.register({
    evaluateResult: persistedRecordResult("memoryId"),
    definition: {
      name: "memory.remember",
      description: "Propose or store a durable memory with provenance. Store only information likely to matter in a future interaction; receiving content is not evidence that the user adopted it.",
      inputSchema: schema({
        kind: { type: "string", enum: ["identity", "preference", "pattern", "fact", "goal", "commitment", "episode"] },
        statement: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 }, salience: { type: "number", minimum: 0, maximum: 1 },
      }, ["kind", "statement"]),
      risk: "local-write", tags: ["memory", "remember", "preference", "commitment", "goal"], idempotent: false,
    },
    execute: async (context, arguments_) => {
      const allowed: MemoryKind[] = ["identity", "preference", "pattern", "fact", "goal", "commitment", "episode"];
      const kind = asString(arguments_.kind, "kind") as MemoryKind;
      if (!allowed.includes(kind)) throw new Error(`Unsupported memory kind ${kind}`);
      const memory = input.memory.remember({
        tenantId: context.tenantId, kind, statement: asString(arguments_.statement, "statement"), sourceEventId: context.sourceEventId,
        confidence: Math.min(0.69, asNumber(arguments_.confidence, 0.58)), salience: asNumber(arguments_.salience, 0.5),
      });
      return { memoryId: memory.id, status: memory.status, statement: memory.statement };
    },
  });

  registry.register({
    definition: {
      name: "memory.correct",
      description: "Correct a specific memory using a verbatim replacement from the current owner message. The old version remains as superseded history; a model paraphrase cannot become user-confirmed.",
      inputSchema: schema({ memoryId: { type: "string" }, replacement: { type: "string" } }, ["memoryId", "replacement"]),
      risk: "local-write", tags: ["memory", "correct", "wrong", "update"], idempotent: false,
    },
    execute: async (context, arguments_) => {
      const replacement = asString(arguments_.replacement, "replacement").trim();
      if (replacement.length < 3 || !input.memory.ownerText(context.tenantId, context.sourceEventId).includes(replacement)) {
        throw new Error("Memory correction requires the owner's verbatim replacement");
      }
      const memory = input.memory.correct({ tenantId: context.tenantId, memoryId: asString(arguments_.memoryId, "memoryId"), replacement: asString(arguments_.replacement, "replacement"), sourceEventId: context.sourceEventId });
      return { memoryId: memory.id, supersedesId: memory.supersedesId ?? null, statement: memory.statement };
    },
  });

  registry.register({
    evaluateResult: persistedRecordResult("memoryId"),
    definition: {
      name: "memory.retire", description: "Stop using an active memory without erasing history. Requires a current owner quote that says forget/retire/stop remembering and names the exact statement or memory ID.",
      inputSchema: schema({ memoryId: { type: "string" }, sourceQuote: { type: "string", minLength: 3, maxLength: 1000 } }, ["memoryId", "sourceQuote"]),
      risk: "local-write", tags: ["memory", "forget", "retire", "privacy"], idempotent: true,
    },
    execute: async (context, arguments_) => {
      const memoryId = asString(arguments_.memoryId, "memoryId");
      const quote = asString(arguments_.sourceQuote, "sourceQuote");
      const memory = input.memory.get(memoryId, context.tenantId);
      const ownerText = input.memory.ownerText(context.tenantId, context.sourceEventId);
      if (!memory || !ownerText.includes(quote) || !/\b(forget|retire|stop remembering)\b/i.test(quote)
        || (!quote.includes(memory.statement) && !quote.includes(memory.id))) throw new Error("Memory retirement requires an owner quote bound to this exact memory");
      input.memory.retire(context.tenantId, memoryId, context.sourceEventId);
      return { memoryId, status: "retired", historyRetained: true };
    },
  });

  registry.register({
    definition: {
      name: "file.list",
      description: "List files in a directory under the configured workspace roots.",
      inputSchema: schema({ path: { type: "string" } }, ["path"]), risk: "read", tags: ["files", "repository", "folder", "workspace"], idempotent: true,
    },
    execute: async (_context, arguments_) => {
      const path = inside(asString(arguments_.path, "path"), input.config.workspaceRoots);
      return { path, entries: readdirSync(path, { withFileTypes: true }).slice(0, 500).map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" })) };
    },
  });

  registry.register({
    evaluateResult: (output) => {
      const result = resultObject(output);
      return typeof result.path === "string" && typeof result.content === "string" && result.truncated === false
        ? { status: "succeeded", evidenceScope: "outcome" } : acceptedRequestResult(output);
    },
    definition: {
      name: "file.read",
      description: "Read a UTF-8 file under the configured workspace roots, with a bounded output.",
      inputSchema: schema({ path: { type: "string" }, maxChars: { type: "integer", minimum: 1, maximum: 200000 } }, ["path"]),
      risk: "read", tags: ["file", "read", "repository", "document"], idempotent: true,
    },
    execute: async (_context, arguments_) => {
      const path = inside(asString(arguments_.path, "path"), input.config.workspaceRoots);
      const maxChars = Math.max(1, Math.min(200_000, asNumber(arguments_.maxChars, 40_000)));
      const content = readFileSync(path, "utf8");
      return { path, content: content.slice(0, maxChars), truncated: content.length > maxChars, size: statSync(path).size };
    },
  });

  registry.register({
    evaluateResult: (output) => {
      const result = resultObject(output);
      return typeof result.path === "string" && Number.isSafeInteger(result.bytes) && Number(result.bytes) >= 0
        ? { status: "succeeded", evidenceScope: "outcome" }
        : { status: "failed", evidenceScope: "request", error: "Durable write returned no confirmed byte count" };
    },
    definition: {
      name: "file.write",
      description: "Write a complete UTF-8 file under a configured workspace root. This can overwrite existing work and therefore requires explicit approval by default.",
      inputSchema: schema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
      risk: "destructive", tags: ["file", "write", "create", "edit"], idempotent: true,
    },
    execute: async (_context, arguments_) => {
      const requested = asString(arguments_.path, "path");
      inside(dirname(resolve(requested)), input.config.workspaceRoots);
      const path = inside(requested, input.config.workspaceRoots);
      if (typeof arguments_.content !== "string") throw new Error("content must be a string");
      const content = arguments_.content;
      return writeFileDurably(path, content);
    },
  });

  registry.register({
    definition: {
      name: "content.ingest_url",
      description: "Queue a URL, including a YouTube video, for asynchronous transcript/content extraction and usefulness analysis. Returns immediately.",
      inputSchema: schema({ url: { type: "string" }, userNote: { type: "string" }, refresh: { type: "boolean" } }, ["url"]), risk: "local-write", tags: ["url", "youtube", "video", "article", "read", "analyze"], idempotent: true,
    },
    execute: async (context, arguments_) => {
      const url = asString(arguments_.url, "url");
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Only HTTP(S) URLs are supported");
      const refresh = arguments_.refresh === true;
      const sourceRun = input.store.getRun(context.runId, context.tenantId);
      const job = input.store.enqueueJob(context.tenantId, "content.enrich", {
        url, userNote: typeof arguments_.userNote === "string" ? arguments_.userNote : "", sessionId: context.sessionId, sourceEventId: context.sourceEventId, refresh,
      }, { idempotencyKey: `${context.sourceEventId}:${url}:${refresh}`, ...(sourceRun?.releaseId ? { releaseId: sourceRun.releaseId } : {}) });
      return { queued: job.status === "queued" || job.status === "running", jobId: job.id, status: job.status, url };
    },
    evaluateResult: acceptedRequestResult,
  });

  registry.register({
    definition: {
      name: "process.run",
      description: "Run one allowlisted executable without a shell through the explicitly selected execution backend. The backend bounds workspace, environment, network, time, resources, and output.",
      inputSchema: schema({
        command: { type: "string", minLength: 1, maxLength: 512 },
        args: { type: "array", items: { type: "string" }, maxItems: 128 },
        cwd: { type: "string" },
        stdin: { type: "string", maxLength: 100000 },
      }, ["command"]),
      risk: "destructive", tags: ["process", "command", "terminal", "execute", "build", "test", "run"], idempotent: false,
    },
    execute: async (_context, arguments_) => input.execution.run({
      command: asString(arguments_.command, "command"),
      ...(Array.isArray(arguments_.args) ? { args: arguments_.args.filter((item): item is string => typeof item === "string") } : {}),
      ...(typeof arguments_.cwd === "string" ? { cwd: arguments_.cwd } : {}),
      ...(typeof arguments_.stdin === "string" ? { stdin: arguments_.stdin } : {}),
    }),
    evaluateResult: processToolResult,
  });

  if (input.config.execution.backend === "none") {
    // Keep disabled process execution out of model tool selection entirely.
    registry.unregister("process.run");
  }

  registry.register({
    definition: {
      name: "skill.propose",
      description: "Propose a reusable procedure learned from verified work. This records evidence for review but cannot install itself or expand tool authority.",
      inputSchema: schema({
        name: { type: "string", minLength: 1, maxLength: 64 },
        description: { type: "string", minLength: 1, maxLength: 1000 },
        instructions: { type: "string", minLength: 1, maxLength: 30000 },
        evidenceEventIds: { type: "array", items: { type: "string" }, maxItems: 32 },
        supersedesId: { type: "string" },
      }, ["name", "description", "instructions"]),
      risk: "local-write", tags: ["skill", "learn", "procedure", "reusable", "improve"], idempotent: false,
    },
    execute: async (context, arguments_) => {
      const evidenceEventIds = Array.isArray(arguments_.evidenceEventIds)
        ? arguments_.evidenceEventIds.filter((item): item is string => typeof item === "string")
        : [];
      const proposal = input.skillLearning.propose({
        tenantId: context.tenantId,
        name: asString(arguments_.name, "name"),
        description: asString(arguments_.description, "description"),
        instructions: asString(arguments_.instructions, "instructions"),
        evidenceEventIds,
        sourceEventId: context.sourceEventId,
        sourceRunId: context.runId,
        ...(typeof arguments_.supersedesId === "string" ? { supersedesId: arguments_.supersedesId } : {}),
      });
      return { proposalId: proposal.id, name: proposal.name, version: proposal.version, status: proposal.status, evidenceEventIds: proposal.evidenceEventIds };
    },
  });

  registry.register({
    definition: {
      name: "refinement.propose",
      description: "Propose a minimal, evidence-backed harness refinement for operator review. This cannot approve or apply itself, edit the immutable base prompt, delete history, or change tools, authority, secrets, permissions, or workspace scope.",
      inputSchema: schema({
        kind: { type: "string", enum: ["prompt_overlay", "agent_spec", "procedure", "memory_policy"] },
        scope: { type: "string", enum: ["local", "tenant", "distribution"] }, targetId: { type: "string", minLength: 1, maxLength: 256 },
        title: { type: "string", minLength: 1, maxLength: 256 }, rationale: { type: "string", minLength: 1, maxLength: 5000 },
        expectedEffect: { type: "string", minLength: 1, maxLength: 2000 }, patch: { type: "object" },
        evidenceEventIds: { type: "array", items: { type: "string" }, maxItems: 64 }, supersedesId: { type: "string" },
      }, ["kind", "scope", "targetId", "title", "rationale", "expectedEffect", "patch"]),
      risk: "local-write", tags: ["refinement", "improve", "prompt", "agent", "procedure", "memory", "proposal"], idempotent: false,
    },
    execute: async (context, arguments_) => {
      const patch = arguments_.patch !== null && typeof arguments_.patch === "object" && !Array.isArray(arguments_.patch) ? arguments_.patch as JsonObject : {};
      const evidenceEventIds = Array.isArray(arguments_.evidenceEventIds) ? arguments_.evidenceEventIds.filter((item): item is string => typeof item === "string") : [];
      const proposal = input.refinements.propose({
        tenantId: context.tenantId, kind: asString(arguments_.kind, "kind") as RefinementKind,
        scope: asString(arguments_.scope, "scope") as RefinementScope, targetId: asString(arguments_.targetId, "targetId"),
        title: asString(arguments_.title, "title"), rationale: asString(arguments_.rationale, "rationale"),
        expectedEffect: asString(arguments_.expectedEffect, "expectedEffect"), patch, evidenceEventIds,
        sourceRunId: context.runId, sourceEventId: context.sourceEventId,
        ...(typeof arguments_.supersedesId === "string" ? { supersedesId: arguments_.supersedesId } : {}),
      });
      return input.refinements.asJson(proposal);
    },
  });

  registry.register({
    definition: {
      name: "goal.list",
      description: "List explicit durable goals and their independent completion-gate state. Do not create goals for ordinary conversation, play, or reflection.",
      inputSchema: schema({ status: { type: "string", enum: ["active", "paused", "completed", "failed", "cancelled"] }, limit: { type: "integer", minimum: 1, maximum: 100 } }),
      risk: "read", tags: ["goal", "autonomous", "long-running", "status", "completion"], idempotent: true,
    },
    execute: async (context, arguments_) => {
      const raw = arguments_.status;
      const status = raw === "active" || raw === "paused" || raw === "completed" || raw === "failed" || raw === "cancelled" ? raw : undefined;
      return { goals: input.goals.list(context.tenantId, status, Math.max(1, Math.min(100, asNumber(arguments_.limit, 50)))).map((goal) => input.goals.asJson(goal)) };
    },
  });

  registry.register({
    definition: {
      name: "goal.create",
      description: "Create an explicit persistent goal with a deterministic completion gate and bounded continuation. This requires a short verbatim sourceQuote from the current owner message that explicitly states the ongoing outcome. For an event gate, referenceWindowDays may define a comparable prior-performance window only when the owner's quoted commitment states that exact horizon; never invent a duration from a vague goal. A standardsMandateId may link a separately proposed standing standards mandate; only its explicit activation permits foreground accountability or reality checks. Never turn ordinary conversation, an inferred desire, or Co's own suggestion into accountability.",
      inputSchema: schema({
        objective: { type: "string", minLength: 1, maxLength: 20000 },
        successContract: { type: "string", minLength: 1, maxLength: 10000 },
        sourceQuote: { type: "string", minLength: 2, maxLength: 480 },
        standardsMandateId: { type: "string", minLength: 1, maxLength: 128 },
        agentId: { type: "string" }, gateType: { type: "string", enum: ["manual", "event", "artifact", "run"] },
        gateConfig: { type: "object" }, maxContinuations: { type: "integer", minimum: 0, maximum: 100 },
        maxTokens: { type: "integer", minimum: 256, maximum: 1000000 }, deadlineAt: { type: "string" },
      }, ["objective", "successContract", "sourceQuote", "gateType"]),
      risk: "local-write", tags: ["goal", "autonomous", "persist", "completion", "gate"], idempotent: false,
    },
    execute: async (context, arguments_) => {
      const gateType = asString(arguments_.gateType, "gateType") as GoalGateType;
      const gateConfig = arguments_.gateConfig !== null && typeof arguments_.gateConfig === "object" && !Array.isArray(arguments_.gateConfig) ? arguments_.gateConfig as JsonObject : {};
      const goal = input.goals.create({
        tenantId: context.tenantId, objective: asString(arguments_.objective, "objective"), successContract: asString(arguments_.successContract, "successContract"),
        sourceQuote: asString(arguments_.sourceQuote, "sourceQuote"), gateType, gateConfig,
        createdByRunId: context.runId, sourceEventId: context.sourceEventId,
        ...(typeof arguments_.standardsMandateId === "string" ? { standardsMandateId: arguments_.standardsMandateId } : {}),
        ...(typeof arguments_.agentId === "string" ? { agentId: arguments_.agentId } : {}),
        ...(typeof arguments_.maxContinuations === "number" ? { maxContinuations: arguments_.maxContinuations } : {}),
        ...(typeof arguments_.maxTokens === "number" ? { maxTokens: arguments_.maxTokens } : {}),
        ...(typeof arguments_.deadlineAt === "string" ? { deadlineAt: arguments_.deadlineAt } : {}),
      });
      return input.goals.asJson(goal);
    },
  });

  registry.register({
    definition: {
      name: "goal.transition",
      description: "Pause, resume, or cancel an explicit durable goal when the owner directly asks to change that commitment. Cancellation is permanent and preserves the goal, source quote, checks, and work history.",
      inputSchema: schema({
        goalId: { type: "string", minLength: 1, maxLength: 128 },
        action: { type: "string", enum: ["pause", "resume", "cancel"] },
        sourceQuote: { type: "string", minLength: 2, maxLength: 480 },
      }, ["goalId", "action", "sourceQuote"]),
      risk: "local-write", tags: ["goal", "commitment", "pause", "resume", "cancel", "stop", "revoke"], idempotent: true,
    },
    execute: async (context, arguments_) => {
      const goalId = asString(arguments_.goalId, "goalId");
      const action = asString(arguments_.action, "action");
      if (action !== "pause" && action !== "resume" && action !== "cancel") throw new Error(`Unknown goal transition ${action}`);
      const goal = input.goals.transitionFromOwner({
        tenantId: context.tenantId, goalId, action, sourceEventId: context.sourceEventId,
        sourceQuote: asString(arguments_.sourceQuote, "sourceQuote"),
      });
      return input.goals.asJson(goal);
    },
  });

  registry.register({
    evaluateResult: (output) => resultObject(output).kind === "goal_reality_check"
      ? { status: "succeeded", evidenceScope: "outcome" }
      : { status: "failed", evidenceScope: "request", error: "No prepared reality-check record" },
    definition: {
      name: "goal.reality_check",
      description: "At an actual owner-stated decision point, prepare one evidence-bound arithmetic reality check against an explicit quoted event goal linked to an active member-approved standards mandate. The runtime supplies the original dated quote and verified count, emits it without model commentary, and suppresses an unchanged repeat. Never use merely because a goal exists.",
      inputSchema: schema({
        goalId: { type: "string", minLength: 1, maxLength: 128 },
        decisionQuote: { type: "string", minLength: 2, maxLength: 480 },
      }, ["goalId", "decisionQuote"]),
      risk: "local-write", tags: ["goal", "commitment", "standard", "decision", "count", "progress", "reality", "check"], idempotent: true,
    },
    execute: async (context, arguments_) => input.goals.prepareRealityCheck({
      tenantId: context.tenantId, goalId: asString(arguments_.goalId, "goalId"), sourceEventId: context.sourceEventId,
      decisionQuote: asString(arguments_.decisionQuote, "decisionQuote"), createdByRunId: context.runId,
    }) as unknown as JsonValue,
  });

  registry.register({
    definition: {
      name: "goal.check",
      description: "Queue an independent check of a durable goal. A failed changed-state check may continue its assigned agent within the goal's fixed budgets; unchanged failures never re-trigger work.",
      inputSchema: schema({ goalId: { type: "string" } }, ["goalId"]), risk: "local-write",
      tags: ["goal", "check", "verify", "gate", "continue"], idempotent: true,
    },
    execute: async (context, arguments_) => ({
      goalId: asString(arguments_.goalId, "goalId"),
      jobId: input.goals.enqueueCheck(context.tenantId, asString(arguments_.goalId, "goalId"), `requested by run ${context.runId}`),
      accepted: true,
    }),
    evaluateResult: acceptedRequestResult,
  });

  registry.register({
    definition: {
      name: "agent.list",
      description: "List retained agents addressable from this conversation or agent family, including their durable lifecycle state.",
      inputSchema: schema({ limit: { type: "integer", minimum: 1, maximum: 100 } }),
      risk: "read", tags: ["agent", "subagent", "status", "collaboration", "workers"], idempotent: true,
    },
    execute: async (context, arguments_) => ({
      agents: input.agents.listAddressable(context.tenantId, context.sessionId, Math.max(1, Math.min(100, asNumber(arguments_.limit, 50))))
        .map((agent) => input.agents.asJson(agent)),
    }),
  });

  registry.register({
    definition: {
      name: "agent.messages",
      description: "Read bounded durable messages and results for an addressable retained agent. Use after asynchronous delegation instead of assuming the child already finished.",
      inputSchema: schema({ agentId: { type: "string" }, afterSeq: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["agentId"]),
      risk: "read", tags: ["agent", "messages", "result", "mailbox", "followup"], idempotent: true,
    },
    execute: async (context, arguments_) => {
      const agent = input.agents.addressable(context.tenantId, context.sessionId, asString(arguments_.agentId, "agentId"));
      return {
        agent: input.agents.asJson(agent),
        messages: input.agents.messages(context.tenantId, agent.id, {
          afterSeq: Math.max(0, asNumber(arguments_.afterSeq, 0)), limit: Math.max(1, Math.min(100, asNumber(arguments_.limit, 50))),
        }).map((message) => input.agents.messageJson(message)),
      };
    },
  });

  for (const kind of ["message", "follow_up"] as const) registry.register({
    definition: {
      name: kind === "follow_up" ? "agent.follow_up" : "agent.send",
      description: kind === "follow_up"
        ? "Queue a follow-up for an existing retained agent and return immediately. The same agent keeps its prior session context."
        : "Send a bounded asynchronous message to a parent, child, or sibling retained agent and return immediately.",
      inputSchema: schema({ agentId: { type: "string" }, content: { type: "string", minLength: 1, maxLength: 50000 } }, ["agentId", "content"]),
      risk: "local-write", tags: ["agent", "send", "message", "followup", "steer", "collaboration"], idempotent: false,
    },
    execute: async (context, arguments_) => {
      const queued = input.agents.send({
        tenantId: context.tenantId, senderRunId: context.runId, senderSessionId: context.sessionId,
        targetAgentId: asString(arguments_.agentId, "agentId"), content: asString(arguments_.content, "content"), kind,
      });
      return { accepted: true, message: input.agents.messageJson(queued.message), jobId: queued.jobId };
    },
    evaluateResult: acceptedRequestResult,
  });

  for (const action of ["cancel", "retire"] as const) registry.register({
    definition: {
      name: `agent.${action}`,
      description: action === "cancel"
        ? "Cancel queued work for an addressable retained agent without deleting its transcript or artifacts."
        : "Retire an addressable retained agent. History remains available and the agent can no longer receive work.",
      inputSchema: schema({ agentId: { type: "string" } }, ["agentId"]), risk: "local-write",
      tags: ["agent", action, "stop", "retire"], idempotent: true,
    },
    execute: async (context, arguments_) => {
      const target = input.agents.addressable(context.tenantId, context.sessionId, asString(arguments_.agentId, "agentId"));
      const result = action === "cancel"
        ? input.agents.cancel(context.tenantId, target.id, context.runId)
        : input.agents.retire(context.tenantId, target.id, context.runId);
      return input.agents.asJson(result);
    },
  });

  registry.register({
    definition: {
      name: "delegate_task",
      description: "Admit one retained agent, or a bounded batch, for asynchronous work. Returns stable handles immediately; inspect results later with agent.messages and steer with agent.follow_up.",
      inputSchema: schema({
        name: { type: "string", minLength: 1, maxLength: 64 }, objective: { type: "string" }, deliverable: { type: "string" }, modelRole: { type: "string", enum: ["foreground", "deliberation", "background", "critic"] },
        tokenBudget: { type: "integer", minimum: 256, maximum: 20000 }, allowedTools: { type: "array", items: { type: "string" } },
        tasks: { type: "array", items: { type: "object" }, maxItems: 12 },
      }),
      risk: "local-write", tags: ["delegate", "subagent", "parallel", "research", "specialist"], idempotent: false,
    },
    execute: input.delegate,
    evaluateResult: delegationToolResult,
  });

  // GOOGLE (9/6). Registered only when the loopback bridge is configured — a tool the model can see
  // but never complete is worse than one that does not exist, because the attempt reads to the
  // member as a promise. `bridgeConfig` refuses any non-loopback host.
  const google = bridgeConfig(input.config.googleBridge?.baseUrl, input.config.googleBridge?.token);
  if (google) {
    registry.register({
      definition: {
        name: "calendar.list",
        description: "Read this member's next events from their linked Google calendars. Returns "
          + "connected:false with a reason when Google is not linked — that is NOT an empty day.",
        inputSchema: schema({ limit: { type: "number" } }), risk: "read",
        tags: ["calendar", "schedule", "google"], idempotent: true,
      },
      execute: async (context, arguments_) =>
        listCalendar(google, context.tenantId, Math.min(Number(arguments_.limit ?? 10) || 10, 50)),
    });

    registry.register({
      definition: {
        name: "mail.search",
        description: "Search this member's linked Gmail, read-only, returning headers and snippets. "
          + "Returns connected:false with a reason when Google is not linked.",
        inputSchema: schema({ q: { type: "string" }, limit: { type: "number" } }), risk: "read",
        tags: ["email", "gmail", "google"], idempotent: true,
      },
      execute: async (context, arguments_) =>
        searchMail(google, context.tenantId, asString(arguments_.q ?? "newer_than:7d", "q"),
          Math.min(Number(arguments_.limit ?? 10) || 10, 25)),
    });

    registry.register({
      definition: {
        name: "calendar.hold",
        description: "Put a real event on this member's Google calendar. Other people can see it. "
          + "Completes only when the calendar returns an event link.",
        inputSchema: schema({
          title: { type: "string" }, start: { type: "string" },
          minutes: { type: "number" }, instructions: { type: "string" },
        }, ["title", "start"]),
        risk: "external-write", tags: ["calendar", "google", "write"], idempotent: false,
      },
      evaluateResult: holdOutcome,
      execute: async (context, arguments_) => holdCalendar(google, context.tenantId, {
        title: asString(arguments_.title, "title"),
        start: asString(arguments_.start, "start"),
        minutes: Math.min(Math.max(Number(arguments_.minutes ?? 30) || 30, 5), 480),
        instructions: typeof arguments_.instructions === "string" ? arguments_.instructions : "",
      }),
    });
  }

  return toolRegistry;
}
