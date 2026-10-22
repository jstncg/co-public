import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CoRuntime } from "../src/runtime.ts";
import { loadShadowArchivePlan, ShadowArchiveFollower } from "../src/shadow-archive.ts";
import { RuntimeWorker } from "../src/worker.ts";
import { ProviderRegistry } from "../src/providers.ts";
import { shadowConversationContext } from "../src/shadow-context.ts";
import { testConfig, testHome } from "./helpers.ts";

const inbound = (id: string) => ({ transport: "linq", tenant_phone: "+15550001111", external_thread_id: "direct-chat",
  direction: "inbound", external_message_id: id, text: `Question ${id}`, sent_at: "2026-09-05T12:00:00Z", media_urls: [] });
const line = (value: unknown) => JSON.stringify(value) + "\n";

test("archive composition uses the incumbent past, not unsent drafts, other members or future answers", async () => {
  const f = fixture();
  try {
    await f.runtime.initialize(); f.follower.poll();
    appendFileSync(f.path, line(inbound("first"))
      + line({ ...inbound("reply"), direction: "outbound", text: "The common thread is coordination cost." })
      + line({ ...inbound("followup"), text: "Explain that connection?" })
      + line({ ...inbound("future"), direction: "outbound", text: "FUTURE_ANSWER_MUST_NOT_LEAK", sent_at: "2000-01-01T00:00:00Z" }));
    f.follower.poll();
    const observations = f.runtime.store.listEvents("test", { type: "shadow.inbound_observed" });
    const source = observations.find((event) => (event.payload as { externalId: string }).externalId === "followup")!;
    assert.ok(source);
    const context = shadowConversationContext(f.runtime.store, "test", "member", source.id);
    assert.match(context, /coordination cost/);
    assert.doesNotMatch(context, /FUTURE_ANSWER/);
    assert.throws(() => shadowConversationContext(f.runtime.store, "other", "member", source.id), /tenant-bound/);
    assert.throws(() => shadowConversationContext(f.runtime.store, "test", "other", source.id), /tenant-bound/);
    assert.throws(() => shadowConversationContext(f.runtime.store, "test", "member", "missing"), /tenant-bound/);
    let calls = 0;
    const providers = new ProviderRegistry([{ name: "mock", complete: async (request) => {
      calls++;
      if (calls === 2) {
        assert.match(request.system, /coordination cost/);
        assert.doesNotMatch(JSON.stringify(request), /UNSENT_DRAFT|FUTURE_ANSWER/);
        assert.equal(request.messages.filter((message) => message.role === "user").length, 1);
      }
      return { text: calls === 1 ? "UNSENT_DRAFT" : "The projects share a coordination problem.", toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 0 } };
    } }]);
    const runtime = new CoRuntime({ config: { ...testConfig(f.home.path), mode: "shadow" }, providers });
    try {
      await new RuntimeWorker(runtime, { videoAnalyzer: null }).drain();
      assert.equal(calls, 2);
      assert.equal(runtime.store.listRuns("test").filter((run) => run.status === "completed").length, 2);
      assert.equal(new Set(runtime.store.listRuns("test").map((run) => run.sessionId)).size, 2);
      assert.equal(runtime.store.searchEvidence("test", "UNSENT_DRAFT", { trustClasses: ["agent"] }).length, 0);
      assert.equal(runtime.store.listEvents("test", { type: "message.delivery_accepted" }).length, 0);
    } finally { runtime.close(); }
  } finally { f.close(); }
});

function fixture(initial = "") {
  const home = testHome();
  const path = join(realpathSync(home.path), "archive.jsonl");
  writeFileSync(path, initial, { mode: 0o600 });
  const runtime = new CoRuntime({ config: { ...testConfig(home.path), mode: "shadow" } });
  const plan = { format: "co.shadow-archive.v1", id: "test-feed", path, tenantId: "test",
    routes: [{ transport: "linq", tenantPhone: "+15550001111", threadId: "direct-chat", peerId: "member" }] };
  const follower = new ShadowArchiveFollower(runtime, plan);
  return { home, path, runtime, plan, follower, close: () => { runtime.close(); home.cleanup(); } };
}

test("archive shadow starts at EOF, pairs incumbent outputs, pins durable jobs, and never sends", async () => {
  const f = fixture(line(inbound("historical")));
  try {
    await f.runtime.initialize();
    assert.equal(f.follower.poll().admitted, 0);
    appendFileSync(f.path, line(inbound("new")) + line({ ...inbound("reply"), direction: "outbound", text: "Incumbent answer." }));
    assert.deepEqual(f.follower.poll(), { admitted: 1, baseline: 1, ignored: 0 });
    const jobs = f.runtime.store.listJobs("test");
    assert.equal(jobs.length, 1); assert.ok(jobs[0]?.releaseId);
    await new RuntimeWorker(f.runtime, { videoAnalyzer: null }).drain();
    assert.equal(f.runtime.store.getJob(jobs[0]!.id, "test")?.status, "completed");
    assert.equal(f.runtime.store.listEvents("test", { type: "message.delivery_accepted" }).length, 0);
    assert.equal(f.runtime.store.listEvents("test", { type: "shadow.baseline_observed" }).length, 1);
    assert.deepEqual(new ShadowArchiveFollower(f.runtime, f.plan).poll(), { admitted: 0, baseline: 0, ignored: 0 });
    appendFileSync(f.path, line(inbound("new")));
    assert.equal(f.follower.poll().admitted, 0);
    assert.equal(f.runtime.store.listJobs("test").length, 1);
  } finally { f.close(); }
});

test("cursor and admission roll back together if commit fails; restart admits once", async () => {
  const f = fixture();
  try {
    await f.runtime.initialize(); f.follower.poll();
    appendFileSync(f.path, line(inbound("atomic")));
    const append = f.runtime.store.appendEvent.bind(f.runtime.store);
    f.runtime.store.appendEvent = (event) => {
      if (event.type === "shadow.archive_cursor") throw new Error("simulated disk failure");
      return append(event);
    };
    assert.throws(() => f.follower.poll(), /simulated disk failure/);
    assert.equal(f.runtime.store.listJobs("test").length, 0);
    assert.equal(f.runtime.store.listEvents("test", { type: "shadow.inbound_observed" }).length, 0);
    f.runtime.store.appendEvent = append;
    assert.equal(new ShadowArchiveFollower(f.runtime, f.plan).poll().admitted, 1);
    assert.equal(f.runtime.store.listJobs("test").length, 1);
  } finally { f.close(); }
});

test("partial writes wait; malformed and other-tenant/group rows are recorded and skipped", async () => {
  const f = fixture();
  try {
    await f.runtime.initialize(); f.follower.poll();
    const valid = line(inbound("after-partial"));
    appendFileSync(f.path, valid.slice(0, 17));
    assert.equal(f.follower.poll().admitted, 0);
    appendFileSync(f.path, valid.slice(17) + "{broken-json}\n" + line({ ...inbound("other"), tenant_phone: "+15550002222" })
      + line({ ...inbound("group"), external_thread_id: "group-chat" }));
    assert.deepEqual(f.follower.poll(), { admitted: 1, baseline: 0, ignored: 3 });
    assert.equal(f.runtime.store.listEvents("test", { type: "shadow.archive_row_ignored" }).length, 3);
  } finally { f.close(); }
});

test("feed identity, inode, consumed prefix and duplicate content fail closed", async () => {
  for (const change of ["plan", "inode", "prefix", "duplicate"] as const) {
    const f = fixture(line(inbound("old")));
    try {
      await f.runtime.initialize(); f.follower.poll();
      if (change === "plan") assert.throws(() => new ShadowArchiveFollower(f.runtime, { ...f.plan,
        routes: [{ ...f.plan.routes[0], peerId: "different" }] }).poll(), /plan changed/);
      if (change === "inode") {
        renameSync(f.path, f.path + ".retained"); writeFileSync(f.path, line(inbound("new")));
        assert.throws(() => f.follower.poll(), /replaced/);
      }
      if (change === "prefix") {
        writeFileSync(f.path, readFileSync(f.path, "utf8").replace("Question", "Changed!"));
        assert.throws(() => f.follower.poll(), /rewritten/);
      }
      if (change === "duplicate") {
        appendFileSync(f.path, line(inbound("new"))); f.follower.poll();
        appendFileSync(f.path, line({ ...inbound("new"), text: "different content" }));
        assert.throws(() => f.follower.poll(), /different content/);
        assert.equal(f.runtime.store.listJobs("test").length, 1);
      }
    } finally { f.close(); }
  }
});

test("shadow plan cannot enable following in a live runtime, another tenant, or a symlinked/shared plan", () => {
  const f = fixture();
  const other = testHome();
  const live = new CoRuntime({ config: testConfig(other.path) });
  try {
    assert.throws(() => new ShadowArchiveFollower(live, f.plan), /isolated/);
    assert.throws(() => new ShadowArchiveFollower(f.runtime, { ...f.plan, tenantId: "another" }), /tenant-bound/);
    const path = join(realpathSync(f.home.path), "plan.json");
    writeFileSync(path, JSON.stringify(f.plan), { mode: 0o600 });
    assert.equal(loadShadowArchivePlan(path).id, "test-feed");
    symlinkSync(path, path + ".link"); assert.throws(() => loadShadowArchivePlan(path + ".link"), /canonical/);
    writeFileSync(path + ".shared", JSON.stringify(f.plan), { mode: 0o644 });
    assert.throws(() => loadShadowArchivePlan(path + ".shared"), /private/);
  } finally { live.close(); other.cleanup(); f.close(); }
});

test("real daemon follows new archive input and resumes its cursor after process restart", { timeout: 20_000 }, async () => {
  const f = fixture();
  const planPath = join(realpathSync(f.home.path), "plan.json");
  writeFileSync(planPath, JSON.stringify(f.plan), { mode: 0o600 });
  f.runtime.close();
  let child: ChildProcess | undefined;
  let errors = "";
  const dbPath = join(f.home.path, "runtime.sqlite");
  const start = () => {
    child = spawn(process.execPath, [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "daemon", "--port", "0", "--shadow-archive-plan", planPath], {
      env: { ...process.env, CO_HOME: f.home.path, CO_DB: dbPath, CO_ENV: "test", CO_TENANT: "test",
        CO_RUNTIME_MODE: "shadow", CO_PROVIDER: "mock", CO_FOREGROUND_PROVIDER: "mock", CO_BACKGROUND_PROVIDER: "mock",
        CO_DELIBERATION_PROVIDER: "mock", CO_CRITIC_PROVIDER: "mock", CO_MEDIA_ANALYZER: "none", CO_EXECUTION_BACKEND: "none",
        CO_WORKSPACE_ROOTS: f.home.path, CO_SERVER_TOKEN: "isolated-daemon-fixture-token" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-2000); });
  };
  const count = (sql: string): number => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try { return Number((db.prepare(sql).get() as { n: number }).n); } finally { db.close(); }
  };
  const until = async (predicate: () => boolean) => {
    const end = Date.now() + 5_000;
    while (!predicate()) {
      if (child?.exitCode !== null || Date.now() > end) throw new Error(`Daemon did not progress: ${errors}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 2000);
    try { await stopped; } finally { clearTimeout(timer); }
  };
  try {
    start();
    await until(() => count("SELECT COUNT(*) AS n FROM events WHERE type='shadow.archive_cursor'") === 1);
    appendFileSync(f.path, line(inbound("first-process")));
    await until(() => count("SELECT COUNT(*) AS n FROM jobs WHERE status='completed'") === 1);
    await stop();
    appendFileSync(f.path, line(inbound("while-stopped")));
    start();
    await until(() => count("SELECT COUNT(*) AS n FROM jobs WHERE status='completed'") === 2);
    assert.equal(count("SELECT COUNT(*) AS n FROM events WHERE type='message.delivery_accepted'"), 0);
    assert.equal(count("SELECT COUNT(*) AS n FROM jobs"), 2);
  } finally { await stop(); f.home.cleanup(); }
});
