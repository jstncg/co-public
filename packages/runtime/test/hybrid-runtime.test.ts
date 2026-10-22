import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ConnectorRegistry, type ConnectorAdapter } from "../src/connectors.ts";
import { createProfile, loadConfig, parseProfile } from "../src/config.ts";
import { buildDockerInvocation, ExecutionManager } from "../src/execution.ts";
import { applyOnboardingPlan, parseOnboardingPlan, planOnboarding, verifyOnboarding, writeOnboardingPlan } from "../src/onboarding.ts";
import { parsePluginManifest, PluginRegistry } from "../src/plugins.ts";
import { validateProductionConfig } from "../src/production.ts";
import { redactForObservability } from "../src/logger.ts";
import { CoRuntime } from "../src/runtime.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { SkillRegistry } from "../src/skills.ts";
import { testConfig, testHome } from "./helpers.ts";

function installFixturePlugin(root: string): string {
  const plugin = join(root, "fixture");
  const skills = join(plugin, "skills", "review-notes");
  mkdirSync(skills, { recursive: true });
  writeFileSync(join(skills, "SKILL.md"), "---\nname: review-notes\nversion: 1\ndescription: Review structured notes\nkeywords: review, notes\n---\n\nReview evidence before drafting.");
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({
    schemaVersion: 1,
    id: "fixture",
    version: "1.2.3",
    displayName: "Fixture Plugin",
    contributes: {
      skillRoots: ["skills"],
      mcpServers: [{
        name: "local", transport: "stdio", command: "fixture-mcp", cwd: ".",
        allowedTools: ["events.list"], toolRisks: { "events.list": "read" },
      }],
      sensors: [{
        id: "calendar", displayName: "Fixture calendar", kind: "calendar",
        purpose: "Notice relevant schedule changes.", dataClasses: ["calendar.events"], retentionDays: 30,
        server: "local", tool: "events.list",
      }],
    },
  }));
  return plugin;
}

test("plugin discovery is descriptor-only, deterministic, namespaced, and fail-closed", () => {
  const home = testHome();
  try {
    const root = join(home.path, "plugins");
    installFixturePlugin(root);
    const registry = new PluginRegistry([root]);
    const activated = registry.activate(["fixture"]);
    assert.deepEqual(activated.plugins.map((plugin) => plugin.manifest.id), ["fixture"]);
    assert.equal(activated.skillRoots.length, 1);
    assert.equal(activated.mcpServers[0]?.name, "fixture.local");
    assert.equal(activated.sensors[0]?.runtimeToolName, "mcp_fixture_local_events_list");
    assert.equal(activated.sensors[0]?.kind, "calendar");
    assert.deepEqual(registry.activate([]).plugins, []);
    assert.throws(() => registry.activate(["missing"]), /plugin\.missing/);
    assert.throws(() => parsePluginManifest({
      schemaVersion: 1, id: "future", version: "1.0.0", displayName: "Future",
      contributes: { skillRoots: [], mcpServers: [], connectors: [] },
    }), /unknown fields: connectors/);
    assert.throws(() => parsePluginManifest({
      schemaVersion: 1, id: "unsafe-sensor", version: "1.0.0", displayName: "Unsafe sensor",
      contributes: {
        skillRoots: [], mcpServers: [{ name: "mail", transport: "stdio", command: "mail", allowedTools: ["messages.list"] }],
        sensors: [{
          id: "mail", displayName: "Mail", kind: "email", purpose: "Read relevant mail.",
          dataClasses: ["email.messages"], retentionDays: 30, server: "mail", tool: "messages.list",
        }],
      },
    }), /explicitly classified read-only/);

    const malformedDirectory = join(root, "malformed");
    mkdirSync(malformedDirectory);
    writeFileSync(join(malformedDirectory, "plugin.json"), "{");
    assert.equal(new PluginRegistry([root]).report([]).diagnostics.some((diagnostic) => diagnostic.code === "plugin.invalid"), true);

    const unavailableDirectory = join(root, "unavailable");
    mkdirSync(unavailableDirectory);
    writeFileSync(join(unavailableDirectory, "plugin.json"), JSON.stringify({
      schemaVersion: 1, id: "unavailable", version: "1.0.0", displayName: "Unavailable",
      contributes: { skillRoots: ["does-not-exist"], mcpServers: [] },
    }));
    assert.throws(() => new PluginRegistry([root]).activate(["unavailable"]), /skill root does not exist/);

    const duplicateRoot = join(home.path, "duplicates");
    installFixturePlugin(duplicateRoot);
    assert.throws(() => new PluginRegistry([root, duplicateRoot]).activate(["fixture"]), /multiple manifests|multiple packages/);
  } finally {
    home.cleanup();
  }
});

test("onboarding plans before writing and applies a portable neutral profile without secrets", () => {
  const home = testHome();
  try {
    const pluginRoot = join(home.path, "plugins");
    installFixturePlugin(pluginRoot);
    const plan = planOnboarding({
      id: "account_one", home: home.path, provider: "mock", pluginRoots: [pluginRoot], plugins: ["fixture"],
      memberPeerIds: ["(555) 123-4567"],
      execution: { backend: "none", allowedCommands: [], timeoutMs: 10_000, maxOutputBytes: 100_000, workspaceMode: "read-only" },
    });
    const workspace = plan.profile.workspaceRoots?.[0] as string;
    assert.equal(existsSync(plan.profilePath), false);
    assert.equal(existsSync(workspace), false);
    assert.equal(JSON.stringify(plan).includes("API_KEY"), false);
    assert.deepEqual(plan.profile.memberPeerIds, ["+15551234567"]);

    const planPath = join(home.path, "onboarding-plan.json");
    writeOnboardingPlan(plan, planPath);
    const tampered = JSON.parse(readFileSync(planPath, "utf8")) as Record<string, unknown>;
    (tampered.profile as Record<string, unknown>).tenantId = "different";
    assert.throws(() => parseOnboardingPlan(tampered), /identity does not match/);
    assert.throws(() => parseOnboardingPlan({ ...plan, unreviewed: true }), /unknown fields: unreviewed/);

    const manifestPath = join(pluginRoot, "fixture", "plugin.json");
    const originalManifest = readFileSync(manifestPath, "utf8");
    writeFileSync(manifestPath, originalManifest.replace("1.2.3", "1.2.4"));
    assert.throws(() => applyOnboardingPlan(plan), /capabilities changed after review/);
    writeFileSync(manifestPath, originalManifest);

    const created = applyOnboardingPlan(plan);
    assert.equal(created.path, plan.profilePath);
    assert.equal(existsSync(workspace), true);
    assert.throws(() => applyOnboardingPlan(plan), /already exists|profile\.collision/);
    const profileText = readFileSync(created.path, "utf8");
    assert.equal(/apiKey|credential|secret/i.test(profileText), false);
    const verification = verifyOnboarding(created.path);
    assert.equal(verification.ok, true);
    assert.deepEqual(verification.memberPeerIds, ["+15551234567"]);
    assert.equal(verification.plugins.some((plugin) => plugin.id === "fixture" && plugin.selected === true), true);
    assert.equal(verification.execution.backend, "none");
    assert.equal(verification.routes.find((route) => route.role === "foreground")?.costCeiling, null);
    const unsafe = planOnboarding({ id: "unsafe", home: home.path, provider: "mock", workspaceRoots: ["/"] });
    assert.equal(unsafe.checks.some((check) => check.status === "blocked" && check.code.includes("workspace")), true);
    assert.throws(() => applyOnboardingPlan(unsafe), /workspace.*scope/i);
  } finally {
    home.cleanup();
  }
});

test("profiles preserve mixed per-role provider, model, token, and reasoning routes without credentials", () => {
  const home = testHome();
  try {
    const created = createProfile({
      id: "portable-routes", home: home.path,
      models: {
        foreground: { provider: "openai", model: "foreground-model", maxOutputTokens: 2_048, reasoningEffort: "medium",
          costCeiling: { inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 10, maxRequestUsd: 0.25 } },
        deliberation: { provider: "anthropic", model: "deliberation-model", maxOutputTokens: 8_192, reasoningEffort: "high" },
        background: { provider: "openai-compatible", model: "background-model", maxOutputTokens: 1_024, reasoningEffort: "low", baseUrl: "https://models.example.test/v1", apiKeyEnv: "MODEL_GATEWAY_KEY" },
        critic: { provider: "claude-code-cli", model: "critic-model", maxOutputTokens: 4_096, reasoningEffort: "xhigh" },
      },
    });
    const config = loadConfig({ profilePath: created.path, dbPath: join(home.path, "routes.sqlite") });
    assert.equal(config.models.foreground.provider, "openai");
    assert.deepEqual(config.models.foreground.costCeiling,
      { inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 10, maxRequestUsd: 0.25 });
    assert.equal(config.models.deliberation.provider, "anthropic");
    assert.equal(config.models.background.baseUrl, "https://models.example.test/v1");
    assert.equal(config.models.background.maxOutputTokens, 1_024);
    assert.equal(config.models.critic.reasoningEffort, "xhigh");
    assert.equal(config.execution.backend, "none");
    assert.deepEqual(verifyOnboarding(created.path).routes.find((route) => route.role === "foreground")?.costCeiling,
      { inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 10, maxRequestUsd: 0.25 });
    const stored = JSON.parse(readFileSync(created.path, "utf8")) as { models: Record<string, Record<string, unknown>> };
    assert.equal(Object.values(stored.models).some((route) => "apiKey" in route || "credential" in route), false);
    const rawProfile = JSON.parse(readFileSync(created.path, "utf8")) as { models: Record<string, Record<string, unknown>> };
    rawProfile.models.foreground!.costCeiling = { inputUsdPerMillionTokens: 2.5, maxRequestUsd: 0.25 };
    assert.throws(() => parseProfile(rawProfile), /costCeiling.*outputUsdPerMillionTokens/i);
    rawProfile.models.foreground!.costCeiling = { inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 10, maxRequestUsd: 0.25 };
    rawProfile.models.foreground!.apiKey = "must-not-be-stored";
    assert.throws(() => parseProfile(rawProfile), /unknown fields: apiKey/);
  } finally {
    home.cleanup();
  }
});

test("per-role environment cost ceilings are all-or-nothing and remain independent", () => {
  const home = testHome();
  const names = [
    "CO_PROVIDER", "CO_FOREGROUND_INPUT_USD_PER_MILLION_TOKENS",
    "CO_FOREGROUND_OUTPUT_USD_PER_MILLION_TOKENS", "CO_FOREGROUND_MAX_REQUEST_USD",
  ] as const;
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.CO_PROVIDER = "mock";
    process.env.CO_FOREGROUND_INPUT_USD_PER_MILLION_TOKENS = "2.5";
    process.env.CO_FOREGROUND_OUTPUT_USD_PER_MILLION_TOKENS = "10";
    process.env.CO_FOREGROUND_MAX_REQUEST_USD = "0.25";
    const config = loadConfig({ dbPath: join(home.path, "environment-cost.sqlite") });
    assert.deepEqual(config.models.foreground.costCeiling,
      { inputUsdPerMillionTokens: 2.5, outputUsdPerMillionTokens: 10, maxRequestUsd: 0.25 });
    assert.equal(config.models.background.costCeiling, undefined);
    delete process.env.CO_FOREGROUND_OUTPUT_USD_PER_MILLION_TOKENS;
    assert.throws(() => loadConfig({ dbPath: join(home.path, "partial-cost.sqlite") }), /must be configured together/i);
  } finally {
    for (const name of names) {
      const value = prior[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    home.cleanup();
  }
});

test("learned skills require approval, preserve provenance, and retain prior versions", () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "work", type: "procedure.verified", payload: { result: "worked" } });
    const proposal = runtime.skillLearning.propose({
      tenantId: "test", name: "repeatable-review", description: "Review evidence consistently",
      instructions: "1. Inspect the evidence.\n2. State uncertainty.\n3. Draft the answer.", evidenceEventIds: [], sourceEventId: source.id,
    });
    assert.equal(proposal.status, "proposed");
    assert.throws(() => runtime.skillLearning.install("test", proposal.id), /approved before installation/);
    runtime.skillLearning.approve("test", proposal.id);
    const installed = runtime.skillLearning.install("test", proposal.id);
    assert.equal(installed.status, "installed");
    assert.ok(installed.installedPath && existsSync(installed.installedPath));
    assert.match(readFileSync(installed.installedPath, "utf8"), new RegExp(proposal.id));
    assert.equal(runtime.skillLearning.install("test", proposal.id).id, proposal.id);

    const revisionSource = runtime.store.appendEvent({ tenantId: "test", stream: "work", type: "procedure.revised", payload: { result: "better" } });
    const revision = runtime.skillLearning.propose({
      tenantId: "test", name: "repeatable-review", description: "Review evidence with a counterexample",
      instructions: "1. Inspect evidence.\n2. Seek a counterexample.\n3. State uncertainty.\n4. Draft.", evidenceEventIds: [source.id],
      sourceEventId: revisionSource.id, supersedesId: proposal.id,
    });
    assert.throws(() => runtime.skillLearning.propose({
      tenantId: "test", name: "repeatable-review", description: "Conflicting revision", instructions: "Different draft.",
      evidenceEventIds: [], sourceEventId: revisionSource.id, supersedesId: proposal.id,
    }), /UNIQUE constraint failed/);
    runtime.skillLearning.approve("test", revision.id);
    const installedRevision = runtime.skillLearning.install("test", revision.id);
    assert.equal(runtime.store.getSkillProposal(proposal.id, "test")?.status, "retired");
    assert.ok(installed.installedPath && existsSync(installed.installedPath));
    assert.ok(installedRevision.installedPath && existsSync(installedRevision.installedPath));
    const registry = new SkillRegistry([runtime.config.learnedSkillRoot]);
    assert.equal(registry.skills.find((skill) => skill.name === "repeatable-review")?.version, 2);
    assert.equal(runtime.skills.skills.find((skill) => skill.name === "repeatable-review")?.version, 2);
    runtime.skillLearning.retire("test", revision.id);
    assert.equal(new SkillRegistry([runtime.config.learnedSkillRoot]).skills.some((skill) => skill.name === "repeatable-review"), false);
    assert.equal(runtime.skills.skills.some((skill) => skill.name === "repeatable-review"), false);
    assert.ok(installedRevision.installedPath && existsSync(installedRevision.installedPath));

    const foreign = runtime.store.appendEvent({ tenantId: "other", stream: "work", type: "procedure.verified", payload: {} });
    assert.throws(() => runtime.skillLearning.propose({
      tenantId: "test", name: "foreign-evidence", description: "Invalid", instructions: "Do it", evidenceEventIds: [foreign.id], sourceEventId: source.id,
    }), /does not belong to tenant/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("agent monitor exposes lineage and approvals without hidden state or common secret formats", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const googleStyleSecret = `AI${"za"}${"A".repeat(35)}`;
    await runtime.turn({ tenantId: "test", channel: "cli", peerId: "p", text: `Bearer visible-secret and ${googleStyleSecret}` });
    const delegated = await runtime.turn({
      tenantId: "test", channel: "cli", peerId: "p",
      text: '[[tool:delegate_task {"objective":"inspect one premise","deliverable":"one finding"}]]',
    });
    const waiting = await runtime.turn({
      tenantId: "test", channel: "cli", peerId: "p",
      text: `[[tool:file.write {"path":"${join(home.path, "approval.txt")}","content":"pending"}]]`,
    });
    assert.equal(waiting.status, "waiting_approval");
    const waitingRun = runtime.store.getRun(waiting.runId, "test");
    assert.ok(waitingRun?.state);
    runtime.store.updateRun(waiting.runId, { state: { ...waitingRun.state, system: "HIDDEN_STATE_CANARY" } });

    const snapshot = runtime.agentMonitor.snapshot("test");
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes("visible-secret"), false);
    assert.equal(serialized.includes(googleStyleSecret), false);
    assert.equal(serialized.includes("HIDDEN_STATE_CANARY"), false);
    assert.equal(JSON.stringify(redactForObservability(new Error("Bearer visible-secret"))).includes("visible-secret"), false);
    assert.equal(snapshot.retainedAgents.some((agent) => agent.admittedByRunId === delegated.runId && agent.status === "queued"), true);
    assert.equal(snapshot.flat.find((node) => node.runId === waiting.runId)?.pendingApprovals.length, 1);

    await new RuntimeWorker(runtime).drain(5);
    const after = runtime.agentMonitor.snapshot("test");
    assert.equal(after.flat.some((node) => node.parentRunId === delegated.runId && node.kind === "child"), true);
    assert.equal(after.retainedAgents.some((agent) => agent.admittedByRunId === delegated.runId && agent.status === "idle"), true);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("execution is disabled by default and local development execution is shell-free and workspace-bounded", async () => {
  const home = testHome();
  try {
    const disabledConfig = testConfig(home.path);
    const disabled = new ExecutionManager(disabledConfig);
    await assert.rejects(disabled.run({ command: process.execPath }), /disabled/);
    const disabledRuntime = new CoRuntime({ config: disabledConfig });
    assert.equal(disabledRuntime.tools.get("process.run"), undefined);
    disabledRuntime.close();

    const config = testConfig(home.path);
    config.execution = { backend: "local", allowedCommands: [process.execPath], timeoutMs: 5_000, maxOutputBytes: 10_000, workspaceMode: "read-only" };
    const manager = new ExecutionManager(config);
    const result = await manager.run({ command: process.execPath, args: ["-e", "process.stdout.write('bounded')"], cwd: home.path });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "bounded");
    assert.equal(result.terminationCleanup, "not-needed");
    assert.throws(() => manager.run({ command: "definitely-not-allowed", cwd: home.path }), /not allowlisted/);
    assert.throws(() => manager.run({ command: process.execPath, cwd: join(home.path, "missing") }), /does not exist/);

    config.environment = "production";
    config.profileId = "account";
    config.serverToken = "0123456789abcdef".repeat(4);
    const route = { provider: "openai" as const, model: "test", maxOutputTokens: 512, reasoningEffort: "none" as const };
    config.models = { foreground: route, deliberation: route, background: route, critic: route };
    assert.ok(validateProductionConfig(config, { OPENAI_API_KEY: "key" }).some((issue) => issue.code === "execution.local"));

    config.execution = {
      backend: "docker", allowedCommands: ["node"], timeoutMs: 5_000, maxOutputBytes: 10_000, workspaceMode: "read-only",
      dockerImage: `node:22@sha256:${"a".repeat(64)}`,
    };
    const secondWorkspace = join(home.path, "second-workspace");
    mkdirSync(secondWorkspace);
    config.workspaceRoots.push(secondWorkspace);
    const invocation = buildDockerInvocation(config, { command: "node", args: ["--version"], cwd: home.path });
    assert.ok(invocation.args.includes("--network") && invocation.args.includes("none"));
    assert.ok(invocation.args.includes("--read-only"));
    assert.ok(invocation.args.includes("--init"));
    assert.ok(invocation.args.includes("--cap-drop") && invocation.args.includes("ALL"));
    assert.ok(invocation.args.includes("no-new-privileges"));
    assert.ok(invocation.args.some((argument) => argument.endsWith(",readonly")));
    assert.equal(invocation.args.filter((argument) => argument === "--mount").length, 1);
    assert.deepEqual(invocation.args.slice(-3), [config.execution.dockerImage, "node", "--version"]);

    const fakeBin = join(home.path, "fake-bin");
    const capturePath = join(home.path, "docker-invocations.jsonl");
    const cleanupFailurePath = join(home.path, "fail-docker-cleanup");
    mkdirSync(fakeBin);
    const fakeDocker = join(fakeBin, "docker");
    writeFileSync(fakeDocker, `#!/usr/bin/env node\nconst { appendFileSync, existsSync } = require("node:fs");\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(capturePath)}, JSON.stringify(args) + "\\n");\nif (existsSync(${JSON.stringify(cleanupFailurePath)}) && (args[0] === "rm" || args[0] === "inspect")) { process.stderr.write("daemon unavailable"); process.exit(2); }\nif (args[0] === "run" && args.includes("__hang__")) setInterval(() => {}, 1000);\nelse process.stdout.write("fake docker");\n`);
    chmodSync(fakeDocker, 0o700);
    const priorPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${priorPath ?? ""}`;
    try {
      const dockerManager = new ExecutionManager(config);
      const completed = await dockerManager.run({ command: "node", args: ["--version"], cwd: home.path });
      assert.equal(completed.exitCode, 0);
      assert.equal(completed.command, "node");
      assert.equal(completed.terminationCleanup, "not-needed");

      config.execution.timeoutMs = 250;
      const timedOut = await new ExecutionManager(config).run({ command: "node", args: ["__hang__"], cwd: home.path });
      assert.equal(timedOut.timedOut, true);
      assert.equal(timedOut.terminationCleanup, "confirmed");
      const calls = readFileSync(capturePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
      const timedRun = calls.find((args) => args[0] === "run" && args.includes("__hang__"));
      const nameIndex = timedRun?.indexOf("--name") ?? -1;
      assert.ok(timedRun && nameIndex >= 0);
      assert.equal(calls.some((args) => args[0] === "rm" && args[1] === "--force" && args[2] === timedRun[nameIndex + 1]), true);

      writeFileSync(cleanupFailurePath, "fail");
      await assert.rejects(
        new ExecutionManager(config).run({ command: "node", args: ["__hang__"], cwd: home.path }),
        /cleanup could not be confirmed/,
      );
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
  } finally {
    home.cleanup();
  }
});

test("connector registry supports model-independent adapters and reports directional readiness", async () => {
  const home = testHome();
  try {
    const fixture: ConnectorAdapter = {
      id: "fixture",
      inboundPrincipal: "trusted-system",
      status: () => ({ id: "fixture", inboundConfigured: true, outboundConfigured: true }),
      verifyWebhook: () => true,
      parseWebhook: () => undefined,
      deliver: async (input) => ({ delivered: true, peerId: input.peerId }),
    };
    const registry = new ConnectorRegistry(testConfig(home.path), [fixture]);
    assert.deepEqual(registry.status, [{ id: "fixture", inboundConfigured: true, outboundConfigured: true }]);
    assert.equal((await registry.deliver("fixture", { peerId: "p", content: "hello" })).delivered, true);
    await assert.rejects(registry.deliver("missing", { peerId: "p", content: "hello" }), /No connector registered/);
  } finally {
    home.cleanup();
  }
});
