import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseMcpServers } from "../src/config.ts";
import { evaluateMcpResult, McpManager, riskForMcpTool } from "../src/mcp.ts";

test("MCP config expands explicit secrets without inheriting arbitrary environment", () => {
  const prior = process.env.CO_TEST_MCP_TOKEN;
  process.env.CO_TEST_MCP_TOKEN = "test-token";
  try {
    const [server] = parseMcpServers([{
      name: "calendar", transport: "http", url: "https://example.test/mcp",
      headers: { Authorization: "Bearer ${CO_TEST_MCP_TOKEN}" }, allowedTools: ["events.list"],
      toolRisks: { "events.list": "read" },
    }]);
    assert.equal(server?.headers?.Authorization, "Bearer test-token");
    assert.deepEqual(server?.allowedTools, ["events.list"]);
    assert.equal(riskForMcpTool(server!, "events.list"), "read");
    assert.equal(riskForMcpTool(server!, "events.create"), "external-write");
  } finally {
    if (prior === undefined) delete process.env.CO_TEST_MCP_TOKEN;
    else process.env.CO_TEST_MCP_TOKEN = prior;
  }
});

test("MCP configuration rejects unknown fields instead of silently ignoring them", () => {
  assert.throws(() => parseMcpServers([{ name: "unsafe", transport: "stdio", command: "tool", unreviewedCapability: true }]), /unknown fields: unreviewedCapability/);
});

test("generic MCP semantics never promote queued writes or domain failures to completed outcomes", () => {
  assert.deepEqual(evaluateMcpResult("external-write", { accepted: true, status: "queued" }), {
    status: "succeeded", evidenceScope: "request",
  });
  assert.deepEqual(evaluateMcpResult("external-write", { ok: false, error: "rejected" }), {
    status: "uncertain", error: "rejected",
  });
  assert.deepEqual(evaluateMcpResult("read", { truncated: true, preview: "partial" }), {
    status: "failed", error: "MCP result was truncated and cannot prove the complete outcome",
  });
});

test("MCP discovers and calls stdio tools while ignoring remote safety hints", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/mcp-server.ts", import.meta.url));
  const manager = new McpManager([{ name: "test", transport: "stdio", command: process.execPath, args: [fixture], allowedTools: ["remote-ping"], timeoutMs: 5_000 }]);
  try {
    const tools = await manager.connectAll();
    assert.equal(manager.status[0]?.status, "connected");
    assert.equal(tools.length, 1);
    const tool = tools[0]!;
    assert.equal(tool.definition.name, "mcp_test_remote-ping");
    assert.equal(tool.definition.risk, "external-write");
    const result = await tool.execute({
      tenantId: "t",
      sessionId: "s",
      runId: "r",
      sourceEventId: "e",
      depth: 0,
      authorityToolNames: [tool.definition.name],
      idempotencyKey: "effect_test",
      receiptId: "receipt_test",
    }, {});
    assert.equal((result as { structuredContent?: { answer?: string } }).structuredContent?.answer, "pong");
  } finally {
    await manager.close();
  }
});

test("a generic MCP write error is uncertain because the server may have partially applied it", async () => {
  const fixture = fileURLToPath(new URL("./fixtures/mcp-server.ts", import.meta.url));
  const manager = new McpManager([{ name: "test", transport: "stdio", command: process.execPath, args: [fixture], allowedTools: ["remote-error"], timeoutMs: 5_000 }]);
  try {
    const [tool] = await manager.connectAll();
    assert.ok(tool);
    await assert.rejects(tool.execute({
      tenantId: "t", sessionId: "s", runId: "r", sourceEventId: "e", depth: 0,
      authorityToolNames: [tool.definition.name], idempotencyKey: "effect_error", receiptId: "receipt_error",
    }, {}), (error: unknown) => error instanceof Error && "uncertain" in error && error.uncertain === true);
  } finally {
    await manager.close();
  }
});
