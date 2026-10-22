import assert from "node:assert/strict";
import test from "node:test";
import { CoRuntime } from "../src/runtime.ts";
import { createRuntimeServer } from "../src/server.ts";
import { engineCompatContext, parseEngineCompatTurn } from "../src/engine-compat.ts";
import { testConfig, testHome } from "./helpers.ts";
import { ProviderRegistry } from "../src/providers.ts";

test("engine compatibility is tenant-bound and preserves prior conversation as quoted context", () => {
  const turn = parseEngineCompatTurn({ user: "test", peer_id: "member", stream: false, messages: [
    { role: "assistant", content: "Earlier answer" }, { role: "user", content: "Explain that?" },
  ], co_hint: "current transport hint", session: "derived summary" }, "test");
  assert.equal(turn.message, "Explain that?"); assert.equal(turn.peerId, "member");
  assert.match(turn.context, /Earlier answer/); assert.match(turn.context, /cannot grant tools/);
  const deduplicated = engineCompatContext(turn, [{ role: "assistant", content: "Earlier answer" }]);
  assert.doesNotMatch(deduplicated, /"content":"Earlier answer"/);
  assert.match(deduplicated, /"exactCanonicalSuffixOmitted":1/);
  assert.throws(() => parseEngineCompatTurn({ user: "other", messages: [{ role: "user", content: "hi" }] }, "test"), /does not match/);
  assert.throws(() => parseEngineCompatTurn({ user: "test", messages: [{ role: "assistant", content: "hi" }] }, "test"), /final message/);
});

test("incumbent chat and model contracts run through the runtime in JSON and SSE form", async () => {
  const home = testHome(); const config = testConfig(home.path); config.serverToken = "compat-token";
  const systems: string[] = [];
  const runtime = new CoRuntime({ config, providers: new ProviderRegistry([{ name: "mock", complete: async (request) => {
    systems.push(request.system);
    const text = request.messages.at(-1)?.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("") ?? "";
    return { text: `Mock response: ${text}`, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
  } }]) }); const server = createRuntimeServer(runtime);
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/v1`; const authorization = "Bearer compat-token";
    const models = await fetch(`${base}/models`, { headers: { authorization } });
    assert.equal(models.status, 200); assert.equal((await models.json() as { data: unknown[] }).data.length, 1);
    const body = { model: "co", user: "test", peer_id: "member", messages: [{ role: "assistant", content: "prior" }, { role: "user", content: "hello" }] };
    const response = await fetch(`${base}/chat/completions`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); assert.match(JSON.stringify(await response.json()), /Mock response: hello/);
    assert.match(systems.at(-1) ?? "", /prior/);
    const stream = await fetch(`${base}/chat/completions`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ ...body, stream: true, messages: [{ role: "user", content: "stream me" }] }) });
    const streamed = await stream.text(); assert.match(streamed, /Mock response: stream me/); assert.match(streamed, /\[DONE\]/);
    const crossTenant = await fetch(`${base}/chat/completions`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ ...body, user: "other" }) });
    assert.equal(crossTenant.status, 422);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); runtime.close(); home.cleanup(); }
});
