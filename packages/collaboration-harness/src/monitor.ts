import type { HarnessEvent } from "@co/contracts";
import type { HarnessEventSink } from "./types";

export class InMemoryHarnessMonitor implements HarnessEventSink {
  readonly #events: HarnessEvent[] = [];
  readonly #listeners = new Set<(event: HarnessEvent) => void>();

  async append(event: HarnessEvent) {
    this.#events.push(event);
    for (const listener of this.#listeners) listener(event);
  }

  list(runId?: string, afterSequence = -1) {
    return this.#events.filter((event) =>
      (!runId || event.run_id === runId) && event.sequence > afterSequence
    );
  }

  subscribe(listener: (event: HarnessEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

