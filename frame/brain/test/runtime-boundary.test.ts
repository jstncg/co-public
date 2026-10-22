import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import {
  RuntimeRequestError,
  assertEngineAuthorization,
  loadRuntimeConfig,
  parseTurnEnvelope,
  readBoundedBody,
  readTurnEnvelope,
  requestPath,
} from "../runtime-boundary.ts";

const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEF";

function requestBody(chunks: Array<string | Buffer>): IncomingMessage {
  return Readable.from(chunks) as IncomingMessage;
}

function expectRequestError(run: () => unknown, status: number, code: string): void {
  assert.throws(run, (error) => {
    assert.ok(error instanceof RuntimeRequestError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  });
}

test("runtime is loopback-only by default", () => {
  assert.deepEqual(loadRuntimeConfig({}), {
    host: "127.0.0.1",
    port: 8090,
    token: undefined,
    maxBodyBytes: 1024 * 1024,
    bodyTimeoutMs: 15_000,
  });
});

test("a non-loopback listener requires a strong token", () => {
  assert.throws(
    () => loadRuntimeConfig({ WITNESS_HOST: "0.0.0.0" }),
    /CO_ENGINE_TOKEN is required/,
  );
  assert.throws(
    () => loadRuntimeConfig({ WITNESS_HOST: "0.0.0.0", CO_ENGINE_TOKEN: "too-short" }),
    /at least 32 bytes/,
  );
  assert.equal(
    loadRuntimeConfig({ WITNESS_HOST: "0.0.0.0", CO_ENGINE_TOKEN: TOKEN }).host,
    "0.0.0.0",
  );
});

test("a configured token is required and compared exactly", () => {
  const open = loadRuntimeConfig({});
  assert.doesNotThrow(() => assertEngineAuthorization(open, undefined));

  const secured = loadRuntimeConfig({ CO_ENGINE_TOKEN: TOKEN });
  expectRequestError(() => assertEngineAuthorization(secured, undefined), 401, "unauthorized");
  expectRequestError(
    () => assertEngineAuthorization(secured, `Bearer ${TOKEN}x`),
    401,
    "unauthorized",
  );
  assert.doesNotThrow(() => assertEngineAuthorization(secured, `Bearer ${TOKEN}`));
});

test("turn parsing keeps only the engine contract and normalizes tenant case", () => {
  assert.deepEqual(
    parseTurnEnvelope({
      model: "co",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
      user: "Member_01",
      unknown_openai_field: 0.4,
    }),
    {
      model: "co",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
      user: "member_01",
      channel: undefined,
      mode: undefined,
      co_hint: undefined,
      session: undefined,
    },
  );
});

test("turn parsing rejects ambiguous tenants before a database path is selected", () => {
  const body = { model: "co", messages: [{ role: "user", content: "hello" }], stream: false };
  expectRequestError(() => parseTurnEnvelope(body), 422, "invalid_request");
  expectRequestError(
    () => parseTurnEnvelope({ ...body, user: "../dennis" }),
    422,
    "invalid_tenant",
  );
  expectRequestError(
    () => parseTurnEnvelope({ ...body, user: "member one" }),
    422,
    "invalid_tenant",
  );
});

test("turn parsing requires a final user turn", () => {
  expectRequestError(
    () =>
      parseTurnEnvelope({
        model: "co",
        user: "member",
        messages: [{ role: "assistant", content: "hello" }],
      }),
    422,
    "invalid_messages",
  );
});

test("body reading preserves utf-8 bytes and rejects oversized input", async () => {
  assert.equal(await readBoundedBody(requestBody(["h", Buffer.from("é")]), 3, 1_000), "hé");
  await assert.rejects(readBoundedBody(requestBody(["four"]), 3, 1_000), (error) => {
    assert.ok(error instanceof RuntimeRequestError);
    assert.equal(error.status, 413);
    assert.equal(error.code, "request_too_large");
    return true;
  });
});

test("invalid JSON is reported without entering turn handling", async () => {
  const config = loadRuntimeConfig({ CO_ENGINE_MAX_BODY_BYTES: "1024" });
  await assert.rejects(readTurnEnvelope(requestBody(["{"]), config), (error) => {
    assert.ok(error instanceof RuntimeRequestError);
    assert.equal(error.status, 400);
    assert.equal(error.code, "invalid_json");
    return true;
  });
});

test("routing uses exact URL paths", () => {
  assert.equal(requestPath("/v1/chat/completions?trace=1"), "/v1/chat/completions");
  assert.notEqual(requestPath("/v1/chat/completions-extra"), "/v1/chat/completions");
});
