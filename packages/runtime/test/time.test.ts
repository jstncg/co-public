import assert from "node:assert/strict";
import test from "node:test";
import { absoluteTime } from "../src/time.ts";

test("due times require explicit offsets and reject normalized-away calendar errors", () => {
  assert.equal(absoluteTime("2026-09-06T09:00:00-07:00", "dueAt"), "2026-09-06T16:00:00.000Z");
  assert.equal(absoluteTime("2026-11-01T01:30-07:00", "dueAt"), "2026-11-01T08:30:00.000Z");
  assert.equal(absoluteTime("2026-11-01T01:30-08:00", "dueAt"), "2026-11-01T09:30:00.000Z");
  for (const invalid of ["2026-11-01T01:30", "2026-09-06", "2026-02-30T10:00:00Z", "2026-09-06T24:00:00Z", "2026-09-06T10:00:00+99:00"]) {
    assert.throws(() => absoluteTime(invalid, "dueAt"), /dueAt/);
  }
});
