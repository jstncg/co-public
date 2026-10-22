import { describe, expect, it } from "vitest";
import { actionRunRequestSchema } from "@co/contracts";

const base = {
  version: "action-run.v1",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  source_move_id: "22222222-2222-4222-8222-222222222222",
  idempotency_key: "action:bounded-contract:one",
  objective: "Read the permitted page.",
  assignment: {
    worker_kind: "browser",
    adapter: "sandbox_browser",
    effect: "observe",
    authority: "observe",
    capabilities: ["web.navigate", "web.read"],
    approval_bound_capabilities: [],
    target: {
      start_url: "https://example.test/start",
      allowed_origins: ["https://example.test"],
    },
    public_input: {},
    vault_refs: [],
  },
  expires_at: "2026-08-29T18:00:00Z",
};

describe("action contracts", () => {
  it("requires a known HTTPS browser origin and refuses authority expansion", () => {
    expect(actionRunRequestSchema.parse(base).assignment.target.allowed_origins).toEqual([
      "https://example.test",
    ]);
    expect(() =>
      actionRunRequestSchema.parse({
        ...base,
        assignment: {
          ...base.assignment,
          target: { ...base.assignment.target, allowed_origins: ["https://other.test"] },
        },
      }),
    ).toThrow(/explicitly allowed/);
    expect(() =>
      actionRunRequestSchema.parse({
        ...base,
        assignment: { ...base.assignment, effect: "consequential", authority: "prepare" },
      }),
    ).toThrow(/approval-bound authority/);
  });

  it("rejects credential-shaped public input so secrets can travel only by vault reference", () => {
    expect(() =>
      actionRunRequestSchema.parse({
        ...base,
        assignment: {
          ...base.assignment,
          public_input: { account: { password: "do-not-store-this" } },
        },
      }),
    ).toThrow(/opaque vault reference/);
    expect(() =>
      actionRunRequestSchema.parse({
        ...base,
        assignment: {
          ...base.assignment,
          public_input: { authorization_token: "do-not-store-this" },
        },
      }),
    ).toThrow(/opaque vault reference/);
    expect(() =>
      actionRunRequestSchema.parse({
        ...base,
        objective: "Log in with password: do-not-store-this",
      }),
    ).toThrow(/opaque reference/);
    expect(() =>
      actionRunRequestSchema.parse({
        ...base,
        assignment: {
          ...base.assignment,
          target: {
            ...base.assignment.target,
            start_url: "https://example.test/start?token=secret",
          },
        },
      }),
    ).toThrow(/cannot contain credentials/);
  });
});
