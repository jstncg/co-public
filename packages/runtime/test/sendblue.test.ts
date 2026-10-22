import assert from "node:assert/strict";
import test from "node:test";
import { DependencyError } from "../src/dependency-errors.ts";
import { SendblueAdapter } from "../src/sendblue.ts";
import { CoRuntime } from "../src/runtime.ts";
import { createRuntimeServer } from "../src/server.ts";
import { testConfig, testHome } from "./helpers.ts";

test("Sendblue keeps group conversations together and replies through the group endpoint", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.sendblue = { apiKeyId: "id", apiSecretKey: "secret", fromNumber: "+15550000000", baseUrl: "https://api.sendblue.co" };
  const adapter = new SendblueAdapter(config);
  const inbound = adapter.parseInbound({
    content: "hello", is_outbound: false, message_type: "group", from_number: "+15551111111", group_id: "g-1",
    participants: ["+15551111111", "+15552222222"], message_handle: "m-1",
  }, "test");
  assert.equal(inbound?.peerId, "group:g-1");
  assert.equal(inbound?.metadata?.senderPeerId, "+15551111111");

  const original = globalThis.fetch;
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ message_handle: "outbound-1" }), { status: 200 });
  };
  try {
    await adapter.send("group:g-1", "reply", { replyTo: "m-1" });
    assert.equal(requestedUrl, "https://api.sendblue.co/api/send-group-message");
    assert.equal(requestedBody.group_id, "g-1");
    assert.equal((requestedBody.reply_to as { message_handle: string }).message_handle, "m-1");
    assert.equal("number" in requestedBody, false);
  } finally {
    globalThis.fetch = original;
    home.cleanup();
  }
});

test("Sendblue HTTP success without a provider message ID is uncertain, never accepted", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.sendblue = { apiKeyId: "id", apiSecretKey: "secret", fromNumber: "+15550000000", baseUrl: "https://api.sendblue.co" };
  const adapter = new SendblueAdapter(config);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  try {
    await assert.rejects(adapter.send("+15551111111", "reply"), (error: unknown) => {
      assert.ok(error instanceof DependencyError);
      assert.equal(error.kind, "malformed_response");
      assert.equal(error.uncertain, true);
      assert.equal(error.retryable, false);
      return true;
    });
  } finally {
    globalThis.fetch = original;
    home.cleanup();
  }
});

test("Sendblue reactions use the native tapback endpoint and bind the exact inbound message", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.sendblue = { apiKeyId: "id", apiSecretKey: "secret", fromNumber: "+15550000000", baseUrl: "https://api.sendblue.co" };
  const adapter = new SendblueAdapter(config);
  const original = globalThis.fetch;
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response("{}", { status: 200 });
  };
  try {
    const result = await adapter.react("inbound-17", "love", "stable-reaction-key");
    assert.equal(requestedUrl, "https://api.sendblue.co/api/send-reaction");
    assert.deepEqual(requestedBody, { message_handle: "inbound-17", reaction: "love", from_number: "+15550000000" });
    assert.deepEqual(result, { provider: "sendblue", targetMessageId: "inbound-17", reactionType: "love", status: "accepted" });
  } finally {
    globalThis.fetch = original;
    home.cleanup();
  }
});

test("authenticated Sendblue media ingress preserves the exact URL and cannot rebind a canonical direct conversation", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  config.sendblue.webhookSecret = "signed-media-secret";
  const runtime = new CoRuntime({ config });
  const server = createRuntimeServer(runtime);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}/webhooks/sendblue`;
    const mediaUrl = `https://media.example.test/private/video.mov?X-Amz-Signature=${"aB9_".repeat(700)}&response-content-disposition=attachment%3Bfilename%3Dexact%2520name.mov&token=ends-with-%2F%3D`;
    const content = "Please use this exact private attachment URL; its query string is signed.";
    const firstPayload = {
      content, media_url: mediaUrl, is_outbound: false, message_type: "message", from_number: "+12025559876",
      to_number: "+12025550000", message_handle: "media-exact-1", service: "iMessage",
    };
    const accepted = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json", "sb-signing-secret": "signed-media-secret" },
      body: JSON.stringify(firstPayload),
    });
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json() as { duplicate: boolean }).duplicate, false);

    const firstJob = runtime.store.listJobs("test").find((job) => job.type === "channel.turn" && job.payload.externalId === "media-exact-1");
    assert.ok(firstJob);
    assert.equal(firstJob.payload.text, `${content}\n[attachment 1: file]`);
    assert.equal(String(firstJob.payload.text).includes("X-Amz-Signature"), false, "signed capability URLs stay below the foreground-model boundary");
    assert.deepEqual(firstJob.payload.attachments, [{
      id: (firstJob.payload.attachments as Array<{ id: string }>)[0]?.id,
      url: mediaUrl,
    }]);
    assert.equal(firstJob.payload.peerId, "+12025559876");
    assert.equal(firstJob.payload.relationshipChannel, "imessage");
    assert.equal(firstJob.payload.relationshipPeerId, "+12025559876");
    const source = runtime.store.listEvents("test", { type: "webhook.received" })
      .find((event) => (event.payload as Record<string, unknown>).message_handle === "media-exact-1");
    assert.ok(source);
    assert.equal((source.payload as Record<string, unknown>).media_url, mediaUrl);
    assert.equal((source.payload as Record<string, unknown>).content, content);

    const reboundUrl = "https://attacker.example/rebound.mov?token=different";
    const rebound = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json", "sb-signing-secret": "signed-media-secret" },
      body: JSON.stringify({ ...firstPayload, content: "changed", media_url: reboundUrl }),
    });
    assert.equal(rebound.status, 202);
    assert.equal((await rebound.json() as { duplicate: boolean }).duplicate, true);
    const retained = runtime.store.listEvents("test", { type: "webhook.received" })
      .find((event) => (event.payload as Record<string, unknown>).message_handle === "media-exact-1");
    assert.equal((retained!.payload as Record<string, unknown>).media_url, mediaUrl);
    assert.equal(runtime.store.listJobs("test").filter((job) => job.type === "channel.turn" && job.payload.externalId === "media-exact-1").length, 1);

    const second = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json", "sb-signing-secret": "signed-media-secret" },
      body: JSON.stringify({ content: "same person, later message", is_outbound: false, message_type: "message", from_number: "+12025559876", message_handle: "media-exact-2" }),
    });
    assert.equal(second.status, 202);
    const secondJob = runtime.store.listJobs("test").find((job) => job.type === "channel.turn" && job.payload.externalId === "media-exact-2");
    assert.ok(secondJob);
    assert.equal(secondJob.payload.relationshipPeerId, "+12025559876");
    const firstSession = runtime.store.ensureSession("test", String(firstJob.payload.relationshipChannel), String(firstJob.payload.relationshipPeerId));
    const secondSession = runtime.store.ensureSession("test", String(secondJob.payload.relationshipChannel), String(secondJob.payload.relationshipPeerId));
    assert.equal(secondSession.id, firstSession.id);

    const ambiguousProviderIdentity = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json", "sb-signing-secret": "signed-media-secret" },
      body: JSON.stringify({ content: "guess my country", is_outbound: false, message_type: "message", from_number: "202-555-9876", message_handle: "ambiguous-provider-peer" }),
    });
    assert.equal((await ambiguousProviderIdentity.json() as { ignored: boolean }).ignored, true);
    assert.equal(runtime.store.listJobs("test").some((job) => job.payload.externalId === "ambiguous-provider-peer"), false);

    const unauthenticated = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json", "sb-signing-secret": "wrong" },
      body: JSON.stringify({ ...firstPayload, message_handle: "media-unauthenticated" }),
    });
    assert.equal(unauthenticated.status, 401);
    assert.equal(runtime.store.listJobs("test").some((job) => job.payload.externalId === "media-unauthenticated"), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    home.cleanup();
  }
});
