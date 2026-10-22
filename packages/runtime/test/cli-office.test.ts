import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { testHome } from "./helpers.ts";

function run(home: string, arguments_: string[]): string {
  const result = spawnSync(process.execPath, ["src/cli.ts", ...arguments_], {
    cwd: process.cwd(), encoding: "utf8", timeout: 5_000,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: "1", CO_ENV: "test", CO_HOME: home, CO_TENANT: "cli-office",
      CO_PROVIDER: "mock", CO_FOREGROUND_PROVIDER: "mock", CO_DELIBERATION_PROVIDER: "mock", CO_BACKGROUND_PROVIDER: "mock", CO_CRITIC_PROVIDER: "mock", CO_MEDIA_ANALYZER: "none",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("office CLI creates governed service state and renders a compact daily view", () => {
  const home = testHome();
  try {
    const mandate = JSON.parse(run(home.path, ["mandate", "propose", "--name", "Research desk", "--contract", "Prepare useful research without publishing."])) as { id: string; status: string };
    assert.equal(mandate.status, "proposed");
    assert.equal((JSON.parse(run(home.path, ["mandate", "approve", mandate.id])) as { status: string }).status, "active");
    const matter = JSON.parse(run(home.path, ["matter", "create", "Launch", "--summary", "Track the launch decision", "--priority", "80", "--mandate", mandate.id])) as { id: string };
    const artifact = JSON.parse(run(home.path, ["artifact", "prepare", "brief", "Launch brief", "--content", "A prepared decision brief.", "--matter", matter.id])) as { id: string };
    const today = JSON.parse(run(home.path, ["today", "--json"])) as { activeMandates: unknown[]; matters: unknown[]; prepared: unknown[] };
    assert.equal(today.activeMandates.length, 1);
    assert.equal(today.matters.length, 1);
    assert.equal(today.prepared.length, 1);
    assert.match(run(home.path, ["today"]), /Standing service/);
    assert.equal((JSON.parse(run(home.path, ["why", artifact.id])) as { kind: string }).kind, "prepared_artifact");
  } finally {
    home.cleanup();
  }
});
