import assert from "node:assert/strict";
import test from "node:test";
import { successfulToolResult, ToolRegistry } from "../src/tools.ts";

test("tool validation enforces enums, bounds, integers, arrays, and nested schemas", () => {
  const registry = new ToolRegistry();
  registry.register({
    definition: {
      name: "strict.example",
      description: "test",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["safe"] },
          count: { type: "integer", minimum: 1, maximum: 3 },
          items: { type: "array", maxItems: 2, items: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 2 } }, additionalProperties: false } },
        },
        required: ["mode", "count", "items"],
        additionalProperties: false,
      },
      risk: "read",
      tags: [],
      idempotent: true,
    },
    evaluateResult: successfulToolResult,
    execute: async () => ({ ok: true }),
  });
  assert.ok(registry.validate({ id: "ok", name: "strict.example", arguments: { mode: "safe", count: 2, items: [{ name: "ab" }] } }));
  assert.throws(
    () => registry.validate(
      { id: "hidden", name: "strict.example", arguments: { mode: "safe", count: 2, items: [] } },
      ["another.tool"],
    ),
    /outside this run's authority/,
  );
  assert.throws(() => registry.validate({ id: "bad-enum", name: "strict.example", arguments: { mode: "unsafe", count: 2, items: [] } }), /enum/);
  assert.throws(() => registry.validate({ id: "bad-int", name: "strict.example", arguments: { mode: "safe", count: 1.5, items: [] } }), /integer/);
  assert.throws(() => registry.validate({ id: "bad-max", name: "strict.example", arguments: { mode: "safe", count: 4, items: [] } }), /at most/);
  assert.throws(() => registry.validate({ id: "bad-nested", name: "strict.example", arguments: { mode: "safe", count: 2, items: [{ name: "x", extra: true }] } }), /too short|not allowed/);
});

test("tool selection preserves distribution preference order while letting relevant tools rise", () => {
  const registry = new ToolRegistry();
  const register = (name: string, tags: string[]) => registry.register({
    definition: { name, description: `${name} capability`, inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "read", tags, idempotent: true },
    evaluateResult: successfulToolResult,
    execute: async () => ({}),
  });
  register("office.today", ["calendar", "briefing"]);
  register("history.search", ["history"]);
  register("clock.now", ["time"]);
  register("file.read", ["file", "read"]);
  const preferred = ["clock.now", "history.search", "office.today"];
  assert.deepEqual(registry.select("hello", preferred, 2).map((tool) => tool.name), ["clock.now", "history.search"]);
  assert.deepEqual(registry.select("show my calendar", preferred, 2).map((tool) => tool.name), ["office.today", "clock.now"]);
  assert.deepEqual(registry.select("use file.read", preferred, 2).map((tool) => tool.name), ["file.read", "clock.now"]);
});
