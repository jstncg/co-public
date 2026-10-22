import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { CdpCredentialSink, CredentialBroker, credentialOrigin, parseCredentialKey, type CredentialSink } from "../src/credentials.ts";
import { DependencyError } from "../src/dependency-errors.ts";
import { CoRuntime } from "../src/runtime.ts";
import { createRuntimeServer } from "../src/server.ts";
import { SqliteStore } from "../src/store.ts";
import { testConfig, testHome } from "./helpers.ts";

class FakeSink implements CredentialSink {
  url = "https://accounts.example.com/login";
  fills: Array<{ expectedOrigin: string; fields: Array<{ selector: string; value: string }> }> = [];
  masked = true;
  result: { filled: number; screenshotMasked: boolean } | undefined;
  error?: Error;

  async currentUrl(): Promise<string> {
    return this.url;
  }

  async fillSecretFields(input: { expectedOrigin: string; fields: Array<{ selector: string; value: string }> }): Promise<{ filled: number; screenshotMasked: boolean }> {
    this.fills.push(input);
    if (this.error) throw this.error;
    return this.result ?? { filled: input.fields.length, screenshotMasked: this.masked };
  }
}

test("credential handles encrypt values, bind workspace and origin, and return only masked fill metadata", async () => {
  const home = testHome();
  const store = new SqliteStore(`${home.path}/credentials.sqlite`);
  const sink = new FakeSink();
  const key = Buffer.alloc(32, 7);
  const broker = new CredentialBroker(store, { workspaceId: "workspace-a", key, sinkFactory: () => sink });
  try {
    const handle = broker.storeCredential({
      tenantId: "tenant-a", origin: "https://accounts.example.com/login?next=home", label: "Example login",
      fields: { username: "person@example.com", password: "never-visible-password" },
    });
    assert.equal(handle.origin, "https://accounts.example.com");
    assert.deepEqual(handle.fieldNames, ["password", "username"]);
    assert.doesNotMatch(JSON.stringify(handle), /person@example|never-visible/);
    const raw = store.db.prepare("SELECT ciphertext,field_names_json FROM credential_items WHERE id=?").get(handle.id) as { ciphertext: string; field_names_json: string };
    assert.doesNotMatch(raw.ciphertext, /person@example|never-visible/);
    assert.deepEqual(JSON.parse(raw.field_names_json), ["password", "username"]);

    const receipt = await broker.fill({
      tenantId: "tenant-a", credentialId: handle.id, targetId: "page-1",
      selectors: { username: "input[name=email]", password: "input[type=password]" },
    });
    assert.equal(sink.fills.length, 1);
    assert.deepEqual(sink.fills[0]?.fields.map((field) => field.value), ["person@example.com", "never-visible-password"]);
    assert.deepEqual(receipt.filledFields, ["password", "username"]);
    assert.equal(receipt.screenshotMasked, true);
    assert.doesNotMatch(JSON.stringify(receipt), /person@example|never-visible|input\[/);
    const events = store.listEvents("tenant-a", { stream: `credential:${handle.id}` });
    assert.equal(events.some((event) => JSON.stringify(event.payload).includes("never-visible-password")), false);

    sink.url = "https://lookalike.example.net/login";
    await assert.rejects(broker.fill({
      tenantId: "tenant-a", credentialId: handle.id, targetId: "page-1", selectors: { password: "#password" },
    }), /origin mismatch/);
    assert.equal(sink.fills.length, 1);

    store.db.prepare("UPDATE credential_items SET workspace_id='workspace-b' WHERE id=?").run(handle.id);
    const rebound = new CredentialBroker(store, { workspaceId: "workspace-b", key, sinkFactory: () => {
      sink.url = "https://accounts.example.com/login";
      return sink;
    } });
    await assert.rejects(rebound.fill({
      tenantId: "tenant-a", credentialId: handle.id, targetId: "page-1", selectors: { password: "#password" },
    }), /workspace-bound authentication/);
    assert.equal(sink.fills.length, 1);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("browser credential fill crosses the exact ordinary approval boundary", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  const store = new SqliteStore(config.dbPath);
  const sink = new FakeSink();
  const broker = new CredentialBroker(store, { workspaceId: config.browser.workspaceId, key: Buffer.alloc(32, 9), sinkFactory: () => sink });
  const handle = broker.storeCredential({ tenantId: "test", origin: "https://accounts.example.com", label: "Login", fields: { password: "approval-secret" } });
  const runtime = new CoRuntime({ config, store, credentials: broker });
  try {
    const call = `[[tool:browser.credential.fill ${JSON.stringify({ credentialId: handle.id, targetId: "page-1", selectors: { password: "#password" } })}]]`;
    const waiting = await runtime.turn({ tenantId: "test", channel: "cli", peerId: "operator", text: call }, {
      allowedTools: ["browser.credential.fill"], requiredTools: ["browser.credential.fill"],
    });
    assert.equal(waiting.status, "waiting_approval");
    assert.equal(sink.fills.length, 0);
    const approval = runtime.store.getApproval(waiting.approvalId as string);
    const completed = await runtime.resumeApproval(waiting.approvalId as string, "approved");
    assert.equal(completed.status, "completed");
    assert.equal(sink.fills.length, 1);
    const receipt = runtime.store.getReceipt("test", completed.runId, approval?.toolCallId as string);
    assert.equal(receipt?.toolName, "browser.credential.fill");
    assert.equal(receipt?.status, "succeeded");
    assert.equal(receipt?.effectState, "confirmed");
    assert.doesNotMatch(JSON.stringify(receipt), /approval-secret/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("partial and post-dispatch credential fills remain uncertain in durable tool receipts", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  const store = new SqliteStore(config.dbPath);
  const sink = new FakeSink();
  const broker = new CredentialBroker(store, { workspaceId: config.browser.workspaceId, key: Buffer.alloc(32, 21), sinkFactory: () => sink });
  const handle = broker.storeCredential({ tenantId: "test", origin: sink.url, label: "Ambiguous login", fields: { username: "private@example.com", password: "private-password" } });
  const runtime = new CoRuntime({ config, store, credentials: broker });
  try {
    sink.result = { filled: 1, screenshotMasked: false };
    await assert.rejects(
      broker.fill({ tenantId: "test", credentialId: handle.id, targetId: "page-partial", selectors: { username: "#u", password: "#p" } }),
      (error) => error instanceof DependencyError && error.uncertain && !error.retryable,
    );

    sink.result = undefined;
    sink.error = new Error("connection closed after Runtime.evaluate dispatch");
    const call = `[[tool:browser.credential.fill ${JSON.stringify({ credentialId: handle.id, targetId: "page-disconnected", selectors: { password: "#password" } })}]]`;
    const waiting = await runtime.turn({ tenantId: "test", channel: "cli", peerId: "operator", text: call }, {
      allowedTools: ["browser.credential.fill"], requiredTools: ["browser.credential.fill"],
    });
    assert.equal(waiting.status, "waiting_approval");
    const approval = runtime.store.getApproval(waiting.approvalId as string);
    await runtime.resumeApproval(waiting.approvalId as string, "approved");
    const receipt = runtime.store.getReceipt("test", waiting.runId, approval?.toolCallId as string);
    assert.equal(receipt?.status, "uncertain");
    assert.equal(receipt?.effectState, "uncertain");
    assert.equal(receipt?.output, undefined);
    assert.doesNotMatch(JSON.stringify(receipt), /private@example|private-password/);
  } finally {
    runtime.close();
    home.cleanup();
  }
});

test("credential key, origin, retirement, and CDP discovery fail closed", async () => {
  assert.equal(parseCredentialKey(Buffer.alloc(32, 3).toString("base64"))?.byteLength, 32);
  assert.equal(parseCredentialKey(Buffer.alloc(32, 4).toString("hex"))?.byteLength, 32);
  assert.throws(() => parseCredentialKey("too-short"), /32 bytes/);
  assert.equal(credentialOrigin("http://127.0.0.1:3000/login"), "http://127.0.0.1:3000");
  assert.throws(() => credentialOrigin("http://accounts.example.com/login"), /HTTPS/);

  const home = testHome();
  const store = new SqliteStore(`${home.path}/retire.sqlite`);
  const sink = new FakeSink();
  const broker = new CredentialBroker(store, { workspaceId: "workspace", key: Buffer.alloc(32, 5), sinkFactory: () => sink });
  try {
    const handle = broker.storeCredential({ tenantId: "tenant", origin: "https://accounts.example.com", label: "Retire me", fields: { password: "secret" } });
    assert.equal(broker.retire("tenant", handle.id).status, "retired");
    await assert.rejects(broker.fill({ tenantId: "tenant", credentialId: handle.id, targetId: "page", selectors: { password: "#p" } }), /retired/);
  } finally {
    store.close();
    home.cleanup();
  }

  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([{ id: "page", type: "page", url: "https://accounts.example.com", webSocketDebuggerUrl: "ws://attacker.example.net/devtools/page/page" }]));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await assert.rejects(new CdpCredentialSink(`http://127.0.0.1:${address.port}`, "page").currentUrl(), /outside the configured browser boundary/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("credential HTTP management returns handles and never echoes submitted values", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  const store = new SqliteStore(config.dbPath);
  const broker = new CredentialBroker(store, { workspaceId: config.browser.workspaceId, key: Buffer.alloc(32, 13) });
  const runtime = new CoRuntime({ config, store, credentials: broker });
  const server = createRuntimeServer(runtime);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { "content-type": "application/json" };
    const secret = "http-boundary-secret";

    const invalid = await fetch(`${base}/v1/credentials`, {
      method: "POST", headers, body: JSON.stringify({ origin: "http://accounts.example.com", label: "Invalid", fields: { password: secret } }),
    });
    assert.equal(invalid.status, 400);
    assert.doesNotMatch(await invalid.text(), new RegExp(secret));

    const created = await fetch(`${base}/v1/credentials`, {
      method: "POST", headers, body: JSON.stringify({ origin: "https://accounts.example.com/login", label: "HTTP login", fields: { username: "person@example.com", password: secret } }),
    });
    assert.equal(created.status, 201);
    const createdText = await created.text();
    assert.doesNotMatch(createdText, /http-boundary-secret|person@example\.com/);
    const handle = JSON.parse(createdText) as { id: string; origin: string; fieldNames: string[] };
    assert.equal(handle.origin, "https://accounts.example.com");
    assert.deepEqual(handle.fieldNames, ["password", "username"]);

    const listedText = await (await fetch(`${base}/v1/credentials`)).text();
    assert.doesNotMatch(listedText, /http-boundary-secret|person@example\.com/);
    assert.match(listedText, new RegExp(handle.id));
    const retiredText = await (await fetch(`${base}/v1/credentials/${handle.id}/actions`, {
      method: "POST", headers, body: JSON.stringify({ action: "retire" }),
    })).text();
    assert.doesNotMatch(retiredText, /http-boundary-secret|person@example\.com/);
    assert.equal((JSON.parse(retiredText) as { status: string }).status, "retired");
    assert.doesNotMatch(JSON.stringify(store.listEvents(config.tenantId)), /http-boundary-secret|person@example\.com/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.shutdown();
    home.cleanup();
  }
});
