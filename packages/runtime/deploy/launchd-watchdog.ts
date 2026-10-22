#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Result = { status: number | null; stdout: string };
type Runner = (args: string[]) => Result;

/** External liveness recovery for macOS KeepAlive deferrals. Never bootstrap a
 * removed service, replace a running process, inspect credentials, or touch an
 * incumbent sender. A successful kickstart is a request, not proof of health. */
export function recoverLoadedRuntime(label: string, uid: number, run: Runner): string {
  if (!/^com\.co\.runtime-(?:shadow|live)(?:\.[a-z0-9-]+)?$/.test(label)
    || !Number.isSafeInteger(uid) || uid <= 0) throw new Error("Expected a user-scoped Co runtime service");
  const target = `gui/${uid}/${label}`;
  const inspected = run(["print", target]);
  if (inspected.status !== 0) return "unavailable-no-action";
  if (!inspected.stdout.startsWith(`${target} = {\n`)) throw new Error("Unexpected supervisor identity");
  const state = inspected.stdout.match(/^\tstate = (.+)$/m)?.[1];
  if (state === "running") return "running-no-action";
  if (state !== "not running") return "transitioning-no-action";
  if (/^\tpid = [1-9][0-9]*$/m.test(inspected.stdout)) throw new Error("Conflicting supervisor process state");
  // No -k: if launchd starts it between inspection and this request, do not kill it.
  if (run(["kickstart", target]).status !== 0) throw new Error("Runtime recovery request failed");
  return "start-requested-health-unverified";
}

export const recoverLoadedShadow = recoverLoadedRuntime;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== "darwin") throw new Error("This adapter requires macOS");
    const label = process.argv[2];
    if (!label || process.argv.length !== 3) throw new Error("Usage: launchd-watchdog.ts com.co.runtime-{shadow|live}[.suffix]");
    const status = recoverLoadedRuntime(label, process.getuid!(), (args) => {
      const result = spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 5000, maxBuffer: 128_000 });
      return { status: result.status, stdout: result.stdout ?? "" };
    });
    if (status !== "running-no-action") console.log(JSON.stringify({ at: new Date().toISOString(), service: label, status }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Runtime recovery failed");
    process.exitCode = 1;
  }
}
