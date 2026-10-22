import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { attachmentDigest, attachmentJson, normalizeInboundAttachments, safeSourceUrl } from "./deposits.ts";
import { id, stableId } from "./id.ts";
import { EmailVerificationError } from "./email.ts";
import { credentialOrigin } from "./credentials.ts";
import { compatCompletionId, engineCompatContext, parseEngineCompatTurn } from "./engine-compat.ts";
import { applyShape } from "./shape.ts";
import { RuntimeLogger } from "./logger.ts";
import { RuntimeMetrics } from "./metrics.ts";
import { assertProductionConfig } from "./production.ts";
import { PluginRegistry } from "./plugins.ts";
import type { CoRuntime } from "./runtime.ts";
import { CURRENT_SCHEMA_VERSION } from "./store.ts";
import type { JsonObject, JsonValue, RunRecord } from "./types.ts";

class HttpError extends Error {
  readonly status: number;
  readonly publicMessage: string;

  constructor(status: number, publicMessage: string) {
    super(publicMessage);
    this.name = "HttpError";
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

interface RateLimitEntry {
  count: number;
  resetsAt: number;
}

class FixedWindowRateLimiter {
  private readonly entries = new Map<string, RateLimitEntry>();
  private checks = 0;

  check(key: string, maximum: number, windowMs: number): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
    const current = Date.now();
    const prior = this.entries.get(key);
    const entry = !prior || prior.resetsAt <= current ? { count: 0, resetsAt: current + windowMs } : prior;
    entry.count += 1;
    this.entries.set(key, entry);
    this.checks += 1;
    if (this.checks % 1_000 === 0) for (const [candidate, value] of this.entries) if (value.resetsAt <= current) this.entries.delete(candidate);
    return {
      allowed: entry.count <= maximum,
      remaining: Math.max(0, maximum - entry.count),
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetsAt - current) / 1_000)),
    };
  }
}

function secureHeaders(response: ServerResponse, correlationId: string): void {
  response.setHeader("x-request-id", correlationId);
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("cache-control", "no-store");
}

function reply(response: ServerResponse, status: number, body: JsonValue): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] as JsonValue)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function textReply(response: ServerResponse, status: number, body: string, contentType: string): void {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  response.end(body);
}

function originalReply(response: ServerResponse, body: Buffer, mimeType: string, filename: string | undefined): void {
  if (response.headersSent || response.destroyed) return;
  const safeMimeType = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mimeType) ? mimeType : "application/octet-stream";
  const safeFilename = (filename ?? "original").replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180) || "original";
  response.writeHead(200, {
    "content-type": safeMimeType, "content-length": String(body.byteLength),
    "content-disposition": `attachment; filename="${safeFilename.replaceAll('"', "_")}"`, "cache-control": "no-store",
  });
  response.end(body);
}

function readJsonBody(request: IncomingMessage, maximum: number): Promise<{ value: unknown; raw: Buffer }> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "Content-Type must be application/json");
  const encoding = request.headers["content-encoding"]?.trim().toLowerCase();
  if (encoding && encoding !== "identity") throw new HttpError(415, "Compressed request bodies are not supported");
  const declared = Number.parseInt(request.headers["content-length"] ?? "", 10);
  if (Number.isFinite(declared) && declared > maximum) throw new HttpError(413, "Request body too large");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const cleanup = () => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      request.resume();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maximum) {
        chunks.length = 0;
        fail(new HttpError(413, "Request body too large"));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const raw = Buffer.concat(chunks);
        resolve({ value: raw.length ? JSON.parse(raw.toString("utf8")) : {}, raw });
      } catch {
        reject(new HttpError(400, "Invalid JSON body"));
      }
    };
    const onError = () => fail(new HttpError(400, "Request body could not be read"));
    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

async function readBody(request: IncomingMessage, maximum: number): Promise<unknown> {
  return (await readJsonBody(request, maximum)).value;
}

function boundedLimit(value: string | null, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(maximum, parsed)) : fallback;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedString(value: unknown, field: string, maximum: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
  const result = value.trim();
  if (required && !result) throw new HttpError(400, `${field} is required`);
  if (result.length > maximum) throw new HttpError(400, `${field} exceeds ${maximum} characters`);
  return result || undefined;
}

function safeEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function authorized(runtime: CoRuntime, request: IncomingMessage): boolean {
  if (!runtime.config.serverToken) return runtime.config.environment !== "production";
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  return safeEqual(header.slice("Bearer ".length), runtime.config.serverToken);
}

function routeLabel(pathname: string): string {
  if (/^\/v1\/responsibilities\/[^/]+(?:\/actions)?$/.test(pathname)) return "/v1/responsibilities/:id";
  if (pathname === "/v1/responsibilities") return pathname;
  if (/^\/v1\/runs\/[^/]+\/actions$/.test(pathname)) return "/v1/runs/:id/actions";
  if (/^\/v1\/receipts\/[^/]+\/actions$/.test(pathname)) return "/v1/receipts/:id/actions";
  if (/^\/v1\/deliveries\/[^/]+\/actions$/.test(pathname)) return "/v1/deliveries/:id/actions";
  if (/^\/v1\/work-orders\/[^/]+\/actions$/.test(pathname)) return "/v1/work-orders/:id/actions";
  if (/^\/v1\/work-orders\/[^/]+$/.test(pathname)) return "/v1/work-orders/:id";
  if (/^\/v1\/email-verifications\/[^/]+\/actions$/.test(pathname)) return "/v1/email-verifications/:id/actions";
  if (/^\/v1\/email-verifications\/[^/]+$/.test(pathname)) return "/v1/email-verifications/:id";
  if (/^\/v1\/email-identities\/[^/]+\/actions$/.test(pathname)) return "/v1/email-identities/:id/actions";
  if (/^\/v1\/mandates\/[^/]+\/actions$/.test(pathname)) return "/v1/mandates/:id/actions";
  if (/^\/v1\/matters\/[^/]+\/actions$/.test(pathname)) return "/v1/matters/:id/actions";
  if (/^\/v1\/prepared-artifacts\/[^/]+\/actions$/.test(pathname)) return "/v1/prepared-artifacts/:id/actions";
  if (/^\/v1\/inbox\/[^/]+\/actions$/.test(pathname)) return "/v1/inbox/:id/actions";
  if (/^\/v1\/mandates\/[^/]+$/.test(pathname)) return "/v1/mandates/:id";
  if (/^\/v1\/matters\/[^/]+$/.test(pathname)) return "/v1/matters/:id";
  if (/^\/v1\/prepared-artifacts\/[^/]+$/.test(pathname)) return "/v1/prepared-artifacts/:id";
  if (/^\/v1\/inbox\/[^/]+$/.test(pathname)) return "/v1/inbox/:id";
  if (/^\/v1\/why\/[^/]+$/.test(pathname)) return "/v1/why/:id";
  if (/^\/v1\/approvals\/[^/]+$/.test(pathname)) return "/v1/approvals/:id";
  if (/^\/v1\/agents\/[^/]+\/messages$/.test(pathname)) return "/v1/agents/:id/messages";
  if (/^\/v1\/agents\/[^/]+\/actions$/.test(pathname)) return "/v1/agents/:id/actions";
  if (/^\/v1\/agents\/[^/]+$/.test(pathname)) return "/v1/agents/:id";
  if (/^\/v1\/goals\/[^/]+\/actions$/.test(pathname)) return "/v1/goals/:id/actions";
  if (/^\/v1\/goals\/[^/]+$/.test(pathname)) return "/v1/goals/:id";
  if (/^\/v1\/promises\/[^/]+\/actions$/.test(pathname)) return "/v1/promises/:id/actions";
  if (/^\/v1\/refinements\/[^/]+\/actions$/.test(pathname)) return "/v1/refinements/:id/actions";
  if (/^\/v1\/insights\/[^/]+\/feedback$/.test(pathname)) return "/v1/insights/:id/feedback";
  if (/^\/v1\/insights\/[^/]+$/.test(pathname)) return "/v1/insights/:id";
  if (/^\/v1\/inquiries\/[^/]+$/.test(pathname)) return "/v1/inquiries/:id";
  if (/^\/v1\/research\/[^/]+$/.test(pathname)) return "/v1/research/:id";
  if (/^\/v1\/consequences\/[^/]+$/.test(pathname)) return "/v1/consequences/:id";
  if (/^\/v1\/scouts\/[^/]+\/actions$/.test(pathname)) return "/v1/scouts/:id/actions";
  if (/^\/v1\/scouts\/[^/]+\/wakes$/.test(pathname)) return "/v1/scouts/:id/wakes";
  if (/^\/v1\/scouts\/[^/]+$/.test(pathname)) return "/v1/scouts/:id";
  if (/^\/v1\/credentials\/[^/]+\/actions$/.test(pathname)) return "/v1/credentials/:id/actions";
  if (/^\/v1\/credentials\/[^/]+$/.test(pathname)) return "/v1/credentials/:id";
  if (/^\/v1\/sensors\/[^/]+\/actions$/.test(pathname)) return "/v1/sensors/:id/actions";
  if (/^\/v1\/sensors\/[^/]+$/.test(pathname)) return "/v1/sensors/:id";
  if (/^\/v1\/skill-proposals\/[^/]+$/.test(pathname)) return "/v1/skill-proposals/:id";
  if (/^\/webhooks\/[a-zA-Z0-9_-]+$/.test(pathname)) return "/webhooks/:connector";
  return new Set([
    "/health", "/health/live", "/health/ready", "/metrics", "/v1/runtime", "/v1/models", "/v1/chat", "/v1/chat/completions", "/v1/chat/status", "/v1/events",
    "/v1/events/stream", "/v1/attach", "/v1/approvals", "/v1/runs", "/v1/work-orders", "/v1/agents", "/v1/goals", "/v1/promises", "/v1/jobs", "/v1/schedules", "/v1/memories", "/v1/history", "/v1/insights", "/v1/inquiries", "/v1/product-metrics", "/v1/product-qualification", "/v1/personal-model", "/v1/source-affinity", "/v1/research", "/v1/consequences", "/v1/scouts", "/v1/credentials", "/v1/sensors", "/v1/tenant/audit", "/v1/tenant/export",
    "/v1/capabilities", "/v1/plugins", "/v1/connectors", "/v1/execution", "/v1/releases", "/v1/skill-proposals", "/v1/refinements", "/v1/overlays",
    "/v1/today", "/v1/inbox", "/v1/mandates", "/v1/matters", "/v1/prepared-artifacts", "/v1/email-verifications", "/v1/email-identities",
  ]).has(pathname) ? pathname : "unmatched";
}

function rateLimitIdentity(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

function requestId(request: IncomingMessage): string {
  const supplied = request.headers["x-request-id"];
  return typeof supplied === "string" && /^[a-zA-Z0-9._:-]{8,128}$/.test(supplied) ? supplied : id("req");
}

function ready(runtime: CoRuntime): { ok: boolean; schemaVersion?: number } {
  try {
    runtime.store.db.prepare("SELECT 1 AS ok").get();
    const schemaVersion = runtime.store.schemaVersion();
    return { ok: schemaVersion === CURRENT_SCHEMA_VERSION, schemaVersion };
  } catch {
    return { ok: false };
  }
}

function publicRun(run: RunRecord): Omit<RunRecord, "state"> {
  const { state: _state, ...record } = run;
  return record;
}

function sse(runtime: CoRuntime, request: IncomingMessage, response: ServerResponse, options: { afterSeq: number; stream?: string; correlationId?: string }, logger: RuntimeLogger, requestId_: string): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let cursor = Math.max(0, Math.floor(options.afterSeq));
  response.write(`retry: 1000\nevent: runtime.attached\ndata: ${JSON.stringify({ cursor, stream: options.stream ?? null, correlationId: options.correlationId ?? null })}\n\n`);
  const flush = () => {
    try {
      const events = runtime.store.listEvents(runtime.config.tenantId, {
        afterSeq: cursor, limit: 200, ...(options.stream ? { stream: options.stream } : {}),
        ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      });
      for (const event of events) {
        cursor = event.seq;
        response.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } catch (error) {
      logger.error("sse_flush_failed", { requestId: requestId_, error });
      response.end();
    }
  };
  flush();
  const timer = setInterval(flush, 1_000);
  const heartbeat = setInterval(() => response.write(": keepalive\n\n"), 15_000);
  timer.unref();
  heartbeat.unref();
  request.on("close", () => {
    clearInterval(timer);
    clearInterval(heartbeat);
  });
}

export interface RuntimeServerOptions {
  logger?: RuntimeLogger;
  metrics?: RuntimeMetrics;
}

export function createRuntimeServer(runtime: CoRuntime, options: RuntimeServerOptions = {}): Server {
  const logger = options.logger ?? new RuntimeLogger(runtime.config.environment);
  const metrics = options.metrics ?? new RuntimeMetrics();
  const rateLimiter = new FixedWindowRateLimiter();
  const server = createServer(async (request, response) => {
    const started = performance.now();
    const requestIdentity = requestId(request);
    const finishActive = metrics.beginRequest();
    secureHeaders(response, requestIdentity);
    let label = "unmatched";
    response.once("finish", () => {
      finishActive();
      metrics.observeRequest(request.method ?? "UNKNOWN", label, response.statusCode, performance.now() - started);
      logger.info("http_request", {
        requestId: requestIdentity, method: request.method ?? "UNKNOWN", route: label, status: response.statusCode,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
      });
    });
    response.once("close", finishActive);
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      label = routeLabel(url.pathname);
      if (runtime.config.mode === "shadow" && request.method !== "GET"
        && !(request.method === "POST" && (url.pathname === "/v1/chat" || url.pathname === "/v1/chat/completions"))) {
        throw new HttpError(403, "Shadow mode accepts composition only; mutations and transport webhooks are disabled");
      }
      if (request.method === "GET" && (url.pathname === "/health" || url.pathname === "/health/live")) {
        reply(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && url.pathname === "/health/ready") {
        const state = ready(runtime);
        reply(response, state.ok ? 200 : 503, { ok: state.ok });
        return;
      }

      const rate = rateLimiter.check(rateLimitIdentity(request), runtime.config.http.rateLimitMaxRequests, runtime.config.http.rateLimitWindowMs);
      response.setHeader("ratelimit-remaining", String(rate.remaining));
      if (!rate.allowed) {
        response.setHeader("retry-after", String(rate.retryAfterSeconds));
        throw new HttpError(429, "Too many requests");
      }

      if (request.method === "GET" && url.pathname === "/metrics") {
        if (!authorized(runtime, request)) throw new HttpError(401, "Unauthorized");
        textReply(response, 200, metrics.render(runtime), "text/plain; version=0.0.4; charset=utf-8");
        return;
      }

      const webhookMatch = url.pathname.match(/^\/webhooks\/([a-zA-Z0-9_-]+)$/);
      if (request.method === "POST" && webhookMatch?.[1]) {
        const connector = runtime.connectors.webhook(webhookMatch[1]);
        if (!connector) throw new HttpError(404, "Connector not found");
        const body = await readJsonBody(request, runtime.config.http.bodyLimitBytes);
        if (!connector.verifyWebhook(request.headers, body.raw)) throw new HttpError(401, "Invalid connector webhook authentication");
        const payload = body.value;
        const ingress = connector.parseWebhook(payload, runtime.config.tenantId);
        if (!ingress) {
          reply(response, 202, { accepted: true, ignored: true });
          return;
        }
        if (ingress.principalClass === "member" && connector.inboundPrincipal !== "member") {
          throw new HttpError(400, "Connector principal classification mismatch");
        }
        if (ingress.principalClass === "trusted-system" && connector.inboundPrincipal !== "trusted-system") {
          throw new HttpError(400, "Connector principal classification mismatch");
        }
        if (ingress.principalClass === "member" && (!ingress.memberRelationship
          || !runtime.isMemberRelationship(ingress.memberRelationship.channel, ingress.memberRelationship.peerId))) {
          // Rejected human content and identifiers are not evidence. Keep only
          // a bounded cryptographic deduplication token and a content-free
          // incident; neither the sender nor their chosen receipt ID survives.
          const rejectedReceipt = stableId("rejected", `${runtime.config.tenantId}:${connector.id}:${ingress.receiptKey}`);
          const rejectionId = stableId("evt", `untrusted-connector-ingress:${runtime.config.tenantId}:${connector.id}:${rejectedReceipt}`);
          const accepted = runtime.store.transaction(() => {
            if (!runtime.store.claimIngress({
              tenantId: runtime.config.tenantId, scope: `webhook-rejected:${connector.id}`, externalId: rejectedReceipt, eventId: rejectionId,
            })) return false;
            runtime.store.appendEvent({
              id: rejectionId, tenantId: runtime.config.tenantId, stream: `security:connector:${connector.id}`,
              type: "security.untrusted_connector_ingress_rejected",
              payload: { connectorId: connector.id, principalClass: "member", reason: "relationship is not an onboarded direct member" },
            });
            // A provider-authenticated thread becoming a group revokes any
            // previously learned direct route even though its human content is
            // rejected. Rebind the update to the content-free rejection event.
            for (const route of ingress.routeUpdates ?? []) {
              if (route.status !== "blocked") continue;
              runtime.store.noteConnectorRoute({
                tenantId: runtime.config.tenantId, connectorId: connector.id,
                externalThreadId: route.externalThreadId, status: "blocked", sourceEventId: rejectionId,
              });
            }
            return true;
          });
          reply(response, 202, { accepted: true, ignored: true, duplicate: !accepted });
          return;
        }
        const inboundReleaseId = ingress.message
          ? runtime.releases.assign(runtime.config.tenantId).release.id
          : undefined;
        const inbound = ingress.message;
        const decision = inbound?.text.trim().match(/^(approve|deny)\s+(apr_[a-zA-Z0-9_-]+)$/i);
        const accepted = runtime.store.transaction(() => {
          if (!runtime.store.claimIngress({
            tenantId: runtime.config.tenantId, scope: `webhook:${connector.id}`, externalId: ingress.receiptKey, eventId: ingress.primaryEvent.id,
          })) return false;
          runtime.store.appendEvent({ tenantId: runtime.config.tenantId, ...ingress.primaryEvent });
          if (ingress.principalClass !== "connector-status") {
            runtime.goals.enqueueForEvent(runtime.config.tenantId, ingress.primaryEvent.type);
          }
          for (const evidence of ingress.evidenceEvents) {
            runtime.store.appendEvent({ tenantId: runtime.config.tenantId, ...evidence });
            runtime.reconcileConnectorDeliveryStatus(evidence);
            if (ingress.principalClass !== "connector-status") runtime.goals.enqueueForEvent(runtime.config.tenantId, evidence.type);
          }
          for (const route of ingress.routeUpdates ?? []) runtime.store.noteConnectorRoute({ tenantId: runtime.config.tenantId, connectorId: connector.id, ...route });
          if (inbound) {
            if (ingress.principalClass !== "member" || !ingress.memberRelationship) {
              throw new Error("A connector message must carry an authorized member principal");
            }
            const relationshipChannel = inbound.relationship?.channel ?? inbound.channel;
            const relationshipPeerId = inbound.relationship?.peerId ?? inbound.peerId;
            const attachments = inbound.attachments ?? [];
            const jobType = decision?.[1] && decision[2] ? "approval.decide" : "channel.turn";
            const authorizationId = stableId("evt", `connector-member-authorization:${runtime.config.tenantId}:${connector.id}:${ingress.primaryEvent.id}:${jobType}`);
            runtime.store.appendEvent({
              id: authorizationId, tenantId: runtime.config.tenantId, stream: `security:connector:${connector.id}`,
              type: "connector.member_ingress_authorized", causationId: ingress.primaryEvent.id,
              payload: {
                connectorId: connector.id, jobType, channel: inbound.channel, peerId: inbound.peerId,
                relationshipChannel, relationshipPeerId, externalId: inbound.externalId ?? null,
                textDigest: jobType === "channel.turn" ? stableId("content", inbound.text) : null,
                attachmentDigest: jobType === "channel.turn" ? attachmentDigest(attachments) : null,
                approvalId: decision?.[2] ?? null,
                decision: decision?.[1] ? decision[1].toLowerCase() === "approve" ? "approved" : "denied" : null,
              },
            });
            if (decision?.[1] && decision[2]) {
              runtime.store.enqueueJob(inbound.tenantId, "approval.decide", {
                approvalId: decision[2], decision: decision[1].toLowerCase() === "approve" ? "approved" : "denied",
                channel: inbound.channel, peerId: inbound.peerId, externalId: inbound.externalId ?? "",
                relationshipChannel, relationshipPeerId, connectorIngressEventId: authorizationId,
              }, inboundReleaseId ? { releaseId: inboundReleaseId } : {});
            } else {
              runtime.store.enqueueJob(inbound.tenantId, "channel.turn", {
                channel: inbound.channel, peerId: inbound.peerId, text: inbound.text, externalId: inbound.externalId ?? "",
                relationshipChannel, relationshipPeerId, connectorIngressEventId: authorizationId,
                attachments: attachmentJson(attachments),
              }, inboundReleaseId ? { releaseId: inboundReleaseId } : {});
            }
          }
          return true;
        });
        reply(response, 202, { accepted: true, duplicate: !accepted, type: ingress.primaryEvent.type });
        return;
      }

      if (url.pathname.startsWith("/v1/") && !authorized(runtime, request)) throw new HttpError(401, "Unauthorized");

      if (request.method === "GET" && url.pathname === "/v1/runtime") {
        reply(response, 200, {
          tenantId: runtime.config.tenantId, profileId: runtime.config.profileId ?? null,
          distribution: runtime.distribution.id, schemaVersion: runtime.store.schemaVersion(),
          mode: runtime.config.mode ?? "live",
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        const route = runtime.config.models.foreground;
        reply(response, 200, { object: "list", data: [{ id: route.model, object: "model", owned_by: route.provider }] });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/tenant/audit") {
        reply(response, 200, runtime.tenantLifecycle.audit(runtime.config.tenantId) as unknown as JsonValue);
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/tenant/export") {
        const bundle = runtime.tenantLifecycle.createExport(runtime.config.tenantId);
        runtime.tenantLifecycle.recordExport(bundle);
        reply(response, 200, bundle as unknown as JsonValue);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/email-verifications") {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const headerKey = request.headers["idempotency-key"];
        const idempotencyKey = boundedString(body.idempotencyKey ?? (typeof headerKey === "string" ? headerKey : undefined), "idempotencyKey", 256) ?? `api:${requestIdentity}`;
        try {
          const challenge = await runtime.email.request({
            tenantId: runtime.config.tenantId,
            email: boundedString(body.email, "email", 254, true) as string,
            purpose: boundedString(body.purpose, "purpose", 128) ?? "contact",
            idempotencyKey,
          });
          reply(response, 202, runtime.email.challengeJson(challenge));
        } catch (error) {
          if (!(error instanceof EmailVerificationError)) throw error;
          const challenge = error.challengeId ? runtime.email.getChallenge(runtime.config.tenantId, error.challengeId) : undefined;
          reply(response, error.httpStatus, { error: error.message, ...(challenge ? { challenge: runtime.email.challengeJson(challenge) } : {}) });
        }
        return;
      }

      const emailVerificationAction = url.pathname.match(/^\/v1\/email-verifications\/([^/]+)\/actions$/)?.[1];
      if (request.method === "POST" && emailVerificationAction) {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        if (body.action !== "verify") throw new HttpError(400, "action must be verify");
        try {
          const identity = runtime.email.verify(
            runtime.config.tenantId, emailVerificationAction,
            boundedString(body.code, "code", 6, true) as string,
          );
          reply(response, 200, runtime.email.identityJson(identity));
        } catch (error) {
          if (!(error instanceof EmailVerificationError)) throw error;
          reply(response, error.httpStatus, { error: error.message });
        }
        return;
      }

      const emailIdentityAction = url.pathname.match(/^\/v1\/email-identities\/([^/]+)\/actions$/)?.[1];
      if (request.method === "POST" && emailIdentityAction) {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        if (body.action !== "revoke") throw new HttpError(400, "action must be revoke");
        try {
          reply(response, 200, runtime.email.identityJson(runtime.email.revokeIdentity(runtime.config.tenantId, emailIdentityAction)));
        } catch (error) {
          if (!(error instanceof EmailVerificationError)) throw error;
          reply(response, error.httpStatus, { error: error.message });
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/chat") {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const message = boundedString(body.message, "message", runtime.config.http.bodyLimitBytes, true) as string;
        if (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.length > 10)) throw new HttpError(400, "attachments must be an array of at most ten references");
        const attachments = normalizeInboundAttachments(body.attachments);
        const channel = boundedString(body.channel, "channel", 64) ?? "api";
        const peerId = boundedString(body.peerId, "peerId", 512) ?? "default";
        const externalId = boundedString(body.externalId, "externalId", 512);
        const result = await runtime.turn({
          tenantId: runtime.config.tenantId, channel, peerId, text: message,
          ...(attachments.length ? { attachments } : {}),
          ...(externalId ? { externalId } : {}),
        });
        if (result.status === "failed" && runtime.config.environment === "production") {
          logger.error("run_failed", { requestId: requestIdentity, runId: result.runId });
          reply(response, 500, { error: "Run failed", requestId: requestIdentity, runId: result.runId });
        }
        else reply(response, result.status === "failed" ? 500 : 200, result as unknown as JsonValue);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        let turn;
        try { turn = parseEngineCompatTurn(await readBody(request, runtime.config.http.bodyLimitBytes), runtime.config.tenantId); }
        catch (error) { throw new HttpError(422, error instanceof Error ? error.message : "Invalid engine request"); }
        const canonicalSession = runtime.store.ensureSession(
          runtime.config.tenantId, "imessage", turn.peerId,
          { channel: "engine-compat", peerId: turn.peerId },
        );
        const canonicalHistory = runtime.store.listMessages(runtime.config.tenantId, canonicalSession.id, 36)
          .flatMap((message) => {
            if (message.role !== "user" && message.role !== "assistant") return [];
            const content = message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("").trim();
            return content ? [{ role: message.role, content }] : [];
          });
        const result = await runtime.turn({
          tenantId: runtime.config.tenantId, channel: "engine-compat", peerId: turn.peerId,
          relationship: { channel: "imessage", peerId: turn.peerId }, text: turn.message,
          ...(turn.externalId ? { externalId: turn.externalId } : {}),
          metadata: { source: "authenticated-local-incumbent-router" },
        }, { conversationContext: engineCompatContext(turn, canonicalHistory) });
        if (result.status === "failed") throw new HttpError(500, "Runtime turn failed");
        // THE SHAPE GATE (9/6). iMessage only — the CLI and other channels are not bubbles. The
        // incumbent brain enforced beats and bubble length with a revision pass; the runtime shipped
        // without one and 8 of 42 bubbles ran past the cap on the first afternoon. This never
        // truncates: it applies the one repair that is safe by construction and records the rest as
        // an event, so a composer revision and evals/register.py both have something to read.
        const priorAssistant = canonicalHistory.filter((entry) => entry.role === "assistant").at(-1)?.content ?? "";
        const shaped = applyShape(result.text ?? "", { last: turn.message, previousReply: priorAssistant });
        if (shaped.repaired || shaped.violations.length > 0) {
          runtime.store.appendEvent({
            tenantId: runtime.config.tenantId, stream: `shape:${result.runId}`,
            type: "reply.shape_checked", causationId: result.runId,
            payload: { runId: result.runId, repaired: shaped.repaired, violations: shaped.violations.slice(0, 4) },
          });
        }
        const completion = {
          id: compatCompletionId(result.runId), object: "chat.completion", created: Math.floor(Date.now() / 1_000),
          model: runtime.config.models.foreground.model,
          choices: [{ index: 0, message: { role: "assistant", content: shaped.text }, finish_reason: "stop" }],
        };
        if (!turn.stream) reply(response, 200, completion);
        else {
          response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
          response.write(`data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", created: completion.created,
            model: completion.model, choices: [{ index: 0, delta: { role: "assistant", content: shaped.text }, finish_reason: null }] })}\n\n`);
          response.write(`data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", created: completion.created,
            model: completion.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
          response.end("data: [DONE]\n\n");
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/chat/status") {
        const externalId = boundedString(url.searchParams.get("externalId"), "externalId", 512, true) as string;
        const channel = boundedString(url.searchParams.get("channel"), "channel", 64) ?? "cli";
        const peerId = boundedString(url.searchParams.get("peerId"), "peerId", 512) ?? "local";
        const receipt = runtime.store.getIngress(runtime.config.tenantId, `turn:${channel}:${peerId}`, externalId);
        if (!receipt) {
          reply(response, 200, { accepted: false, externalId });
          return;
        }
        const run = receipt.runId ? runtime.store.getRun(receipt.runId, runtime.config.tenantId) : undefined;
        const events = run ? runtime.store.listEvents(runtime.config.tenantId, {
          stream: `run:${run.id}`, afterSeq: Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0), limit: 200,
        }) : [];
        reply(response, 200, { accepted: true, externalId, receipt, run: run ? publicRun(run) : null, events, cursor: events.at(-1)?.seq ?? Number(url.searchParams.get("after") ?? 0) } as unknown as JsonValue);
        return;
      }

      const runActionsMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/actions$/);
      if (request.method === "POST" && runActionsMatch?.[1]) {
        const run = runtime.store.getRun(runActionsMatch[1], runtime.config.tenantId);
        if (!run) throw new HttpError(404, "Run not found");
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        if (body.action === "cancel") {
          reply(response, 200, publicRun(runtime.cancelRun(run.id, boundedString(body.reason, "reason", 512) ?? "operator_api_cancelled")) as unknown as JsonValue);
          return;
        }
        if (body.action === "recover") {
          if (run.status !== "running" || !run.state) throw new HttpError(409, `Run is ${run.status}; it cannot be recovered`);
          reply(response, 200, await runtime.recoverRun(run.id) as unknown as JsonValue);
          return;
        }
        throw new HttpError(400, "action must be cancel or recover");
      }

      const receiptActionsMatch = url.pathname.match(/^\/v1\/receipts\/([^/]+)\/actions$/);
      if (request.method === "POST" && receiptActionsMatch?.[1]) {
        const body = object(await readBody(request, Math.min(runtime.config.http.bodyLimitBytes, 32_768)));
        if (body.action !== "reconcile") throw new HttpError(400, "Receipt action must be reconcile");
        const decision = body.decision === "confirmed" || body.decision === "failed" ? body.decision : undefined;
        if (!decision) throw new HttpError(400, "Receipt reconciliation decision must be confirmed or failed");
        const reason = boundedString(body.reason, "reason", 4_000, true) as string;
        const evidence = body.evidence !== null && typeof body.evidence === "object" && !Array.isArray(body.evidence)
          ? body.evidence as JsonObject : undefined;
        try {
          reply(response, 200, runtime.reconcileToolReceipt({
            receiptId: decodeURIComponent(receiptActionsMatch[1]), decision, reason,
            ...(evidence ? { evidence } : {}), ...(body.output !== undefined ? { output: body.output as JsonValue } : {}),
          }) as unknown as JsonValue);
        } catch (error) {
          if (error instanceof Error && /not found/i.test(error.message)) throw new HttpError(404, error.message);
          if (error instanceof Error && /only uncertain|already reconciled|changed while/i.test(error.message)) throw new HttpError(409, error.message);
          throw error;
        }
        return;
      }

      const deliveryActionsMatch = url.pathname.match(/^\/v1\/deliveries\/([^/]+)\/actions$/);
      if (request.method === "POST" && deliveryActionsMatch?.[1]) {
        const body = object(await readBody(request, Math.min(runtime.config.http.bodyLimitBytes, 32_768)));
        if (body.action !== "reconcile") throw new HttpError(400, "Delivery action must be reconcile");
        const decision = body.decision === "accepted" || body.decision === "failed" ? body.decision : undefined;
        if (!decision) throw new HttpError(400, "Delivery reconciliation decision must be accepted or failed");
        const reason = boundedString(body.reason, "reason", 4_000, true) as string;
        const providerMessageId = boundedString(body.providerMessageId, "providerMessageId", 1_000);
        if (decision === "accepted" && !providerMessageId) throw new HttpError(400, "Accepted delivery reconciliation requires providerMessageId");
        const evidence = body.evidence !== null && typeof body.evidence === "object" && !Array.isArray(body.evidence)
          ? body.evidence as JsonObject : undefined;
        try {
          reply(response, 200, runtime.reconcileOutboundDelivery({
            intentId: decodeURIComponent(deliveryActionsMatch[1]), decision, reason,
            ...(providerMessageId ? { providerMessageId } : {}), ...(evidence ? { evidence } : {}),
          }) as unknown as JsonValue);
        } catch (error) {
          if (error instanceof Error && /not found/i.test(error.message)) throw new HttpError(404, error.message);
          if (error instanceof Error && /only uncertain|already reconciled|changed while|different provider/i.test(error.message)) {
            throw new HttpError(409, error.message);
          }
          throw error;
        }
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/responsibilities") {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const responsibilityId = runtime.responsibilities.create({ tenantId: runtime.config.tenantId,
          sourceEventId: boundedString(body.sourceEventId, "sourceEventId", 256, true) as string,
          ownerSessionId: boundedString(body.ownerSessionId, "ownerSessionId", 256, true) as string,
          objective: boundedString(body.objective, "objective", 20_000, true) as string,
          deadlineAt: boundedString(body.deadlineAt, "deadlineAt", 64, true) as string,
          idempotencyKey: boundedString(body.idempotencyKey, "idempotencyKey", 256, true) as string,
          tokenLimit: Number(body.tokenLimit), modelCallLimit: Number(body.modelCallLimit), toolCallLimit: Number(body.toolCallLimit),
        });
        reply(response, 201, runtime.responsibilities.view(runtime.config.tenantId, responsibilityId) ?? null);
        return;
      }
      const responsibilityMatch = url.pathname.match(/^\/v1\/responsibilities\/([^/]+)(\/actions)?$/);
      if (responsibilityMatch?.[1] && (request.method === "GET" || request.method === "POST")) {
        const responsibilityId = responsibilityMatch[1];
        if (!runtime.responsibilities.view(runtime.config.tenantId, responsibilityId)) throw new HttpError(404, "Responsibility not found");
        if (request.method === "POST") {
          const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
          if (!responsibilityMatch[2] || body.action !== "cancel") throw new HttpError(400, "Only responsibility cancellation is supported");
          runtime.responsibilities.cancel(runtime.config.tenantId, responsibilityId);
        }
        reply(response, 200, runtime.responsibilities.view(runtime.config.tenantId, responsibilityId) ?? null);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/work-orders") {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const evidencePolicy = body.evidencePolicy === "run" || body.evidencePolicy === "external-write" ? body.evidencePolicy : "tool";
        const modelRole = body.modelRole === "foreground" || body.modelRole === "background" || body.modelRole === "critic" ? body.modelRole : "deliberation";
        const allowedTools = Array.isArray(body.allowedTools) ? body.allowedTools.filter((item): item is string => typeof item === "string").slice(0, 256) : undefined;
        const requiredToolNames = Array.isArray(body.requiredToolNames) ? body.requiredToolNames.filter((item): item is string => typeof item === "string").slice(0, 13) : undefined;
        const headerKey = request.headers["idempotency-key"];
        const idempotencyKey = boundedString(body.idempotencyKey ?? (typeof headerKey === "string" ? headerKey : undefined), "idempotencyKey", 512);
        const admission = await runtime.submitWorkOrder({
          ...(body.responsibilityId !== undefined ? { responsibilityId: boundedString(body.responsibilityId, "responsibilityId", 256, true) as string } : {}),
          objective: boundedString(body.objective, "objective", 20_000, true) as string,
          ...(typeof body.successContract === "string" ? { successContract: boundedString(body.successContract, "successContract", 10_000, true) as string } : {}),
          evidencePolicy, modelRole, ...(typeof body.tokenBudget === "number" ? { tokenBudget: body.tokenBudget } : {}),
          ...(typeof body.minimumReceipts === "number" ? { minimumReceipts: body.minimumReceipts } : {}),
          ...(requiredToolNames?.length ? { requiredToolNames } : {}),
          ...(allowedTools ? { allowedTools } : {}), sourceChannel: "api",
          sourcePeerId: boundedString(body.peerId, "peerId", 512) ?? "default",
          ...(idempotencyKey ? { idempotencyKey } : {}),
        });
        reply(response, 202, { accepted: true, duplicate: admission.duplicate, jobId: admission.jobId, workOrder: runtime.workOrders.asJson(admission.workOrder) });
        return;
      }

      const workOrderActionsMatch = url.pathname.match(/^\/v1\/work-orders\/([^/]+)\/actions$/);
      if (request.method === "POST" && workOrderActionsMatch?.[1]) {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const workOrder = runtime.workOrders.get(runtime.config.tenantId, workOrderActionsMatch[1]);
        if (!workOrder) throw new HttpError(404, "Work order not found");
        if (body.action !== "cancel") throw new HttpError(400, "action must be cancel");
        reply(response, 200, runtime.workOrders.asJson(runtime.cancelWorkOrder(workOrder.id)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/mandates") {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const authority = body.authority !== null && typeof body.authority === "object" && !Array.isArray(body.authority) ? body.authority as JsonObject : {};
        const delivery = body.delivery !== null && typeof body.delivery === "object" && !Array.isArray(body.delivery) ? body.delivery as JsonObject : {};
        reply(response, 201, runtime.office.proposeMandate({
          tenantId: runtime.config.tenantId, name: boundedString(body.name, "name", 256, true) as string,
          serviceContract: boundedString(body.serviceContract, "serviceContract", 5_000, true) as string, authority, delivery,
        }) as unknown as JsonValue);
        return;
      }

      const mandateActionsMatch = url.pathname.match(/^\/v1\/mandates\/([^/]+)\/actions$/);
      if (request.method === "POST" && mandateActionsMatch?.[1]) {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const action = body.action;
        if (action !== "approve" && action !== "pause" && action !== "resume" && action !== "retire") throw new HttpError(400, "action must be approve, pause, resume, or retire");
        const mandate = runtime.office.getMandate(runtime.config.tenantId, mandateActionsMatch[1]);
        if (!mandate) throw new HttpError(404, "Mandate not found");
        if ((action === "approve" && mandate.status !== "proposed") || (action === "resume" && mandate.status !== "paused") || (action === "pause" && mandate.status !== "active")) {
          throw new HttpError(409, `Mandate cannot ${action} from ${mandate.status}`);
        }
        const target = action === "pause" ? "paused" : action === "retire" ? "retired" : "active";
        reply(response, 200, runtime.office.transitionMandate(runtime.config.tenantId, mandateActionsMatch[1], target) as unknown as JsonValue);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/matters") {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const status = body.status === "active" || body.status === "watching" || body.status === "waiting" ? body.status : undefined;
        reply(response, 201, runtime.office.createMatter({
          tenantId: runtime.config.tenantId, title: boundedString(body.title, "title", 512, true) as string,
          summary: boundedString(body.summary, "summary", 10_000, true) as string,
          ...(status ? { status } : {}), ...(typeof body.priority === "number" ? { priority: body.priority } : {}),
          ...(typeof body.mandateId === "string" ? { mandateId: boundedString(body.mandateId, "mandateId", 128, true) as string } : {}),
          ...(typeof body.sourceEventId === "string" ? { sourceEventId: boundedString(body.sourceEventId, "sourceEventId", 128, true) as string } : {}),
        }) as unknown as JsonValue);
        return;
      }

      const matterActionsMatch = url.pathname.match(/^\/v1\/matters\/([^/]+)\/actions$/);
      if (request.method === "POST" && matterActionsMatch?.[1]) {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const status = body.status === "active" || body.status === "watching" || body.status === "waiting" || body.status === "completed" || body.status === "archived" ? body.status : undefined;
        reply(response, 200, runtime.office.updateMatter(runtime.config.tenantId, matterActionsMatch[1], {
          ...(status ? { status } : {}), ...(typeof body.summary === "string" ? { summary: boundedString(body.summary, "summary", 10_000, true) as string } : {}),
          ...(typeof body.priority === "number" ? { priority: body.priority } : {}),
          ...(typeof body.evidenceEventId === "string" ? { evidenceEventId: boundedString(body.evidenceEventId, "evidenceEventId", 128, true) as string } : {}),
        }) as unknown as JsonValue);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/prepared-artifacts") {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        reply(response, 201, runtime.office.prepareArtifact({
          tenantId: runtime.config.tenantId, kind: boundedString(body.kind, "kind", 64, true) as string,
          title: boundedString(body.title, "title", 512, true) as string, content: boundedString(body.content, "content", 100_000, true) as string,
          sourceEventIds: Array.isArray(body.sourceEventIds) ? body.sourceEventIds.filter((item): item is string => typeof item === "string").slice(0, 64) : [],
          ...(typeof body.matterId === "string" ? { matterId: boundedString(body.matterId, "matterId", 128, true) as string } : {}),
          ...(typeof body.mandateId === "string" ? { mandateId: boundedString(body.mandateId, "mandateId", 128, true) as string } : {}),
        }) as unknown as JsonValue);
        return;
      }

      const artifactActionsMatch = url.pathname.match(/^\/v1\/prepared-artifacts\/([^/]+)\/actions$/);
      if (request.method === "POST" && artifactActionsMatch?.[1]) {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const status = body.action === "review" ? "reviewed" : body.action === "use" ? "used" : body.action === "retire" ? "retired" : undefined;
        if (!status) throw new HttpError(400, "action must be review, use, or retire");
        reply(response, 200, runtime.office.markArtifact(runtime.config.tenantId, artifactActionsMatch[1], status) as unknown as JsonValue);
        return;
      }

      const inboxActionsMatch = url.pathname.match(/^\/v1\/inbox\/([^/]+)\/actions$/);
      if (request.method === "POST" && inboxActionsMatch?.[1]) {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const status = body.action === "dismiss" ? "dismissed" : body.action === "act" ? "acted" : body.action === "deliver" ? "delivered" : undefined;
        if (!status) throw new HttpError(400, "action must be dismiss, act, or deliver");
        reply(response, 200, runtime.office.resolveAttention(runtime.config.tenantId, inboxActionsMatch[1], status) as unknown as JsonValue);
        return;
      }

      const promiseActionsMatch = url.pathname.match(/^\/v1\/promises\/([^/]+)\/actions$/);
      if (request.method === "POST" && promiseActionsMatch?.[1]) {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const status = body.action === "complete" ? "completed" : body.action === "release" ? "released" : undefined;
        if (!status) throw new HttpError(400, "action must be complete or release");
        const resolution = boundedString(body.resolution, "resolution", 4_000, true) as string;
        reply(response, 200, runtime.office.resolvePromise(runtime.config.tenantId, promiseActionsMatch[1], status, resolution) as unknown as JsonValue);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/events") {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const type = boundedString(body.type, "type", 128, true) as string;
        if (!/^[a-zA-Z0-9_.:-]+$/.test(type)) throw new HttpError(400, "type contains invalid characters");
        const tenantId = runtime.config.tenantId;
        const externalId = boundedString(body.externalId, "externalId", 512);
        const stream = boundedString(body.stream, "stream", 256) ?? "ambient";
        const channel = boundedString(body.channel, "channel", 64);
        const peerId = boundedString(body.peerId, "peerId", 512);
        const releaseId = runtime.releases.assign(tenantId).release.id;
        const eventId = externalId ? stableId("evt", `${tenantId}:ambient:${externalId}`) : undefined;
        const result = runtime.store.transaction(() => {
          if (externalId && !runtime.store.claimIngress({ tenantId, scope: "ambient", externalId, eventId: eventId as string })) return { event: runtime.store.getEvent(tenantId, eventId as string), duplicate: true };
          const event = runtime.store.appendEvent({
            tenantId, stream, type, payload: (body.payload !== undefined ? body.payload : {}) as JsonValue,
            ...(eventId ? { id: eventId } : {}),
          });
          runtime.goals.enqueueForEvent(tenantId, type);
          runtime.store.enqueueJob(tenantId, "ambient.evaluate", {
            eventId: event.id, ...(channel ? { channel } : {}), ...(peerId ? { peerId } : {}),
          }, { releaseId });
          return { event, duplicate: false };
        });
        if (!result.event) throw new Error("Ambient ingress receipt exists without its event");
        reply(response, 202, { ...result.event, duplicate: result.duplicate } as unknown as JsonValue);
        return;
      }

      const approvalMatch = url.pathname.match(/^\/v1\/approvals\/([^/]+)$/);
      if (request.method === "POST" && approvalMatch?.[1]) {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const decision = body.decision === "approved" ? "approved" : body.decision === "denied" ? "denied" : undefined;
        if (!decision) throw new HttpError(400, "decision must be approved or denied");
        const approval = runtime.store.getApproval(approvalMatch[1]);
        if (!approval || approval.tenantId !== runtime.config.tenantId) throw new HttpError(404, "Approval not found");
        const result = await runtime.resumeApproval(approvalMatch[1], decision);
        if (result.status === "failed" && runtime.config.environment === "production") {
          logger.error("run_resume_failed", { requestId: requestIdentity, runId: result.runId });
          reply(response, 500, { error: "Run failed", requestId: requestIdentity, runId: result.runId });
        }
        else reply(response, result.status === "failed" ? 500 : 200, result as unknown as JsonValue);
        return;
      }

      const skillProposalMatch = url.pathname.match(/^\/v1\/skill-proposals\/([^/]+)$/);
      if (request.method === "POST" && skillProposalMatch?.[1]) {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const action = body.action;
        const proposalId = skillProposalMatch[1];
        const proposal = runtime.store.getSkillProposal(proposalId, runtime.config.tenantId);
        if (!proposal) throw new HttpError(404, "Skill proposal not found");
        const allowed = action === "approve" ? proposal.status === "proposed"
          : action === "reject" ? proposal.status === "proposed" || proposal.status === "approved"
            : action === "install" ? proposal.status === "approved" || proposal.status === "installed"
              : action === "retire" ? proposal.status === "installed" || proposal.status === "retired"
                : false;
        if (!allowed && (action === "approve" || action === "reject" || action === "install" || action === "retire")) {
          throw new HttpError(409, `Skill proposal cannot ${action} from ${proposal.status}`);
        }
        const result = action === "approve" ? runtime.skillLearning.approve(runtime.config.tenantId, proposalId)
          : action === "reject" ? runtime.skillLearning.reject(runtime.config.tenantId, proposalId)
            : action === "install" ? runtime.skillLearning.install(runtime.config.tenantId, proposalId)
              : action === "retire" ? runtime.skillLearning.retire(runtime.config.tenantId, proposalId)
                : undefined;
        if (!result) throw new HttpError(400, "action must be approve, reject, install, or retire");
        reply(response, 200, result as unknown as JsonValue);
        return;
      }

      const agentMessagesMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/messages$/);
      if (request.method === "POST" && agentMessagesMatch?.[1]) {
        const agent = runtime.agents.get(runtime.config.tenantId, agentMessagesMatch[1]);
        if (!agent) throw new HttpError(404, "Agent not found");
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const content = boundedString(body.content, "content", 50_000, true) as string;
        const kind = body.kind === "message" ? "message" : body.kind === undefined || body.kind === "follow_up" ? "follow_up" : undefined;
        if (!kind) throw new HttpError(400, "kind must be message or follow_up");
        const externalId = boundedString(body.externalId, "externalId", 512);
        const queued = runtime.agents.sendFromOwner({
          tenantId: runtime.config.tenantId, targetAgentId: agent.id, content, kind,
          ...(externalId ? { idempotencyKey: `api-agent:${agent.id}:${externalId}` } : {}),
        });
        reply(response, 202, { accepted: true, agent: runtime.agents.asJson(agent), message: runtime.agents.messageJson(queued.message), jobId: queued.jobId } as unknown as JsonValue);
        return;
      }

      const agentActionsMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/actions$/);
      if (request.method === "POST" && agentActionsMatch?.[1]) {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const action = body.action;
        const agent = runtime.agents.get(runtime.config.tenantId, agentActionsMatch[1]);
        if (!agent) throw new HttpError(404, "Agent not found");
        const result = action === "cancel" ? runtime.agents.cancel(runtime.config.tenantId, agent.id)
          : action === "retire" ? runtime.agents.retire(runtime.config.tenantId, agent.id)
            : undefined;
        if (!result) throw new HttpError(400, "action must be cancel or retire");
        reply(response, 200, runtime.agents.asJson(result) as unknown as JsonValue);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/goals") {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const gateType = body.gateType === "manual" || body.gateType === "event" || body.gateType === "artifact" || body.gateType === "run" ? body.gateType : undefined;
        if (!gateType) throw new HttpError(400, "gateType must be manual, event, artifact, or run");
        const gateConfig = body.gateConfig !== null && typeof body.gateConfig === "object" && !Array.isArray(body.gateConfig) ? body.gateConfig as JsonObject : {};
        const goal = runtime.goals.create({
          tenantId: runtime.config.tenantId,
          objective: boundedString(body.objective, "objective", 20_000, true) as string,
          successContract: boundedString(body.successContract, "successContract", 10_000, true) as string,
          gateType, gateConfig,
          ...(typeof body.agentId === "string" ? { agentId: boundedString(body.agentId, "agentId", 128, true) as string } : {}),
          ...(typeof body.maxContinuations === "number" ? { maxContinuations: body.maxContinuations } : {}),
          ...(typeof body.maxTokens === "number" ? { maxTokens: body.maxTokens } : {}),
          ...(typeof body.deadlineAt === "string" ? { deadlineAt: boundedString(body.deadlineAt, "deadlineAt", 128, true) as string } : {}),
        });
        reply(response, 201, runtime.goals.asJson(goal) as unknown as JsonValue);
        return;
      }

      const goalActionsMatch = url.pathname.match(/^\/v1\/goals\/([^/]+)\/actions$/);
      if (request.method === "POST" && goalActionsMatch?.[1]) {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const goal = runtime.goals.get(runtime.config.tenantId, goalActionsMatch[1]);
        if (!goal) throw new HttpError(404, "Goal not found");
        const action = body.action;
        if (action === "check") {
          const jobId = runtime.goals.enqueueCheck(runtime.config.tenantId, goal.id, "operator API");
          reply(response, 202, { accepted: true, goalId: goal.id, jobId });
          return;
        }
        const result = action === "pause" ? runtime.goals.pause(runtime.config.tenantId, goal.id)
          : action === "resume" ? runtime.goals.resume(runtime.config.tenantId, goal.id)
            : action === "cancel" ? runtime.goals.cancel(runtime.config.tenantId, goal.id)
              : action === "confirm" ? runtime.goals.confirm(runtime.config.tenantId, goal.id, boundedString(body.evidence, "evidence", 2_000) ?? "operator API confirmed completion")
                : undefined;
        if (!result) throw new HttpError(400, "action must be check, pause, resume, cancel, or confirm");
        reply(response, 200, runtime.goals.asJson(result) as unknown as JsonValue);
        return;
      }

      const refinementActionsMatch = url.pathname.match(/^\/v1\/refinements\/([^/]+)\/actions$/);
      if (request.method === "POST" && refinementActionsMatch?.[1]) {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const proposal = runtime.refinements.get(runtime.config.tenantId, refinementActionsMatch[1]);
        if (!proposal) throw new HttpError(404, "Refinement proposal not found");
        const review = body.review !== null && typeof body.review === "object" && !Array.isArray(body.review) ? body.review as JsonObject : {};
        const action = body.action;
        const result = action === "approve" ? runtime.refinements.asJson(runtime.refinements.approve(runtime.config.tenantId, proposal.id, review))
          : action === "reject" ? runtime.refinements.asJson(runtime.refinements.reject(runtime.config.tenantId, proposal.id, review))
            : action === "apply" ? (() => {
              const applied = runtime.refinements.apply(runtime.config.tenantId, proposal.id);
              return { proposal: runtime.refinements.asJson(applied.proposal), overlay: runtime.refinements.overlayJson(applied.overlay) };
            })()
              : action === "retire" ? runtime.refinements.asJson(runtime.refinements.retire(runtime.config.tenantId, proposal.id))
                : action === "rollback" ? (() => {
                  const rolledBack = runtime.refinements.rollback(runtime.config.tenantId, proposal.id);
                  return { proposal: runtime.refinements.asJson(rolledBack.proposal), overlay: runtime.refinements.overlayJson(rolledBack.overlay) };
                })()
                : undefined;
        if (!result) throw new HttpError(400, "action must be approve, reject, apply, retire, or rollback");
        reply(response, 200, result as unknown as JsonValue);
        return;
      }

      const insightFeedbackMatch = url.pathname.match(/^\/v1\/insights\/([^/]+)\/feedback$/);
      if (request.method === "POST" && insightFeedbackMatch?.[1]) {
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const hypothesis = runtime.perception.get(runtime.config.tenantId, insightFeedbackMatch[1]);
        if (!hypothesis) throw new HttpError(404, "Insight not found");
        const kind = body.kind;
        if (kind !== "resonated" && kind !== "corrected" && kind !== "rejected" && kind !== "annoyed" && kind !== "neutral") {
          throw new HttpError(400, "kind must be resonated, corrected, rejected, annoyed, or neutral");
        }
        const note = boundedString(body.note, "note", 2_000) ?? "";
        const source = runtime.store.appendEvent({
          tenantId: runtime.config.tenantId, stream: `perception:${hypothesis.id}`, type: "perception.user_feedback",
          payload: { hypothesisId: hypothesis.id, kind, note },
        });
        const updated = runtime.perception.recordFeedback({
          tenantId: runtime.config.tenantId, hypothesisId: hypothesis.id, sourceEventId: source.id, kind, note,
        });
        runtime.personalModel.updateLatentThesisStatus(runtime.config.tenantId, hypothesis.id, updated.status, updated.confidence);
        reply(response, 200, updated as unknown as JsonValue);
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/credentials") {
        if (!runtime.credentials.enabled()) throw new HttpError(503, "Browser credential storage is not configured");
        const body = object(await readBody(request, Math.min(runtime.config.http.bodyLimitBytes, 70_000)));
        const originInput = boundedString(body.origin, "origin", 2_048, true) as string;
        const credentialLabel = boundedString(body.label, "label", 256, true) as string;
        let origin: string;
        try { origin = credentialOrigin(originInput); } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : "Credential origin is invalid");
        }
        const suppliedFields = object(body.fields);
        const entries = Object.entries(suppliedFields);
        if (!entries.length || entries.length > 16) throw new HttpError(400, "fields must contain 1-16 credential values");
        const fields: Record<string, string> = {};
        let secretBytes = 0;
        for (const [name, secret] of entries) {
          if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name)) throw new HttpError(400, `Credential field name is invalid: ${name}`);
          if (typeof secret !== "string" || !secret || secret.includes("\0")) throw new HttpError(400, `Credential field ${name} must be a non-empty string without null bytes`);
          const bytes = Buffer.byteLength(secret);
          if (bytes > 16_384) throw new HttpError(400, `Credential field ${name} exceeds 16 KiB`);
          secretBytes += bytes;
          fields[name] = secret;
        }
        if (secretBytes > 65_536) throw new HttpError(400, "Credential fields exceed 64 KiB in total");
        try {
          reply(response, 201, runtime.credentials.asJson(runtime.credentials.storeCredential({
            tenantId: runtime.config.tenantId, origin, label: credentialLabel, fields,
          })));
        } finally {
          for (const name of Object.keys(fields)) {
            fields[name] = "";
            suppliedFields[name] = "";
          }
        }
        return;
      }

      const credentialActionMatch = url.pathname.match(/^\/v1\/credentials\/([^/]+)\/actions$/)?.[1];
      if (request.method === "POST" && credentialActionMatch) {
        const body = object(await readBody(request, Math.min(runtime.config.http.bodyLimitBytes, 1_024)));
        const action = boundedString(body.action, "action", 32, true);
        if (action !== "retire") throw new HttpError(400, "Credential action must be retire");
        try {
          reply(response, 200, runtime.credentials.asJson(runtime.credentials.retire(runtime.config.tenantId, decodeURIComponent(credentialActionMatch))));
        } catch (error) {
          if (error instanceof Error && /not found/i.test(error.message)) throw new HttpError(404, "Credential handle not found");
          throw error;
        }
        return;
      }

      const sensorActionMatch = url.pathname.match(/^\/v1\/sensors\/([^/]+)\/actions$/)?.[1];
      if (request.method === "POST" && sensorActionMatch) {
        const sensorId = decodeURIComponent(sensorActionMatch);
        const body = object(await readBody(request, Math.min(runtime.config.http.bodyLimitBytes, 4_096)));
        const action = boundedString(body.action, "action", 32, true);
        const sensor = runtime.sensors.get(runtime.config.tenantId, sensorId);
        if (!sensor) throw new HttpError(404, "Sensor not found");
        if (action === "grant") {
          const descriptorHash = boundedString(body.descriptorHash, "descriptorHash", 64, true) as string;
          if (!/^[a-f0-9]{64}$/.test(descriptorHash)) throw new HttpError(400, "descriptorHash must be a lowercase SHA-256 value");
          try {
            reply(response, 200, runtime.sensors.asJson(runtime.sensors.grant({
              tenantId: runtime.config.tenantId, sensorId, expectedDescriptorHash: descriptorHash,
            })));
          } catch (error) {
            if (error instanceof Error && /changed before consent/i.test(error.message)) throw new HttpError(409, error.message);
            throw error;
          }
        } else if (action === "revoke") {
          reply(response, 200, runtime.sensors.asJson(runtime.sensors.revoke(runtime.config.tenantId, sensorId)));
        } else throw new HttpError(400, "Sensor action must be grant or revoke");
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/approvals") reply(response, 200, runtime.store.listApprovals(runtime.config.tenantId) as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname === "/v1/work-orders") {
        const rawStatus = url.searchParams.get("status");
        const status = rawStatus === "queued" || rawStatus === "running" || rawStatus === "waiting_approval" || rawStatus === "needs_input" || rawStatus === "completed" || rawStatus === "failed" || rawStatus === "cancelled" ? rawStatus : undefined;
        if (rawStatus && !status) throw new HttpError(400, "Unknown work-order status");
        reply(response, 200, runtime.workOrders.list(runtime.config.tenantId, status, boundedLimit(url.searchParams.get("limit"), 100, 1_000)).map((workOrder) => runtime.workOrders.asJson(workOrder)));
      }
      else if (request.method === "GET" && url.pathname.match(/^\/v1\/work-orders\/([^/]+)$/)?.[1]) {
        const workOrderId = url.pathname.match(/^\/v1\/work-orders\/([^/]+)$/)?.[1] as string;
        const workOrder = runtime.workOrders.get(runtime.config.tenantId, workOrderId);
        if (!workOrder) throw new HttpError(404, "Work order not found");
        reply(response, 200, runtime.workOrders.asJson(workOrder));
      }
      else if (request.method === "GET" && url.pathname === "/v1/today") reply(response, 200, runtime.office.today(runtime.config.tenantId) as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname === "/v1/inbox") reply(response, 200, runtime.office.listAttention(runtime.config.tenantId, "open", boundedLimit(url.searchParams.get("limit"), 100, 1_000)) as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname === "/v1/promises") {
        const status = url.searchParams.get("status");
        const statuses: Array<"accepted" | "overdue" | "completed" | "released"> = status === "accepted" || status === "overdue" || status === "completed" || status === "released" ? [status] : ["accepted", "overdue"];
        reply(response, 200, runtime.office.listPromises(runtime.config.tenantId, statuses, boundedLimit(url.searchParams.get("limit"), 100, 1_000)) as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname === "/v1/personal-model") {
        const rawKind = url.searchParams.get("kind");
        const kind = rawKind === "thought" || rawKind === "concept" || rawKind === "source" || rawKind === "latent_thesis" ? rawKind : undefined;
        if (rawKind && !kind) throw new HttpError(400, "Unknown personal-model node kind");
        reply(response, 200, (kind
          ? { nodes: runtime.personalModel.nodes(runtime.config.tenantId, kind, boundedLimit(url.searchParams.get("limit"), 100, 1_000)) }
          : runtime.personalModel.snapshot(runtime.config.tenantId)) as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname === "/v1/source-affinity") {
        reply(response, 200, runtime.personalModel.sourceAffinities(runtime.config.tenantId, boundedLimit(url.searchParams.get("limit"), 100, 1_000)) as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname === "/v1/inquiries") {
        const rawStatus = url.searchParams.get("status");
        const status = rawStatus === "proposed" || rawStatus === "investigating" || rawStatus === "resolved" || rawStatus === "insufficient"
          || rawStatus === "needs_member" || rawStatus === "expired" || rawStatus === "retired" ? rawStatus : undefined;
        if (rawStatus && !status) throw new HttpError(400, "Unknown inquiry status");
        reply(response, 200, runtime.inquiries.list(runtime.config.tenantId, { ...(status ? { status } : {}), limit: boundedLimit(url.searchParams.get("limit"), 100, 1_000) }) as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname.startsWith("/v1/inquiries/")) {
        const inquiryId = decodeURIComponent(url.pathname.slice("/v1/inquiries/".length));
        const inquiry = runtime.inquiries.get(runtime.config.tenantId, inquiryId);
        if (!inquiry) throw new HttpError(404, "Inquiry not found");
        reply(response, 200, { inquiry, foregroundDecisions: runtime.inquiries.foregroundDecisions(runtime.config.tenantId, inquiry.id) } as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname === "/v1/research") {
        reply(response, 200, runtime.research.list(runtime.config.tenantId, boundedLimit(url.searchParams.get("limit"), 100, 1_000)) as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname.startsWith("/v1/research/")) {
        const commissionId = decodeURIComponent(url.pathname.slice("/v1/research/".length));
        const commission = runtime.research.get(runtime.config.tenantId, commissionId);
        if (!commission) throw new HttpError(404, "Research commission not found");
        reply(response, 200, runtime.research.asJson(commission));
      }
      else if (request.method === "GET" && url.pathname === "/v1/consequences") {
        reply(response, 200, runtime.consequences.list(runtime.config.tenantId, boundedLimit(url.searchParams.get("limit"), 100, 1_000)) as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname.startsWith("/v1/consequences/")) {
        const consequenceId = decodeURIComponent(url.pathname.slice("/v1/consequences/".length));
        const consequence = runtime.consequences.get(runtime.config.tenantId, consequenceId);
        if (!consequence) throw new HttpError(404, "Consequence not found");
        reply(response, 200, runtime.consequences.asJson(consequence));
      }
      else if (request.method === "GET" && url.pathname === "/v1/scouts") {
        reply(response, 200, runtime.scouts.list(runtime.config.tenantId, boundedLimit(url.searchParams.get("limit"), 100, 1_000))
          .map((scout) => runtime.scouts.asJson(scout, false)) as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname.match(/^\/v1\/scouts\/([^/]+)$/)?.[1]) {
        const scoutId = decodeURIComponent(url.pathname.match(/^\/v1\/scouts\/([^/]+)$/)?.[1] as string);
        const scout = runtime.scouts.get(runtime.config.tenantId, scoutId);
        if (!scout) throw new HttpError(404, "Scout not found");
        reply(response, 200, runtime.scouts.asJson(scout));
      }
      else if (request.method === "POST" && url.pathname.match(/^\/v1\/scouts\/([^/]+)\/wakes$/)?.[1]) {
        const scoutId = decodeURIComponent(url.pathname.match(/^\/v1\/scouts\/([^/]+)\/wakes$/)?.[1] as string);
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const externalId = boundedString(body.externalId, "externalId", 512, true) as string;
        const type = boundedString(body.type, "type", 128) ?? "source.changed";
        if (!/^[a-zA-Z0-9_.:-]+$/.test(type)) throw new HttpError(400, "type contains invalid characters");
        const eventId = stableId("evt", `${runtime.config.tenantId}:scout-wake:${scoutId}:${externalId}`);
        const sourceCursor = typeof body.cursor === "string" ? boundedString(body.cursor, "cursor", 2_000, true) as string : undefined;
        const payloadDigest = createHash("sha256").update(canonicalJson((body.payload ?? {}) as JsonValue)).digest("hex");
        const sourcePayload = { payloadDigest, cursor: sourceCursor ?? null } as JsonObject;
        const result = runtime.store.transaction(() => {
          const existing = runtime.store.getEvent(runtime.config.tenantId, eventId);
          if (existing) {
            if (existing.type !== type || canonicalJson(existing.payload) !== canonicalJson(sourcePayload)) {
              throw new HttpError(409, "externalId was already used for different source wake content");
            }
            return { duplicate: true, wake: runtime.scouts.wake({ tenantId: runtime.config.tenantId, scoutId, sourceEventId: existing.id,
              ...(sourceCursor ? { sourceCursor } : {}) }) };
          }
          const event = runtime.store.appendEvent({ id: eventId, tenantId: runtime.config.tenantId,
            stream: `source:${scoutId}`, type, payload: sourcePayload });
          return { duplicate: false, wake: runtime.scouts.wake({
            tenantId: runtime.config.tenantId, scoutId, sourceEventId: event.id,
            ...(sourceCursor ? { sourceCursor } : {}),
          }) };
        });
        reply(response, 202, { accepted: result.wake.accepted, duplicate: result.duplicate,
          coalesced: result.wake.coalesced, scout: runtime.scouts.asJson(result.wake.scout) });
      }
      else if (request.method === "POST" && url.pathname.match(/^\/v1\/scouts\/([^/]+)\/actions$/)?.[1]) {
        const scoutId = decodeURIComponent(url.pathname.match(/^\/v1\/scouts\/([^/]+)\/actions$/)?.[1] as string);
        const body = object(await readBody(request, runtime.config.http.bodyLimitBytes));
        const action = boundedString(body.action, "action", 32, true);
        const status = action === "pause" ? "paused" : action === "resume" ? "active" : action === "retire" ? "retired" : undefined;
        if (!status) throw new HttpError(400, "Scout action must be pause, resume, or retire");
        const scout = action === "resume"
          ? runtime.scouts.resumeAfterRepair(
            runtime.config.tenantId, scoutId,
            typeof body.releaseId === "string" ? boundedString(body.releaseId, "releaseId", 256, true) : undefined,
          )
          : runtime.scouts.transition(runtime.config.tenantId, scoutId, status);
        reply(response, 200, runtime.scouts.asJson(scout));
      }
      else if (request.method === "GET" && url.pathname === "/v1/credentials") {
        reply(response, 200, runtime.credentials.list(runtime.config.tenantId, boundedLimit(url.searchParams.get("limit"), 100, 1_000)).map((handle) => runtime.credentials.asJson(handle)));
      }
      else if (request.method === "GET" && url.pathname.match(/^\/v1\/credentials\/([^/]+)$/)?.[1]) {
        const credentialId = decodeURIComponent(url.pathname.match(/^\/v1\/credentials\/([^/]+)$/)?.[1] as string);
        const handle = runtime.credentials.get(runtime.config.tenantId, credentialId);
        if (!handle) throw new HttpError(404, "Credential handle not found");
        reply(response, 200, runtime.credentials.asJson(handle));
      }
      else if (request.method === "GET" && url.pathname === "/v1/sensors") {
        reply(response, 200, runtime.sensors.list(runtime.config.tenantId).map((sensor) => runtime.sensors.asJson(sensor)));
      }
      else if (request.method === "GET" && url.pathname.match(/^\/v1\/sensors\/([^/]+)$/)?.[1]) {
        const sensorId = decodeURIComponent(url.pathname.match(/^\/v1\/sensors\/([^/]+)$/)?.[1] as string);
        const sensor = runtime.sensors.get(runtime.config.tenantId, sensorId);
        if (!sensor) throw new HttpError(404, "Sensor not found");
        reply(response, 200, runtime.sensors.asJson(sensor));
      }
      else if (request.method === "GET" && url.pathname === "/v1/mandates") reply(response, 200, runtime.office.listMandates(runtime.config.tenantId, undefined, boundedLimit(url.searchParams.get("limit"), 100, 1_000)) as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname === "/v1/matters") reply(response, 200, runtime.office.listMatters(runtime.config.tenantId, undefined, boundedLimit(url.searchParams.get("limit"), 100, 1_000)) as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname === "/v1/prepared-artifacts") reply(response, 200, runtime.office.listArtifacts(runtime.config.tenantId, undefined, boundedLimit(url.searchParams.get("limit"), 100, 1_000)) as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname.match(/^\/v1\/mandates\/([^/]+)$/)?.[1]) {
        const record = runtime.office.getMandate(runtime.config.tenantId, url.pathname.match(/^\/v1\/mandates\/([^/]+)$/)?.[1] as string);
        if (!record) throw new HttpError(404, "Mandate not found");
        reply(response, 200, record as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname.match(/^\/v1\/matters\/([^/]+)$/)?.[1]) {
        const record = runtime.office.getMatter(runtime.config.tenantId, url.pathname.match(/^\/v1\/matters\/([^/]+)$/)?.[1] as string);
        if (!record) throw new HttpError(404, "Matter not found");
        reply(response, 200, record as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname.match(/^\/v1\/prepared-artifacts\/([^/]+)$/)?.[1]) {
        const record = runtime.office.getArtifact(runtime.config.tenantId, url.pathname.match(/^\/v1\/prepared-artifacts\/([^/]+)$/)?.[1] as string);
        if (!record) throw new HttpError(404, "Prepared artifact not found");
        reply(response, 200, record as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname.match(/^\/v1\/inbox\/([^/]+)$/)?.[1]) {
        const record = runtime.office.getAttention(runtime.config.tenantId, url.pathname.match(/^\/v1\/inbox\/([^/]+)$/)?.[1] as string);
        if (!record) throw new HttpError(404, "Attention item not found");
        reply(response, 200, record as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname.match(/^\/v1\/why\/([^/]+)$/)?.[1]) reply(response, 200, runtime.office.why(runtime.config.tenantId, url.pathname.match(/^\/v1\/why\/([^/]+)$/)?.[1] as string) as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname === "/v1/runs") reply(response, 200, runtime.store.listRuns(runtime.config.tenantId, boundedLimit(url.searchParams.get("limit"), 50, 500)).map(publicRun) as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname === "/v1/agents") reply(response, 200, runtime.agentMonitor.snapshot(runtime.config.tenantId, boundedLimit(url.searchParams.get("limit"), 200, 1_000)) as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname === "/v1/goals") {
        const rawStatus = url.searchParams.get("status");
        const status = rawStatus === "active" || rawStatus === "paused" || rawStatus === "completed" || rawStatus === "failed" || rawStatus === "cancelled" ? rawStatus : undefined;
        if (rawStatus && !status) throw new HttpError(400, "Unknown goal status");
        reply(response, 200, runtime.goals.list(runtime.config.tenantId, status, boundedLimit(url.searchParams.get("limit"), 100, 1_000)).map((goal) => runtime.goals.asJson(goal)) as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname.match(/^\/v1\/goals\/([^/]+)$/)?.[1]) {
        const goalId = url.pathname.match(/^\/v1\/goals\/([^/]+)$/)?.[1] as string;
        const goal = runtime.goals.get(runtime.config.tenantId, goalId);
        if (!goal) throw new HttpError(404, "Goal not found");
        reply(response, 200, { goal: runtime.goals.asJson(goal), gateResults: runtime.goals.results(runtime.config.tenantId, goal.id) } as unknown as JsonValue);
      }
      else if (request.method === "GET" && agentMessagesMatch?.[1]) {
        const agent = runtime.agents.get(runtime.config.tenantId, agentMessagesMatch[1]);
        if (!agent) throw new HttpError(404, "Agent not found");
        reply(response, 200, {
          agent: runtime.agents.asJson(agent),
          messages: runtime.agents.messages(runtime.config.tenantId, agent.id, {
            afterSeq: Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0), limit: boundedLimit(url.searchParams.get("limit"), 100, 500),
          }).map((message) => runtime.agents.messageJson(message)),
        } as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname.match(/^\/v1\/agents\/([^/]+)$/)?.[1]) {
        const identifier = url.pathname.match(/^\/v1\/agents\/([^/]+)$/)?.[1] as string;
        const snapshot = identifier.startsWith("agt_")
          ? runtime.agentMonitor.retained(runtime.config.tenantId, identifier)
          : runtime.agentMonitor.run(runtime.config.tenantId, identifier);
        if (!snapshot) throw new HttpError(404, "Agent or run not found");
        reply(response, 200, snapshot as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname === "/v1/jobs") reply(response, 200, runtime.store.listJobs(runtime.config.tenantId) as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname === "/v1/plugins") reply(response, 200, new PluginRegistry(runtime.config.plugins.roots).report(runtime.config.plugins.enabled) as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname === "/v1/connectors") reply(response, 200, runtime.connectors.status as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname === "/v1/email-identities") reply(response, 200, runtime.email.listIdentities(runtime.config.tenantId).map((identity) => runtime.email.identityJson(identity)) as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname.match(/^\/v1\/email-verifications\/([^/]+)$/)?.[1]) {
        const challengeId = url.pathname.match(/^\/v1\/email-verifications\/([^/]+)$/)?.[1] as string;
        const challenge = runtime.email.getChallenge(runtime.config.tenantId, challengeId);
        if (!challenge) throw new HttpError(404, "Email verification challenge not found");
        reply(response, 200, runtime.email.challengeJson(challenge));
      }
      else if (request.method === "GET" && url.pathname === "/v1/execution") reply(response, 200, runtime.execution.status as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname === "/v1/releases") reply(response, 200, runtime.releases.status(runtime.config.tenantId) as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname === "/v1/capabilities") reply(response, 200, {
        plugins: new PluginRegistry(runtime.config.plugins.roots).report(runtime.config.plugins.enabled),
        connectors: runtime.connectors.status,
        sensors: runtime.sensors.list(runtime.config.tenantId).map((sensor) => runtime.sensors.asJson(sensor)),
        email: runtime.email.status,
        execution: runtime.execution.status,
        models: runtime.config.models,
        skills: runtime.skills.skills.map((skill) => ({ name: skill.name, version: skill.version, description: skill.description })),
        collaboration: {
          retainedAgents: true, durableMailboxes: true, persistentGoals: true, deterministicCompletionGates: true,
          cursorAttachResume: true, governedRefinements: true, modelCanApplyRefinements: false,
        },
        actionProof: { durableWorkOrders: true, evidencePolicies: ["run", "tool", "external-write"], asynchronousAdmission: true, boundedStandingMandates: true },
        browserCredentials: { configured: runtime.credentials.enabled(), opaqueHandles: true, exactOrigin: true, screenshotMask: true },
        identity: { emailVerification: true, agentReceivesCode: false, verifiedRecipientDelivery: true },
        office: { mandates: true, matters: true, preparedArtifacts: true, heldAttentionInbox: true, provenance: true },
        perception: { longitudinalHypotheses: true, counterevidence: true, explicitFeedback: true, asynchronousSynthesis: true, silenceByDefault: true },
        productMeasurement: { ownerProvenancedFeedback: true, selfGrading: false, contextAdvantage: true, interruptionVolume: true },
        releases: { immutableManifests: true, deterministicCanaries: true, pinnedRuns: true, rollback: true, authorityCeiling: true },
      } as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname === "/v1/skill-proposals") {
        const rawStatus = url.searchParams.get("status");
        const status = rawStatus === "proposed" || rawStatus === "approved" || rawStatus === "rejected" || rawStatus === "installed" || rawStatus === "retired" ? rawStatus : undefined;
        if (rawStatus && !status) throw new HttpError(400, "Unknown skill proposal status");
        reply(response, 200, runtime.skillLearning.list(runtime.config.tenantId, status) as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname === "/v1/refinements") {
        const rawStatus = url.searchParams.get("status");
        const status = rawStatus === "proposed" || rawStatus === "approved" || rawStatus === "rejected" || rawStatus === "applied" || rawStatus === "retired" ? rawStatus : undefined;
        if (rawStatus && !status) throw new HttpError(400, "Unknown refinement status");
        reply(response, 200, runtime.refinements.list(runtime.config.tenantId, status, boundedLimit(url.searchParams.get("limit"), 100, 1_000)).map((proposal) => runtime.refinements.asJson(proposal)) as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname === "/v1/overlays") {
        const rawStatus = url.searchParams.get("status");
        const status = rawStatus === "active" || rawStatus === "superseded" || rawStatus === "retired" ? rawStatus : undefined;
        if (rawStatus && !status) throw new HttpError(400, "Unknown overlay status");
        reply(response, 200, runtime.refinements.overlays(runtime.config.tenantId, { ...(status ? { status } : {}), limit: boundedLimit(url.searchParams.get("limit"), 100, 1_000) }).map((overlay) => runtime.refinements.overlayJson(overlay)) as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname === "/v1/schedules") reply(response, 200, runtime.scheduler.list(runtime.config.tenantId) as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname === "/v1/memories") reply(response, 200, runtime.memory.list(runtime.config.tenantId, { status: "active", limit: boundedLimit(url.searchParams.get("limit"), 100, 1_000) }) as unknown as JsonValue);
      else if (request.method === "GET" && url.pathname === "/v1/product-metrics") {
        reply(response, 200, {
          summary: runtime.outcomes.summary(runtime.config.tenantId),
          feedback: runtime.outcomes.list(runtime.config.tenantId, boundedLimit(url.searchParams.get("limit"), 200, 1_000)),
        } as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname === "/v1/product-qualification") {
        const qualityPlanId = boundedString(url.searchParams.get("qualityPlanId"), "qualityPlanId", 512, false);
        reply(response, 200, runtime.productQualification.qualify(
          runtime.config.tenantId, runtime.config.autonomy.maxDailyInterventions, new Date(), qualityPlanId,
        ) as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname === "/v1/insights") {
        const rawStatus = url.searchParams.get("status");
        const status = rawStatus === "candidate" || rawStatus === "maturing" || rawStatus === "ready" || rawStatus === "surfaced" || rawStatus === "confirmed" || rawStatus === "rejected" || rawStatus === "superseded" ? rawStatus : undefined;
        if (rawStatus && !status) throw new HttpError(400, "Unknown insight status");
        reply(response, 200, runtime.perception.list(runtime.config.tenantId, { ...(status ? { status } : {}), limit: boundedLimit(url.searchParams.get("limit"), 100, 1_000) }) as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname.match(/^\/v1\/insights\/([^/]+)$/)?.[1]) {
        const hypothesisId = url.pathname.match(/^\/v1\/insights\/([^/]+)$/)?.[1] as string;
        const hypothesis = runtime.perception.get(runtime.config.tenantId, hypothesisId);
        if (!hypothesis) throw new HttpError(404, "Insight not found");
        const interventions = runtime.store.db.prepare("SELECT * FROM interventions WHERE tenant_id=? AND hypothesis_id=? ORDER BY created_at")
          .all(runtime.config.tenantId, hypothesisId);
        reply(response, 200, { hypothesis, evidence: runtime.perception.evidence(runtime.config.tenantId, hypothesisId), feedback: runtime.perception.feedback(runtime.config.tenantId, hypothesisId), interventions } as unknown as JsonValue);
      }
      else if (request.method === "GET" && url.pathname === "/v1/history") {
        const query = boundedString(url.searchParams.get("q"), "q", 2_000, true) as string;
        reply(response, 200, runtime.store.searchEvidence(runtime.config.tenantId, query, {
          limit: boundedLimit(url.searchParams.get("limit"), 8, 50),
          trustClasses: url.searchParams.get("includeUntrusted") === "true" ? ["owner", "agent", "untrusted"] : ["owner", "agent"],
        }) as unknown as JsonValue);
      } else if (request.method === "GET" && url.pathname === "/v1/originals") {
        reply(response, 200, runtime.originals.list(runtime.config.tenantId, boundedLimit(url.searchParams.get("limit"), 100, 1_000))
          .map((original) => ({ ...original, sourceUri: safeSourceUrl(original.sourceUri), finalUri: safeSourceUrl(original.finalUri) })) as unknown as JsonValue);
      } else if (request.method === "GET" && url.pathname.match(/^\/v1\/originals\/([^/]+)\/content$/)?.[1]) {
        const originalId = url.pathname.match(/^\/v1\/originals\/([^/]+)\/content$/)?.[1] as string;
        const original = runtime.originals.get(runtime.config.tenantId, originalId);
        const bytes = original ? runtime.originals.bytes(runtime.config.tenantId, originalId) : undefined;
        if (!original || !bytes) throw new HttpError(404, "Original not found");
        originalReply(response, bytes, original.mimeType, original.filename);
      } else if (request.method === "GET" && url.pathname === "/v1/events") {
        const stream = boundedString(url.searchParams.get("stream"), "stream", 256);
        const correlationId = boundedString(url.searchParams.get("correlationId"), "correlationId", 256);
        reply(response, 200, runtime.store.listEvents(runtime.config.tenantId, {
          afterSeq: Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0), limit: boundedLimit(url.searchParams.get("limit"), 100, 1_000),
          ...(stream ? { stream } : {}), ...(correlationId ? { correlationId } : {}),
        }) as unknown as JsonValue);
      } else if (request.method === "GET" && url.pathname === "/v1/attach") {
        const kind = url.searchParams.get("kind") ?? "runtime";
        if (kind !== "runtime" && kind !== "agent" && kind !== "run" && kind !== "goal") throw new HttpError(400, "kind must be runtime, agent, run, or goal");
        const identifier = boundedString(url.searchParams.get("id"), "id", 256);
        if (kind !== "runtime" && !identifier) throw new HttpError(400, `${kind} attachment requires id`);
        const afterSeq = Math.max(0, Number(url.searchParams.get("after") ?? 0) || 0);
        const stream = kind === "agent" ? `agent:${identifier}` : kind === "run" ? `run:${identifier}` : kind === "goal" ? `goal:${identifier}` : undefined;
        const state = kind === "agent" ? runtime.agentMonitor.retained(runtime.config.tenantId, identifier as string)
          : kind === "run" ? runtime.agentMonitor.run(runtime.config.tenantId, identifier as string)
            : kind === "goal" ? runtime.goals.get(runtime.config.tenantId, identifier as string)
              : { agents: runtime.agentMonitor.snapshot(runtime.config.tenantId), goals: runtime.goals.list(runtime.config.tenantId).map((goal) => runtime.goals.asJson(goal)) };
        if (!state) throw new HttpError(404, `${kind} not found`);
        const events = runtime.store.listEvents(runtime.config.tenantId, { afterSeq, limit: 500, ...(stream ? { stream } : {}) });
        const maximum = runtime.store.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE tenant_id=?").get(runtime.config.tenantId) as { seq: number };
        const cursor = events.at(-1)?.seq ?? afterSeq;
        reply(response, 200, {
          attachment: { kind, id: identifier ?? null, stream: stream ?? null }, state, events, cursor,
          latestTenantCursor: Number(maximum.seq), hasMore: stream ? events.length === 500 : cursor < Number(maximum.seq),
        } as unknown as JsonValue);
      } else if (request.method === "GET" && url.pathname === "/v1/events/stream") {
        const stream = boundedString(url.searchParams.get("stream"), "stream", 256);
        const correlationId = boundedString(url.searchParams.get("correlationId"), "correlationId", 256);
        sse(runtime, request, response, {
          afterSeq: Number(url.searchParams.get("after") ?? request.headers["last-event-id"] ?? 0),
          ...(stream ? { stream } : {}), ...(correlationId ? { correlationId } : {}),
        }, logger, requestIdentity);
      } else throw new HttpError(404, "Not found");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.publicMessage : runtime.config.environment === "production" ? "Internal server error" : error instanceof Error ? error.message : String(error);
      if (status >= 500) logger.error("http_request_failed", { requestId: requestIdentity, method: request.method, route: label, error });
      else logger.warn("http_request_rejected", { requestId: requestIdentity, method: request.method, route: label, status, reason: message });
      reply(response, status, { error: message, requestId: requestIdentity });
    }
  });
  server.requestTimeout = runtime.config.http.requestTimeoutMs;
  server.headersTimeout = runtime.config.http.headersTimeoutMs;
  server.keepAliveTimeout = runtime.config.http.keepAliveTimeoutMs;
  server.maxRequestsPerSocket = 100;
  server.maxHeadersCount = 100;
  server.maxConnections = runtime.config.http.maxConnections;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return server;
}

export async function listen(runtime: CoRuntime, options: { host?: string; port?: number; logger?: RuntimeLogger; metrics?: RuntimeMetrics } = {}): Promise<Server> {
  assertProductionConfig(runtime.config);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && !runtime.config.serverToken) throw new Error("Refusing non-loopback bind without CO_SERVER_TOKEN");
  const server = createRuntimeServer(runtime, { ...(options.logger ? { logger: options.logger } : {}), ...(options.metrics ? { metrics: options.metrics } : {}) });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}

export async function closeRuntimeServer(server: Server, graceMs: number): Promise<void> {
  server.closeIdleConnections();
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, graceMs);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      finish();
    });
  });
}
