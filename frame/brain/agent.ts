/**
 * Donna on Pi — the robust harness. Runtime = pi-agent-core; memory = ./memory.ts.
 *
 * What makes it robust (not the spike):
 *   • Memory split done right: coreSelf is CARRIED (resident every turn via transformContext, not
 *     retrieved); facts are RETRIEVED per message. Patterns are never top-k'd.
 *   • Accumulation: the transcript persists to disk and reseeds next run — Donna never resets (§7).
 *   • Write-back: she calls remember/update_belief to get sharper every conversation; frame-cap in code.
 *   • Graceful degradation everywhere — a dark pipe logs and continues; it never crashes the loop.
 *   • OAuth subscription token via pi-ai (ANTHROPIC_OAUTH_TOKEN). Terminal rail for dogfood (no Slack).
 *
 *   doppler run -- node donna/agent.ts            # interactive REPL
 *   doppler run -- node donna/agent.ts "message"  # one-shot
 */
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { defaultMemory } from "./memory.ts";
import { JOURNAL_SYSTEM, buildAgent as brainBuildAgent, donnaTools } from "./brain.ts";

const TRANSCRIPT = join(homedir(), ".co_pi_transcript.json");

// --- the journaling loop: the conversation IS the journal. At session end, the user's own turns are
// extracted into the belief graph so every conversation deepens the model (the flywheel). ---
const PY = "/Users/main/Projects/Secretary/Secretary-Production/projects/substrate/.venv/bin/python3";
const JOURNAL = "/Users/main/Projects/Secretary/Secretary-Production/projects/co/frame/claims/journal_ingest.py";
function ingestJournal(): void {
	try {
		process.stdout.write("\n[journaling this conversation into the model…]\n");
		const out = execFileSync(PY, [JOURNAL], { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
		process.stdout.write((out || "").trim() + "\n");
	} catch (e) {
		console.error(`[donna] journal ingest skipped (${(e as Error).message})`);
	}
}

// The brain (persona + tools + the memory move) is defined ONCE in brain.ts and shared with the server +
// first-contact. This file is now just the terminal I/O surface + the journaling loop around that brain.

// ---------------- persistence (accumulation — never reset) ----------------
function loadTranscript(): AgentMessage[] {
	try {
		if (existsSync(TRANSCRIPT)) return JSON.parse(readFileSync(TRANSCRIPT, "utf8")) as AgentMessage[];
	} catch (e) {
		console.error(`[donna] couldn't load transcript (${(e as Error).message}) — starting fresh`);
	}
	return [];
}
function saveTranscript(messages: AgentMessage[]) {
	try {
		writeFileSync(TRANSCRIPT, JSON.stringify(messages.slice(-60))); // bound it
	} catch (e) {
		console.error(`[donna] couldn't save transcript: ${(e as Error).message}`);
	}
}

function buildAgent(): Agent {
	const prior = loadTranscript();
	const mem = defaultMemory();
	// The persona, tools, and the carried-core + per-turn-recall memory move all live in brain.ts now — the
	// SAME brain the server and first-contact use. This surface only adds the terminal I/O + journaling loop.
	return brainBuildAgent({ memory: mem, persona: JOURNAL_SYSTEM, messages: prior, tools: donnaTools(mem) });
}

function streamToStdout(agent: Agent): void {
	agent.subscribe((event: { type: string; assistantMessageEvent?: { type: string; delta: string } }) => {
		if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta")
			process.stdout.write(event.assistantMessageEvent.delta);
	});
}

async function turn(agent: Agent, msg: string): Promise<void> {
	process.stdout.write("donna › ");
	try {
		await agent.prompt(msg);
		process.stdout.write("\n");
		saveTranscript((agent as unknown as { _state: { messages: AgentMessage[] } })._state?.messages ?? []);
	} catch (e) {
		process.stdout.write(`\n[donna error: ${(e as Error).message}]\n`);
	}
}

async function main() {
	// Doppler stores the subscription token as CLAUDE_CODE_OAUTH_TOKEN; pi-ai reads ANTHROPIC_OAUTH_TOKEN.
	if (!process.env.ANTHROPIC_OAUTH_TOKEN && process.env.CLAUDE_CODE_OAUTH_TOKEN) {
		process.env.ANTHROPIC_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
	}
	if (!process.env.ANTHROPIC_OAUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
		console.error("set CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY)"); process.exit(1);
	}
	const agent = buildAgent();
	streamToStdout(agent); // subscribe ONCE
	// INTERFACE BOUNDARY: this terminal REPL is the swappable I/O. v2 = LiveKit voice (the agent below is the
	// in-loop LLM; STT/TTS/telephony replace stdin/stdout). The agent, memory, and journaling loop don't change.
	const oneShot = process.argv[2];
	if (oneShot) { await turn(agent, oneShot); ingestJournal(); process.exit(0); }
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	console.log("🫧 Donna — your journal + thought partner. Think out loud; I'll keep you honest. (exit to end & journal)\n");
	while (true) {
		const msg = (await rl.question("you  › ")).trim();
		if (!msg) continue;
		if (msg === "exit" || msg === "quit") break;
		await turn(agent, msg);
	}
	rl.close();
	ingestJournal();   // the conversation becomes the journal → the model deepens
}

main().then(() => process.exit(0));
