import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createProfile, defaultSkillRoots, loadConfig, parseProfile } from "../src/config.ts";
import { getDistribution, listDistributions } from "../src/distributions.ts";
import { CoRuntime } from "../src/runtime.ts";
import type { Distribution } from "../src/types.ts";
import { testConfig, testHome } from "./helpers.ts";

test("unknown distributions fail closed instead of silently becoming Donna", () => {
  assert.throws(() => getDistribution("missing"), /Unknown distribution missing/);
  assert.deepEqual(listDistributions().map((item) => item.id), ["co", "donna"]);
});

test("bundled skills are scoped to common and the selected distribution", () => {
  const roots = defaultSkillRoots("/runtime-home", "co", "/workspace");
  assert.equal(roots.some((root) => root.includes("/donna")), false);
  assert.equal(roots.some((root) => root.endsWith("/skills/common")), true);
  assert.equal(roots.some((root) => root.endsWith("/skills/co")), true);
});

test("profiles bind explicit authority-bearing member identities and never overwrite", () => {
  const home = testHome();
  try {
    const created = createProfile({ id: "person_two", home: home.path, timezone: "UTC", memberPeerIds: ["(555) 000-1111"] });
    assert.equal(created.profile.tenantId, "person_two");
    assert.equal(created.profile.distribution, "co");
    assert.equal(created.profile.timezone, "UTC");
    assert.equal(created.profile.workspaceRoots?.length, 1);
    assert.deepEqual(created.profile.memberPeerIds, ["+15550001111"]);
    assert.deepEqual(parseProfile(JSON.parse(readFileSync(created.path, "utf8")) as unknown), created.profile);
    assert.throws(() => createProfile({ id: "person_two", home: home.path }), /already exists/);
    assert.throws(() => parseProfile({ version: 1, id: "bad", tenantId: "bad", memberPeerIds: ["group:someone"] }), /explicit phone number/);
  } finally {
    home.cleanup();
  }
});

test("the Co rename preserves legacy environment, data-home, secret, and distribution inputs", () => {
  const home = testHome();
  const keys = [
    "CO_HOME", "CO_TENANT", "CO_DISTRIBUTION", "CO_SERVER_TOKEN",
    "COMPANION_HOME", "COMPANION_TENANT", "COMPANION_DISTRIBUTION", "COMPANION_SERVER_TOKEN", "COMPANION_SERVER_TOKEN_FILE",
  ] as const;
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<(typeof keys)[number], string | undefined>;
  try {
    for (const key of keys) delete process.env[key];
    process.env.COMPANION_HOME = home.path;
    process.env.COMPANION_TENANT = "legacy_tenant";
    process.env.COMPANION_DISTRIBUTION = "companion";
    const secretPath = join(home.path, "legacy-token");
    writeFileSync(secretPath, "legacy-secret-with-more-than-32-bytes\n");
    process.env.COMPANION_SERVER_TOKEN_FILE = secretPath;

    const legacy = loadConfig();
    assert.equal(legacy.home, home.path);
    assert.equal(legacy.tenantId, "legacy_tenant");
    assert.equal(legacy.distribution, "co");
    assert.equal(legacy.serverToken, "legacy-secret-with-more-than-32-bytes");
    assert.equal(getDistribution("companion").id, "co");

    const primaryHome = join(home.path, "co-home");
    process.env.CO_HOME = primaryHome;
    process.env.CO_TENANT = "co_tenant";
    process.env.CO_SERVER_TOKEN = "co-secret-with-more-than-32-bytes";
    const primary = loadConfig();
    assert.equal(primary.home, primaryHome);
    assert.equal(primary.tenantId, "co_tenant");
    assert.equal(primary.serverToken, "co-secret-with-more-than-32-bytes");
  } finally {
    for (const key of keys) {
      const prior = before[key];
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    home.cleanup();
  }
});

test("a selected profile cannot inherit another person's scoping defaults from the environment", () => {
  const home = testHome();
  const keys = ["CO_TENANT", "CO_MEMBER_PEERS", "CO_DISTRIBUTION", "CO_DISTRIBUTION_CONFIG", "CO_LOCATION", "CO_WORKSPACE_ROOTS", "CO_SKILL_ROOTS", "CO_PLUGIN_ROOTS", "CO_PLUGINS", "CO_EXECUTION_BACKEND", "CO_EXECUTION_ALLOWED_COMMANDS", "TZ"] as const;
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<(typeof keys)[number], string | undefined>;
  try {
    process.env.CO_TENANT = "someone_else";
    process.env.CO_MEMBER_PEERS = "+15559999999";
    process.env.CO_DISTRIBUTION = "donna";
    process.env.CO_DISTRIBUTION_CONFIG = "/someone-else/distribution.json";
    process.env.CO_LOCATION = "someone else's location";
    process.env.CO_WORKSPACE_ROOTS = "/someone-else/workspace";
    process.env.CO_SKILL_ROOTS = "/someone-else/skills";
    process.env.CO_PLUGIN_ROOTS = "/someone-else/plugins";
    process.env.CO_PLUGINS = "someone-else-plugin";
    process.env.CO_EXECUTION_BACKEND = "local";
    process.env.CO_EXECUTION_ALLOWED_COMMANDS = "sh";
    process.env.TZ = "America/Los_Angeles";
    const created = createProfile({ id: "isolated", home: home.path, timezone: "Europe/London" });
    const config = loadConfig({ profilePath: created.path, dbPath: join(home.path, "isolated.sqlite") });
    assert.equal(config.tenantId, "isolated");
    assert.equal(config.distribution, "co");
    assert.equal(config.distributionConfigPath, undefined);
    assert.equal(config.location, undefined);
    assert.deepEqual(config.memberPeerIds, []);
    assert.equal(config.timezone, "Europe/London");
    assert.equal(config.workspaceRoots.some((root) => root.includes("someone-else")), false);
    assert.equal(config.skillRoots.some((root) => root.includes("someone-else")), false);
    assert.equal(config.plugins.roots.some((root) => root.includes("someone-else")), false);
    assert.deepEqual(config.plugins.enabled, []);
    assert.equal(config.execution.backend, "none");
  } finally {
    for (const key of keys) {
      const prior = before[key];
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    home.cleanup();
  }
});

test("existing Sendblue credential names remain a migration-safe alias", () => {
  const home = testHome();
  const keys = ["CO_HOME", "SENDBLUE_API_KEY_ID", "SENDBLUE_API_SECRET_KEY", "SENDBLUE_API_KEY", "SENDBLUE_SECRET_KEY"] as const;
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]])) as Record<(typeof keys)[number], string | undefined>;
  try {
    for (const key of keys) delete process.env[key];
    process.env.CO_HOME = home.path;
    process.env.SENDBLUE_API_KEY = "legacy-key-id";
    process.env.SENDBLUE_SECRET_KEY = "legacy-secret";
    const legacy = loadConfig();
    assert.equal(legacy.sendblue.apiKeyId, "legacy-key-id");
    assert.equal(legacy.sendblue.apiSecretKey, "legacy-secret");

    process.env.SENDBLUE_API_KEY_ID = "explicit-key-id";
    process.env.SENDBLUE_API_SECRET_KEY = "explicit-secret";
    const explicit = loadConfig();
    assert.equal(explicit.sendblue.apiKeyId, "explicit-key-id");
    assert.equal(explicit.sendblue.apiSecretKey, "explicit-secret");
  } finally {
    for (const key of keys) {
      const prior = before[key];
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    home.cleanup();
  }
});

test("a custom distribution is portable data rather than a runtime code change", async () => {
  const home = testHome();
  const custom: Distribution = {
    id: "editor",
    displayName: "Editor",
    systemPrompt: "You are an exacting editor. Do not assume who the user is.",
    foregroundToolNames: ["clock.now"],
    backgroundToolNames: ["clock.now"],
  };
  const path = join(home.path, "editor.json");
  writeFileSync(path, JSON.stringify(custom));
  const loaded = getDistribution("editor", path);
  assert.deepEqual(loaded, custom);
  const config = testConfig(home.path);
  config.distribution = "editor";
  const runtime = new CoRuntime({ config, distribution: loaded });
  try {
    assert.equal(runtime.distribution.displayName, "Editor");
    assert.equal(runtime.skills.skills.length, 0);
  } finally {
    runtime.close();
    home.cleanup();
  }
});
