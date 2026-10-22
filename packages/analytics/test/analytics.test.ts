import { test } from "node:test";
import assert from "node:assert/strict";
import { track, AnalyticsViolationError, looksLikeRawContent, type AnalyticsProps } from "../src/index";
import type { ProductEventName } from "@co/contracts";

function capture() {
  const written: Array<{ event: ProductEventName; props: AnalyticsProps }> = [];
  return { written, sink: { write: (event: ProductEventName, props: AnalyticsProps) => void written.push({ event, props }) } };
}

test("valid content-free event passes through", () => {
  const { written, sink } = capture();
  track("capture_created", { source_type: "article", coverage: "text", user_id: "00000000-0000-4000-8000-000000000101" }, { sink, mode: "dev" });
  assert.equal(written.length, 1);
});

test("unknown event name throws in dev", () => {
  const { sink } = capture();
  assert.throws(() => track("made_up_event", {}, { sink, mode: "dev" }), AnalyticsViolationError);
});

test("raw-content-shaped props throw in dev: long string", () => {
  const { sink } = capture();
  const longText = "x".repeat(81);
  assert.throws(() => track("why_submitted", { note: longText }, { sink, mode: "dev" }), AnalyticsViolationError);
});

test("raw-content-shaped props throw in dev: sentence-like string", () => {
  const { sink } = capture();
  assert.throws(
    () => track("why_submitted", { why: "the room mattered more than the pottery tonight" }, { sink, mode: "dev" }),
    AnalyticsViolationError,
  );
});

test("prod mode drops violations silently, never writes", () => {
  const { written, sink } = capture();
  track("why_submitted", { why: "a full private sentence that should never be logged" }, { sink, mode: "prod" });
  track("made_up_event", {}, { sink, mode: "prod" });
  assert.equal(written.length, 0);
});

test("looksLikeRawContent boundary: 5 words ok, 6 words rejected", () => {
  assert.equal(looksLikeRawContent("one two three four five"), false);
  assert.equal(looksLikeRawContent("one two three four five six"), true);
  assert.equal(looksLikeRawContent(42), false);
  assert.equal(looksLikeRawContent(null), false);
});
