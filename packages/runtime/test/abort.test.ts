import assert from "node:assert/strict";
import test from "node:test";
import { withAbort } from "../src/abort.ts";
import { fetchPublicResource } from "../src/media.ts";

test("an aborted DNS lookup never reaches HTTP even when the resolver cannot cancel", async () => {
  const controller = new AbortController();
  let requests = 0;
  const pending = fetchPublicResource("https://example.test/image", {}, 1024, 5, {
    signal: controller.signal, resolve: async () => new Promise(() => undefined),
    request: async () => { requests += 1; throw new Error("must not be called"); },
  });
  controller.abort(new Error("deadline exceeded"));
  await assert.rejects(pending, /deadline exceeded/);
  assert.equal(requests, 0);
});

test("late dependency rejections remain handled after caller cancellation", async () => {
  const controller = new AbortController();
  let rejectLate: (error: Error) => void = () => undefined;
  const pending = withAbort(new Promise<never>((_resolve, reject) => { rejectLate = reject; }), controller.signal);
  controller.abort(new Error("closed"));
  await assert.rejects(pending, /closed/);
  rejectLate(new Error("late failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(await withAbort(Promise.resolve(4)), 4);
});
