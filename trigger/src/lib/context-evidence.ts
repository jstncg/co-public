import type { AwarenessEvidence } from "@co/awareness";
import type { HarnessEvidenceItem } from "@co/collaboration-harness";
import type { Db } from "./db";

type ContextEventRow = {
  id: string;
  user_id: string;
  source_id: string | null;
  source_kind: "messaging" | "calendar" | "email";
  event_kind: AwarenessEvidence["eventKind"];
  resource_type: "message" | "calendar_item" | "email_item";
  resource_id: string;
  occurred_at: string;
  effective_from: string | null;
  effective_to: string | null;
  state: string;
};

export type ResolvedContextEvidence = {
  awareness: AwarenessEvidence;
  harness: HarnessEvidenceItem;
};

function unavailableError() {
  return new Error("context packet contains missing, empty, revoked, superseded, or analysis-restricted evidence");
}

export async function loadContextEvidence(
  db: Db,
  userId: string,
  eventIds: string[],
  options: { allowRestricted?: boolean; skipUnavailable?: boolean } = {},
): Promise<ResolvedContextEvidence[]> {
  if (eventIds.length === 0) return [];
  const uniqueIds = [...new Set(eventIds)];
  const eventResult = await db.from("context_events")
    .select("id,user_id,source_id,source_kind,event_kind,resource_type,resource_id,occurred_at,effective_from,effective_to,state")
    .eq("user_id", userId).in("id", uniqueIds);
  if (eventResult.error) throw eventResult.error;
  const eventRows = (eventResult.data ?? []) as ContextEventRow[];
  if (!options.skipUnavailable && eventRows.length !== uniqueIds.length) throw unavailableError();

  const messageIds = eventRows.filter((row) => row.resource_type === "message").map((row) => row.resource_id);
  const calendarIds = eventRows.filter((row) => row.resource_type === "calendar_item").map((row) => row.resource_id);
  const emailIds = eventRows.filter((row) => row.resource_type === "email_item").map((row) => row.resource_id);
  const sourceIds = eventRows.flatMap((row) => row.source_id ? [row.source_id] : []);
  const [messageResult, calendarResult, emailResult, sourceResult] = await Promise.all([
    messageIds.length > 0
      ? db.from("messages").select("id,direction,text,media_urls,sent_at,transport")
        .eq("user_id", userId).in("id", messageIds)
      : Promise.resolve({ data: [], error: null }),
    calendarIds.length > 0
      ? db.from("calendar_context_items")
        .select("id,source_id,starts_at,ends_at,timezone,is_all_day,status,availability,title,location,notes,analysis_allowed,sensitivity,superseded_at")
        .eq("user_id", userId).in("id", calendarIds)
      : Promise.resolve({ data: [], error: null }),
    emailIds.length > 0
      ? db.from("email_context_items")
        .select("id,source_id,internal_date,sender,recipients,subject,sent_date,snippet,label_ids,analysis_allowed,sensitivity,tombstone")
        .eq("user_id", userId).in("id", emailIds)
      : Promise.resolve({ data: [], error: null }),
    sourceIds.length > 0
      ? db.from("context_sources").select("id,access_mode,status")
        .eq("user_id", userId).in("id", sourceIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (messageResult.error) throw messageResult.error;
  if (calendarResult.error) throw calendarResult.error;
  if (emailResult.error) throw emailResult.error;
  if (sourceResult.error) throw sourceResult.error;

  const messages = new Map((messageResult.data ?? []).map((row) => [String(row.id), row]));
  const calendar = new Map((calendarResult.data ?? []).map((row) => [String(row.id), row]));
  const emails = new Map((emailResult.data ?? []).map((row) => [String(row.id), row]));
  const sources = new Map((sourceResult.data ?? []).map((row) => [String(row.id), row]));

  const resolved = eventRows.map((event): ResolvedContextEvidence | null => {
    if (event.resource_type === "message") {
      const message = messages.get(event.resource_id);
      if (!message) {
        if (options.skipUnavailable) return null;
        throw unavailableError();
      }
      const text = String(message.text ?? "").trim() ||
        (Array.isArray(message.media_urls) && message.media_urls.length > 0
          ? `Message with ${message.media_urls.length} media attachment(s).`
          : "");
      if (!text) {
        if (options.skipUnavailable) return null;
        throw unavailableError();
      }
      const direction = String(message.direction);
      return {
        awareness: {
          evidenceType: "context_event",
          id: event.id,
          text: text.slice(0, 8_000),
          sourceKind: "messaging",
          occurredAt: event.occurred_at,
          effectiveFrom: event.effective_from,
          effectiveTo: event.effective_to,
          eventKind: event.event_kind,
          analysisAllowed: true,
          sensitivity: "medium",
          confidence: 1,
          subjectRelation: direction === "inbound" ? "user" : "source",
        },
        harness: {
          evidence_type: "context_event",
          evidence_id: event.id,
          text: text.slice(0, 8_000),
          metadata: {
            source_kind: "messaging",
            event_kind: event.event_kind ?? "unknown",
            direction,
            occurred_at: event.occurred_at,
          },
        },
      };
    }

    if (event.resource_type === "email_item") {
      const item = emails.get(event.resource_id);
      const source = event.source_id ? sources.get(event.source_id) : undefined;
      if (!item || !source || source.status !== "active" || item.tombstone) {
        if (options.skipUnavailable) return null;
        throw unavailableError();
      }
      const analysisAllowed = Boolean(item.analysis_allowed);
      const sensitivity = String(item.sensitivity) as AwarenessEvidence["sensitivity"];
      if (!options.allowRestricted && (!analysisAllowed || sensitivity === "high")) {
        if (options.skipUnavailable) return null;
        throw unavailableError();
      }
      const parts = [
        item.sender ? `Email from: ${String(item.sender).slice(0, 1_000)}.` : "Email received.",
        item.subject ? `Subject: ${String(item.subject).slice(0, 1_000)}.` : "",
        item.sent_date ? `Sent: ${String(item.sent_date).slice(0, 256)}.` : "",
      ];
      if (source.access_mode === "snippet" && item.snippet) {
        parts.push(`Snippet: ${String(item.snippet).slice(0, 1_000)}.`);
      }
      const text = parts.filter(Boolean).join(" ").slice(0, 8_000);
      return {
        awareness: {
          evidenceType: "context_event",
          id: event.id,
          text,
          sourceKind: "email",
          occurredAt: event.occurred_at,
          effectiveFrom: event.effective_from,
          effectiveTo: event.effective_to,
          eventKind: event.event_kind,
          analysisAllowed,
          sensitivity,
          confidence: 1,
          subjectRelation: "source",
        },
        harness: {
          evidence_type: "context_event",
          evidence_id: event.id,
          text,
          metadata: {
            source_kind: "email",
            event_kind: event.event_kind ?? "unknown",
            access_mode: String(source.access_mode),
            occurred_at: event.occurred_at,
          },
        },
      };
    }

    const item = calendar.get(event.resource_id);
    const source = event.source_id ? sources.get(event.source_id) : undefined;
    if (!item || !source || source.status !== "active") {
      if (options.skipUnavailable) return null;
      throw unavailableError();
    }
    if (item.superseded_at !== null && event.event_kind !== "calendar_deleted") {
      if (options.skipUnavailable) return null;
      throw unavailableError();
    }
    const analysisAllowed = Boolean(item.analysis_allowed);
    const sensitivity = String(item.sensitivity) as AwarenessEvidence["sensitivity"];
    if (!options.allowRestricted && (!analysisAllowed || sensitivity === "high")) {
      if (options.skipUnavailable) return null;
      throw unavailableError();
    }
    const availability = [
      `Calendar availability: ${String(item.availability)}.`,
      `From ${String(item.starts_at)} to ${String(item.ends_at)} (${String(item.timezone)}).`,
      `Status: ${String(item.status)}${item.is_all_day ? "; all day" : ""}.`,
    ];
    if (source.access_mode === "details") {
      if (item.title) availability.push(`Title: ${String(item.title).slice(0, 1_000)}.`);
      if (item.location) availability.push(`Location: ${String(item.location).slice(0, 1_000)}.`);
      if (item.notes) availability.push(`Notes: ${String(item.notes).slice(0, 4_000)}.`);
    }
    const text = availability.join(" ").slice(0, 8_000);
    return {
      awareness: {
        evidenceType: "context_event",
        id: event.id,
        text,
        sourceKind: "calendar",
        occurredAt: event.occurred_at,
        effectiveFrom: event.effective_from,
        effectiveTo: event.effective_to,
        eventKind: event.event_kind,
        analysisAllowed,
        sensitivity,
        confidence: 1,
        subjectRelation: "user",
      },
      harness: {
        evidence_type: "context_event",
        evidence_id: event.id,
        text,
        metadata: {
          source_kind: "calendar",
          event_kind: event.event_kind ?? "unknown",
          access_mode: String(source.access_mode),
          occurred_at: event.occurred_at,
        },
      },
    };
  });

  const available = resolved.filter((item): item is ResolvedContextEvidence => item !== null);
  const byId = new Map(available.map((item) => [item.awareness.id, item]));
  return uniqueIds.flatMap((id) => {
    const item = byId.get(id);
    if (!item) {
      if (options.skipUnavailable) return [];
      throw unavailableError();
    }
    return [item];
  });
}
