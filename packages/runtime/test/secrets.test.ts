import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readSecret } from "../src/secrets.ts";
import { testHome } from "./helpers.ts";
import { loadConfig } from "../src/config.ts";

test("shared dotenv selects one credential without importing connector authority or evaluating shell text", () => {
  const home = testHome();
  try {
    const path = join(home.path, "service.env");
    writeFileSync(path, 'export TEST_MODEL_KEY="literal-$(whoami)-${OTHER}"\nTEST_CONNECTOR_KEY=unrelated\n', { mode: 0o600 });
    const before = process.env.TEST_CONNECTOR_KEY;
    const environment = { TEST_MODEL_KEY_DOTENV_FILE: path };
    assert.equal(readSecret("TEST_MODEL_KEY", environment), "literal-$(whoami)-${OTHER}");
    assert.equal(readSecret("TEST_CONNECTOR_KEY", environment), undefined);
    assert.equal(process.env.TEST_CONNECTOR_KEY, before);
    writeFileSync(path, 'TEST_MODEL_KEY="rotated-key"\n', { mode: 0o600 });
    assert.equal(readSecret("TEST_MODEL_KEY", environment), "rotated-key", "next read sees rotation without copying secrets");
  } finally { home.cleanup(); }
});

test("secret sources reject conflicts, missing keys, unsafe files and oversized reads without leaking contents", () => {
  const home = testHome();
  try {
    const path = join(home.path, "service.env");
    writeFileSync(path, "UNRELATED=sensitive-value\n", { mode: 0o600 });
    for (const environment of [
      { KEY: "inline", KEY_DOTENV_FILE: path },
      { KEY_FILE: path, KEY_DOTENV_FILE: path },
      { KEY: "", KEY_FILE: path },
    ]) assert.throws(() => readSecret("KEY", environment), /Set only one/);
    assert.throws(() => readSecret("KEY", { KEY_DOTENV_FILE: path }), /no nonempty value/);
    chmodSync(path, 0o622);
    assert.throws(() => readSecret("KEY", { KEY_DOTENV_FILE: path }), /owner-controlled/);
    chmodSync(path, 0o600);
    writeFileSync(path, "x".repeat(65_537));
    for (const suffix of ["_FILE", "_DOTENV_FILE"]) {
      assert.throws(() => readSecret("KEY", { [`KEY${suffix}`]: path }), /exceeds 64 KiB/);
      assert.throws(() => readSecret("KEY", { [`KEY${suffix}`]: home.path }), /regular file/);
    }
    writeFileSync(path, "KEY=sensitive-value\0");
    assert.throws(() => readSecret("KEY", { KEY_DOTENV_FILE: path }), (error: unknown) =>
      error instanceof Error && error.message.includes("null byte") && !error.message.includes("sensitive-value"));
    assert.throws(() => readSecret("invalid=name", {}), /Invalid secret/);
  } finally { home.cleanup(); }
});

test("runtime can reuse a differently named service token without copying it", () => {
  const home = testHome();
  const keys = ["CO_SERVER_TOKEN", "CO_SERVER_TOKEN_FILE", "CO_SERVER_TOKEN_DOTENV_FILE", "CO_SERVER_TOKEN_ENV", "EXISTING_SERVICE_TOKEN"];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    process.env.CO_HOME = home.path;
    process.env.CO_SERVER_TOKEN_ENV = "EXISTING_SERVICE_TOKEN";
    process.env.EXISTING_SERVICE_TOKEN = "existing-service-token-with-enough-entropy";
    assert.equal(loadConfig().serverToken, process.env.EXISTING_SERVICE_TOKEN);
    process.env.CO_SERVER_TOKEN = "conflict";
    assert.throws(() => loadConfig(), /not both/);
  } finally {
    delete process.env.CO_HOME;
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
    home.cleanup();
  }
});
