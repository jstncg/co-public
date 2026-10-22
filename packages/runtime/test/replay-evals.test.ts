import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { ProviderRegistry } from "../src/providers.ts";
import {
  buildExternalReplayPacket, captureExternalReplayBaseline, externalReplayInvocationSha256,
  prepareReplayCorpus, runLongitudinalReplay, writeExternalReplayPacket,
} from "../src/replay-evals.ts";
import type { ExternalReplayCapture, ExternalReplayReceiptProof } from "../src/replay-evals.ts";
import { CoRuntime } from "../src/runtime.ts";
import type { ProviderAdapter } from "../src/types.ts";
import { testConfig, testHome } from "./helpers.ts";

function textFromRequest(request: Parameters<ProviderAdapter["complete"]>[0]): string {
  return request.messages.flatMap((message) => message.parts)
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text).join("\n");
}

function fixtureRuntime(path: string): {
  runtime: CoRuntime;
  calls: string[];
  prompts: string[];
  requests: Array<{ model: string; system: string; toolNames: string[] }>;
} {
  const calls: string[] = [];
  const prompts: string[] = [];
  const requests: Array<{ model: string; system: string; toolNames: string[] }> = [];
  const adapter: ProviderAdapter = {
    name: "openai-compatible",
    complete: async (request) => {
      calls.push(request.route.model);
      requests.push({ model: request.route.model, system: request.system, toolNames: request.tools.map((tool) => tool.name).sort() });
      const prompt = textFromRequest(request);
      prompts.push(prompt);
      if (request.route.model === "judge") {
        const winner = prompt.match(/([A-D])\ncandidate insight/)?.[1];
        if (!winner) throw new Error("Candidate was not anonymously represented in judge prompt");
        const grades = Object.fromEntries(["A", "B", "C", "D", "E"].map((label) => [label, {
          rulePass: label === winner,
          obviousness: label === winner ? 0.1 : 0.8,
          subtleReflection: label === winner ? 0.8 : 0.1,
          unsupportedInference: label === winner ? 0.1 : 0.7,
          actionBias: label === winner ? 0.1 : 0.7,
        }]));
        return { text: JSON.stringify({
          winner, grades,
          reason: "The candidate connects the private January borrowed-premise evidence without forcing a task.",
        }), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
      }
      const response = request.route.model === "frontier" ? "frontier immediate answer"
        : prompt.includes("DATED LONGITUDINAL EVIDENCE") || request.system.includes("LONGITUDINAL EVIDENCE") ? "candidate insight" : "ablated generic answer";
      return { text: response, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    },
  };
  const config = testConfig(path);
  config.models.foreground = { provider: "openai-compatible", model: "candidate", maxOutputTokens: 512, reasoningEffort: "none" };
  config.models.deliberation = { provider: "openai-compatible", model: "frontier", maxOutputTokens: 512, reasoningEffort: "none" };
  config.models.critic = { provider: "openai-compatible", model: "judge", maxOutputTokens: 512, reasoningEffort: "none" };
  return { runtime: new CoRuntime({ config, providers: new ProviderRegistry([adapter]) }), calls, prompts, requests };
}

function externalBaseline(corpusPath: string, manifestPath: string, input: {
  name: string;
  version?: string;
  configurationDigest: string;
  responses: Record<string, string>;
  receipts?: Record<string, unknown[]>;
}): Record<string, unknown> {
  const packet = buildExternalReplayPacket(corpusPath, manifestPath);
  const capture: ExternalReplayCapture = {
    protocol: "co.external-replay.v1", runnerSha256: "d".repeat(64), argumentsSha256: "e".repeat(64),
  };
  return {
    schemaVersion: 2,
    harness: { name: input.name, version: input.version ?? "fixture", configurationDigest: input.configurationDigest },
    capture,
    corpusSha256: packet.corpusSha256,
    manifestSha256: packet.manifestSha256,
    packetSha256: createHash("sha256").update(JSON.stringify(packet)).digest("hex"),
    generatedAt: "2026-09-04T00:00:00.000Z",
    cases: packet.cases.map((entry) => {
      const response = input.responses[entry.id] as string;
      const receipts = (input.receipts?.[entry.id] ?? []) as ExternalReplayReceiptProof[];
      return {
        id: entry.id, inputSha256: entry.inputSha256, response, receipts,
        invocationSha256: externalReplayInvocationSha256({
          capture, configurationDigest: input.configurationDigest, inputSha256: entry.inputSha256, response, receipts,
        }),
      };
    }),
  };
}

function writeFixtures(path: string): { corpusPath: string; manifestPath: string; externalBaselinePath: string } {
  const corpusPath = join(path, "private-corpus.jsonl");
  const manifestPath = join(path, "private-manifest.json");
  const turns = [
    { idx: 0, role: "user", content: "In January I rejected the borrowed premise.", exchange_id: 1, timestamp: "2026-01-10T12:00:00Z" },
    { idx: 1, role: "assistant", content: "Logged January reply.", exchange_id: 1, timestamp: "2026-01-10T12:01:00Z" },
    { idx: 2, role: "user", content: "In February the smaller original version restored energy.", exchange_id: 2, timestamp: "2026-02-12T12:00:00Z" },
    { idx: 3, role: "assistant", content: "Logged February reply.", exchange_id: 2, timestamp: "2026-02-12T12:01:00Z" },
    { idx: 4, role: "user", content: "In March the prestigious framing again felt inert.", exchange_id: 3, timestamp: "2026-03-14T12:00:00Z" },
    { idx: 5, role: "assistant", content: "Logged March reply.", exchange_id: 3, timestamp: "2026-03-14T12:01:00Z" },
    { idx: 6, role: "user", content: "What premise connects the ideas I keep returning to?", exchange_id: 4, timestamp: "2026-04-16T12:00:00Z" },
    { idx: 7, role: "assistant", content: "logged generic answer", exchange_id: 4, timestamp: "2026-04-16T12:01:00Z" },
  ];
  writeFileSync(corpusPath, `${turns.map((turn) => JSON.stringify(turn)).join("\n")}\n`, { mode: 0o600 });
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    cases: [{
      id: "hidden-thesis-1", family: "hidden-thesis", checkpointIndex: 6, evidenceIndices: [0, 2, 4],
      rule: "Name a specific shared premise grounded across months without generic productivity advice or a compulsory task.",
    }],
  }), { mode: 0o600 });
  const externalBaselinePath = join(path, "external-baseline.json");
  writeFileSync(externalBaselinePath, JSON.stringify(externalBaseline(corpusPath, manifestPath, {
    name: "OpenClaw", configurationDigest: "a".repeat(64), responses: { "hidden-thesis-1": "external harness answer" },
  })), { mode: 0o600 });
  return { corpusPath, manifestPath, externalBaselinePath };
}

test("longitudinal replay is private-by-default, blind, temporally bounded, and response-redacted", async () => {
  const home = testHome();
  const { corpusPath, manifestPath, externalBaselinePath } = writeFixtures(home.path);
  const { runtime, calls, prompts, requests } = fixtureRuntime(home.path);
  try {
    await assert.rejects(runLongitudinalReplay(runtime, { corpusPath, manifestPath, allowPrivateModelUpload: false }), /allow-private-model-upload/);
    const unavailable = await runLongitudinalReplay(runtime, { corpusPath, manifestPath, allowPrivateModelUpload: true });
    assert.equal(unavailable.status, "unavailable");
    assert.match(unavailable.reason ?? "", /external harness/);
    assert.equal(calls.length, 0);
    const report = await runLongitudinalReplay(runtime, { corpusPath, manifestPath, externalBaselinePath, allowPrivateModelUpload: true });
    assert.equal(report.status, "completed");
    assert.equal(report.corpus.calendarMonths, 4);
    assert.equal(report.summary?.cases, 1);
    assert.equal(report.summary?.candidateWins, 1);
    assert.equal(report.summary?.contextAdvantages, 1);
    assert.equal(report.results[0]?.passed, true);
    assert.equal(report.results[0]?.winner, "candidate");
    assert.equal(report.results[0]?.externalRulePass, false);
    assert.match(report.routes?.external ?? "", /^OpenClaw@fixture:/);
    assert.equal(report.results[0]?.responses, undefined);
    assert.doesNotMatch(JSON.stringify(report), /private January borrowed-premise evidence/,
      "the default report cannot leak a judge's quotation of private evidence");
    assert.match(report.results[0]?.reasonSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.equal(report.results[0]?.responseHashes.candidate.length, 64);
    assert.deepEqual(calls, ["candidate", "candidate", "frontier", "judge"]);
    const matchedRuntimeRequests = requests.filter((request) => request.model === "candidate");
    assert.equal(matchedRuntimeRequests.length, 2);
    assert.deepEqual(matchedRuntimeRequests[0]?.toolNames, matchedRuntimeRequests[1]?.toolNames,
      "context ablation must preserve the candidate runtime's tool surface");
    assert.match(matchedRuntimeRequests[0]?.system ?? "", /LONGITUDINAL EVIDENCE/);
    assert.doesNotMatch(matchedRuntimeRequests[1]?.system ?? "", /LONGITUDINAL EVIDENCE/,
      "context ablation must withhold prior personal history while preserving the runtime");
    const judgePrompt = prompts.at(-1) ?? "";
    assert.match(judgePrompt, /DATED CASE EVIDENCE/);
    assert.match(judgePrompt, /In January I rejected the borrowed premise/);
    assert.match(judgePrompt, /In February the smaller original version restored energy/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("private corpus preparation preserves timestamps and source bytes while refusing overwrite", () => {
  const home = testHome();
  const sourcePath = join(home.path, "source.json");
  const outputPath = join(home.path, "prepared.jsonl");
  const source = [
    { role: "user", content: "January private sentinel", ts: "2026-01-01T12:00:00Z" },
    { role: "assistant", content: "January response", ts: "2026-01-01T12:01:00Z" },
    { role: "user", content: "February private sentinel", ts: "2026-02-01T12:00:00Z" },
    { role: "assistant", content: "February response", ts: "2026-02-01T12:01:00Z" },
    { role: "user", content: "March private sentinel", ts: "2026-03-01T12:00:00Z" },
    { role: "assistant", content: "March response", ts: "2026-03-01T12:01:00Z" },
  ];
  writeFileSync(sourcePath, JSON.stringify(source), { mode: 0o600 });
  const sourceBefore = readFileSync(sourcePath);
  try {
    const report = prepareReplayCorpus(sourcePath, outputPath);
    assert.equal(report.turns, 6);
    assert.equal(report.datedTurns, 6);
    assert.equal(report.calendarMonths, 3);
    assert.equal(report.firstObservedAt, "2026-01-01T12:00:00.000Z");
    assert.equal(report.lastObservedAt, "2026-03-01T12:01:00.000Z");
    assert.doesNotMatch(JSON.stringify(report), /private sentinel/i, "the operational report must never echo corpus content");
    assert.deepEqual(readFileSync(sourcePath), sourceBefore, "preparation cannot alter the source log");
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    assert.equal(readFileSync(outputPath, "utf8").trim().split("\n").length, 6);
    assert.match(readFileSync(outputPath, "utf8"), /"timestamp":"2026-02-01T12:00:00.000Z"/);
    assert.throws(() => prepareReplayCorpus(sourcePath, outputPath), /EEXIST|file already exists/i);
    assert.throws(() => prepareReplayCorpus(sourcePath, sourcePath), /different from its source/);

    const naivePath = join(home.path, "naive-source.json");
    const naiveOutputPath = join(home.path, "naive-output.jsonl");
    writeFileSync(naivePath, JSON.stringify([{ role: "user", content: "local time", ts: "2026-07-01T12:00:00" }]), { mode: 0o600 });
    assert.throws(() => prepareReplayCorpus(naivePath, naiveOutputPath), /without a UTC offset/,
      "host timezone must never silently reinterpret a private source timestamp");
    const naiveReport = prepareReplayCorpus(naivePath, naiveOutputPath, { naiveTimestampOffset: "-07:00" });
    assert.equal(naiveReport.firstObservedAt, "2026-07-01T19:00:00.000Z");
    assert.throws(() => prepareReplayCorpus(naivePath, join(home.path, "bad-offset.jsonl"), { naiveTimestampOffset: "+15:00" }),
      /ISO UTC offset/);
    const invalidPath = join(home.path, "invalid-source.json");
    writeFileSync(invalidPath, JSON.stringify([{ role: "user", content: "bad time", timestamp: "not-a-date" }]), { mode: 0o600 });
    assert.throws(() => prepareReplayCorpus(invalidPath, join(home.path, "invalid-output.jsonl")), /timestamp is invalid/);
  } finally {
    home.cleanup();
  }
});

test("external replay packets bind every private case input and stale or legacy baselines fail closed", async () => {
  const home = testHome();
  const { corpusPath, manifestPath, externalBaselinePath } = writeFixtures(home.path);
  const packetPath = join(home.path, "external-packet.json");
  const packetReport = writeExternalReplayPacket(corpusPath, manifestPath, packetPath);
  const packet = buildExternalReplayPacket(corpusPath, manifestPath);
  assert.equal(packetReport.packetSha256, createHash("sha256").update(JSON.stringify(packet)).digest("hex"));
  assert.equal(packetReport.cases, 1);
  assert.equal(statSync(packetPath).mode & 0o777, 0o600);
  assert.throws(() => writeExternalReplayPacket(corpusPath, manifestPath, packetPath), /EEXIST|file already exists/i);
  assert.throws(() => buildExternalReplayPacket(corpusPath, manifestPath, Number.NaN), /case limit must be an integer/);
  assert.throws(() => buildExternalReplayPacket(corpusPath, manifestPath, 101), /case limit must be an integer/);

  const baseline = JSON.parse(readFile(externalBaselinePath)) as Record<string, unknown>;
  const cases = baseline.cases as Array<Record<string, unknown>>;
  cases[0]!.inputSha256 = "f".repeat(64);
  writeFileSync(externalBaselinePath, JSON.stringify(baseline), { mode: 0o600 });
  const { runtime, calls } = fixtureRuntime(home.path);
  try {
    await assert.rejects(runLongitudinalReplay(runtime, {
      corpusPath, manifestPath, externalBaselinePath, allowPrivateModelUpload: true,
    }), /different replay input/);
    assert.equal(calls.length, 0, "input provenance is checked before any private model upload");
    baseline.schemaVersion = 1;
    writeFileSync(externalBaselinePath, JSON.stringify(baseline), { mode: 0o600 });
    await assert.rejects(runLongitudinalReplay(runtime, {
      corpusPath, manifestPath, externalBaselinePath, allowPrivateModelUpload: true,
    }), /header is invalid/);
    assert.equal(calls.length, 0);

    const malformedReceiptBaseline = externalBaseline(corpusPath, manifestPath, {
      name: "OpenClaw", configurationDigest: "a".repeat(64), responses: { "hidden-thesis-1": "external answer" },
      receipts: { "hidden-thesis-1": [{
        receiptId: "claimed-receipt", toolName: "artifact.prepare", status: "succeeded",
        effectState: "accepted", evidenceScope: "outcome", outputSha256: "c".repeat(64),
      }] },
    });
    writeFileSync(externalBaselinePath, JSON.stringify(malformedReceiptBaseline), { mode: 0o600 });
    await assert.rejects(runLongitudinalReplay(runtime, {
      corpusPath, manifestPath, externalBaselinePath, allowPrivateModelUpload: true,
    }), /not confirmed semantic outcome evidence/);
    assert.equal(calls.length, 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("external baseline capture executes an exact no-shell runner and binds response evidence", async () => {
  const home = testHome();
  const { corpusPath, manifestPath } = writeFixtures(home.path);
  const runnerPath = join(home.path, "external-runner.mjs");
  const configPath = join(home.path, "external-runner-config.json");
  const baselinePath = join(home.path, "captured-baseline.json");
  writeFileSync(runnerPath, `
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.protocol !== "co.external-replay.v1") process.exit(2);
process.stdout.write(JSON.stringify({
  protocol: "co.external-replay.v1",
  response: "captured external response for " + request.case.id,
  receipts: []
}));
`, { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ privateConfigurationSentinel: "never copy this into the baseline" }), { mode: 0o600 });
  try {
    const captured = captureExternalReplayBaseline({
      corpusPath, manifestPath, outputPath: baselinePath, runnerPath: process.execPath,
      runnerArguments: [runnerPath], runnerConfigPath: configPath, harnessName: "External Fixture", harnessVersion: "1.0.0",
    });
    assert.equal(captured.cases, 1);
    assert.equal(captured.harness, "External Fixture@1.0.0");
    assert.match(captured.baselineSha256, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(captured), /captured external response|privateConfigurationSentinel/);
    assert.equal(statSync(baselinePath).mode & 0o777, 0o600);
    const capturedBaseline = JSON.parse(readFile(baselinePath)) as { capture: { argumentsSha256: string } };
    assert.notEqual(capturedBaseline.capture.argumentsSha256,
      createHash("sha256").update(JSON.stringify([runnerPath])).digest("hex"),
      "a script passed to an interpreter must be content-bound, not merely named in the argument hash");
    assert.doesNotMatch(readFile(baselinePath), /privateConfigurationSentinel|never copy this/,
      "only the external configuration digest belongs in the baseline");

    const { runtime } = fixtureRuntime(home.path);
    try {
      const report = await runLongitudinalReplay(runtime, {
        corpusPath, manifestPath, externalBaselinePath: baselinePath, allowPrivateModelUpload: true,
      });
      assert.equal(report.status, "completed");
      assert.match(report.routes?.external ?? "", /^External Fixture@1\.0\.0:/);
    } finally {
      runtime.close();
    }

    const tampered = JSON.parse(readFile(baselinePath)) as Record<string, unknown>;
    (tampered.cases as Array<Record<string, unknown>>)[0]!.response = "post-capture replacement";
    writeFileSync(baselinePath, JSON.stringify(tampered), { mode: 0o600 });
    const { runtime: rejectingRuntime, calls } = fixtureRuntime(home.path);
    try {
      await assert.rejects(runLongitudinalReplay(rejectingRuntime, {
        corpusPath, manifestPath, externalBaselinePath: baselinePath, allowPrivateModelUpload: true,
      }), /invocation evidence is invalid/);
      assert.equal(calls.length, 0);
    } finally {
      rejectingRuntime.close();
    }

    const failingRunnerPath = join(home.path, "failing-runner.mjs");
    writeFileSync(failingRunnerPath, `console.error("PRIVATE_RUNNER_STDERR"); process.exit(9);`, { mode: 0o600 });
    assert.throws(() => captureExternalReplayBaseline({
      corpusPath, manifestPath, outputPath: join(home.path, "failed-capture.json"), runnerPath: process.execPath,
      runnerArguments: [failingRunnerPath], runnerConfigPath: configPath, harnessName: "Failure Fixture", harnessVersion: "1",
    }), (error: unknown) => error instanceof Error && /failed for case/.test(error.message) && !/PRIVATE_RUNNER_STDERR/.test(error.message));
    assert.throws(() => captureExternalReplayBaseline({
      corpusPath, manifestPath, outputPath: join(home.path, "invalid-timeout.json"), runnerPath: process.execPath,
      runnerArguments: [runnerPath], runnerConfigPath: configPath, harnessName: "Failure Fixture", harnessVersion: "1",
      timeoutMs: Number.NaN,
    }), /runner timeout must be an integer/);
  } finally {
    home.cleanup();
  }
});

test("a short corpus cannot masquerade as a longitudinal release gate", async () => {
  const home = testHome();
  const { corpusPath, manifestPath, externalBaselinePath } = writeFixtures(home.path);
  const firstMonth = readFile(corpusPath).split("\n").filter(Boolean).slice(0, 2).join("\n");
  writeFileSync(corpusPath, `${firstMonth}\n`, { mode: 0o600 });
  const { runtime, calls } = fixtureRuntime(home.path);
  try {
    const report = await runLongitudinalReplay(runtime, { corpusPath, manifestPath, externalBaselinePath, allowPrivateModelUpload: true });
    assert.equal(report.status, "unavailable");
    assert.match(report.reason ?? "", /fewer than three/);
    assert.equal(calls.length, 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("assistant-authored history cannot masquerade as longitudinal owner evidence", async () => {
  const home = testHome();
  const { corpusPath, manifestPath, externalBaselinePath } = writeFixtures(home.path);
  const rows = readFile(corpusPath).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const index of [0, 2, 4]) rows[index] = { ...rows[index], role: "assistant" };
  writeFileSync(corpusPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
  const baseline = JSON.parse(readFile(externalBaselinePath)) as Record<string, unknown>;
  baseline.corpusSha256 = createHash("sha256").update(readFileSync(corpusPath)).digest("hex");
  writeFileSync(externalBaselinePath, JSON.stringify(baseline), { mode: 0o600 });
  const { runtime, calls } = fixtureRuntime(home.path);
  try {
    await assert.rejects(
      runLongitudinalReplay(runtime, { corpusPath, manifestPath, externalBaselinePath, allowPrivateModelUpload: true }),
      /dated owner evidence from at least two calendar months/,
    );
    assert.equal(calls.length, 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

function actionReplayFixtures(path: string): { corpusPath: string; manifestPath: string; externalBaselinePath: string } {
  const corpusPath = join(path, "action-corpus.jsonl");
  const manifestPath = join(path, "action-manifest.json");
  const externalBaselinePath = join(path, "action-external.json");
  writeFileSync(corpusPath, [
    { idx: 0, role: "user", content: "January context", exchange_id: 1, timestamp: "2026-01-01T00:00:00Z" },
    { idx: 1, role: "assistant", content: "January reply", exchange_id: 1, timestamp: "2026-01-01T00:01:00Z" },
    { idx: 2, role: "user", content: "February context", exchange_id: 2, timestamp: "2026-02-01T00:00:00Z" },
    { idx: 3, role: "assistant", content: "February reply", exchange_id: 2, timestamp: "2026-02-01T00:01:00Z" },
    { idx: 4, role: "user", content: "Please prepare the useful introduction draft now.", exchange_id: 3, timestamp: "2026-03-01T00:00:00Z" },
    { idx: 5, role: "assistant", content: "I drafted it.", exchange_id: 3, timestamp: "2026-03-01T00:01:00Z" },
  ].map((turn) => JSON.stringify(turn)).join("\n") + "\n", { mode: 0o600 });
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    cases: [{
      id: "useful-action-1", family: "useful-action", checkpointIndex: 4, evidenceIndices: [0], requiredToolNames: ["artifact.prepare"],
      rule: "Prepare the requested usable draft and claim completion only if the artifact exists.",
    }],
  }), { mode: 0o600 });
  writeFileSync(externalBaselinePath, JSON.stringify(externalBaseline(corpusPath, manifestPath, {
    name: "Hermes", configurationDigest: "b".repeat(64), responses: { "useful-action-1": "Here is how you could draft it." },
  })), { mode: 0o600 });
  return { corpusPath, manifestPath, externalBaselinePath };
}

function actionReplayRuntime(path: string, execute: boolean): CoRuntime {
  const adapter: ProviderAdapter = {
    name: "openai-compatible",
    complete: async (request) => {
      const prompt = textFromRequest(request);
      if (request.route.model === "judge") {
        const winner = prompt.match(/([A-E])\nVERIFIED ACTION PROOF:[^\n]+\nI drafted a ready-to-send introduction/)?.[1] ?? "A";
        const grades = Object.fromEntries(["A", "B", "C", "D", "E"].map((label) => [label, {
          rulePass: label === winner, obviousness: 0.1, subtleReflection: 0.1, unsupportedInference: 0.1, actionBias: 0.1,
        }]));
        return { text: JSON.stringify({ winner, grades, reason: "The selected response claims the requested finished artifact." }), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
      }
      if (request.route.model === "frontier" || !request.tools.some((tool) => tool.name === "artifact.prepare")) {
        return { text: "I can help draft it.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
      }
      const hasResult = request.messages.some((message) => message.parts.some((part) => part.type === "tool_result" && part.name === "artifact.prepare"));
      if (!hasResult && execute) return {
        text: "", toolCalls: [{
          id: "prepare_replay_artifact", name: "artifact.prepare", arguments: {
            kind: "draft", title: "Introduction draft",
            content: "Hi — your work on evidence-grounded agents maps closely to a reliability problem I am testing. Would you be open to comparing notes for twenty minutes next week?",
          },
        }], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      };
      return { text: "I drafted a ready-to-send introduction and kept it private.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    },
  };
  const config = testConfig(path);
  config.models.foreground = { provider: "openai-compatible", model: "candidate", maxOutputTokens: 512, reasoningEffort: "none" };
  config.models.deliberation = { provider: "openai-compatible", model: "frontier", maxOutputTokens: 512, reasoningEffort: "none" };
  config.models.critic = { provider: "openai-compatible", model: "judge", maxOutputTokens: 512, reasoningEffort: "none" };
  return new CoRuntime({ config, providers: new ProviderRegistry([adapter]) });
}

test("useful-action replay executes the real runtime and cannot pass without its exact confirmed receipt", async () => {
  const home = testHome();
  const fixtures = actionReplayFixtures(home.path);
  const executing = actionReplayRuntime(home.path, true);
  try {
    const proven = await runLongitudinalReplay(executing, { ...fixtures, allowPrivateModelUpload: true });
    assert.equal(proven.results[0]?.candidateRunStatus, "completed");
    assert.equal(proven.results[0]?.actionProof, true);
    assert.deepEqual(proven.results[0]?.receiptToolNames, ["artifact.prepare"]);
    assert.equal(proven.results[0]?.variantActionProofs.external, false);
    assert.equal(proven.results[0]?.externalRulePass, false,
      "an external harness response without confirmed semantic receipts cannot pass an action case");
    assert.equal(proven.results[0]?.passed, true);
  } finally {
    executing.close();
  }
  const unproven = actionReplayRuntime(home.path, false);
  try {
    const failed = await runLongitudinalReplay(unproven, { ...fixtures, allowPrivateModelUpload: true });
    assert.equal(failed.results[0]?.candidateRulePass, false,
      "a judge cannot promote action prose after the receipt gate fails");
    assert.equal(failed.results[0]?.actionProof, false);
    assert.equal(failed.results[0]?.passed, false);
    assert.match(failed.results[0]?.reason ?? "", /lacked required confirmed outcome receipts/);
  } finally {
    unproven.close();
    home.cleanup();
  }
});

function focusedPilotRuntime(path: string): CoRuntime {
  const adapter: ProviderAdapter = {
    name: "openai-compatible",
    complete: async (request) => {
      const prompt = textFromRequest(request);
      if (request.route.model === "judge") {
        const expected = prompt.includes("FAMILY: useful-action")
          ? "I prepared a private return brief"
          : "The three ideas form a portable learning loop";
        const winner = prompt.match(new RegExp(`([A-E])\\n(?:VERIFIED ACTION PROOF:[^\\n]+\\n)?${expected}`))?.[1];
        if (!winner) throw new Error("Focused-pilot candidate was not anonymously represented in the judge prompt");
        const grades = Object.fromEntries(["A", "B", "C", "D", "E"].map((label) => [label, {
          rulePass: label === winner,
          obviousness: label === winner ? 0.1 : 0.8,
          subtleReflection: label === winner ? 0.2 : 0.1,
          unsupportedInference: label === winner ? 0.1 : 0.7,
          actionBias: label === winner ? 0.1 : 0.6,
        }]));
        return {
          text: JSON.stringify({ winner, grades, reason: "The selected response is grounded in the dated evidence and satisfies the exact case contract." }),
          toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
        };
      }
      const practical = prompt.includes("useful private groundwork for that return");
      const hasHistory = practical
        ? prompt.includes("August 18 return deadline") && prompt.includes("Northstar Cafe")
        : prompt.includes("small language-model tools") && prompt.includes("evaluations could become part of the product");
      if (request.route.model === "frontier") {
        return { text: practical ? "Make a return checklist." : "These ideas are about personal agents.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
      }
      if (!practical) {
        const text = hasHistory
          ? "The three ideas form a portable learning loop: use produces owned evidence, owned evidence improves the agent, and evaluation decides which changes survive. Engelbart's bootstrapping strategy is a useful outside frame. A falsifiable next question is whether a member-specific trace improves a held-out future outcome more than the same runtime with that trace removed."
          : "This sounds like a project about improving an AI assistant.";
        return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
      }
      const hasResult = request.messages.some((message) => message.parts.some((part) => part.type === "tool_result" && part.name === "artifact.prepare"));
      if (!hasResult) return {
        text: "",
        toolCalls: [{
          id: hasHistory ? "prepare_grounded_return_brief" : "prepare_ablated_return_brief",
          name: "artifact.prepare",
          arguments: {
            kind: "checklist",
            title: hasHistory ? "Headphones return — August 16" : "Return checklist",
            content: hasHistory
              ? "Before August 16: confirm the August 18 deadline and UPS Store eligibility in the order email; pack the headphones and required return materials. On August 16: take the sealed package to dinner at Northstar Cafe and use the adjacent UPS Store. No message was sent and no calendar record was changed."
              : "Find the return deadline, accepted drop-off, and a convenient time. No external record was changed.",
          },
        }],
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      };
      return {
        text: hasHistory
          ? "I prepared a private return brief for August 16: verify the August 18 email terms, pack the headphones, and use the UPS Store beside Northstar Cafe. I did not message anyone or change your calendar."
          : "I prepared a generic private return checklist, but it lacks the earlier details.",
        toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
      };
    },
  };
  const config = testConfig(path);
  config.models.foreground = { provider: "openai-compatible", model: "candidate", maxOutputTokens: 512, reasoningEffort: "none" };
  config.models.deliberation = { provider: "openai-compatible", model: "frontier", maxOutputTokens: 512, reasoningEffort: "none" };
  config.models.critic = { provider: "openai-compatible", model: "judge", maxOutputTokens: 512, reasoningEffort: "none" };
  return new CoRuntime({ config, providers: new ProviderRegistry([adapter]) });
}

test("focused-pilot fixtures exercise both multi-event loops through matched runtime and exact action proof", async () => {
  const home = testHome();
  const corpusPath = fileURLToPath(new URL("./fixtures/focused-pilot-synthetic.jsonl", import.meta.url));
  const manifestPath = fileURLToPath(new URL("./fixtures/focused-pilot-synthetic-manifest.json", import.meta.url));
  const externalBaselinePath = join(home.path, "focused-pilot-external.json");
  writeFileSync(externalBaselinePath, JSON.stringify(externalBaseline(corpusPath, manifestPath, {
    name: "Pinned External Harness",
    configurationDigest: "f".repeat(64),
    responses: {
      "focused-intellectual-connection": "These thoughts all concern personal AI systems.",
      "focused-practical-groundwork": "You could make a return checklist and add the errand to your calendar.",
    },
  })), { mode: 0o600 });
  const runtime = focusedPilotRuntime(home.path);
  try {
    const report = await runLongitudinalReplay(runtime, {
      corpusPath, manifestPath, externalBaselinePath, allowPrivateModelUpload: true, includeResponses: true,
    });
    assert.equal(report.status, "completed");
    assert.equal(report.summary?.cases, 2);
    assert.equal(report.summary?.passed, 2);
    assert.equal(report.summary?.candidateWins, 2);
    assert.equal(report.summary?.contextAdvantages, 2,
      "both cases must attribute their gain to longitudinal context, not a different execution surface");

    const intellectual = report.results.find((result) => result.id === "focused-intellectual-connection");
    assert.equal(intellectual?.family, "outside-framework");
    assert.equal(intellectual?.candidateRulePass, true);
    assert.equal(intellectual?.ablationRulePass, false);
    assert.match(intellectual?.responses?.candidate ?? "", /Engelbart's bootstrapping strategy/);

    const practical = report.results.find((result) => result.id === "focused-practical-groundwork");
    assert.equal(practical?.family, "useful-action");
    assert.equal(practical?.candidateRunStatus, "completed");
    assert.equal(practical?.actionProof, true);
    assert.deepEqual(practical?.receiptToolNames, ["artifact.prepare"]);
    assert.equal(practical?.variantActionProofs.ablation, true,
      "the ablation must retain the same ability to execute the required tool");
    assert.equal(practical?.ablationRulePass, false,
      "a confirmed but ungrounded generic artifact must not count as the useful outcome");
    assert.equal(practical?.externalRulePass, false,
      "advice from an external harness cannot masquerade as completed groundwork without a receipt");
    assert.match(practical?.responses?.candidate ?? "", /did not message anyone or change your calendar/i);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}
