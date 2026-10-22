import type { ActionBlocker } from "@co/contracts";
import type { ActionExecutionContext } from "./types";
import type { DevtoolsPage } from "./cdp";
import type { WorkspaceBoundVault } from "./vault";

export type BrowserToolName =
  | "navigate"
  | "read"
  | "fill_public"
  | "fill_secret"
  | "screenshot"
  | "submit";
export type BrowserToolTrace = {
  sequence: number;
  tool: BrowserToolName;
  capability: string;
  browser_call: true;
  occurred_at: string;
};

type ToolPolicy = {
  capability: string;
  approval?: (input: {
    context: ActionExecutionContext;
    effectFingerprint: string | null;
  }) => boolean;
};

export const browserToolPolicies: Record<BrowserToolName, ToolPolicy> = {
  navigate: { capability: "web.navigate" },
  read: { capability: "web.read" },
  fill_public: { capability: "web.fill" },
  fill_secret: { capability: "vault.fill" },
  screenshot: { capability: "web.screenshot" },
  submit: {
    capability: "web.submit",
    approval: ({ context, effectFingerprint }) =>
      Boolean(effectFingerprint) && context.active_approval_fingerprint === effectFingerprint,
  },
};

export class ApprovalRequiredError extends Error {
  constructor(readonly blocker: Extract<ActionBlocker, { type: "approval" }>) {
    super("exact approval required");
  }
}

export class DeclarativeBrowserToolGate {
  authorize(input: {
    tool: BrowserToolName;
    context: ActionExecutionContext;
    effectFingerprint?: string;
    stepId?: string;
    approvalPrompt?: string;
    now?: Date;
  }) {
    const policy = browserToolPolicies[input.tool];
    const hasCapability = input.context.assignment.authorized_capabilities.includes(
      policy.capability,
    );
    const approvalSatisfied =
      !policy.approval ||
      policy.approval({
        context: input.context,
        effectFingerprint: input.effectFingerprint ?? null,
      });
    if (hasCapability && approvalSatisfied) return policy.capability;
    if (policy.approval && input.context.assignment.authority === "execute_after_approval") {
      const fingerprint = input.effectFingerprint;
      if (!fingerprint?.match(/^[a-f0-9]{64}$/) || !input.stepId || !input.approvalPrompt) {
        throw new Error("approval-bound tool requires a step, prompt, and effect fingerprint");
      }
      throw new ApprovalRequiredError({
        type: "approval",
        step_id: input.stepId,
        prompt: input.approvalPrompt,
        request_hash: input.context.request_hash,
        effect_fingerprint: fingerprint,
        expires_at: new Date((input.now ?? new Date()).getTime() + 15 * 60_000).toISOString(),
      });
    }
    throw new Error(`browser capability unavailable: ${policy.capability}`);
  }
}

export class OriginLockedSecretInjector {
  constructor(private readonly vault: WorkspaceBoundVault) {}

  async fill(input: { workspaceId: string; handle: string; selector: string; page: DevtoolsPage }) {
    const currentOrigin = await input.page.currentOrigin();
    return this.vault.withSecret(
      {
        workspaceId: input.workspaceId,
        handle: input.handle,
        currentOrigin,
      },
      async (secret, metadata) => {
        // Check the origin again inside the same privileged browser call that performs the fill. The
        // pre-decryption check limits exposure; this atomic check closes a navigation race after it.
        await input.page.injectSecret(input.selector, secret, metadata.origin);
        return {
          filled: true as const,
          handle: input.handle,
          origin: metadata.origin,
          kind: metadata.kind,
        };
      },
    );
  }
}

export class RestrictedBrowserTools {
  readonly #trace: BrowserToolTrace[] = [];

  constructor(
    private readonly context: ActionExecutionContext,
    private readonly page: DevtoolsPage,
    private readonly injector: OriginLockedSecretInjector,
    private readonly gate = new DeclarativeBrowserToolGate(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async navigate(url: string) {
    const capability = this.gate.authorize({ tool: "navigate", context: this.context });
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      !this.context.assignment.target.allowed_origins.includes(parsed.origin)
    ) {
      throw new Error("browser navigation origin is not allowed");
    }
    await this.page.navigate(parsed.toString());
    this.#record("navigate", capability);
  }

  async read(selector: string | null = null) {
    const capability = this.gate.authorize({ tool: "read", context: this.context });
    const value = await this.page.readVisibleText(selector);
    this.#record("read", capability);
    return value.slice(0, 100_000);
  }

  async fillPublic(selector: string, value: string) {
    const capability = this.gate.authorize({ tool: "fill_public", context: this.context });
    if (value.length > 20_000) throw new Error("public browser input is too large");
    await this.page.fillPublic(selector, value);
    this.#record("fill_public", capability);
  }

  async fillSecret(handle: string, selector: string) {
    const capability = this.gate.authorize({ tool: "fill_secret", context: this.context });
    if (!this.context.assignment.vault_refs.some((reference) => reference.id === handle)) {
      throw new Error("vault handle is not assigned to this worker");
    }
    const receipt = await this.injector.fill({
      workspaceId: this.context.tenant_id,
      handle,
      selector,
      page: this.page,
    });
    this.#record("fill_secret", capability);
    return receipt;
  }

  async screenshot() {
    const capability = this.gate.authorize({ tool: "screenshot", context: this.context });
    const screenshot = await this.page.screenshot();
    this.#record("screenshot", capability);
    return screenshot;
  }

  async submit(input: {
    selector: string;
    stepId: string;
    effectFingerprint: string;
    approvalPrompt: string;
  }) {
    const capability = this.gate.authorize({
      tool: "submit",
      context: this.context,
      effectFingerprint: input.effectFingerprint,
      stepId: input.stepId,
      approvalPrompt: input.approvalPrompt,
      now: this.now(),
    });
    await this.page.click(input.selector);
    this.#record("submit", capability);
  }

  trace() {
    return this.#trace.map((event) => ({ ...event }));
  }

  sessionIdForEval() {
    return this.page.sessionId;
  }

  async secretFieldPresentationForEval(selector: string) {
    return this.page.secretFieldPresentation(selector);
  }

  methodAuditForEval() {
    return this.page.methodAudit();
  }

  #record(tool: BrowserToolName, capability: string) {
    this.#trace.push({
      sequence: this.#trace.length,
      tool,
      capability,
      browser_call: true,
      occurred_at: this.now().toISOString(),
    });
  }
}
