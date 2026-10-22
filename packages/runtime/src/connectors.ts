import type { IncomingHttpHeaders } from "node:http";
import { attachmentJson, attachmentMarker } from "./deposits.ts";
import { stableId } from "./id.ts";
import { LinqAdapter, parseLinqEvent, verifyLinqWebhook } from "./linq.ts";
import { SendblueAdapter } from "./sendblue.ts";
import type { SqliteStore } from "./store.ts";
import type { InboundMessage, JsonObject, RuntimeConfig, TapbackType } from "./types.ts";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export interface ConnectorEventInput {
  id: string;
  stream: string;
  type: string;
  payload: JsonObject;
  at?: string;
  correlationId?: string;
  causationId?: string;
}

export interface ConnectorIngress {
  receiptKey: string;
  /** Authority is decided once, at the parsed-ingress boundary. */
  principalClass: "member" | "connector-status" | "trusted-system";
  primaryEvent: ConnectorEventInput;
  evidenceEvents: ConnectorEventInput[];
  message?: InboundMessage;
  memberRelationship?: { channel: string; peerId: string };
  routeUpdates?: Array<{ peerId?: string; externalThreadId: string; status: "active" | "blocked"; sourceEventId: string }>;
}

export interface ConnectorDelivery {
  tenantId?: string;
  peerId: string;
  content: string;
  replyTo?: string;
  idempotencyKey?: string;
  reaction?: { type: TapbackType; targetMessageId: string };
}

export interface ConnectorStatus {
  id: string;
  inboundConfigured: boolean;
  outboundConfigured: boolean;
}

export interface ConnectorAdapter {
  readonly id: string;
  /** Whether this rail can originate owner-authored turns. */
  readonly inboundPrincipal: "member" | "trusted-system";
  status(): ConnectorStatus;
  verifyWebhook(headers: IncomingHttpHeaders, rawBody: Uint8Array): boolean;
  parseWebhook(payload: unknown, tenantId: string): ConnectorIngress | undefined;
  deliver(input: ConnectorDelivery): Promise<JsonObject>;
  relationship?(peerId: string): { channel: string; peerId: string };
}

function deliveryAcceptance(store: SqliteStore, tenantId: string, provider: string, messageId: string): { id: string; correlationId?: string } | undefined {
  const row = store.db.prepare(`SELECT id,correlation_id FROM events
    WHERE tenant_id=? AND (
      (type IN ('message.delivery_accepted','message.delivered')
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.providerReceipt.provider') END=?
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.providerReceipt.messageId') END=?)
      OR
      (type='message.delivery_reconciled'
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.decision') END='accepted'
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.channel') END=?
        AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.providerMessageId') END=?)
    )
    ORDER BY seq DESC LIMIT 1`).get(tenantId, provider, messageId, provider, messageId) as { id: string; correlation_id: string | null } | undefined;
  return row ? { id: row.id, ...(row.correlation_id ? { correlationId: row.correlation_id } : {}) } : undefined;
}

class SendblueConnector implements ConnectorAdapter {
  readonly id = "sendblue";
  readonly inboundPrincipal = "member" as const;
  readonly adapter: SendblueAdapter;
  private readonly store: SqliteStore;

  constructor(config: RuntimeConfig, store: SqliteStore) {
    this.adapter = new SendblueAdapter(config);
    this.store = store;
  }

  status(): ConnectorStatus {
    return {
      id: this.id,
      inboundConfigured: Boolean(this.adapter.config.sendblue.webhookSecret),
      outboundConfigured: this.adapter.configured(),
    };
  }

  verifyWebhook(headers: IncomingHttpHeaders): boolean {
    const value = headers["sb-signing-secret"];
    return this.adapter.verify(typeof value === "string" ? value : undefined);
  }

  parseWebhook(payload: unknown, tenantId: string): ConnectorIngress | undefined {
    const body = object(payload);
    if (body.event_type === "call_log" || body.event_type === "inbound_call") {
      const inbound = body.event_type === "inbound_call" && body.direction === "inbound";
      const outbound = body.event_type === "call_log" && body.direction === "outbound";
      if (!inbound && !outbound) return undefined;
      const callId = string(body.call_id) || stableId("call", JSON.stringify(payload));
      const eventId = stableId("evt", `sendblue-call:${tenantId}:${callId}`);
      const counterparty = inbound ? string(body.from_number) : string(body.to_number);
      const memberRelationship = counterparty ? this.relationship(counterparty) : undefined;
      return {
        receiptKey: callId,
        principalClass: "member",
        primaryEvent: {
          id: eventId,
          stream: `call:${callId}`,
          type: "call.completed",
          payload: body as JsonObject,
          ...(typeof body.created_at === "string" ? { at: body.created_at } : {}),
        },
        evidenceEvents: [],
        ...(memberRelationship ? { memberRelationship } : {}),
      };
    }
    const rawStatus = string(body.status).trim().toLowerCase();
    const knownStatus = /^(registered|pending|declined|queued|accepted|sent|delivered|read|error|failed|undeliverable|cancelled)$/.test(rawStatus);
    if (body.is_outbound === true && knownStatus) {
      const messageId = string(body.message_handle) || string(body.message_id) || string(body.id);
      if (!messageId) return undefined;
      const state = /fail|error|undeliver|declin|cancel/.test(rawStatus) ? "failed"
        : /read/.test(rawStatus) ? "read"
          : /deliver/.test(rawStatus) ? "delivered"
            : /queue/.test(rawStatus) ? "queued" : "sent";
      const acceptance = deliveryAcceptance(this.store, tenantId, this.id, messageId);
      const receiptKey = `outbound:${messageId}:${state}`;
      const primaryId = stableId("evt", `sendblue-status-webhook:${tenantId}:${receiptKey}`);
      const statusId = stableId("evt", `sendblue-status:${tenantId}:${receiptKey}`);
      return {
        receiptKey,
        principalClass: "connector-status",
        primaryEvent: {
          id: primaryId, stream: `connector:sendblue:delivery:${messageId}`, type: "message.delivery_status",
          payload: { connectorId: this.id, externalMessageId: messageId, state, status: rawStatus },
          ...(acceptance?.correlationId ? { correlationId: acceptance.correlationId } : {}),
        },
        evidenceEvents: [{
          id: statusId, stream: `connector:sendblue:delivery:${messageId}`, type: `connector.message.${state}`,
          payload: { connectorId: this.id, externalMessageId: messageId, status: rawStatus || state },
          causationId: acceptance?.id ?? primaryId,
          ...(acceptance?.correlationId ? { correlationId: acceptance.correlationId } : {}),
        }],
      };
    }
    const message = this.adapter.parseInbound(payload, tenantId);
    if (!message) return undefined;
    message.relationship = this.relationship(message.peerId);
    const receiptKey = message.externalId ?? stableId("inbound", JSON.stringify(payload));
    const primaryId = stableId("evt", `sendblue-webhook:${tenantId}:${receiptKey}`);
    const location = object(message.metadata?.location);
    const evidenceEvents = typeof location.latitude === "number" && typeof location.longitude === "number"
      ? [{
          id: stableId("evt", `sendblue-location:${tenantId}:${receiptKey}`),
          stream: `location:${message.peerId}`,
          type: "location.shared",
          payload: { ...location, channel: message.channel, peerId: message.peerId, sourceMessageId: message.externalId ?? null } as JsonObject,
        }]
      : [];
    return {
      receiptKey,
      principalClass: "member",
      primaryEvent: { id: primaryId, stream: `channel:sendblue:${message.peerId}`, type: "webhook.received", payload: body as JsonObject },
      evidenceEvents,
      message,
      memberRelationship: message.relationship,
    };
  }

  deliver(input: ConnectorDelivery): Promise<JsonObject> {
    if (input.reaction) {
      return this.adapter.react(input.reaction.targetMessageId, input.reaction.type, input.idempotencyKey);
    }
    return this.adapter.send(input.peerId, input.content, {
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
  }

  relationship(peerId: string): { channel: string; peerId: string } {
    return peerId.startsWith("group:")
      ? { channel: "imessage-group", peerId: `sendblue:${peerId}` }
      : { channel: "imessage", peerId };
  }
}

class LinqConnector implements ConnectorAdapter {
  readonly id = "linq";
  readonly inboundPrincipal = "member" as const;
  readonly adapter: LinqAdapter;
  private readonly store: SqliteStore;
  private readonly tenantId: string;

  constructor(config: RuntimeConfig, store: SqliteStore) {
    this.adapter = new LinqAdapter(config.linq);
    this.store = store;
    this.tenantId = config.tenantId;
  }

  status(): ConnectorStatus {
    return { id: this.id, inboundConfigured: Boolean(this.adapter.config.webhookSecret), outboundConfigured: this.adapter.configured() };
  }

  verifyWebhook(headers: IncomingHttpHeaders, rawBody: Uint8Array): boolean {
    return verifyLinqWebhook(this.adapter.config.webhookSecret, headers, rawBody);
  }

  parseWebhook(payload: unknown, tenantId: string): ConnectorIngress | undefined {
    const event = parseLinqEvent(payload);
    if (!event.eventType || !event.eventId) return undefined;
    if (!event.trustedShape) return undefined;
    if (event.kind === "ignored" && !(event.eventType === "message.received" && event.isGroup)) return undefined;
    const primaryId = stableId("evt", `linq-webhook:${tenantId}:${event.eventId}`);
    const primaryEvent: ConnectorEventInput = {
      id: primaryId,
      stream: event.chatId ? `channel:linq:${event.chatId}` : "channel:linq:unknown",
      type: event.kind === "status" ? "message.delivery_status" : event.kind === "reaction" ? "message.reaction" : event.kind === "typing" ? "conversation.typing" : "webhook.received",
      payload: event.kind === "status"
        ? { connectorId: this.id, externalThreadId: event.chatId, externalMessageId: event.messageId ?? null, eventType: event.eventType }
        : event.payload,
    };
    const routeUpdates: ConnectorIngress["routeUpdates"] = [];
    const evidenceEvents: ConnectorEventInput[] = [];
    if (event.chatId && event.kind === "message" && event.peerId) {
      const routeEventId = stableId("evt", `linq-route:${tenantId}:${event.eventId}`);
      evidenceEvents.push({
        id: routeEventId, stream: `connector:linq:route:${stableId("peer", event.peerId)}`, type: "connector.route_observed",
        payload: { connectorId: this.id, peerId: event.peerId, externalThreadId: event.chatId, status: "active" },
      });
      routeUpdates.push({ peerId: event.peerId, externalThreadId: event.chatId, status: "active", sourceEventId: routeEventId });
    } else if (event.chatId && event.isGroup) {
      routeUpdates.push({ externalThreadId: event.chatId, status: "blocked", sourceEventId: primaryId });
    }
    const knownPeer = event.peerId || (event.chatId ? this.store.connectorPeer(tenantId, this.id, event.chatId) : undefined);
    const statusEvidence = event.kind === "status" && event.messageId
      ? (() => {
          const acceptance = deliveryAcceptance(this.store, tenantId, this.id, event.messageId as string);
          return [{
          id: stableId("evt", `linq-status:${tenantId}:${event.eventId}`), stream: `connector:linq:delivery:${event.messageId}`,
          type: `connector.${event.eventType}`,
          payload: { connectorId: this.id, peerId: knownPeer ?? null, externalThreadId: event.chatId, externalMessageId: event.messageId },
          causationId: acceptance?.id ?? primaryId,
          ...(acceptance?.correlationId ? { correlationId: acceptance.correlationId } : {}),
        } satisfies ConnectorEventInput];
        })()
      : [];
    evidenceEvents.push(...statusEvidence);
    const media = event.attachments.map(attachmentMarker);
    const message = event.kind === "message" && event.peerId
      ? {
          tenantId, channel: this.id, peerId: event.peerId, text: [event.text, ...media].filter(Boolean).join("\n"),
          ...(event.attachments.length ? { attachments: event.attachments } : {}),
          ...(event.messageId ? { externalId: event.messageId } : {}),
          relationship: this.relationship(event.peerId),
          metadata: { externalThreadId: event.chatId, mediaUrls: event.mediaUrls, attachments: attachmentJson(event.attachments) },
        } satisfies InboundMessage
      : undefined;
    const humanIngress = event.kind === "message" || event.kind === "reaction" || event.kind === "typing" || event.eventType === "message.received";
    const memberRelationship = humanIngress && knownPeer
      ? event.isGroup ? { channel: "imessage-group", peerId: `linq:${event.chatId || knownPeer}` } : this.relationship(knownPeer)
      : undefined;
    return {
      receiptKey: event.eventId, principalClass: humanIngress ? "member" : "connector-status", primaryEvent, evidenceEvents,
      ...(message ? { message } : {}), ...(routeUpdates.length ? { routeUpdates } : {}),
      ...(memberRelationship ? { memberRelationship } : {}),
    };
  }

  async deliver(input: ConnectorDelivery): Promise<JsonObject> {
    const tenantId = input.tenantId ?? this.tenantId;
    const idempotencyKey = input.idempotencyKey ?? stableId("delivery", `${tenantId}:${this.id}:${input.peerId}:${input.content}`);
    if (input.reaction) {
      return this.adapter.react(input.reaction.targetMessageId, input.reaction.type, input.idempotencyKey);
    }
    const chatId = this.store.connectorRoute(tenantId, this.id, input.peerId);
    const result = await this.adapter.send({
      peerId: input.peerId, content: input.content, ...(chatId ? { chatId } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    const learnedChat = typeof result.chatId === "string" ? result.chatId : chatId;
    if (learnedChat) {
      const sourceEventId = stableId("evt", `linq-outbound-route:${tenantId}:${idempotencyKey}:${learnedChat}`);
      this.store.transaction(() => {
        this.store.appendEvent({ id: sourceEventId, tenantId, stream: `connector:linq:route:${stableId("peer", input.peerId)}`, type: "connector.route_observed", payload: { connectorId: this.id, peerId: input.peerId, externalThreadId: learnedChat, status: "active" } });
        this.store.noteConnectorRoute({ tenantId, connectorId: this.id, peerId: input.peerId, externalThreadId: learnedChat, status: "active", sourceEventId });
      });
    }
    return result;
  }

  relationship(peerId: string): { channel: string; peerId: string } {
    return { channel: "imessage", peerId };
  }
}

export class ConnectorRegistry {
  private readonly adapters = new Map<string, ConnectorAdapter>();
  private readonly shadow: boolean;

  constructor(config: RuntimeConfig, storeOrAdapters: SqliteStore | ConnectorAdapter[], adapters?: ConnectorAdapter[]) {
    this.shadow = config.mode === "shadow";
    const selected = Array.isArray(storeOrAdapters)
      ? storeOrAdapters
      : adapters ?? [new SendblueConnector(config, storeOrAdapters), new LinqConnector(config, storeOrAdapters)];
    for (const adapter of selected) this.register(adapter);
  }

  register(adapter: ConnectorAdapter): void {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(adapter.id)) throw new Error(`Invalid connector id ${adapter.id}`);
    if (this.adapters.has(adapter.id)) throw new Error(`Duplicate connector id ${adapter.id}`);
    // Wrap the adapter itself: webhook() callers must not bypass the registry's
    // delivery guard, including adapters registered after initialization.
    this.adapters.set(adapter.id, this.shadow ? {
      id: adapter.id,
      inboundPrincipal: adapter.inboundPrincipal,
      status: () => ({ ...adapter.status(), outboundConfigured: false }),
      verifyWebhook: (headers, body) => adapter.verifyWebhook(headers, body),
      parseWebhook: (payload, tenantId) => adapter.parseWebhook(payload, tenantId),
      deliver: async () => { throw new Error("Shadow mode forbids connector delivery"); },
      ...(adapter.relationship ? { relationship: (peerId: string) => adapter.relationship!(peerId) } : {}),
    } : adapter);
  }

  webhook(id: string): ConnectorAdapter | undefined {
    return this.adapters.get(id);
  }

  canDeliver(id: string): boolean {
    return this.adapters.get(id)?.status().outboundConfigured === true;
  }

  requiresMemberPrincipal(id: string): boolean {
    return this.adapters.get(id)?.inboundPrincipal === "member";
  }

  async deliver(id: string, input: ConnectorDelivery): Promise<JsonObject> {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`No connector registered for ${id}`);
    if (!adapter.status().outboundConfigured) throw new Error(`Connector ${id} is not configured for outbound delivery`);
    return adapter.deliver(input);
  }

  relationship(id: string, peerId: string): { channel: string; peerId: string } {
    return this.adapters.get(id)?.relationship?.(peerId) ?? { channel: id, peerId };
  }

  get status(): ConnectorStatus[] {
    return [...this.adapters.values()].map((adapter) => adapter.status()).sort((left, right) => left.id.localeCompare(right.id));
  }
}
