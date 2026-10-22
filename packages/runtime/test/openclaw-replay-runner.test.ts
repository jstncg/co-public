import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { pinOpenClawReplayRunnerConfig, runOpenClawReplayRequest, type OpenClawReplayRunnerConfig, type OpenClawReplayRunnerRequest } from "../src/openclaw-replay-runner.ts";
import { testHome } from "./helpers.ts";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function runtimeFileSha256(path: string): string {
  const bytes = readFileSync(path);
  return createHash("sha256").update(`file\0\0${bytes.length}\0`).update(bytes).update("\0").digest("hex");
}

function git(cwd: string, arguments_: string[]): string {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, String(result.stderr));
  return String(result.stdout).trim();
}

test("the OpenClaw replay adapter invokes pinned agent exec without inventing action receipts", () => {
  const home = testHome();
  const repositoryPath = join(home.path, "openclaw");
  const agentWorkingDirectory = join(home.path, "agent-workspace");
  const markerPath = join(home.path, "harness-called.txt");
  const fakeHarnessPath = join(home.path, "fake-openclaw.mjs");
  const failingHarnessPath = join(home.path, "failing-openclaw.mjs");
  const openclawConfigPath = join(home.path, "openclaw.json");
  const openclawStateDirectory = join(home.path, "openclaw-state");
  const runnerConfigPath = join(home.path, "replay-runner.json");
  const missingEvidenceConfigPath = join(home.path, "missing-evidence-runner.json");
  mkdirSync(repositoryPath);
  mkdirSync(agentWorkingDirectory);
  mkdirSync(openclawStateDirectory);
  writeFileSync(join(repositoryPath, "tracked.txt"), "pinned source\n");
  git(repositoryPath, ["init", "-q"]);
  git(repositoryPath, ["add", "tracked.txt"]);
  git(repositoryPath, ["-c", "user.name=Co Test", "-c", "user.email=co@example.invalid", "commit", "-qm", "fixture"]);
  const repositoryRevision = git(repositoryPath, ["rev-parse", "HEAD"]);
  const harnessSource = `
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const [marker, ...args] = process.argv.slice(2);
if (args[0] === "agent" && args[1] === "exec" && args[2] === "--help") {
  process.stdout.write("--message-file --config --cwd --json");
  process.exit(0);
}
if (args[0] !== "agent" || args[1] !== "exec" || !args.includes("--json") || !args.includes("--config")) process.exit(4);
const promptPath = args[args.indexOf("--message-file") + 1];
const prompt = readFileSync(promptPath, "utf8");
if (!prompt.includes('"role":"assistant","content":"Historical answer"') || !prompt.includes('"currentMemberMessage":{"index":2,"role":"user","content":"What did that imply?"')) process.exit(5);
writeFileSync(marker, createHash("sha256").update(prompt).digest("hex"));
process.stdout.write(JSON.stringify({ ok: true, status: "ok", final: "actual OpenClaw harness response", toolSummary: { calls: 1, tools: ["write"] } }));
`;
  writeFileSync(fakeHarnessPath, harnessSource, { mode: 0o600 });
  writeFileSync(failingHarnessPath, `console.error("PRIVATE_HARNESS_STDERR"); process.exit(9);`, { mode: 0o600 });
  const openclawConfig = "{\"tools\":{\"profile\":\"minimal\"}}\n";
  writeFileSync(openclawConfigPath, openclawConfig, { mode: 0o600 });

  const writeRunnerConfig = (command: string[]): string => {
    const config: OpenClawReplayRunnerConfig = {
      schemaVersion: 2, harness: "openclaw-agent-exec", command,
      commandExecutableSha256: sha256(readFileSync(command[0] as string)),
      runtimeEvidence: [{ path: command[1] as string, sha256: runtimeFileSha256(command[1] as string) }],
      launcherWorkingDirectory: repositoryPath, repositoryPath, repositoryRevision,
      requireCleanRepository: true, openclawConfigPath, openclawConfigSha256: sha256(openclawConfig),
      openclawStateDirectory, agentWorkingDirectory, timeoutSeconds: 30, model: "fixture/model", thinking: "low",
    };
    const serialized = `${JSON.stringify(config)}\n`;
    writeFileSync(runnerConfigPath, serialized, { mode: 0o600 });
    return sha256(serialized);
  };
  const input = {
    schemaVersion: 1 as const, caseId: "case-1",
    history: [
      { index: 0, role: "user" as const, content: "Historical question", observedAt: "2026-01-01T00:00:00.000Z" },
      { index: 1, role: "assistant" as const, content: "Historical answer", observedAt: "2026-01-01T00:01:00.000Z" },
    ],
    checkpoint: { index: 2, role: "user" as const, content: "What did that imply?", observedAt: "2026-03-01T00:00:00.000Z" },
    requiredToolNames: ["artifact.prepare"],
  };
  const request = (configurationDigest: string): OpenClawReplayRunnerRequest => {
    const requestInput = structuredClone(input);
    return {
      protocol: "co.external-replay.v1", configurationPath: runnerConfigPath, configurationDigest,
      case: { id: "case-1", inputSha256: sha256(JSON.stringify(requestInput)), input: requestInput },
    };
  };

  try {
    const pin = pinOpenClawReplayRunnerConfig({
      outputPath: runnerConfigPath, command: [process.execPath, fakeHarnessPath, markerPath],
      launcherWorkingDirectory: repositoryPath, repositoryPath, openclawConfigPath, openclawStateDirectory, agentWorkingDirectory,
      timeoutSeconds: 30, model: "fixture/model", thinking: "low",
    });
    const digest = pin.configurationSha256;
    assert.equal(pin.repositoryRevision, repositoryRevision);
    assert.match(pin.commandExecutableSha256, /^[a-f0-9]{64}$/);
    assert.match(pin.runtimeEvidenceSha256, /^[a-f0-9]{64}$/);
    assert.equal(statSync(runnerConfigPath).mode & 0o777, 0o600);
    assert.throws(() => pinOpenClawReplayRunnerConfig({
      outputPath: runnerConfigPath, command: [process.execPath, fakeHarnessPath, markerPath],
      launcherWorkingDirectory: repositoryPath, repositoryPath, openclawConfigPath, openclawStateDirectory, agentWorkingDirectory,
    }), /EEXIST|file already exists/i);
    assert.throws(() => pinOpenClawReplayRunnerConfig({
      outputPath: missingEvidenceConfigPath, command: [process.execPath, fakeHarnessPath, markerPath],
      launcherWorkingDirectory: repositoryPath, repositoryPath, openclawConfigPath, openclawStateDirectory, agentWorkingDirectory,
      runtimeEvidencePaths: [join(home.path, "missing-provider-runtime")],
    }), /runtime evidence does not exist/);
    assert.equal(existsSync(missingEvidenceConfigPath), false);
    const result = runOpenClawReplayRequest(request(digest));
    assert.equal(result.response, "actual OpenClaw harness response");
    assert.deepEqual(result.receipts, [], "a generic tool summary is not semantic outcome evidence");
    assert.match(readFileSync(markerPath, "utf8"), /^[a-f0-9]{64}$/);

    const whitespace = request(digest);
    whitespace.case.input.checkpoint.content = "  What did that imply?  ";
    whitespace.case.inputSha256 = sha256(JSON.stringify(whitespace.case.input));
    assert.throws(() => runOpenClawReplayRequest(whitespace), /status 5/,
      "the fake harness should observe preserved whitespace instead of a trimmed approximation");

    rmSync(markerPath);
    writeFileSync(openclawConfigPath, "{\"tools\":{\"profile\":\"full\"}}\n", { mode: 0o600 });
    assert.throws(() => runOpenClawReplayRequest(request(digest)), /configuration changed/);
    assert.equal(existsSync(markerPath), false, "config drift must fail before the harness runs");
    writeFileSync(openclawConfigPath, openclawConfig, { mode: 0o600 });

    writeFileSync(join(repositoryPath, "untracked-plugin.ts"), "unreviewed\n");
    assert.throws(() => runOpenClawReplayRequest(request(digest)), /uncommitted or untracked/);
    assert.equal(existsSync(markerPath), false, "repository drift must fail before the harness runs");
    rmSync(join(repositoryPath, "untracked-plugin.ts"));

    writeFileSync(fakeHarnessPath, `${harnessSource}\n// unreviewed runtime mutation\n`, { mode: 0o600 });
    assert.throws(() => runOpenClawReplayRequest(request(digest)), /runtime evidence changed/);
    assert.equal(existsSync(markerPath), false, "runtime evidence drift must fail before the harness runs");
    writeFileSync(fakeHarnessPath, harnessSource, { mode: 0o600 });

    const outOfOrder = request(digest);
    outOfOrder.case.input.history = [outOfOrder.case.input.history[1]!, outOfOrder.case.input.history[0]!];
    outOfOrder.case.inputSha256 = sha256(JSON.stringify(outOfOrder.case.input));
    assert.throws(() => runOpenClawReplayRequest(outOfOrder), /strictly ordered/);

    const failingDigest = writeRunnerConfig([process.execPath, failingHarnessPath]);
    assert.throws(() => runOpenClawReplayRequest(request(failingDigest)),
      (error: unknown) => error instanceof Error && /status 9/.test(error.message) && !/PRIVATE_HARNESS_STDERR/.test(error.message));

    const executableDigest = writeRunnerConfig([process.execPath, fakeHarnessPath, markerPath]);
    const executableResult = spawnSync(process.execPath, [resolve("src/openclaw-replay-runner.ts")], {
      input: JSON.stringify(request(executableDigest)), encoding: "utf8", timeout: 10_000,
    });
    assert.equal(executableResult.status, 0, executableResult.stderr);
    assert.deepEqual(JSON.parse(executableResult.stdout), {
      protocol: "co.external-replay.v1", response: "actual OpenClaw harness response", receipts: [],
    });

    const tampered = request(digest);
    tampered.case.input.checkpoint.content = "changed after hashing";
    assert.throws(() => runOpenClawReplayRequest(tampered), /input digest is invalid/);
  } finally {
    home.cleanup();
  }
});
