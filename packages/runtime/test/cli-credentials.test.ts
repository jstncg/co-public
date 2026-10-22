import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { testHome } from "./helpers.ts";

function environment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1", CO_ENV: "test", CO_HOME: home, CO_TENANT: "cli-credentials",
    CO_PROVIDER: "mock", CO_FOREGROUND_PROVIDER: "mock", CO_DELIBERATION_PROVIDER: "mock", CO_BACKGROUND_PROVIDER: "mock", CO_CRITIC_PROVIDER: "mock",
    CO_MEDIA_ANALYZER: "none", CO_BROWSER_CREDENTIAL_KEY: Buffer.alloc(32, 17).toString("base64"),
  };
}

function run(home: string, arguments_: string[], input?: string): string {
  const result = spawnSync(process.execPath, ["src/cli.ts", ...arguments_], {
    cwd: process.cwd(), env: environment(home), encoding: "utf8", timeout: 5_000, ...(input !== undefined ? { input } : {}),
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("credential CLI accepts secrets only through masked or piped input and prints opaque handles", () => {
  const home = testHome();
  try {
    const secretInput = JSON.stringify({ username: "cli@example.com", password: "cli-secret-value" });
    const createdText = run(home.path, ["credential", "add", "--origin", "https://accounts.example.com/login", "--label", "CLI login", "--stdin"], secretInput);
    assert.doesNotMatch(createdText, /cli@example\.com|cli-secret-value/);
    const created = JSON.parse(createdText) as { id: string; origin: string; fieldNames: string[]; status: string };
    assert.match(created.id, /^cred_/);
    assert.equal(created.origin, "https://accounts.example.com");
    assert.deepEqual(created.fieldNames, ["password", "username"]);

    const listed = run(home.path, ["credentials"]);
    assert.match(listed, new RegExp(created.id));
    assert.doesNotMatch(listed, /cli@example\.com|cli-secret-value/);
    const retired = JSON.parse(run(home.path, ["credential", "retire", created.id])) as { status: string };
    assert.equal(retired.status, "retired");
  } finally {
    home.cleanup();
  }
});
