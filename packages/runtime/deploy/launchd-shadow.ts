#!/usr/bin/env node
/** Prepare a fresh, credential-free infrastructure rehearsal. Activation is a
 * separate launchctl operation; this never replaces an existing service. */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

const [destination, rawPort = "8788", label = "com.co.runtime-shadow"] = process.argv.slice(2);
if (process.platform !== "darwin") throw new Error("This supervisor adapter requires macOS; use deploy/docker-compose.yml on Linux");
if (!destination || !isAbsolute(destination) || !/^com\.co\.runtime-shadow(?:\.[a-z0-9-]+)?$/.test(label)) {
  throw new Error("Usage: node deploy/launchd-shadow.ts /absolute/new/private-directory [port] [com.co.runtime-shadow.suffix]");
}
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Port must be an integer between 1024 and 65535");
const home = resolve(destination);
const launchAgents = join(homedir(), "Library", "LaunchAgents");
const plistPath = join(launchAgents, `${label}.plist`);
if (existsSync(home) || existsSync(plistPath)) throw new Error("Refusing to overwrite an existing state directory or supervisor configuration");
// An explicitly supplied existing parent is required; do not recursively
// create a mistyped path. The state directory never shares the live database.
realpathSync(dirname(home));
mkdirSync(home, { mode: 0o700 });
const workspace = join(home, "workspace");
mkdirSync(workspace, { mode: 0o700 });
const tokenPath = join(home, "server-token");
writeFileSync(tokenPath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
const runtimeRoot = fileURLToPath(new URL("../", import.meta.url));
const variables: Record<string, string> = {
  CO_HOME: home, CO_DB: join(home, "runtime.sqlite"), CO_TENANT: "shadow-rehearsal",
  CO_ENV: "development", CO_RUNTIME_MODE: "shadow", CO_PROVIDER: "mock", CO_MODEL: "mock-1",
  CO_EXECUTION_BACKEND: "none", CO_MEDIA_ANALYZER: "none", CO_EMAIL_PROVIDER: "none",
  CO_SERVER_TOKEN_FILE: tokenPath, CO_WORKSPACE_ROOTS: workspace,
};
const argumentsList = [process.execPath, join(runtimeRoot, "src", "cli.ts"), "daemon", "--host", "127.0.0.1", "--port", String(port)];
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${argumentsList.map((argument) => `<string>${xml(argument)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(runtimeRoot)}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(variables).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(join(home, "daemon.stdout.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(home, "daemon.stderr.log"))}</string>
</dict></plist>
`;
mkdirSync(launchAgents, { recursive: true });
writeFileSync(plistPath, plist, { mode: 0o600, flag: "wx" });
chmodSync(home, 0o700);
console.log(JSON.stringify({ status: "prepared-not-started", mode: "shadow", provider: "mock", home, plistPath, port }));
