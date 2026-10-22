import { actionExecutorManifestSchema } from "@co/contracts";
import type { ActionExecutor } from "./types";

export class ActionExecutorRegistry {
  readonly #executors = new Map<string, ActionExecutor>();

  register(executor: ActionExecutor) {
    const manifest = actionExecutorManifestSchema.parse(executor.manifest);
    const key = `${manifest.worker_kind}:${manifest.adapter}`;
    if (this.#executors.has(key)) throw new Error(`action executor already registered: ${key}`);
    this.#executors.set(key, executor);
    return this;
  }

  resolve(workerKind: string, adapter: string) {
    const executor = this.#executors.get(`${workerKind}:${adapter}`);
    if (!executor) throw new Error(`no action executor registered for ${workerKind}:${adapter}`);
    return executor;
  }
}
