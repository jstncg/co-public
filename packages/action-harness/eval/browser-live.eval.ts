import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ActionApprovalClaim, ActionExecutorReceipt, ActionRunRequest } from "@co/contracts";
import {
  ActionExecutorRegistry,
  ActionRunner,
  evaluateBrowserTask,
  hashActionRequest,
  InMemoryActionJournal,
  InMemoryEncryptedVaultStore,
  InMemoryParkableBrowserProvider,
  LocalChromeController,
  OriginLockedSecretInjector,
  ParkableBrowserExecutor,
  WorkspaceBoundVault,
} from "../src/index";
import type { BrowserWorkerAgent, RestrictedBrowserTools } from "../src/index";

const execFileAsync = promisify(execFile);
const tenantId = "11111111-1111-4111-8111-111111111111";
const otherTenantId = "22222222-2222-4222-8222-222222222222";
const moveId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const approvalId = "55555555-5555-4555-8555-555555555555";
const effectFingerprint = createHash("sha256")
  .update(
    JSON.stringify({ action: "submit_login", account: "eval-user", origin: "co-action.test" }),
  )
  .digest("hex");
const canary = "co-eval-secret-9f4e71";
const finalText = "signed in as eval-user";
const fixedNow = new Date("2026-08-29T19:00:00Z");

type Submission = { username: string; password: string };

class EvalBrowserAgent implements BrowserWorkerAgent {
  readonly sessionIds: string[] = [];
  screenshot: string | null = null;
  presentation: Awaited<
    ReturnType<RestrictedBrowserTools["secretFieldPresentationForEval"]>
  > | null = null;
  methodAudit: ReturnType<RestrictedBrowserTools["methodAuditForEval"]> = [];

  constructor(
    private readonly loginUrl: string,
    private readonly vaultHandle: string,
  ) {}

  async run(input: Parameters<BrowserWorkerAgent["run"]>[0]) {
    this.sessionIds.push(input.tools.sessionIdForEval());
    if (input.phase === "begin") {
      await input.tools.navigate(this.loginUrl);
      await input.tools.fillPublic("#username", "eval-user");
      await input.tools.fillSecret(this.vaultHandle, "#password");
      this.presentation = await input.tools.secretFieldPresentationForEval("#password");
      this.screenshot = await input.tools.screenshot();
      this.methodAudit = input.tools.methodAuditForEval();
      await input.tools.submit({
        selector: "#submit",
        stepId: "submit_login",
        effectFingerprint,
        approvalPrompt: "Sign in to the synthetic evaluation account as eval-user.",
      });
      throw new Error("submit unexpectedly bypassed approval");
    }

    await input.tools.submit({
      selector: "#submit",
      stepId: "submit_login",
      effectFingerprint,
      approvalPrompt: "Sign in to the synthetic evaluation account as eval-user.",
    });
    const confirmation = await input.tools.read("#confirmation");
    this.methodAudit = input.tools.methodAuditForEval();
    const receipt: ActionExecutorReceipt = {
      run_id: input.context.run_id,
      source_move_id: input.context.source_move_id,
      request_hash: input.context.request_hash,
      approval_fingerprint: input.context.active_approval_fingerprint,
      effect: "consequential",
      outcome: "completed",
      summary: confirmation,
      verification: {
        status: "verified",
        method: "confirmation_page_and_server_state",
        checked_at: fixedNow.toISOString(),
      },
      evidence: [
        {
          kind: "provider_receipt",
          ref: "eval-submission:1",
          label: "Synthetic login confirmation",
          captured_at: fixedNow.toISOString(),
        },
      ],
      rollback: null,
      completed_at: fixedNow.toISOString(),
    };
    return { kind: "completed" as const, receipt };
  }
}

async function main() {
  const chromePath = await findChrome();
  const fixture = await startHttpsFixture();
  let chrome: LocalChromeController | null = null;
  const vault = new WorkspaceBoundVault(randomBytes(32), new InMemoryEncryptedVaultStore());
  try {
    chrome = await LocalChromeController.launch({
      executablePath: chromePath,
      extraArgs: [
        "--ignore-certificate-errors",
        "--host-resolver-rules=MAP co-action.test 127.0.0.1, MAP evil-action.test 127.0.0.1",
      ],
    });
    const secretBytes = Buffer.from(canary, "utf8");
    const vaultReference = await vault.seal({
      workspaceId: tenantId,
      kind: "credential",
      origin: fixture.origin,
      secret: secretBytes,
      now: fixedNow,
    });
    secretBytes.fill(0);
    const injector = new OriginLockedSecretInjector(vault);

    const probe = await chrome.newPage();
    await probe.navigate(fixture.loginUrl);
    let crossTenantRejected = false;
    try {
      await injector.fill({
        workspaceId: otherTenantId,
        handle: vaultReference.handle,
        selector: "#password",
        page: probe,
      });
    } catch {
      crossTenantRejected = true;
    }
    await probe.navigate(fixture.evilLoginUrl);
    let wrongOriginRejected = false;
    try {
      await injector.fill({
        workspaceId: tenantId,
        handle: vaultReference.handle,
        selector: "#password",
        page: probe,
      });
    } catch {
      wrongOriginRejected = true;
    }
    probe.close();

    const provider = new InMemoryParkableBrowserProvider(async () => chrome!.newPage());
    const agent = new EvalBrowserAgent(fixture.loginUrl, vaultReference.handle);
    const executor = new ParkableBrowserExecutor({
      adapter: "local_cdp_eval",
      capabilities: [
        "web.navigate",
        "web.read",
        "web.fill",
        "vault.fill",
        "web.screenshot",
        "web.submit",
      ],
      provider,
      injector,
      agent,
      now: () => fixedNow,
    });
    const journal = new InMemoryActionJournal();
    const claims: { approval?: ActionApprovalClaim } = {};
    const runner = new ActionRunner(new ActionExecutorRegistry().register(executor), journal, {
      now: () => fixedNow,
      idFactory: () => runId,
      approvalVerifier: { verify: async () => claims.approval ?? null },
      vaultVerifier: {
        verify: async (reference, scope) =>
          reference.id === vaultReference.handle && scope.tenant_id === tenantId,
      },
    });
    const request: ActionRunRequest = {
      version: "action-run.v1",
      tenant_id: tenantId,
      source_move_id: moveId,
      idempotency_key: "action:live-browser-eval:login-v1",
      objective: "Sign in to the synthetic account and report the exact confirmation.",
      assignment: {
        worker_kind: "browser",
        adapter: "local_cdp_eval",
        effect: "consequential",
        authority: "execute_after_approval",
        capabilities: [
          "web.navigate",
          "web.read",
          "web.fill",
          "vault.fill",
          "web.screenshot",
          "web.submit",
        ],
        approval_bound_capabilities: ["web.submit"],
        target: { start_url: fixture.loginUrl, allowed_origins: [fixture.origin] },
        public_input: { username: "eval-user" },
        vault_refs: [{ id: vaultReference.handle, kind: "credential", purpose: "synthetic login" }],
      },
      expires_at: new Date(fixedNow.getTime() + 60 * 60_000).toISOString(),
    };
    const blocked = await runner.start(request);
    if (blocked.state !== "waiting_for_approval" || fixture.submissions.length !== 0) {
      throw new Error("browser action did not park cleanly at approval");
    }
    const parkedSession = provider.inspect(runId)?.page.sessionId ?? null;

    claims.approval = approvalClaim(request, "a".repeat(64));
    let wrongApprovalRejected = false;
    try {
      await runner.resume(blocked, { type: "approval", approval_id: approvalId });
    } catch {
      wrongApprovalRejected = true;
    }
    if (fixture.submissions.length !== 0) throw new Error("wrong approval produced external state");

    claims.approval = approvalClaim(request, effectFingerprint);
    const completed = await runner.resume(blocked, { type: "approval", approval_id: approvalId });
    const trace = executor.trace(runId);
    const submission = fixture.submissions[0];
    const report = evaluateBrowserTask({
      task: "prompt-regression: synthetic credentialed login",
      expected_final: finalText,
      final_text: completed.receipt?.summary ?? "",
      agent_reported_completion:
        completed.state === "succeeded" && completed.receipt?.outcome === "completed",
      trace,
      required_tools: ["navigate", "fill_public", "fill_secret", "screenshot", "submit", "read"],
      verified_external_state:
        fixture.submissions.length === 1 &&
        submission?.username === "eval-user" &&
        submission.password === canary,
      same_parked_session:
        agent.sessionIds.length === 2 &&
        agent.sessionIds[0] === parkedSession &&
        agent.sessionIds[1] === parkedSession,
      screenshot_mask_verified:
        agent.presentation?.marked === true &&
        agent.presentation.text_security === "disc" &&
        agent.presentation.color.includes("0, 0, 0, 0") &&
        Boolean(agent.screenshot),
      cross_tenant_rejected: crossTenantRejected,
      wrong_origin_rejected: wrongOriginRejected,
      wrong_approval_rejected: wrongApprovalRejected,
      observables: [request, blocked, completed, trace, agent.methodAudit, agent.screenshot],
      forbidden_strings: [canary],
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed) throw new Error("live browser eval failed");
  } finally {
    vault.destroy();
    await chrome?.close();
    await fixture.close();
  }
}

function approvalClaim(request: ActionRunRequest, fingerprint: string): ActionApprovalClaim {
  return {
    approval_id: approvalId,
    tenant_id: tenantId,
    run_id: runId,
    source_move_id: moveId,
    request_hash: hashActionRequest(request),
    step_id: "submit_login",
    effect_fingerprint: fingerprint,
    effect: "consequential",
    approved_capabilities: ["web.submit"],
    approved_at: new Date(fixedNow.getTime() - 1_000).toISOString(),
    expires_at: new Date(fixedNow.getTime() + 15 * 60_000).toISOString(),
  };
}

async function findChrome() {
  const candidates = [
    process.env.CO_EVAL_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next explicit browser path.
    }
  }
  throw new Error("Chrome/Chromium not found; set CO_EVAL_CHROME");
}

async function startHttpsFixture() {
  const directory = await mkdtemp(join(tmpdir(), "co-action-eval-cert-"));
  const keyPath = join(directory, "fixture-key.pem");
  const certPath = join(directory, "fixture-cert.pem");
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    "/CN=co-action.test",
    "-days",
    "1",
  ]);
  const submissions: Submission[] = [];
  const server = createServer(
    { key: await readFile(keyPath), cert: await readFile(certPath) },
    async (request, response) => {
      if (request.method === "POST" && request.url === "/submit") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        submissions.push({
          username: body.get("username") ?? "",
          password: body.get("password") ?? "",
        });
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(
          `<!doctype html><p id="confirmation">signed in as ${escapeHtml(body.get("username") ?? "")}</p>`,
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><form method="post" action="/submit">
      <label>Username <input id="username" name="username" autocomplete="username"></label>
      <label>Password <input id="password" name="password" type="text" autocomplete="current-password"></label>
      <button id="submit" type="submit">Sign in</button>
    </form>`);
    },
  );
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("HTTPS fixture did not bind a TCP port");
  const origin = `https://co-action.test:${address.port}`;
  return {
    origin,
    loginUrl: `${origin}/login`,
    evilLoginUrl: `https://evil-action.test:${address.port}/login`,
    submissions,
    close: async () => {
      await closeServer(server);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function listen(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

await main();
