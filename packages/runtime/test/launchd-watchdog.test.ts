import assert from "node:assert/strict";
import test from "node:test";
import { recoverLoadedRuntime as recoverLoadedShadow } from "../deploy/launchd-watchdog.ts";

test("watchdog requests a loaded stopped shadow without killing a concurrently started process", () => {
  const calls: string[][] = [];
  const result = recoverLoadedShadow("com.co.runtime-shadow.test", 501, (args) => {
    calls.push(args);
    return { status: 0, stdout: "gui/501/com.co.runtime-shadow.test = {\n\tstate = not running\n}" };
  });
  assert.equal(result, "start-requested-health-unverified");
  assert.deepEqual(calls, [["print", "gui/501/com.co.runtime-shadow.test"], ["kickstart", "gui/501/com.co.runtime-shadow.test"]]);
});

test("watchdog respects intentional removal, running and transitioning jobs, and fails closed on scope/state errors", () => {
  for (const state of ["running", "spawn scheduled", "exited"]) {
    let calls = 0;
    recoverLoadedShadow("com.co.runtime-shadow", 501, () => {
      calls++;
      return { status: 0, stdout: `gui/501/com.co.runtime-shadow = {\n\tstate = ${state}\n}` };
    });
    assert.equal(calls, 1);
  }
  let missingCalls = 0;
  assert.equal(recoverLoadedShadow("com.co.runtime-shadow", 501, () => { missingCalls++; return { status: 113, stdout: "" }; }), "unavailable-no-action");
  assert.equal(missingCalls, 1);
  for (const [label, uid] of [["com.incumbent", 501], ["com.co.runtime-shadow", 0], ["com.co.runtime-shadow/escape", 501]] as const) {
    assert.throws(() => recoverLoadedShadow(label, uid, () => { throw new Error("must not invoke supervisor"); }), /user-scoped/);
  }
  assert.throws(() => recoverLoadedShadow("com.co.runtime-shadow", 501, () => ({ status: 0, stdout: "wrong service" })), /identity/);
  assert.throws(() => recoverLoadedShadow("com.co.runtime-shadow", 501, () => ({ status: 0,
    stdout: "gui/501/com.co.runtime-shadow = {\n\tstate = not running\n\tpid = 123\n}" })), /Conflicting/);
  assert.throws(() => recoverLoadedShadow("com.co.runtime-shadow", 501, (args) => ({ status: args[0] === "print" ? 0 : 1,
    stdout: "gui/501/com.co.runtime-shadow = {\n\tstate = not running\n}" })), /request failed/);
});

test("watchdog supports the exact live runtime label but no incumbent service", () => {
  assert.equal(recoverLoadedShadow("com.co.runtime-live", 501, () => ({ status: 113, stdout: "" })), "unavailable-no-action");
  assert.throws(() => recoverLoadedShadow("com.dennis.co-brain", 501, () => ({ status: 0, stdout: "" })), /user-scoped/);
});
