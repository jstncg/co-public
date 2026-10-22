import { actionEventSchema, actionRunSnapshotSchema } from "@co/contracts";
import type { ActionEvent, ActionRunSnapshot } from "@co/contracts";
import type { ActionRunJournal } from "./types";

export class InMemoryActionJournal implements ActionRunJournal {
  readonly #events: ActionEvent[] = [];
  readonly #listeners = new Set<(event: ActionEvent) => void>();
  readonly #snapshots = new Map<string, ActionRunSnapshot>();
  readonly #idempotency = new Map<string, string>();

  async initialize(unknownSnapshot: ActionRunSnapshot) {
    const snapshot = actionRunSnapshotSchema.parse(unknownSnapshot);
    const key = `${snapshot.request.tenant_id}:${snapshot.request.idempotency_key}`;
    const existingId = this.#idempotency.get(key);
    if (existingId) {
      const existing = this.#snapshots.get(existingId);
      if (!existing) throw new Error("action journal idempotency index is inconsistent");
      if (existing.request_hash !== snapshot.request_hash)
        throw new Error("action idempotency key reused with different input");
      return { created: false, snapshot: existing };
    }
    this.#idempotency.set(key, snapshot.run_id);
    this.#snapshots.set(snapshot.run_id, snapshot);
    return { created: true, snapshot };
  }

  async commit(
    expected: Pick<ActionRunSnapshot, "state" | "next_sequence" | "updated_at">,
    unknownEvent: ActionEvent,
    unknownSnapshot: ActionRunSnapshot,
  ) {
    const event = actionEventSchema.parse(unknownEvent);
    const snapshot = actionRunSnapshotSchema.parse(unknownSnapshot);
    const current = this.#snapshots.get(snapshot.run_id);
    if (!current || current.request.tenant_id !== snapshot.request.tenant_id)
      throw new Error("action run not found");
    if (
      current.next_sequence !== expected.next_sequence ||
      current.state !== expected.state ||
      current.updated_at !== expected.updated_at ||
      event.sequence !== expected.next_sequence
    ) {
      throw new Error("action journal sequence conflict");
    }
    if (snapshot.next_sequence !== expected.next_sequence + 1)
      throw new Error("action snapshot did not advance exactly once");
    this.#snapshots.set(snapshot.run_id, snapshot);
    this.#events.push(event);
    for (const listener of this.#listeners) listener(event);
  }

  async load(tenantId: string, runId: string) {
    const snapshot = this.#snapshots.get(runId);
    return snapshot?.request.tenant_id === tenantId ? snapshot : null;
  }

  list(runId?: string, afterSequence = -1) {
    return this.#events.filter(
      (event) => (!runId || event.run_id === runId) && event.sequence > afterSequence,
    );
  }

  subscribe(listener: (event: ActionEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export { InMemoryActionJournal as InMemoryActionMonitor };
