import { describe, expect, it } from "vitest";
import type { ActionExecutionContext } from "../src/index";
import {
  ApprovalRequiredError,
  browserToolPolicies,
  DeclarativeBrowserToolGate,
} from "../src/index";

const fingerprint = "b".repeat(64);

function context(
  input: {
    approvedFingerprint?: string | null;
    authorizedCapabilities?: string[];
  } = {},
): ActionExecutionContext {
  return {
    run_id: "11111111-1111-4111-8111-111111111111",
    tenant_id: "22222222-2222-4222-8222-222222222222",
    source_move_id: "33333333-3333-4333-8333-333333333333",
    request_hash: "a".repeat(64),
    active_approval_fingerprint: input.approvedFingerprint ?? null,
    objective: "Submit the prepared synthetic form.",
    assignment: {
      worker_kind: "browser",
      adapter: "synthetic_browser",
      effect: "consequential",
      authority: "execute_after_approval",
      target: {
        start_url: "https://example.test/login",
        allowed_origins: ["https://example.test"],
      },
      public_input: {},
      vault_refs: [],
      authorized_capabilities: input.authorizedCapabilities ?? ["web.navigate"],
    },
    resolved_input_refs: [],
    signal: new AbortController().signal,
  };
}

describe("declarative browser tool policy", () => {
  it("parks submit authority at the tool boundary with the exact effect binding", () => {
    const gate = new DeclarativeBrowserToolGate();
    let error: unknown;
    try {
      gate.authorize({
        tool: "submit",
        context: context(),
        effectFingerprint: fingerprint,
        stepId: "submit_form",
        approvalPrompt: "Submit the synthetic form.",
        now: new Date("2026-08-29T19:00:00Z"),
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApprovalRequiredError);
    expect((error as ApprovalRequiredError).blocker).toMatchObject({
      step_id: "submit_form",
      request_hash: "a".repeat(64),
      effect_fingerprint: fingerprint,
    });
  });

  it("allows only the declared capability with the exact active fingerprint", () => {
    const gate = new DeclarativeBrowserToolGate();
    expect(
      gate.authorize({
        tool: "submit",
        context: context({
          approvedFingerprint: fingerprint,
          authorizedCapabilities: ["web.submit"],
        }),
        effectFingerprint: fingerprint,
      }),
    ).toBe("web.submit");

    expect(() =>
      gate.authorize({
        tool: "submit",
        context: context({
          approvedFingerprint: "c".repeat(64),
          authorizedCapabilities: ["web.submit"],
        }),
        effectFingerprint: fingerprint,
        stepId: "submit_form",
        approvalPrompt: "Submit the synthetic form.",
      }),
    ).toThrow(ApprovalRequiredError);
  });

  it("keeps the approval requirement in executable policy, not prompt text", () => {
    expect(browserToolPolicies.submit.capability).toBe("web.submit");
    expect(browserToolPolicies.submit.approval).toBeTypeOf("function");
    expect(browserToolPolicies.navigate.approval).toBeUndefined();
  });
});
