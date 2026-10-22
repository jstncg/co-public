import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { testHome } from "./helpers.ts";

function environment(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CO_ENV: "test",
    CO_HOME: home,
    CO_PROVIDER: "mock",
    CO_FOREGROUND_PROVIDER: "mock",
    CO_DELIBERATION_PROVIDER: "mock",
    CO_BACKGROUND_PROVIDER: "mock",
    CO_CRITIC_PROVIDER: "mock",
    CO_MEDIA_ANALYZER: "none",
  };
}

test("interactive chat coalesces a multi-line terminal paste into one turn", () => {
  const home = testHome();
  try {
    const result = spawnSync(process.execPath, ["src/cli.ts", "chat"], {
      cwd: process.cwd(), env: environment(home.path), input: "first pasted line\nsecond pasted line\n",
      encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /received 36 characters; working/);
    assert.match(result.stdout, /Mock response: first pasted line\nsecond pasted line/);
  } finally {
    home.cleanup();
  }
});

test("chat --file submits a bounded document with an explicit analysis instruction", () => {
  const home = testHome();
  try {
    const document = join(home.path, "document.txt");
    writeFileSync(document, "alpha\nbeta\ngamma\n", "utf8");
    const result = spawnSync(process.execPath, ["src/cli.ts", "chat", "--file", document, "Summarize this"], {
      cwd: process.cwd(), env: environment(home.path), encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /received .* characters; working/);
    assert.match(result.stdout, /Summarize this/);
    assert.match(result.stdout, /alpha\nbeta\ngamma/);
  } finally {
    home.cleanup();
  }
});

test("chat --stdin reads a complete multi-line stream as one document", () => {
  const home = testHome();
  try {
    const result = spawnSync(process.execPath, ["src/cli.ts", "chat", "--stdin", "Extract the claims"], {
      cwd: process.cwd(), env: environment(home.path), input: "claim one\nclaim two\n",
      encoding: "utf8", timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /received .* characters; working/);
    assert.match(result.stdout, /Extract the claims/);
    assert.match(result.stdout, /claim one\nclaim two/);
  } finally {
    home.cleanup();
  }
});
