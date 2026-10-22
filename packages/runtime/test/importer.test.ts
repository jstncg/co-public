import assert from "node:assert/strict";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import test from "node:test";
import { LogImporter } from "../src/importer.ts";
import { SqliteStore } from "../src/store.ts";
import { testHome } from "./helpers.ts";

test("log import is append-only, idempotent, and leaves source files unchanged", async () => {
  const home = testHome();
  const path = `${home.path}/history.jsonl`;
  const original = '{"type":"user","timestamp":"2025-09-14T10:30:00Z","message":{"role":"user","content":"old thought about Nightingale"}}\nnot-json-but-important\n';
  writeFileSync(path, original);
  const store = new SqliteStore(`${home.path}/runtime.sqlite`);
  try {
    const importer = new LogImporter(store);
    const first = await importer.importPath("test", path);
    const second = await importer.importPath("test", path);
    assert.equal(first.imported, 2);
    assert.equal(second.imported, 0);
    assert.equal(second.skipped, 2);
    assert.equal(readFileSync(path, "utf8"), original);
    assert.equal(store.listEvents("test", { type: "log.imported" }).length, 2);
    const historical = store.searchEvidence("test", "Nightingale");
    assert.equal(historical.length, 1);
    assert.equal(historical[0]?.trustClass, "owner");
    assert.equal(historical[0]?.observedAt, "2025-09-14T10:30:00.000Z");
    assert.equal(store.searchEvidence("test", "not-json-but-important").length, 0);
    assert.equal(store.searchEvidence("test", "not-json-but-important", { trustClasses: ["untrusted"] }).length, 1);
  } finally {
    store.close();
    home.cleanup();
  }
});

test("text imports remain stable across appends, moves, and tenants", async () => {
  const home = testHome();
  const originalPath = `${home.path}/history.txt`;
  const movedPath = `${home.path}/moved.txt`;
  writeFileSync(originalPath, "first line\n");
  const store = new SqliteStore(`${home.path}/runtime.sqlite`);
  try {
    const importer = new LogImporter(store);
    assert.deepEqual(await importer.importPath("one", originalPath), { files: 1, imported: 1, skipped: 0 });
    appendFileSync(originalPath, "second line\n");
    assert.deepEqual(await importer.importPath("one", originalPath), { files: 1, imported: 1, skipped: 1 });
    renameSync(originalPath, movedPath);
    assert.deepEqual(await importer.importPath("one", movedPath), { files: 1, imported: 0, skipped: 2 });
    assert.deepEqual(await importer.importPath("two", movedPath), { files: 1, imported: 2, skipped: 0 });
    assert.equal(store.listEvents("one", { type: "log.imported" }).length, 2);
    assert.equal(store.listEvents("two", { type: "log.imported" }).length, 2);
  } finally {
    store.close();
    home.cleanup();
  }
});
