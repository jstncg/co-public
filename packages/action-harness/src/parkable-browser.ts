import { randomUUID } from "node:crypto";
import type {
  ActionBlocker,
  ActionExecutorManifest,
  ActionExecutorReceipt,
  ActionExecutorResult,
  ActionResumeRequest,
} from "@co/contracts";
import { ApprovalRequiredError, RestrictedBrowserTools } from "./browser";
import type { BrowserToolTrace, OriginLockedSecretInjector } from "./browser";
import type { DevtoolsPage } from "./cdp";
import type { ActionExecutionContext, ActionExecutor } from "./types";

export type BrowserWorkerOutcome =
  | { kind: "completed"; receipt: ActionExecutorReceipt }
  | { kind: "blocked"; blocker: ActionBlocker }
  | { kind: "failed"; code: string; message: string; retryable: boolean };

export interface BrowserWorkerAgent {
  run(input: {
    phase: "begin" | "resume" | "reconcile";
    context: ActionExecutionContext;
    tools: RestrictedBrowserTools;
    resolution: ActionResumeRequest | null;
  }): Promise<BrowserWorkerOutcome>;
}

export type ParkedBrowserSession = {
  run_id: string;
  checkpoint_ref: string;
  page: DevtoolsPage;
};

export interface ParkableBrowserProvider {
  create(runId: string): Promise<ParkedBrowserSession>;
  resume(runId: string, checkpointRef: string): Promise<ParkedBrowserSession>;
  reconcile(runId: string, checkpointRef: string | null): Promise<ParkedBrowserSession>;
  close(runId: string): Promise<void>;
}

export class InMemoryParkableBrowserProvider implements ParkableBrowserProvider {
  readonly #sessions = new Map<string, ParkedBrowserSession>();

  constructor(private readonly createPage: (runId: string) => Promise<DevtoolsPage>) {}

  async create(runId: string) {
    if (this.#sessions.has(runId)) throw new Error("browser run already exists");
    const session = {
      run_id: runId,
      checkpoint_ref: randomUUID(),
      page: await this.createPage(runId),
    };
    this.#sessions.set(runId, session);
    return session;
  }

  async resume(runId: string, checkpointRef: string) {
    const session = this.#sessions.get(runId);
    if (!session || session.checkpoint_ref !== checkpointRef)
      throw new Error("parked browser session unavailable");
    return session;
  }

  async reconcile(runId: string, checkpointRef: string | null) {
    const session = this.#sessions.get(runId);
    if (!session || (checkpointRef && session.checkpoint_ref !== checkpointRef)) {
      throw new Error("browser session cannot be reconciled");
    }
    return session;
  }

  async close(runId: string) {
    const session = this.#sessions.get(runId);
    if (!session) return;
    session.page.close();
    this.#sessions.delete(runId);
  }

  inspect(runId: string) {
    return this.#sessions.get(runId) ?? null;
  }
}

export class ParkableBrowserExecutor implements ActionExecutor {
  readonly manifest: ActionExecutorManifest;
  readonly #traceByRun = new Map<string, BrowserToolTrace[]>();

  constructor(input: {
    adapter: string;
    capabilities: string[];
    provider: ParkableBrowserProvider;
    injector: OriginLockedSecretInjector;
    agent: BrowserWorkerAgent;
    now?: () => Date;
  }) {
    this.provider = input.provider;
    this.injector = input.injector;
    this.agent = input.agent;
    this.now = input.now ?? (() => new Date());
    this.manifest = {
      worker_kind: "browser",
      adapter: input.adapter,
      supported_capabilities: input.capabilities,
      can_message_user: false,
      secret_transport: "opaque_refs",
      untrusted_content: "data_only",
      capability_enforcement: "per_invocation",
      network_policy: "allowlist",
      supports_pause_resume: true,
      supports_reconciliation: true,
    };
  }

  private readonly provider: ParkableBrowserProvider;
  private readonly injector: OriginLockedSecretInjector;
  private readonly agent: BrowserWorkerAgent;
  private readonly now: () => Date;

  async begin(context: ActionExecutionContext) {
    const session = await this.provider.create(context.run_id);
    return this.#run("begin", context, session, null);
  }

  async resume(
    context: ActionExecutionContext,
    checkpointRef: string,
    resolution: ActionResumeRequest,
  ) {
    const session = await this.provider.resume(context.run_id, checkpointRef);
    return this.#run("resume", context, session, resolution);
  }

  async reconcile(context: ActionExecutionContext, checkpointRef: string | null) {
    const session = await this.provider.reconcile(context.run_id, checkpointRef);
    return this.#run("reconcile", context, session, null);
  }

  async cancel(context: Omit<ActionExecutionContext, "signal">) {
    await this.provider.close(context.run_id);
  }

  trace(runId: string) {
    return (this.#traceByRun.get(runId) ?? []).map((event) => ({ ...event }));
  }

  async #run(
    phase: "begin" | "resume" | "reconcile",
    context: ActionExecutionContext,
    session: ParkedBrowserSession,
    resolution: ActionResumeRequest | null,
  ): Promise<ActionExecutorResult> {
    const tools = new RestrictedBrowserTools(
      context,
      session.page,
      this.injector,
      undefined,
      this.now,
    );
    try {
      const outcome = await this.agent.run({ phase, context, tools, resolution });
      this.#appendTrace(context.run_id, tools.trace());
      if (outcome.kind === "blocked") {
        return {
          kind: "blocked",
          checkpoint_ref: session.checkpoint_ref,
          blocker: outcome.blocker,
        };
      }
      await this.provider.close(context.run_id);
      return outcome;
    } catch (error) {
      this.#appendTrace(context.run_id, tools.trace());
      if (error instanceof ApprovalRequiredError) {
        return { kind: "blocked", checkpoint_ref: session.checkpoint_ref, blocker: error.blocker };
      }
      await this.provider.close(context.run_id);
      return {
        kind: "failed",
        code: "browser_worker_failed",
        message: "browser worker failed",
        retryable: false,
      };
    }
  }

  #appendTrace(runId: string, events: BrowserToolTrace[]) {
    const existing = this.#traceByRun.get(runId) ?? [];
    this.#traceByRun.set(runId, [
      ...existing,
      ...events.map((event, index) => ({
        ...event,
        sequence: existing.length + index,
      })),
    ]);
  }
}
