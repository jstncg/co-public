import { stableId } from "./id.ts";
import type { ConnectorStatus } from "./connectors.ts";
import type { SqliteStore } from "./store.ts";
import type { EventRecord, JsonObject, RunRecord, RuntimeEnvironment } from "./types.ts";

type DeliveryQualificationStatus = "none" | "accepted" | "delivered" | "read" | "failed" | "uncertain";

export interface ConnectorQualificationStage {
  passed: boolean;
  detail: string;
  evidenceIds: string[];
}

export interface ConnectorRoundTripQualification {
  schemaVersion: 1;
  qualificationId: string;
  qualifiedAt: string;
  tenantId: string;
  connectorId: string;
  minimumStatus: "delivered" | "read";
  passed: boolean;
  actualStatus: DeliveryQualificationStatus;
  selector: { runId?: string; inboundExternalIdHash?: string };
  deployment: {
    environment: RuntimeEnvironment;
    since?: string;
    expectedReleaseId?: string;
    actualReleaseId?: string;
    releaseDigest?: string;
    provider?: string;
    model?: string;
  };
  evidence: {
    runId?: string;
    ingressReceiptId?: string;
    ingressEventId?: string;
    authorizationEventId?: string;
    sourceEventId?: string;
    completionEventId?: string;
    deliveryIntentId?: string;
    acceptanceEventId?: string;
    statusWebhookEventId?: string;
    statusEventId?: string;
    reconciliationEventId?: string;
    providerMessageIdHash?: string;
    peerIdHash?: string;
  };
  stages: {
    selection: ConnectorQualificationStage;
    deployment: ConnectorQualificationStage;
    authenticatedIngress: ConnectorQualificationStage;
    memberAuthorization: ConnectorQualificationStage;
    completedRun: ConnectorQualificationStage;
    providerAcceptance: ConnectorQualificationStage;
    authenticatedDeliveryStatus: ConnectorQualificationStage;
  };
}

export interface ConnectorRoundTripQualificationInput {
  tenantId: string;
  connectorId: string;
  environment: RuntimeEnvironment;
  connectorStatus: ConnectorStatus;
  runId?: string;
  inboundExternalId?: string;
  since?: string;
  expectedReleaseId?: string;
  minimumStatus?: "delivered" | "read";
}

interface EventRow {
  seq: number;
  id: string;
  stream: string;
  type: string;
  at: string;
  correlation_id: string | null;
  causation_id: string | null;
  payload_json: string;
}

interface DeliveryRow {
  intent_id: string;
  request_digest: string;
  channel: string;
  peer_id: string;
  state: string;
  acceptance_event_id: string | null;
  accepted_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  failed_at: string | null;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function json(value: string): Record<string, unknown> {
  try {
    return object(JSON.parse(value));
  } catch {
    return {};
  }
}

function stage(passed: boolean, detail: string, evidenceIds: Array<string | undefined> = []): ConnectorQualificationStage {
  return { passed, detail, evidenceIds: [...new Set(evidenceIds.filter((value): value is string => Boolean(value)))] };
}

function eventRecord(row: EventRow | undefined, tenantId: string): EventRecord<JsonObject> | undefined {
  if (!row) return undefined;
  const payload = json(row.payload_json) as JsonObject;
  return {
    seq: row.seq, id: row.id, tenantId, stream: row.stream, type: row.type, at: row.at, payload,
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    ...(row.causation_id ? { causationId: row.causation_id } : {}),
  };
}

function validDeploymentStart(value: string | undefined): string | undefined {
  if (!value || !/T.*(?:Z|[+-]\d\d:\d\d)$/i.test(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

/**
 * Read-only proof over durable runtime evidence. It intentionally cannot
 * create, repair, or reinterpret any receipt while deciding whether a live
 * connector round trip passed.
 */
export class ConnectorRoundTripQualifier {
  readonly store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  qualify(input: ConnectorRoundTripQualificationInput): ConnectorRoundTripQualification {
    const minimumStatus = input.minimumStatus ?? "delivered";
    const normalizedSince = validDeploymentStart(input.since);
    const selector = {
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.inboundExternalId ? { inboundExternalIdHash: stableId("inbound", input.inboundExternalId) } : {}),
    };
    let run: RunRecord | undefined;
    let started: EventRecord<JsonObject> | undefined;
    let source: EventRecord<JsonObject> | undefined;
    const selectionEvidence: string[] = [];
    let selectionDetail = "No exact run selector was supplied.";

    if (input.runId && input.inboundExternalId) {
      selectionDetail = "Choose either a run ID or an inbound provider message ID, not both.";
    } else if (input.runId) {
      run = this.store.getRun(input.runId, input.tenantId);
      const rows = this.store.db.prepare(`SELECT seq,id,stream,type,at,correlation_id,causation_id,payload_json FROM events
        WHERE tenant_id=? AND type='run.started' AND correlation_id=? ORDER BY seq`).all(input.tenantId, input.runId) as unknown as EventRow[];
      if (run && rows.length === 1) {
        started = eventRecord(rows[0], input.tenantId);
        source = started?.causationId ? this.store.getEvent<JsonObject>(input.tenantId, started.causationId) : undefined;
        selectionEvidence.push(started?.id ?? "", source?.id ?? "");
        selectionDetail = source ? "The selector resolves to one tenant-scoped run and one causal input event." : "The run has no causal input event.";
      } else {
        selectionDetail = !run ? "The selected run does not exist in this tenant." : "The selected run has an ambiguous or missing run-start event.";
      }
    } else if (input.inboundExternalId) {
      const sources = this.store.db.prepare(`SELECT seq,id,stream,type,at,correlation_id,causation_id,payload_json FROM events
        WHERE tenant_id=? AND type='message.received' AND json_valid(payload_json)
          AND json_extract(payload_json,'$.channel')=? AND json_extract(payload_json,'$.externalId')=?
        ORDER BY seq`).all(input.tenantId, input.connectorId, input.inboundExternalId) as unknown as EventRow[];
      if (sources.length === 1) {
        source = eventRecord(sources[0], input.tenantId);
        const starts = this.store.db.prepare(`SELECT seq,id,stream,type,at,correlation_id,causation_id,payload_json FROM events
          WHERE tenant_id=? AND type='run.started' AND causation_id=? ORDER BY seq`).all(input.tenantId, sources[0]!.id) as unknown as EventRow[];
        if (starts.length === 1 && starts[0]?.correlation_id) {
          started = eventRecord(starts[0], input.tenantId);
          run = this.store.getRun(starts[0].correlation_id, input.tenantId);
          selectionEvidence.push(source?.id ?? "", started?.id ?? "");
          selectionDetail = run ? "The provider message ID resolves to one tenant-scoped inbound event and run." : "The causal run record is missing.";
        } else {
          selectionDetail = "The provider message ID has an ambiguous or missing causal run.";
        }
      } else {
        selectionDetail = sources.length === 0
          ? "No canonical inbound event matches this provider message ID and connector."
          : "The provider message ID is ambiguous; qualify by exact run ID.";
      }
    }

    const selectionPassed = Boolean(run && started && source);
    const sourcePayload = object(source?.payload);
    const sourceText = typeof sourcePayload.text === "string" ? sourcePayload.text : undefined;
    const externalId = typeof sourcePayload.externalId === "string" ? sourcePayload.externalId : undefined;
    const peerId = typeof sourcePayload.peerId === "string" ? sourcePayload.peerId : undefined;
    const authorization = source?.causationId ? this.store.getEvent<JsonObject>(input.tenantId, source.causationId) : undefined;
    const authorizationPayload = object(authorization?.payload);
    const ingress = authorization?.causationId ? this.store.getEvent<JsonObject>(input.tenantId, authorization.causationId) : undefined;

    const receiptRows = ingress ? this.store.db.prepare(`SELECT external_id,event_id FROM inbound_receipts
      WHERE tenant_id=? AND scope=? AND event_id=? ORDER BY created_at`).all(
      input.tenantId, `webhook:${input.connectorId}`, ingress.id,
    ) as Array<{ external_id: string; event_id: string }> : [];
    const ingressReceipt = receiptRows.length === 1 ? receiptRows[0] : undefined;
    const authenticatedIngressPassed = Boolean(selectionPassed
      && source?.type === "message.received"
      && sourcePayload.channel === input.connectorId
      && sourcePayload.principal === "member"
      && externalId
      && peerId
      && ingress?.type === "webhook.received"
      && ingressReceipt);

    const session = run ? this.store.getSession(run.sessionId, input.tenantId) : undefined;
    const memberAuthorizationPassed = Boolean(authenticatedIngressPassed
      && authorization?.type === "connector.member_ingress_authorized"
      && authorization.stream === `security:connector:${input.connectorId}`
      && authorization?.causationId === ingress?.id
      && authorizationPayload.connectorId === input.connectorId
      && authorizationPayload.jobType === "channel.turn"
      && authorizationPayload.channel === input.connectorId
      && authorizationPayload.peerId === peerId
      && authorizationPayload.externalId === externalId
      && typeof sourceText === "string"
      && authorizationPayload.textDigest === stableId("content", sourceText)
      && typeof authorizationPayload.relationshipChannel === "string"
      && typeof authorizationPayload.relationshipPeerId === "string"
      && session?.channel === authorizationPayload.relationshipChannel
      && session?.peerId === authorizationPayload.relationshipPeerId);

    const completionRows = run ? this.store.db.prepare(`SELECT seq,id,stream,type,at,correlation_id,causation_id,payload_json FROM events
      WHERE tenant_id=? AND type='run.completed' AND correlation_id=? ORDER BY seq`).all(input.tenantId, run.id) as unknown as EventRow[] : [];
    const completion = completionRows.length === 1 ? eventRecord(completionRows[0], input.tenantId) : undefined;
    const completionPayload = object(completion?.payload);
    const startedPayload = object(started?.payload);
    const completedRunPassed = Boolean(memberAuthorizationPassed
      && run?.status === "completed"
      && run.kind === "foreground"
      && run.input === sourceText
      && started?.causationId === source?.id
      && started?.correlationId === run.id
      && startedPayload.releaseId === run.releaseId
      && startedPayload.releaseDigest === run.releaseDigest
      && completion
      && completionPayload.output === run.output
      && completionPayload.responseMode === "reply"
      && completionPayload.reaction === null);

    const manifest = run?.releaseId ? this.store.db.prepare(`SELECT id,manifest_digest FROM release_manifests
      WHERE id=?`).get(run.releaseId) as { id: string; manifest_digest: string } | undefined : undefined;
    const deploymentPassed = Boolean(normalizedSince
      && input.expectedReleaseId
      && input.environment === "production"
      && input.connectorStatus.id === input.connectorId
      && input.connectorStatus.inboundConfigured
      && input.connectorStatus.outboundConfigured
      && run?.provider
      && run.provider !== "mock"
      && run.releaseId === input.expectedReleaseId
      && run.releaseDigest
      && manifest?.id === run.releaseId
      && manifest.manifest_digest === run.releaseDigest
      && ingress
      && Date.parse(ingress.at) >= Date.parse(normalizedSince));

    const intentRows = completedRunPassed && externalId && peerId && run
      ? this.store.db.prepare(`SELECT seq,id,stream,type,at,correlation_id,causation_id,payload_json FROM events
          WHERE tenant_id=? AND type='message.delivery_started' AND correlation_id=?
            AND json_valid(payload_json) AND json_extract(payload_json,'$.channel')=?
            AND json_extract(payload_json,'$.peerId')=? AND json_extract(payload_json,'$.replyTo')=?
          ORDER BY seq`).all(input.tenantId, run.id, input.connectorId, peerId, externalId) as unknown as EventRow[]
      : [];
    const intent = intentRows.length === 1 ? eventRecord(intentRows[0], input.tenantId) : undefined;
    const intentPayload = object(intent?.payload);
    const content = typeof intentPayload.content === "string" ? intentPayload.content : undefined;
    const deliveryKey = typeof intentPayload.deliveryKey === "string" ? intentPayload.deliveryKey : undefined;
    const requestDigest = content !== undefined && deliveryKey && externalId && peerId
      ? stableId("delivery", JSON.stringify({ channel: input.connectorId, peerId, content, deliveryKey, replyTo: externalId }))
      : undefined;
    const delivery = intent ? this.store.db.prepare(`SELECT intent_id,request_digest,channel,peer_id,state,acceptance_event_id,
      accepted_at,delivered_at,read_at,failed_at FROM outbound_deliveries WHERE tenant_id=? AND intent_id=?`).get(
      input.tenantId, intent.id,
    ) as DeliveryRow | undefined : undefined;
    const acceptance = delivery?.acceptance_event_id
      ? this.store.getEvent<JsonObject>(input.tenantId, delivery.acceptance_event_id)
      : undefined;
    const acceptancePayload = object(acceptance?.payload);
    const providerReceipt = object(acceptancePayload.providerReceipt);
    const providerMessageId = typeof providerReceipt.messageId === "string" && providerReceipt.messageId.trim()
      ? providerReceipt.messageId : undefined;
    const providerAcceptancePassed = Boolean(completedRunPassed
      && intentRows.length === 1
      && intent
      && content !== undefined
      && Boolean(content.trim())
      && content === run?.output
      && intentPayload.reaction === null
      && deliveryKey
      && requestDigest
      && intentPayload.requestDigest === requestDigest
      && delivery?.intent_id === intent.id
      && delivery.request_digest === requestDigest
      && delivery.channel === input.connectorId
      && delivery.peer_id === peerId
      && delivery.state === "accepted"
      && delivery.accepted_at
      && !delivery.failed_at
      && acceptance?.type === "message.delivery_accepted"
      && acceptance.causationId === intent.id
      && acceptance.correlationId === run?.id
      && acceptancePayload.channel === input.connectorId
      && acceptancePayload.peerId === peerId
      && acceptancePayload.replyTo === externalId
      && acceptancePayload.deliveryKey === deliveryKey
      && providerReceipt.provider === input.connectorId
      && providerMessageId);

    let statusEvent: EventRecord<JsonObject> | undefined;
    let statusWebhook: EventRecord<JsonObject> | undefined;
    let reconciliation: EventRecord<JsonObject> | undefined;
    if (providerAcceptancePassed && providerMessageId && acceptance && run) {
      const statusRows = this.store.db.prepare(`SELECT seq,id,stream,type,at,correlation_id,causation_id,payload_json FROM events
        WHERE tenant_id=? AND type IN ('connector.message.read','connector.message.delivered')
          AND json_valid(payload_json) AND json_extract(payload_json,'$.connectorId')=?
          AND json_extract(payload_json,'$.externalMessageId')=?
        ORDER BY CASE type WHEN 'connector.message.read' THEN 0 ELSE 1 END,seq DESC`).all(
        input.tenantId, input.connectorId, providerMessageId,
      ) as unknown as EventRow[];
      for (const candidateRow of statusRows) {
        const candidate = eventRecord(candidateRow, input.tenantId);
        if (!candidate) continue;
        if (minimumStatus === "read" && candidate.type !== "connector.message.read") continue;
        const priorRow = this.store.db.prepare(`SELECT seq,id,stream,type,at,correlation_id,causation_id,payload_json FROM events
          WHERE tenant_id=? AND seq=?`).get(input.tenantId, candidate.seq - 1) as EventRow | undefined;
        const prior = eventRecord(priorRow, input.tenantId);
        const priorPayload = object(prior?.payload);
        const receipt = prior ? this.store.db.prepare(`SELECT external_id FROM inbound_receipts
          WHERE tenant_id=? AND scope=? AND event_id=?`).get(
          input.tenantId, `webhook:${input.connectorId}`, prior.id,
        ) as { external_id: string } | undefined : undefined;
        const state = candidate.type.endsWith(".read") ? "read" : "delivered";
        const primaryStateMatches = priorPayload.state === state || priorPayload.eventType === `message.${state}`;
        const authenticatedPair = Boolean(prior
          && receipt
          && prior.type === "message.delivery_status"
          && priorPayload.connectorId === input.connectorId
          && priorPayload.externalMessageId === providerMessageId
          && primaryStateMatches);
        if (!authenticatedPair) continue;
        let bridge: EventRecord<JsonObject> | undefined;
        const directCausation = candidate.causationId === acceptance.id && candidate.correlationId === run.id;
        if (!directCausation) {
          const bridgeRows = this.store.db.prepare(`SELECT seq,id,stream,type,at,correlation_id,causation_id,payload_json FROM events
            WHERE tenant_id=? AND type='message.delivery_status_reconciled' AND correlation_id=? AND causation_id=?
            ORDER BY seq`).all(input.tenantId, run.id, candidate.id) as unknown as EventRow[];
          if (bridgeRows.length === 1) {
            const possible = eventRecord(bridgeRows[0], input.tenantId);
            const payload = object(possible?.payload);
            if (payload.acceptanceEventId === acceptance.id
              && payload.statusEventId === candidate.id
              && payload.connectorId === input.connectorId
              && payload.providerMessageId === providerMessageId) bridge = possible;
          }
        }
        if (!directCausation && !bridge) continue;
        const projectionMatches = state === "read"
          ? Boolean(delivery?.read_at && delivery.delivered_at)
          : Boolean(delivery?.delivered_at);
        if (!projectionMatches) continue;
        statusEvent = candidate;
        statusWebhook = prior;
        reconciliation = bridge;
        break;
      }
    }

    const authenticatedDeliveryStatusPassed = Boolean(statusEvent && statusWebhook);
    const actualStatus: DeliveryQualificationStatus = delivery?.failed_at || delivery?.state === "failed" ? "failed"
      : statusEvent?.type === "connector.message.read" ? "read"
        : statusEvent?.type === "connector.message.delivered" ? "delivered"
          : providerAcceptancePassed ? "accepted"
            : delivery?.state === "uncertain" || delivery?.state === "running" ? "uncertain" : "none";
    const stages = {
      selection: stage(selectionPassed, selectionDetail, selectionEvidence),
      deployment: stage(deploymentPassed, deploymentPassed
        ? "Production configuration, current rail readiness, deployment window, non-mock provider, and exact immutable release all match."
        : "Qualification requires production mode, inbound/outbound rail readiness, --since, --release, a non-mock provider, and an exact stored release digest.", [run?.releaseId]),
      authenticatedIngress: stage(authenticatedIngressPassed, authenticatedIngressPassed
        ? "The canonical inbound descends from a webhook receipt persisted only after connector authentication."
        : "No exact authenticated webhook receipt and canonical member message chain was found.", [ingressReceipt?.event_id, ingress?.id, source?.id]),
      memberAuthorization: stage(memberAuthorizationPassed, memberAuthorizationPassed
        ? "The connector ingress authorization binds the exact member relationship, provider message ID, and content digest."
        : "The member authorization is missing, rebound, or does not match the canonical relationship and content digest.", [authorization?.id]),
      completedRun: stage(completedRunPassed, completedRunPassed
        ? "One foreground run completed from the exact authorized inbound event."
        : "The exact authorized foreground run did not complete unambiguously.", [started?.id, run?.id, completion?.id]),
      providerAcceptance: stage(providerAcceptancePassed, providerAcceptancePassed
        ? "The exact reply digest and reply target are bound to a real provider message acceptance."
        : "No unique exact-digest provider acceptance for a text reply to this inbound message was found.", [intent?.id, acceptance?.id]),
      authenticatedDeliveryStatus: stage(authenticatedDeliveryStatusPassed, authenticatedDeliveryStatusPassed
        ? `An authenticated provider callback proves ${statusEvent?.type.endsWith(".read") ? "read" : "delivery"}; its projection and causal binding agree.`
        : `No authenticated ${minimumStatus} callback with an exact acceptance binding and matching projection was found.`, [statusWebhook?.id, statusEvent?.id, reconciliation?.id]),
    };
    const passed = Object.values(stages).every((value) => value.passed);
    const evidence = {
      ...(run ? { runId: run.id } : {}),
      ...(ingressReceipt ? { ingressReceiptId: stableId("receipt", `${input.tenantId}:webhook:${input.connectorId}:${ingressReceipt.external_id}`) } : {}),
      ...(ingress ? { ingressEventId: ingress.id } : {}),
      ...(authorization ? { authorizationEventId: authorization.id } : {}),
      ...(source ? { sourceEventId: source.id } : {}),
      ...(completion ? { completionEventId: completion.id } : {}),
      ...(intent ? { deliveryIntentId: intent.id } : {}),
      ...(acceptance ? { acceptanceEventId: acceptance.id } : {}),
      ...(statusWebhook ? { statusWebhookEventId: statusWebhook.id } : {}),
      ...(statusEvent ? { statusEventId: statusEvent.id } : {}),
      ...(reconciliation ? { reconciliationEventId: reconciliation.id } : {}),
      ...(providerMessageId ? { providerMessageIdHash: stableId("provider-message", providerMessageId) } : {}),
      ...(peerId ? { peerIdHash: stableId("peer", peerId) } : {}),
    };
    const proof = { tenantId: input.tenantId, connectorId: input.connectorId, minimumStatus, selector, deployment: {
      environment: input.environment,
      ...(normalizedSince ? { since: normalizedSince } : {}),
      ...(input.expectedReleaseId ? { expectedReleaseId: input.expectedReleaseId } : {}),
      ...(run?.releaseId ? { actualReleaseId: run.releaseId } : {}),
      ...(run?.releaseDigest ? { releaseDigest: run.releaseDigest } : {}),
      ...(run?.provider ? { provider: run.provider } : {}),
      ...(run?.model ? { model: run.model } : {}),
    }, actualStatus, evidence, stages };
    return {
      schemaVersion: 1,
      qualificationId: stableId("connector-qualification", JSON.stringify(proof)),
      qualifiedAt: new Date().toISOString(),
      ...proof,
      passed,
    };
  }
}
