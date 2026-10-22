import {
  gmailContextItemSchema,
  gmailHistorySyncSchema,
  type GmailContextItem,
  type GmailHistorySync,
} from "@co/contracts";
import { z } from "zod";
import { redactWorkspaceText } from "./redaction";

const gmailProfileSchema = z
  .object({
    emailAddress: z.email(),
    historyId: z.string().regex(/^\d{1,40}$/u),
  })
  .strip();

const gmailWatchResponseSchema = z
  .object({
    historyId: z.string().regex(/^\d{1,40}$/u),
    expiration: z.string().regex(/^\d{10,20}$/u),
  })
  .strip();

const gmailMessageSchema = z
  .object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    historyId: z
      .string()
      .regex(/^\d{1,40}$/u)
      .optional(),
    internalDate: z.string().regex(/^\d{1,20}$/u),
    labelIds: z.array(z.string()).default([]),
    snippet: z.string().default(""),
    payload: z
      .object({
        headers: z
          .array(
            z
              .object({
                name: z.string(),
                value: z.string(),
              })
              .strip(),
          )
          .default([]),
      })
      .strip()
      .optional(),
  })
  .strip();

const historyMessageSchema = z
  .object({
    message: z.object({ id: z.string().min(1) }).passthrough(),
  })
  .strip();

const historyLabelSchema = historyMessageSchema.extend({
  labelIds: z.array(z.string()).default([]),
});

const gmailHistoryPageSchema = z
  .object({
    history: z
      .array(
        z
          .object({
            id: z.string().regex(/^\d{1,40}$/u),
            messagesAdded: z.array(historyMessageSchema).default([]),
            messagesDeleted: z.array(historyMessageSchema).default([]),
            labelsAdded: z.array(historyLabelSchema).default([]),
            labelsRemoved: z.array(historyLabelSchema).default([]),
          })
          .strip(),
      )
      .default([]),
    historyId: z
      .string()
      .regex(/^\d{1,40}$/u)
      .optional(),
    nextPageToken: z.string().min(1).optional(),
  })
  .strip();

const gmailMessageListSchema = z
  .object({
    messages: z.array(z.object({ id: z.string().min(1) }).strip()).default([]),
    nextPageToken: z.string().min(1).optional(),
  })
  .strip();

export type GmailFetch = typeof fetch;

export class GmailApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

export class GmailHistoryCursorExpiredError extends GmailApiError {
  constructor() {
    super(404, "Gmail history cursor expired");
    this.name = "GmailHistoryCursorExpiredError";
  }
}

export type GmailWatch = {
  emailAddress: string;
  historyId: string;
  expiresAt: string;
};

type GmailClientOptions = {
  fetch?: GmailFetch;
  timeoutMs?: number;
  maxHistoryPages?: number;
  maxMessages?: number;
  metadataConcurrency?: number;
};

type HistoryChanges = {
  received: Set<string>;
  updated: Set<string>;
  removed: Set<string>;
  nextHistoryId: string;
};

export class GmailClient {
  readonly #fetch: GmailFetch;
  readonly #timeoutMs: number;
  readonly #maxHistoryPages: number;
  readonly #maxMessages: number;
  readonly #metadataConcurrency: number;

  constructor(options: GmailClientOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxHistoryPages = options.maxHistoryPages ?? 20;
    this.#maxMessages = options.maxMessages ?? 500;
    this.#metadataConcurrency = options.metadataConcurrency ?? 8;
  }

  async profile(accessToken: string, signal?: AbortSignal) {
    const value = await this.#request("/users/me/profile", accessToken, { signal });
    return gmailProfileSchema.parse(value);
  }

  async watch(input: {
    accessToken: string;
    topicName: string;
    signal?: AbortSignal;
  }): Promise<GmailWatch> {
    if (
      !/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~-]{2,254}$/u.test(
        input.topicName,
      )
    ) {
      throw new Error("invalid Gmail Pub/Sub topic name");
    }
    const [profile, watched] = await Promise.all([
      this.profile(input.accessToken, input.signal),
      this.#request("/users/me/watch", input.accessToken, {
        body: {
          labelFilterBehavior: "INCLUDE",
          labelIds: ["INBOX"],
          topicName: input.topicName,
        },
        method: "POST",
        signal: input.signal,
      }).then((value) => gmailWatchResponseSchema.parse(value)),
    ]);
    return {
      emailAddress: profile.emailAddress.toLocaleLowerCase(),
      historyId: watched.historyId,
      expiresAt: new Date(Number(watched.expiration)).toISOString(),
    };
  }

  async stop(accessToken: string, signal?: AbortSignal) {
    await this.#request("/users/me/stop", accessToken, { method: "POST", signal });
  }

  async syncHistory(input: {
    accessToken: string;
    startHistoryId: string;
    signal?: AbortSignal;
  }): Promise<GmailHistorySync> {
    const changes = await this.#historyChanges(input);
    const ids = [...new Set([...changes.received, ...changes.updated])].slice(0, this.#maxMessages);
    const messages = await mapConcurrent(ids, this.#metadataConcurrency, (id) =>
      this.#message(input.accessToken, id, input.signal),
    );
    const items: GmailContextItem[] = [];
    for (const [index, message] of messages.entries()) {
      if (message === null) {
        const id = ids[index];
        if (id !== undefined) changes.removed.add(id);
        continue;
      }
      if (!message.labelIds.includes("INBOX")) {
        changes.removed.add(message.id);
        continue;
      }
      items.push(
        normalizeMessage(
          message,
          changes.received.has(message.id) ? "received" : "updated",
          changes.nextHistoryId,
        ),
      );
      changes.removed.delete(message.id);
    }
    return gmailHistorySyncSchema.parse({
      next_history_id: changes.nextHistoryId,
      items,
      deleted_external_ids: [...changes.removed].slice(0, this.#maxMessages),
      reconciliation: false,
    });
  }

  async reconcileInbox(input: {
    accessToken: string;
    signal?: AbortSignal;
  }): Promise<GmailHistorySync> {
    const profile = await this.profile(input.accessToken, input.signal);
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < this.#maxHistoryPages && ids.length < this.#maxMessages; page += 1) {
      const query = new URLSearchParams({
        maxResults: String(Math.min(100, this.#maxMessages - ids.length)),
        q: "in:inbox newer_than:30d",
      });
      if (pageToken) query.set("pageToken", pageToken);
      const response = gmailMessageListSchema.parse(
        await this.#request(`/users/me/messages?${query.toString()}`, input.accessToken, {
          signal: input.signal,
        }),
      );
      ids.push(...response.messages.map((message) => message.id));
      pageToken = response.nextPageToken;
      if (!pageToken) break;
    }
    const messages = await mapConcurrent(
      [...new Set(ids)].slice(0, this.#maxMessages),
      this.#metadataConcurrency,
      (id) => this.#message(input.accessToken, id, input.signal),
    );
    const items: GmailContextItem[] = [];
    for (const message of messages) {
      if (message !== null && message.labelIds.includes("INBOX")) {
        items.push(normalizeMessage(message, "updated", profile.historyId));
      }
    }
    return gmailHistorySyncSchema.parse({
      next_history_id: profile.historyId,
      items,
      deleted_external_ids: [],
      reconciliation: true,
    });
  }

  async #historyChanges(input: {
    accessToken: string;
    startHistoryId: string;
    signal?: AbortSignal;
  }): Promise<HistoryChanges> {
    if (!/^\d{1,40}$/u.test(input.startHistoryId)) throw new Error("invalid Gmail history cursor");
    const received = new Set<string>();
    const updated = new Set<string>();
    const removed = new Set<string>();
    let nextHistoryId = input.startHistoryId;
    let pageToken: string | undefined;
    for (let page = 0; page < this.#maxHistoryPages; page += 1) {
      const query = new URLSearchParams({
        maxResults: "500",
        startHistoryId: input.startHistoryId,
      });
      if (pageToken) query.set("pageToken", pageToken);
      let value: unknown;
      try {
        value = await this.#request(`/users/me/history?${query.toString()}`, input.accessToken, {
          signal: input.signal,
        });
      } catch (error) {
        if (error instanceof GmailApiError && error.status === 404) {
          throw new GmailHistoryCursorExpiredError();
        }
        throw error;
      }
      const response = gmailHistoryPageSchema.parse(value);
      if (response.historyId) nextHistoryId = maxHistoryId(nextHistoryId, response.historyId);
      for (const history of response.history) {
        nextHistoryId = maxHistoryId(nextHistoryId, history.id);
        for (const entry of history.messagesAdded) received.add(entry.message.id);
        for (const entry of history.messagesDeleted) removed.add(entry.message.id);
        for (const entry of history.labelsAdded) {
          if (entry.labelIds.includes("INBOX")) updated.add(entry.message.id);
        }
        for (const entry of history.labelsRemoved) {
          if (entry.labelIds.includes("INBOX")) removed.add(entry.message.id);
        }
      }
      if (received.size + updated.size + removed.size > this.#maxMessages) {
        throw new Error("Gmail history delta exceeds the bounded sync size");
      }
      pageToken = response.nextPageToken;
      if (!pageToken) break;
      if (page === this.#maxHistoryPages - 1) {
        throw new Error("Gmail history delta exceeds the bounded page count");
      }
    }
    for (const id of received) removed.delete(id);
    return { received, updated, removed, nextHistoryId };
  }

  async #message(accessToken: string, id: string, signal?: AbortSignal) {
    const query = new URLSearchParams({ format: "metadata" });
    for (const header of ["From", "To", "Cc", "Subject", "Date", "Message-ID"]) {
      query.append("metadataHeaders", header);
    }
    try {
      return gmailMessageSchema.parse(
        await this.#request(
          `/users/me/messages/${encodeURIComponent(id)}?${query.toString()}`,
          accessToken,
          { signal },
        ),
      );
    } catch (error) {
      // Messages can disappear between a history/list response and the metadata fetch.
      if (error instanceof GmailApiError && error.status === 404) return null;
      throw error;
    }
  }

  async #request(
    path: string,
    accessToken: string,
    options: {
      body?: unknown;
      method?: "GET" | "POST";
      signal?: AbortSignal | undefined;
    } = {},
  ) {
    if (accessToken.length < 8) throw new Error("Gmail access token is unavailable");
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await this.#fetch(`https://gmail.googleapis.com/gmail/v1${path}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      method: options.method ?? "GET",
      signal,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) {
      throw new GmailApiError(
        response.status,
        `Gmail API request failed with status ${response.status}`,
      );
    }
    if (response.status === 204) return {};
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > 2_000_000) throw new Error("Gmail API response is too large");
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error("Gmail API response is too large");
    return text ? (JSON.parse(text) as unknown) : {};
  }
}

function normalizeMessage(
  message: z.infer<typeof gmailMessageSchema>,
  changeKind: GmailContextItem["change_kind"],
  fallbackHistoryId: string,
): GmailContextItem {
  const headers = new Map(
    (message.payload?.headers ?? []).map((header) => [
      header.name.toLocaleLowerCase(),
      header.value,
    ]),
  );
  const internalDate = Number(message.internalDate);
  if (!Number.isFinite(internalDate) || internalDate <= 0) {
    throw new Error("Gmail message has an invalid internal date");
  }
  const occurredAt = new Date(internalDate).toISOString();
  const optional = (name: string, maximum: number) => {
    const value = headers.get(name)?.trim();
    return value ? redactWorkspaceText(value, maximum) : null;
  };
  return gmailContextItemSchema.parse({
    external_id: message.id,
    thread_id: message.threadId,
    history_id: message.historyId ?? fallbackHistoryId,
    internal_date: occurredAt,
    change_kind: changeKind,
    from: optional("from", 1_000),
    to: optional("to", 2_000),
    cc: optional("cc", 2_000),
    subject: optional("subject", 1_000),
    sent_date: optional("date", 256),
    snippet: message.snippet ? redactWorkspaceText(message.snippet, 1_000) : null,
    label_ids: [...new Set(message.labelIds)].slice(0, 100),
    analysis_allowed: true,
    sensitivity: "medium",
  });
}

function maxHistoryId(left: string, right: string) {
  return BigInt(left) >= BigInt(right) ? left : right;
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
) {
  const output: R[] = [];
  output.length = values.length;
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) output[index] = await transform(value);
      }
    },
  );
  await Promise.all(workers);
  return output;
}
