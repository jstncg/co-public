import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { CoRuntime } from "../src/runtime.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { parseReleaseManifest, type ReleaseManifest } from "../src/releases.ts";
import { createRuntimeServer } from "../src/server.ts";
import { RuntimeWorker } from "../src/worker.ts";
import type { ProviderAdapter, ProviderRequest } from "../src/types.ts";
import { testConfig, testHome } from "./helpers.ts";

function candidate(runtime: CoRuntime, overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return parseReleaseManifest({
    version: 1,
    label: "candidate-26",
    distributionId: runtime.distribution.id,
    systemPrompt: "CANDIDATE RELEASE PROMPT. Give a short, direct answer.",
    models: Object.fromEntries(Object.entries(runtime.config.models).map(([role, route]) => [role, { ...route, model: "mock-canary" }])),
    skills: runtime.skills.skills.map((skill) => ({ name: skill.name, version: skill.version })),
    autoApproveRisks: [],
    ...overrides,
  });
}

function memberFor(runtime: CoRuntime, cohort: "stable" | "canary"): string {
  for (let index = 0; index < 1_000; index += 1) {
    const tenantId = `${cohort}-member-${index}`;
    if (runtime.releases.assign(tenantId).cohort === cohort) return tenantId;
  }
  throw new Error(`Could not find a ${cohort} cohort member`);
}

test("immutable releases drive real prompt/model/policy selection and rollback only changes new runs", async () => {
  const home = testHome();
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    name: "mock",
    complete: async (request) => {
      requests.push(request);
      const text = request.messages.flatMap((message) => message.parts)
        .filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const hasToolResult = request.messages.some((message) => message.parts.some((part) => part.type === "tool_result"));
      if (/remember this release/i.test(text) && !hasToolResult) {
        return {
          text: "", toolCalls: [{ id: "call_release_policy", name: "memory.remember", arguments: { kind: "fact", statement: "release policy check" } }],
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
        };
      }
      return {
        text: `answered by ${request.route.model}`, toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      };
    },
  };
  const operatorConfig = { ...testConfig(home.path), tenantId: "operator" };
  const operator = new CoRuntime({ config: operatorConfig, providers: new ProviderRegistry([provider]) });
  try {
    const baselineId = operator.releases.active().stableReleaseId;
    const staged = operator.releases.stage("operator", candidate(operator));
    const rollout = operator.releases.canary("operator", staged.id, 5_000);
    const canaryTenant = memberFor(operator, "canary");
    const canaryRuntime = new CoRuntime({
      config: { ...testConfig(home.path), tenantId: canaryTenant },
      providers: new ProviderRegistry([provider]),
    });
    try {
      const result = await canaryRuntime.turn({ tenantId: canaryTenant, channel: "imessage", peerId: "+15550001", text: "hello" });
      const run = canaryRuntime.store.getRun(result.runId, canaryTenant);
      assert.equal(result.text, "answered by mock-canary");
      assert.equal(run?.releaseId, staged.id);
      assert.equal(run?.rolloutId, rollout.id);
      assert.equal(run?.releaseCohort, "canary");
      assert.match(requests.at(-1)?.system ?? "", /CANDIDATE RELEASE PROMPT/);
      assert.equal(requests.at(-1)?.route.model, "mock-canary");

      const gated = await canaryRuntime.turn({
        tenantId: canaryTenant, channel: "imessage", peerId: "+15550002", text: "Remember this release policy check",
      });
      assert.equal(gated.status, "waiting_approval");
      assert.deepEqual(canaryRuntime.store.getRun(gated.runId, canaryTenant)?.state?.policyAutoApproveRisks, []);

      const statusJson = JSON.stringify(canaryRuntime.releases.status(canaryTenant));
      assert.match(statusJson, new RegExp(staged.id));
      assert.doesNotMatch(statusJson, /CANDIDATE RELEASE PROMPT/);

      operator.releases.rollback("operator");
      const postRollbackTenant = "post-rollback-member";
      const postRollback = operator.releases.assign(postRollbackTenant);
      assert.equal(postRollback.cohort, "stable");
      assert.equal(postRollback.release.id, baselineId);
      assert.equal(canaryRuntime.store.getRun(result.runId, canaryTenant)?.releaseId, staged.id);

      operator.releases.canary("operator", staged.id, 5_000);
      operator.releases.promote("operator", staged.id);
      assert.equal(operator.releases.assign("post-promotion-member").release.id, staged.id);
      operator.releases.rollback("operator");
      assert.equal(operator.releases.assign("post-promotion-rollback-member").release.id, baselineId);
    } finally {
      canaryRuntime.close();
    }
  } finally {
    operator.close();
    home.cleanup();
  }
});

test("release manifests fail closed on ambiguity, unavailable skills, and stored tampering", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    assert.throws(() => parseReleaseManifest({ ...candidate(runtime), mystery: true }), /unknown fields/);
    assert.throws(
      () => runtime.releases.stage("test", candidate(runtime, { skills: [{ name: "missing", version: 7 }] })),
      /unavailable immutable skill snapshot missing@7/,
    );

    const valid = runtime.releases.stage("test", candidate(runtime, { label: "tamper target" }));
    runtime.store.db.prepare("UPDATE release_manifests SET manifest_json=? WHERE id=?")
      .run(JSON.stringify({ ...valid.manifest, label: "silently changed" }), valid.id);
    assert.throws(() => runtime.releases.canary("test", valid.id, 100), /integrity check|metadata does not match/);

    runtime.store.db.prepare("UPDATE release_rollouts SET candidate_basis_points=1 WHERE status='active'").run();
    assert.throws(() => runtime.releases.assign("corrupt-rollout-member"), /invalid candidate allocation/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("a staged release executes its exact skill snapshot after the source file changes and disappears", async () => {
  const home = testHome();
  const skillDirectory = `${home.path}/skills/immutable-advice`;
  const skillPath = `${skillDirectory}/SKILL.md`;
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(skillPath, "---\nname: immutable-advice\nversion: 1\ndescription: Give immutable advice\nkeywords: immutable, advice\n---\n\nORIGINAL RELEASE-SIGNED PROCEDURE");
  const systems: string[] = [];
  const provider: ProviderAdapter = {
    name: "mock",
    complete: async (request) => {
      systems.push(request.system);
      return { text: "ok", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    },
  };
  const operator = new CoRuntime({ config: { ...testConfig(home.path), tenantId: "operator" }, providers: new ProviderRegistry([provider]) });
  let tenantId = "";
  try {
    const staged = operator.releases.stage("operator", candidate(operator, {
      label: "immutable-skill-candidate",
      skills: [{ name: "immutable-advice", version: 1 }],
    }));
    assert.match(staged.manifest.skills[0]?.digest ?? "", /^[a-f0-9]{64}$/);
    assert.equal(staged.manifest.skills[0]?.instructions, "ORIGINAL RELEASE-SIGNED PROCEDURE");
    operator.releases.canary("operator", staged.id, 9_999);
    tenantId = memberFor(operator, "canary");
  } finally {
    operator.close();
  }

  writeFileSync(skillPath, "---\nname: immutable-advice\nversion: 1\ndescription: Give immutable advice\nkeywords: immutable, advice\n---\n\nMUTATED LOCAL PROCEDURE");
  const mutated = new CoRuntime({ config: { ...testConfig(home.path), tenantId }, providers: new ProviderRegistry([provider]) });
  try {
    await mutated.turn({ tenantId, channel: "api", peerId: "mutation", externalId: "skill-mutation", text: "Give me immutable advice" });
    assert.match(systems.at(-1) ?? "", /ORIGINAL RELEASE-SIGNED PROCEDURE/);
    assert.doesNotMatch(systems.at(-1) ?? "", /MUTATED LOCAL PROCEDURE/);
  } finally {
    mutated.close();
  }

  rmSync(skillPath);
  const deleted = new CoRuntime({ config: { ...testConfig(home.path), tenantId }, providers: new ProviderRegistry([provider]) });
  try {
    await deleted.turn({ tenantId, channel: "api", peerId: "deletion", externalId: "skill-deletion", text: "Give me immutable advice" });
    assert.match(systems.at(-1) ?? "", /ORIGINAL RELEASE-SIGNED PROCEDURE/);
  } finally {
    deleted.close();
    home.cleanup();
  }
});

test("a delayed background job is release-pinned when admitted and cannot adopt a later rollback", async () => {
  const home = testHome();
  const requests: ProviderRequest[] = [];
  const provider: ProviderAdapter = {
    name: "openai-compatible",
    complete: async (request) => {
      requests.push(request);
      return {
        text: JSON.stringify({ useful: false }), toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      };
    },
  };
  const operator = new CoRuntime({ config: { ...testConfig(home.path), tenantId: "operator" }, providers: new ProviderRegistry([provider]) });
  let tenantRuntime: CoRuntime | undefined;
  try {
    const candidateRelease = operator.releases.stage("operator", candidate(operator, {
      label: "delayed-candidate",
      systemPrompt: "DELAYED CANDIDATE RELEASE PROMPT",
      models: Object.fromEntries(Object.entries(operator.config.models).map(([role, route]) => [role, {
        ...route, provider: "openai-compatible", model: "delayed-candidate-model",
      }])) as ReleaseManifest["models"],
    }));
    operator.releases.canary("operator", candidateRelease.id, 9_999);
    const tenantId = memberFor(operator, "canary");
    tenantRuntime = new CoRuntime({ config: { ...testConfig(home.path), tenantId }, providers: new ProviderRegistry([provider]) });
    const source = tenantRuntime.store.appendEvent({
      tenantId, stream: "fixture", type: "email.changed", payload: { subject: "delayed release evidence" },
    });
    const job = tenantRuntime.store.enqueueJob(tenantId, "ambient.evaluate", { eventId: source.id }, {
      runAfter: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: "delayed-release-fixture",
    });
    assert.equal(job.releaseId, candidateRelease.id, "pinning must happen before the worker sees the job");

    operator.releases.rollback("operator");
    tenantRuntime.store.db.prepare("UPDATE jobs SET run_after=? WHERE id=?").run(new Date(Date.now() - 1_000).toISOString(), job.id);
    assert.equal(await new RuntimeWorker(tenantRuntime, { videoAnalyzer: null }).runOnce(), true);
    assert.equal(tenantRuntime.store.getJob(job.id, tenantId)?.status, "completed");
    assert.equal(requests.at(-1)?.route.model, "delayed-candidate-model");
    assert.match(requests.at(-1)?.system ?? "", /DELAYED CANDIDATE RELEASE PROMPT/);
  } finally {
    tenantRuntime?.close();
    operator.close();
    home.cleanup();
  }
});

test("authenticated release status exposes cohort and component versions without prompt contents", async () => {
  const home = testHome();
  const config = { ...testConfig(home.path), serverToken: "release-status-token" };
  const runtime = new CoRuntime({ config });
  const server = createRuntimeServer(runtime);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}/v1/releases`;
    assert.equal((await fetch(endpoint)).status, 401);
    const response = await fetch(endpoint, { headers: { authorization: "Bearer release-status-token" } });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /releaseId|releaseDigest|stable/);
    assert.doesNotMatch(body, new RegExp(runtime.distribution.systemPrompt.slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.shutdown();
    home.cleanup();
  }
});

test("an auto provider becomes a concrete immutable baseline before startup", () => {
  const home = testHome();
  const config = testConfig(home.path);
  const autoRoute = { ...config.models.foreground, provider: "auto" as const, model: "provider-neutral-default" };
  config.models = { foreground: autoRoute, deliberation: autoRoute, background: autoRoute, critic: autoRoute };
  const priorOpenAi = process.env.OPENAI_API_KEY;
  const priorAnthropic = process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  let runtime: CoRuntime | undefined;
  try {
    runtime = new CoRuntime({ config });
    const manifest = runtime.releases.baseline.manifest;
    assert.deepEqual(Object.values(manifest.models).map((route) => route.provider), ["mock", "mock", "mock", "mock"]);
    assert.deepEqual(Object.values(manifest.models).map((route) => route.model), ["mock-1", "mock-1", "mock-1", "mock-1"]);
  } finally {
    runtime?.close();
    if (priorOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorOpenAi;
    if (priorAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = priorAnthropic;
    home.cleanup();
  }
});

test("release manifests pin complete cost ceilings and reject partial or unpriced envelopes", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const manifest = candidate(runtime);
    manifest.models.foreground.costCeiling = {
      inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 10, maxRequestUsd: 0.2,
    };
    assert.deepEqual(parseReleaseManifest(manifest).models.foreground.costCeiling, manifest.models.foreground.costCeiling);
    const partial = structuredClone(manifest) as unknown as Record<string, unknown>;
    const models = partial.models as Record<string, Record<string, unknown>>;
    models.foreground!.costCeiling = { inputUsdPerMillionTokens: 2.5, maxRequestUsd: 0.2 };
    assert.throws(() => parseReleaseManifest(partial), /costCeiling.*outputUsdPerMillionTokens/i);
    models.foreground!.costCeiling = { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0, maxRequestUsd: 0.2 };
    assert.throws(() => parseReleaseManifest(partial), /non-zero input or output price/i);
  } finally {
    runtime.close();
    home.cleanup();
  }
});
