import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { testHome } from "./helpers.ts";

function environment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1", CO_ENV: "test", CO_HOME: home, CO_TENANT: "cli-work",
    CO_PROVIDER: "mock", CO_FOREGROUND_PROVIDER: "mock", CO_DELIBERATION_PROVIDER: "mock", CO_BACKGROUND_PROVIDER: "mock", CO_CRITIC_PROVIDER: "mock", CO_MEDIA_ANALYZER: "none",
  };
}

test("co do drives a local work order through receipt-backed completion", () => {
  const home = testHome();
  try {
    const objective = '[[tool:artifact.prepare {"kind":"brief","title":"CLI proof","content":"Prepared through co do."}]]';
    const result = spawnSync(process.execPath, ["src/cli.ts", "do", objective, "--success", "A local artifact exists.", "--require-tool", "artifact.prepare", "--local", "--json"], {
      cwd: process.cwd(), env: environment(home.path), encoding: "utf8", timeout: 10_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const workOrder = JSON.parse(result.stdout) as { status: string; workOrderId: string; evidenceIds: string[] };
    assert.equal(workOrder.status, "completed");
    assert.match(workOrder.workOrderId, /^work_/);
    assert.equal(workOrder.evidenceIds.length, 1);
    const listed = spawnSync(process.execPath, ["src/cli.ts", "work-orders"], {
      cwd: process.cwd(), env: environment(home.path), encoding: "utf8", timeout: 5_000,
    });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(workOrder.workOrderId));
  } finally {
    home.cleanup();
  }
});

test("co do retries a transient daemon status failure without losing the work order", async () => {
  const home = testHome();
  let statusReads = 0;
  const workOrder = {
    workOrderId: "work_remote_retry", objective: "prepare the proof", successContract: "proof exists",
    evidencePolicy: "tool", evidenceRequirements: { minimumReceipts: 1, requiredToolNames: ["artifact.prepare"] },
    status: "running", modelRole: "deliberation", tokenBudget: 60_000, allowedTools: ["artifact.prepare"],
    sourceChannel: "api", sourcePeerId: "local", runId: null, approvalId: null, result: null,
    failureReason: null, evidenceIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
  };
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/v1/runtime") {
      response.end(JSON.stringify({ tenantId: "cli-work" }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/work-orders") {
      response.statusCode = 202;
      response.end(JSON.stringify({ workOrder }));
      return;
    }
    if (request.method === "GET" && request.url === "/v1/work-orders/work_remote_retry") {
      statusReads += 1;
      if (statusReads === 1) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: "worker checkpoint in progress" }));
        return;
      }
      response.end(JSON.stringify({
        ...workOrder, status: "completed", runId: "run_remote_retry", result: "Prepared.",
        evidenceIds: ["rcp_remote_retry"], updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["src/cli.ts", "do", "prepare the proof", "--require-tool", "artifact.prepare", "--daemon-url", `http://127.0.0.1:${address.port}`, "--json"], {
        cwd: process.cwd(), env: environment(home.path), stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(statusReads, 2);
    assert.equal((JSON.parse(result.stdout) as { status: string }).status, "completed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    home.cleanup();
  }
});
