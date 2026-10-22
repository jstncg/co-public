import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { testHome } from "./helpers.ts";

function environment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1", CO_ENV: "test", CO_HOME: home, CO_TENANT: "cli-replay",
    CO_PROVIDER: "mock", CO_FOREGROUND_PROVIDER: "mock", CO_DELIBERATION_PROVIDER: "mock", CO_BACKGROUND_PROVIDER: "mock",
    CO_CRITIC_PROVIDER: "mock", CO_MEDIA_ANALYZER: "none",
  };
}

function run(home: string, arguments_: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["src/cli.ts", ...arguments_], {
    cwd: process.cwd(), env: environment(home), encoding: "utf8", timeout: 5_000,
  });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

function git(cwd: string, arguments_: string[]): void {
  const result = spawnSync("git", arguments_, { cwd, encoding: "utf8", timeout: 5_000 });
  assert.equal(result.status, 0, String(result.stderr));
}

test("replay CLI pins a real OpenClaw agent-exec surface without copying its configuration", () => {
  const home = testHome();
  const repositoryPath = join(home.path, "openclaw");
  const workspacePath = join(home.path, "workspace");
  const statePath = join(home.path, "openclaw-state");
  const harnessPath = join(repositoryPath, "openclaw.mjs");
  const openclawConfigPath = join(home.path, "openclaw-private.json");
  const outputPath = join(home.path, "pinned-openclaw-runner.json");
  mkdirSync(repositoryPath);
  mkdirSync(workspacePath);
  mkdirSync(statePath);
  writeFileSync(harnessPath, `
if (process.argv.slice(2).join(" ") === "agent exec --help") {
  process.stdout.write("--message-file --config --cwd --json");
  process.exit(0);
}
process.exit(3);
`, { mode: 0o600 });
  git(repositoryPath, ["init", "-q"]);
  git(repositoryPath, ["add", "openclaw.mjs"]);
  git(repositoryPath, ["-c", "user.name=Co Test", "-c", "user.email=co@example.invalid", "commit", "-qm", "fixture"]);
  writeFileSync(openclawConfigPath, "{\"privateSentinel\":\"DO_NOT_COPY\"}\n", { mode: 0o600 });
  try {
    const result = run(home.path, [
      "eval", "replay", "openclaw-config", "--out", outputPath,
      "--command", process.execPath, "--command-arg", harnessPath,
      "--launcher-cwd", repositoryPath, "--repo", repositoryPath,
      "--openclaw-config", openclawConfigPath, "--openclaw-state", statePath, "--agent-cwd", workspacePath,
      "--model", "fixture/model", "--thinking", "low", "--timeout-seconds", "30",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /DO_NOT_COPY/);
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(outputPath, "utf8"), /DO_NOT_COPY/);
    const report = JSON.parse(result.stdout) as { configurationSha256: string; repositoryRevision: string };
    assert.match(report.configurationSha256, /^[a-f0-9]{64}$/);
    assert.match(report.repositoryRevision, /^[a-f0-9]{40}$/);
  } finally {
    home.cleanup();
  }
});

test("replay CLI prepares timestamped private data and requires explicit export consent", () => {
  const home = testHome();
  const sourcePath = join(home.path, "private-source.json");
  const corpusPath = join(home.path, "private-corpus.jsonl");
  const manifestPath = join(home.path, "manifest.json");
  const packetPath = join(home.path, "external-packet.json");
  const runnerPath = join(home.path, "runner.mjs");
  const runnerConfigPath = join(home.path, "runner-config.json");
  const baselinePath = join(home.path, "external-baseline.json");
  const turns = [
    { role: "user", content: "PRIVATE_JANUARY", ts: "2026-01-01T00:00:00Z" },
    { role: "assistant", content: "January response", ts: "2026-01-01T00:01:00Z" },
    { role: "user", content: "PRIVATE_FEBRUARY", ts: "2026-02-01T00:00:00Z" },
    { role: "assistant", content: "February response", ts: "2026-02-01T00:01:00Z" },
    { role: "user", content: "PRIVATE_MARCH", ts: "2026-03-01T00:00:00Z" },
    { role: "assistant", content: "March response", ts: "2026-03-01T00:01:00Z" },
    { role: "user", content: "What connects these?", ts: "2026-04-01T00:00:00Z" },
    { role: "assistant", content: "Logged response", ts: "2026-04-01T00:01:00Z" },
  ];
  writeFileSync(sourcePath, JSON.stringify(turns), { mode: 0o600 });
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    cases: [{
      id: "cli-hidden-thesis", family: "hidden-thesis", checkpointIndex: 6, evidenceIndices: [0, 2, 4],
      rule: "Connect the dated evidence without inventing a motive.",
    }],
  }), { mode: 0o600 });
  writeFileSync(runnerPath, `
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
process.stdout.write(JSON.stringify({
  protocol: request.protocol,
  response: "external answer for " + request.case.id,
  receipts: []
}));
`, { mode: 0o600 });
  writeFileSync(runnerConfigPath, JSON.stringify({ model: "fixture" }), { mode: 0o600 });
  try {
    const prepared = run(home.path, ["eval", "corpus", "prepare", "--source", sourcePath, "--out", corpusPath]);
    assert.equal(prepared.status, 0, prepared.stderr);
    assert.doesNotMatch(prepared.stdout, /PRIVATE_/);
    const preparation = JSON.parse(prepared.stdout) as { turns: number; calendarMonths: number };
    assert.equal(preparation.turns, 8);
    assert.equal(preparation.calendarMonths, 4);
    assert.equal(statSync(corpusPath).mode & 0o777, 0o600);

    const denied = run(home.path, [
      "eval", "replay", "packet", "--corpus", corpusPath, "--manifest", manifestPath, "--out", packetPath,
    ]);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /requires --allow-private-export/);

    const exported = run(home.path, [
      "eval", "replay", "packet", "--corpus", corpusPath, "--manifest", manifestPath, "--out", packetPath,
      "--allow-private-export",
    ]);
    assert.equal(exported.status, 0, exported.stderr);
    assert.doesNotMatch(exported.stdout, /PRIVATE_/);
    const report = JSON.parse(exported.stdout) as { cases: number; packetSha256: string };
    assert.equal(report.cases, 1);
    assert.match(report.packetSha256, /^[a-f0-9]{64}$/);
    assert.equal(statSync(packetPath).mode & 0o777, 0o600);
    assert.match(readFileSync(packetPath, "utf8"), /PRIVATE_JANUARY/,
      "the external packet contains the private input only after explicit export consent");

    const captureArguments = [
      "eval", "replay", "capture", "--corpus", corpusPath, "--manifest", manifestPath, "--out", baselinePath,
      "--runner", process.execPath, "--runner-arg", runnerPath, "--runner-config", runnerConfigPath,
      "--harness", "CLI Fixture", "--harness-version", "1.0.0",
    ];
    const captureDenied = run(home.path, captureArguments);
    assert.notEqual(captureDenied.status, 0);
    assert.match(captureDenied.stderr, /requires --allow-private-model-upload/);
    const captured = run(home.path, [...captureArguments, "--allow-private-model-upload"]);
    assert.equal(captured.status, 0, captured.stderr);
    assert.doesNotMatch(captured.stdout, /PRIVATE_|external answer/);
    const captureReport = JSON.parse(captured.stdout) as { cases: number; harness: string; baselineSha256: string };
    assert.equal(captureReport.cases, 1);
    assert.equal(captureReport.harness, "CLI Fixture@1.0.0");
    assert.match(captureReport.baselineSha256, /^[a-f0-9]{64}$/);
    assert.equal(statSync(baselinePath).mode & 0o777, 0o600);
  } finally {
    home.cleanup();
  }
});
