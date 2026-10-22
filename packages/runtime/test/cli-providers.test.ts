import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseClaudeJson, parseCodexJsonl, runCliProviderProcess } from "../src/cli-providers.ts";
import { DependencyError } from "../src/dependency-errors.ts";
import { CoRuntime } from "../src/runtime.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { testConfig, testHome } from "./helpers.ts";

test("Codex CLI JSONL parser extracts structured tool calls and usage", () => {
  const final = JSON.stringify({ text: "", toolCalls: [{ name: "clock.now", argumentsJson: "{}" }] });
  const parsed = parseCodexJsonl([
    JSON.stringify({ type: "thread.started", thread_id: "thread_1" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: final } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 5 } }),
  ].join("\n"));
  assert.equal(parsed.responseId, "thread_1");
  assert.equal(parsed.output.toolCalls[0]?.name, "clock.now");
  assert.deepEqual(parsed.output.toolCalls[0]?.arguments, {});
  assert.deepEqual(parsed.usage, { inputTokens: 100, outputTokens: 20, reasoningTokens: 5 });
});

test("Claude Code JSON parser uses structured output and complete cache-aware usage", () => {
  const parsed = parseClaudeJson(JSON.stringify({
    is_error: false, subtype: "success", session_id: "session_1", result: "unused",
    structured_output: { text: "done", toolCalls: [] },
    modelUsage: { "claude-sonnet-5": { inputTokens: 10, cacheReadInputTokens: 20, cacheCreationInputTokens: 30, outputTokens: 4 } },
  }));
  assert.equal(parsed.responseId, "session_1");
  assert.equal(parsed.output.text, "done");
  assert.deepEqual(parsed.usage, { inputTokens: 60, outputTokens: 4, reasoningTokens: 0 });
});

test("CLI provider timeout rejects and terminates a hung subprocess group", async () => {
  const started = Date.now();
  await assert.rejects(
    runCliProviderProcess(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], "", tmpdir(), 100),
    (error: unknown) => error instanceof DependencyError && error.kind === "timeout" && error.retryable,
  );
  assert.ok(Date.now() - started < 1_500);
});

test("CLI parse failures are typed retryable dependency failures", () => {
  assert.throws(() => parseCodexJsonl(JSON.stringify({ type: "turn.failed", message: "HTTP 429 rate limit" })),
    (error: unknown) => error instanceof DependencyError && error.kind === "rate_limited" && error.retryable);
  assert.throws(() => parseClaudeJson("not-json"),
    (error: unknown) => error instanceof DependencyError && error.kind === "malformed_response" && error.retryable);
  const malformedTool = JSON.stringify({ text: "", toolCalls: [{ name: "clock.now", argumentsJson: "{broken" }] });
  assert.throws(() => parseCodexJsonl([
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: malformedTool } }),
    JSON.stringify({ type: "turn.completed", usage: {} }),
  ].join("\n")), (error: unknown) => error instanceof DependencyError && error.kind === "malformed_response" && error.retryable);
});

test("a CLI process failure survives as a durable worker retry instead of failing the run", async () => {
  const home = testHome();
  const priorPath = process.env.CODEX_CLI_PATH;
  process.env.CODEX_CLI_PATH = process.execPath;
  const config = testConfig(home.path);
  const route = { provider: "codex-cli" as const, model: "default", maxOutputTokens: 512, reasoningEffort: "none" as const };
  config.models = { foreground: route, deliberation: route, background: route, critic: route };
  const runtime = new CoRuntime({ config });
  try {
    const admission = await runtime.submitWorkOrder({ objective: "Exercise the actual CLI provider failure path.", evidencePolicy: "run" });
    const worker = new RuntimeWorker(runtime, { videoAnalyzer: null });
    assert.equal(await worker.runOnce(), true);
    assert.equal(runtime.store.getJob(admission.jobId, "test")?.status, "queued");
    assert.equal(runtime.store.getJob(admission.jobId, "test")?.attempts, 1);
    assert.equal(runtime.workOrders.get("test", admission.workOrder.id)?.status, "running");
    assert.equal(runtime.store.getRun(runtime.workOrders.get("test", admission.workOrder.id)?.runId ?? "", "test")?.status, "running");
    assert.equal(runtime.store.listEvents("test", { type: "run.retry_scheduled" }).length, 1);
  } finally {
    if (priorPath === undefined) delete process.env.CODEX_CLI_PATH;
    else process.env.CODEX_CLI_PATH = priorPath;
    runtime.close();
    home.cleanup();
  }
});
