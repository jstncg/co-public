import type { BrowserToolName, BrowserToolTrace } from "./browser";

export type BrowserTaskEvalInput = {
  task: string;
  expected_final: string;
  final_text: string;
  agent_reported_completion: boolean;
  trace: BrowserToolTrace[];
  required_tools: BrowserToolName[];
  verified_external_state: boolean;
  same_parked_session: boolean;
  screenshot_mask_verified: boolean;
  cross_tenant_rejected: boolean;
  wrong_origin_rejected: boolean;
  wrong_approval_rejected: boolean;
  observables: unknown[];
  forbidden_strings: string[];
};

export type BrowserTaskEvalReport = {
  task: string;
  passed: boolean;
  checks: {
    exact_final: boolean;
    completion_reported: boolean;
    real_browser_calls: boolean;
    external_state_verified: boolean;
    parked_session_reused: boolean;
    screenshot_masked: boolean;
    tenant_crypto_isolated: boolean;
    origin_locked: boolean;
    approval_bound: boolean;
    secret_absent_from_observables: boolean;
  };
  browser_call_count: number;
};

export function evaluateBrowserTask(input: BrowserTaskEvalInput): BrowserTaskEvalReport {
  const browserTools = new Set(
    input.trace.filter((event) => event.browser_call).map((event) => event.tool),
  );
  const serializedObservables = JSON.stringify(input.observables);
  const checks = {
    exact_final: input.final_text === input.expected_final,
    completion_reported: input.agent_reported_completion,
    real_browser_calls:
      input.trace.length > 0 && input.required_tools.every((tool) => browserTools.has(tool)),
    external_state_verified: input.verified_external_state,
    parked_session_reused: input.same_parked_session,
    screenshot_masked: input.screenshot_mask_verified,
    tenant_crypto_isolated: input.cross_tenant_rejected,
    origin_locked: input.wrong_origin_rejected,
    approval_bound: input.wrong_approval_rejected,
    secret_absent_from_observables: input.forbidden_strings.every(
      (secret) => secret.length > 0 && !serializedObservables.includes(secret),
    ),
  };
  return {
    task: input.task,
    passed: Object.values(checks).every(Boolean),
    checks,
    browser_call_count: input.trace.length,
  };
}
