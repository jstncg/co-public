import assert from "node:assert/strict";
import test from "node:test";
import { hydrateImages, imageData, MAX_NATIVE_IMAGES } from "../src/images.ts";
import { AnthropicProvider, OpenAICompatibleProvider, OpenAIProvider, ProviderRegistry, providerRequestCostEstimate } from "../src/providers.ts";
import { CoRuntime } from "../src/runtime.ts";
import { createRuntimeServer } from "../src/server.ts";
import type { ImagePart, ProviderAdapter, ProviderRequest } from "../src/types.ts";
import { testConfig, testHome } from "./helpers.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const image: ImagePart = { type: "image", sourceEventId: "source", attachmentId: "attachment", mimeType: "image/png", data: png };

test("HTTP chat preserves attachment references and composes with native pixels", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: { ...testConfig(home.path), mode: "shadow" },
    imageFetcher: async (url) => ({ url, status: 200, headers: {}, body: Buffer.from(png, "base64") }),
    providers: new ProviderRegistry([{ name: "mock", complete: async (request) => {
      assert.equal(request.messages.flatMap((message) => message.parts).some((part) => part.type === "image" && part.data === png), true);
      return { text: "red", toolCalls: [], usage: { inputTokens: 12, outputTokens: 1, reasoningTokens: 0 } };
    } }]),
  });
  const server = createRuntimeServer(runtime);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "What color?", attachments: [{ id: "image", url: "https://example.test/image", mimeType: "image/png" }] }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { text: string }).text, "red");
    assert.equal(runtime.store.listJobs("test").length, 0);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close(); home.cleanup();
  }
});

test("native image bytes use each provider's wire format, never provenance IDs or transport URLs", async () => {
  const originalFetch = globalThis.fetch;
  const priorKey = process.env.CO_IMAGE_TEST_KEY;
  process.env.CO_IMAGE_TEST_KEY = "test-key";
  try {
    for (const adapter of [new OpenAIProvider(), new AnthropicProvider(), new OpenAICompatibleProvider()]) {
      let sent: Record<string, unknown> = {};
      globalThis.fetch = async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(JSON.stringify(adapter.name === "openai" ? {
          output: [{ type: "message", content: [{ type: "output_text", text: "red" }] }], usage: { input_tokens: 12, output_tokens: 1 },
        } : adapter.name === "anthropic" ? {
          content: [{ type: "text", text: "red" }], usage: { input_tokens: 12, output_tokens: 1 },
        } : { choices: [{ message: { content: "red" } }], usage: { prompt_tokens: 12, completion_tokens: 1 } }), { status: 200 });
      };
      const request: ProviderRequest = {
        tenantId: "tenant", tools: [], system: "Describe what you can see.",
        route: { provider: adapter.name, model: "fixture", baseUrl: "https://fixture.invalid", maxOutputTokens: 64, reasoningEffort: "none", apiKeyEnv: "CO_IMAGE_TEST_KEY" },
        messages: [{ id: "m", role: "user", createdAt: new Date().toISOString(), parts: [image, { type: "text", text: "Which color?" }] }],
      };
      assert.equal((await adapter.complete(request)).text, "red");
      const wire = JSON.stringify(sent);
      assert.equal(wire.includes(png), true);
      assert.equal(wire.includes("sourceEventId"), false);
      assert.equal(wire.includes("attachmentId"), false);
      assert.match(wire, adapter.name === "openai" ? /input_image/ : adapter.name === "anthropic" ? /media_type/ : /image_url/);
      assert.throws(() => providerRequestCostEstimate({ ...request, route: { ...request.route,
        costCeiling: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1, maxRequestUsd: 1 },
      } }), /visual-token/);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (priorKey === undefined) delete process.env.CO_IMAGE_TEST_KEY;
    else process.env.CO_IMAGE_TEST_KEY = priorKey;
  }
});

test("foreground sees an image on its first compose, retaining bytes across restart without duplicating them in messages", async () => {
  const home = testHome();
  const config = testConfig(home.path);
  let fetches = 0;
  let seen = 0;
  const adapter: ProviderAdapter = {
    name: "mock", complete: async (request) => {
      const visual = request.messages.flatMap((message) => message.parts).find((part) => part.type === "image");
      assert.equal(visual?.data, png);
      assert.equal(JSON.stringify(request).includes("private-signature"), false);
      seen += 1;
      return { text: "The image contains a red pixel.", toolCalls: [], usage: { inputTokens: 12, outputTokens: 7, reasoningTokens: 0 } };
    },
  };
  let runtime: CoRuntime = new CoRuntime({ config, providers: new ProviderRegistry([adapter]), imageFetcher: async (url) => {
    fetches += 1;
    assert.equal(runtime.store.listRuns("test")[0]?.status, "running", "acceptance precedes download");
    return { url, status: 200, headers: { "content-type": "image/png" }, body: Buffer.from(png, "base64") };
  } });
  try {
    const first = await runtime.turn({ tenantId: "test", channel: "cli", peerId: "p", text: "Which color?", externalId: "image-1",
      attachments: [{ id: "pic", url: "https://example.test/image?private-signature=secret", mimeType: "image/png" }],
    });
    assert.equal(first.status, "completed", first.text);
    assert.equal(runtime.store.listMessages("test", first.sessionId).some((message) => JSON.stringify(message).includes(png)), false);
    assert.equal(JSON.stringify(runtime.store.getRun(first.runId)?.state ?? null).includes(png), false);
    runtime.close();
    runtime = new CoRuntime({ config, providers: new ProviderRegistry([adapter]), imageFetcher: async () => { throw new Error("expired URL"); } });
    const second = await runtime.turn({ tenantId: "test", channel: "cli", peerId: "p", text: "Can you still see that image?" });
    assert.equal(second.status, "completed");
    assert.equal(fetches, 1);
    assert.equal(seen, 2);
  } finally { runtime.close(); home.cleanup(); }
});

test("unavailable images are explicit, bounded, and cannot leak capabilities or cross tenants", async () => {
  const home = testHome();
  const runtime = new CoRuntime({ config: testConfig(home.path) });
  try {
    const attachments = Array.from({ length: MAX_NATIVE_IMAGES + 1 }, (_, index) => ({
      id: `image-${index}`, url: `https://example.test/${index}?secret=capability`, mimeType: "image/png" as const,
    }));
    const source = runtime.store.appendEvent({ tenantId: "test", stream: "test", type: "message.received", payload: { attachments } });
    const messages = [{ id: "m", role: "user" as const, createdAt: source.at, parts: attachments.map((attachment) => ({
      type: "image" as const, attachmentId: attachment.id, sourceEventId: source.id, mimeType: attachment.mimeType,
    })) }];
    let fetched = 0;
    const result = await hydrateImages(runtime.originals, "test", messages, { assertLease: () => undefined,
      fetchResource: async () => { fetched += 1; throw new Error("private URL and secret should not escape"); },
    });
    assert.equal(fetched, MAX_NATIVE_IMAGES);
    assert.match(JSON.stringify(result), /Earlier image omitted/);
    assert.match(JSON.stringify(result), /Image unavailable/);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    await assert.rejects(hydrateImages(runtime.originals, "different-tenant", messages, { assertLease: () => undefined }), /cross-tenant/);
    await assert.rejects(hydrateImages(runtime.originals, "test", messages, { assertLease: () => { throw new Error("lease lost"); } }), /lease lost/);
    assert.throws(() => imageData({ ...image, data: Buffer.from("<html>not an image</html>").toString("base64") }), /MIME/);
  } finally { runtime.close(); home.cleanup(); }
});
