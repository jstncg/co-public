/**
 * Donna's memory — the hard part, built as its own layer.
 *
 * THE ARCHITECTURE (the answer to "memory is the big problem"):
 *   patterns can't be retrieved — they live across the corpus, not in one document. So memory splits
 *   by TYPE, not by recency:
 *     • CARRIED  — the resident "who you are": stable identity + values + top patterns. In EVERY turn,
 *                  unconditionally, NOT retrieved. This is "Donna remembers you," not "Donna looks you up."
 *     • RETRIEVED — specific facts/events, semantically recalled per message (top-k can miss the tail;
 *                  fine for facts, fatal for patterns — which is why patterns are carried, not retrieved).
 *     • WRITE-BACK — conversation updates beliefs, with the integrity rules intact (frame-cap, retire).
 *
 * MULTI-TENANT: a `Memory` is bound to ONE belief graph (one person). `makeMemory(claimsDb)` gives the
 * shared server a per-tenant instance (fifty strangers = fifty graphs; user #2 never sees user #1). The
 * module-level `coreSelf`/`recall`/`remember`/`disconfirm` exports are a DEFAULT instance (env-bound) so the
 * single-process callers (agent.ts REPL, firstcontact.ts one-shot) keep working unchanged.
 *
 * Reads the belief graph (claims.db) the Python extractors build; integrity rules re-expressed here because
 * TS is the runtime home now (the Python claimstore remains the offline bulk-extraction path). Every external
 * dependency degrades gracefully — a half-blind witness still works; a crashed one doesn't.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MODEL } from "./brain.ts";

const DEFAULT_DB = "/Users/main/Projects/Secretary/Secretary-Production/projects/co/frame/claims/claims.db";
const DIM = 1024;
const FRAME_CAP = 0.5; // Level-3 (interpretive) beliefs can never read as asserted fact
const RETIRE_FLOOR = 0.15;

// ---------- RETRIEVED helper: voyage embedding (stateless; shared) ----------
async function voyageEmbed(text: string): Promise<Float32Array | null> {
	const key = process.env.VOYAGE_API_KEY;
	if (!key) return null;
	try {
		const res = await fetch("https://api.voyageai.com/v1/embeddings", {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ input: [text], model: "voyage-4-lite", input_type: "query" }),
		});
		const j = (await res.json()) as { data?: { embedding: number[] }[] };
		if (!j.data?.[0]) return null;
		const v = Float32Array.from(j.data[0].embedding);
		const n = Math.hypot(...v) || 1;
		for (let i = 0; i < v.length; i++) v[i] /= n;
		return v;
	} catch (e) {
		console.error(`[memory] voyage embed failed: ${(e as Error).message}`);
		return null;
	}
}

const TRIVIAL = /\b(name is|last name|first name|goes by|named|email address|has an? \w+ account|linkedin account)\b/i;
// HEDGED GUESSES ARE NOT IDENTITY (8/4). Passive-corpus extraction produces "may be seeking or in
// early-stage software engineering career (job alerts for...)" — a guess about a stranger, from a
// job-alert email. Carried as resident self-knowledge, guesses become the AVERAGE version of the
// person, which is the founder's own critique of AI: "it doesn't actually understand you." Hedged
// claims stay fully recallable; they just never answer WHO THIS PERSON IS.
const HEDGED = /\b(may be|might be|possibly|probably|likely (?:involved|seeking|interested|exploring)|appears to|seems to|could be)\b/i;
// Documentation is not autobiography. canon_ingest writes the product's own specs, ADRs and laws
// into the same graph (correctly — they must be RECALLABLE), but they score as high-salience
// frame-level declaratives and colonized the carried core: 17 of the top 20 resident lines were
// co's engineering decisions rather than anything about the person. Provenance-tagged at write
// time (evidence carries source:canon), excluded from CARRY only.
const DOC_DERIVED = /"source"\s*:\s*"canon"/i;

// State-change markers: "works as a paralegal" vs "LEFT the paralegal job" is 0.7+ lexical overlap but a
// polarity reversal — when the markers differ between old and new, the pair is a CHANGED FACT (supersede),
// never a paraphrase (merge). (Caught live in acceptance, 7/2.)
const CHANGE_RE = /\b(left|quit|quitting|no longer|not anymore|stopped|former|used to|started|starting|ended|done with|switched|moved (to|out|away)|retired from|dropped)\b/i;

// Superseded rows are HISTORY ("used to X"), never the present — every read path excludes them; the chain
// stays queryable through the `supersedes` pointer (7/2).
const NOT_SUPERSEDED =
	" AND id NOT IN (SELECT supersedes FROM claims WHERE supersedes IS NOT NULL AND COALESCE(status,'active')!='retired')";
// The product's own specs are not the person — rawCore has excluded canon since 8/4, but recall()
// kept serving it, so "what do you know about X" answered from the engineering ADRs (epistemic
// governance ws4, built 8/23). Same clause, every read path.
const NOT_CANON = " AND COALESCE(evidence,'') NOT LIKE '%\"source\": \"canon\"%'";
// Below this cosine the match is topical noise — recall computed the dot for weeks and never
// filtered on it, so the top-8 always arrived looking equally relevant (ws4).
const RELEVANCE_FLOOR = 0.35;
const STALE_DAYS = 180;

/** Tiered rendering (epistemic governance ws2): the flat `[87%] statement` line taught the model
 *  to treat every belief as equally assertable. The tier IS the speech-authority instruction. */
function tierLine(r: { statement: string; level: string; confidence: number; evidence?: string; last_verified?: string | null }): string {
	const ev = r.evidence ?? "";
	let n = 0;
	try { n = (JSON.parse(ev) as unknown[]).length; } catch { /* unparseable evidence = zero signals */ }
	const direct = /"source"\s*:\s*"(conversation|user_correction)"/.test(ev);
	let tier: string;
	if (r.level === "frame" || HEDGED.test(r.statement) || r.confidence < 0.5)
		tier = "WONDER (a weak inference — never state as fact; ask if it matters)";
	else if (direct && r.confidence >= 0.75) tier = "KNOWN (they told you directly)";
	else tier = n > 1 ? `OBSERVED (${n} independent signals)` : "OBSERVED (one signal — probable, not settled)";
	let stale = "";
	const lv = r.last_verified ?? "";
	if (lv && Date.now() - Date.parse(lv) > STALE_DAYS * 86400000)
		stale = ` [last supported ${lv.slice(0, 10)} — may be stale, verify before leaning on it]`;
	return `- ${tier}: ${r.statement}${stale}`;
}

/** A belief graph bound to ONE person. All reads/writes are scoped to its claims db + core cache. */
export class Memory {
	readonly claimsDb: string;
	readonly coreCachePath: string;
	private _db: DatabaseSync | null = null;
	private _coreCache: string | null = null;
	// Plain assignment, not TS parameter-properties — Node's native type-stripping erases types only, it can't
	// generate the implicit field assignments that `constructor(public x)` would need.
	constructor(claimsDb: string, coreCachePath: string) {
		this.claimsDb = claimsDb;
		this.coreCachePath = coreCachePath;
	}

	private _ino: number | null = null;

	private db(): DatabaseSync | null {
		// A long-lived engine must notice when a tenant's db FILE is deleted OR deleted+recreated underneath
		// it (evals and tenant resets do this) — a cached handle on the old unlinked inode silently serves the
		// stale interior. Missing file OR a changed inode → close and reopen.
		if (this._db) {
			try {
				const st = existsSync(this.claimsDb) ? statSync(this.claimsDb) : null;
				if (!st || (this._ino !== null && st.ino !== this._ino)) {
					try { (this._db as unknown as { close?: () => void }).close?.(); } catch { /* already gone */ }
					this._db = null;
					this._coreCache = null;
					this._ino = null;
				}
			} catch { /* stat raced — keep the handle */ }
		}
		if (this._db) return this._db;
		try {
			this._db = new DatabaseSync(this.claimsDb); // read+write; runtime owns conversation-writes
			try { this._ino = statSync(this.claimsDb).ino; } catch { this._ino = null; }
			// Full schema (matches Python claimstore) so a FRESH per-tenant db is valid for both TS writes and
			// Python reads — a new stranger's graph must be real, not a stub. IF NOT EXISTS = no-op on populated.
			this._db.exec(
				"CREATE TABLE IF NOT EXISTS claims (" +
					"id INTEGER PRIMARY KEY, type TEXT NOT NULL DEFAULT 'other', level TEXT NOT NULL DEFAULT 'fact', " +
					"statement TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, evidence TEXT NOT NULL DEFAULT '[]', " +
					"decay TEXT DEFAULT 'slow', first_seen TEXT, last_verified TEXT, status TEXT DEFAULT 'active', " +
					"embedding BLOB, salience REAL, graded TEXT, supersedes INTEGER, UNIQUE(type, statement))",
			);
			// Additive migrations (7/2): supersede chains + the viewer's user-corrections contract table.
			try { this._db.exec("ALTER TABLE claims ADD COLUMN supersedes INTEGER"); } catch { /* migrated */ }
			this._db.exec(
				"CREATE TABLE IF NOT EXISTS user_corrections (id INTEGER PRIMARY KEY, claim_id INTEGER NOT NULL, " +
					"action TEXT NOT NULL, text TEXT, created_at TEXT, processed INTEGER DEFAULT 0)",
			);
			return this._db;
		} catch (e) {
			console.error(`[memory] belief graph unavailable (${(e as Error).message}) — running blind`);
			return null;
		}
	}

	/** How many active claims this graph holds — the onboarding gate (server.ts: a tenant with a few real
	 *  claims has been through the guessing game; serve the Co disposition, not first-contact). */
	claimCount(): number {
		const d = this.db();
		if (!d) return 0;
		try {
			const row = d.prepare(`SELECT COUNT(*) AS n FROM claims WHERE COALESCE(status,'active')!='retired'${NOT_SUPERSEDED}`).get() as { n: number };
			return row?.n ?? 0;
		} catch {
			return 0;
		}
	}

	// ---------- CARRIED: the resident "who you are" (every turn, not retrieved) ----------
	coreSelf(refresh = false): string {
		if (!refresh && existsSync(this.coreCachePath)) {
			try { return readFileSync(this.coreCachePath, "utf8"); } catch { /* fall through to raw */ }
		}
		return this.rawCore(refresh);
	}

	private rawCore(refresh = false): string {
		if (this._coreCache && !refresh) return this._coreCache;
		const d = this.db();
		if (!d) return "";
		try {
			// CARRY who-you-are-and-how-you-behave (values + behavioral patterns), NOT facts. Rank by SALIENCE,
			// not confidence; honor the subject's grade (boosted float up, demoted excluded).
			const rows = d
				.prepare(
					"SELECT statement, type, level, confidence, embedding, evidence FROM claims " +
						"WHERE COALESCE(status,'active')!='retired' AND COALESCE(graded,'')!='demote'" +
						NOT_SUPERSEDED +
						// Doc-derived claims are excluded IN THE RANKING, not filtered after: canon ingest
						// writes at a flat high salience, so 199 of the top 200 were the product's own
						// specs and every real claim about the person sat below the window entirely.
						" AND COALESCE(evidence,'') NOT LIKE '%\"source\": \"canon\"%'" +
						// NEVER hard-require a salience score (8/4): the scorer runs on a separate tick,
						// and when it lagged, 16,794 real claims were invisible while the only scored
						// survivors were docs — the agent carried the product's spec as its model of the
						// person for weeks, silently. An unscored claim now falls back to confidence, so
						// a scoring outage degrades the RANKING instead of blinding the agent.
						" ORDER BY (graded='boost') DESC, COALESCE(salience, confidence * 0.6) DESC, confidence DESC LIMIT 200",
				)
				.all() as Array<{ statement: string; type: string; level: string; confidence: number; embedding?: Uint8Array; evidence?: string }>;
			const decode = (u?: Uint8Array): Float32Array | null => {
				if (!u) return null;
				const buf = Buffer.from(u);
				const v = new Float32Array(buf.buffer, buf.byteOffset, DIM);
				const n = Math.hypot(...v) || 1;
				const out = new Float32Array(DIM);
				for (let k = 0; k < DIM; k++) out[k] = v[k] / n;
				return out;
			};
			const kept: Array<{ vec: Float32Array | null; key: string }> = [];
			const lines: string[] = [];
			for (const r of rows) {
				if (TRIVIAL.test(r.statement)) continue; // skip fact-trivia that slipped past salience
				if (DOC_DERIVED.test(r.evidence ?? "")) continue; // the product's specs are not the person
				if (HEDGED.test(r.statement)) continue; // a guess about them is not who they are
				const key = r.statement.toLowerCase().split(/\s+/).slice(0, 5).join(" ");
				const vec = decode(r.embedding);
				let dup = kept.some((k) => k.key === key);
				if (!dup && vec)
					dup = kept.some((k) => {
						if (!k.vec) return false;
						let dot = 0;
						for (let i = 0; i < DIM; i++) dot += vec[i] * k.vec[i];
						return dot >= 0.82; // cluster-dedup paraphrases via embeddings
					});
				if (dup) continue;
				kept.push({ vec, key });
				lines.push(`- ${r.statement}${r.level === "frame" ? " (tentative)" : ""}`);
				if (lines.length >= 20) break;
			}
			this._coreCache = lines.join("\n");
			return this._coreCache;
		} catch (e) {
			console.error(`[memory] coreSelf failed: ${(e as Error).message}`);
			return "";
		}
	}

	// Synthesize raw salient claims into a clean deduped portrait (offline; cached). Not per-turn.
	async refreshCore(): Promise<string> {
		const raw = this.rawCore(true);
		if (!raw) return "";
		const token = process.env.ANTHROPIC_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN;
		if (!token) {
			console.error("[memory] no OAuth token — keeping raw core (no synthesis)");
			return raw;
		}
		const sys =
			"You are given raw belief-claims about a person (values + behavioral patterns), many of them near-" +
			"duplicates. Distill them into a CLEAN core portrait: who they are, what they want, how they behave, " +
			"their central tensions. MERGE duplicates. Rank by SALIENCE — what most defines them first. Plain prose " +
			"or tight bullets, ~150 words, no preamble. This is the resident model carried into every conversation.";
		for (let attempt = 0; attempt < 4; attempt++) {
			try {
				const res = await fetch("https://api.anthropic.com/v1/messages", {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"anthropic-beta": "oauth-2025-04-20",
						"anthropic-version": "2023-06-01",
						"content-type": "application/json",
					},
					// The portrait compressor is a REAL call on a hardcoded id, not a dormant fallback, so this
					// one was actually running a generation behind (8/30). Env-overridable like everything else.
					body: JSON.stringify({ model: process.env.CO_MEMORY_MODEL || DEFAULT_MODEL, max_tokens: 600, system: sys, messages: [{ role: "user", content: raw }] }),
				});
				const j = (await res.json()) as { content?: { type: string; text: string }[]; error?: { type: string } };
				if (j.error?.type === "rate_limit_error") { await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt)); continue; }
				const portrait = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
				if (portrait) { writeFileSync(this.coreCachePath, portrait); return portrait; }
				return raw;
			} catch (e) {
				console.error(`[memory] core synthesis attempt ${attempt + 1} failed: ${(e as Error).message}`);
				await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
			}
		}
		console.error("[memory] core synthesis exhausted retries — keeping raw core");
		return raw;
	}

	// ---------- RETRIEVED: semantic recall for specific facts (keyword fallback) ----------
	async recall(query: string, limit = 8): Promise<string> {
		const d = this.db();
		if (!d) return "(belief graph unavailable)";
		const q = await voyageEmbed(query);
		if (!q) return this.keywordRecall(d, query, limit); // graceful: no embeddings → keyword
		try {
			const rows = d
				.prepare(
					"SELECT statement, level, confidence, evidence, last_verified, embedding FROM claims " +
						"WHERE embedding IS NOT NULL AND COALESCE(status,'active')!='retired'" + NOT_SUPERSEDED + NOT_CANON,
				)
				.all() as Array<{ statement: string; level: string; confidence: number; evidence?: string; last_verified?: string | null; embedding: Uint8Array }>;
			if (rows.length === 0) return this.keywordRecall(d, query, limit);
			const scored = rows.map((r) => {
				const buf = Buffer.from(r.embedding);
				const v = new Float32Array(buf.buffer, buf.byteOffset, DIM);
				let dot = 0;
				const nn = Math.hypot(...v) || 1;
				for (let k = 0; k < DIM; k++) dot += (v[k] / nn) * q[k];
				return { r, dot };
			});
			scored.sort((a, b) => b.dot - a.dot);
			const kept = scored.slice(0, limit).filter(({ dot }) => dot >= RELEVANCE_FLOOR);
			if (!kept.length)
				return `(nothing genuinely relevant in the record about '${query.slice(0, 60)}' — say you don't hold anything on this rather than reaching)`;
			return kept.map(({ r }) => tierLine(r)).join("\n");
		} catch {
			return this.keywordRecall(d, query, limit);
		}
	}

	private keywordRecall(d: DatabaseSync, term: string, limit: number): string {
		try {
			const like = `%${term.split(/\s+/).slice(0, 3).join("%")}%`;
			const rows = d
				.prepare(
					"SELECT statement, level, confidence, evidence, last_verified FROM claims WHERE statement LIKE ? " +
						"AND COALESCE(status,'active')!='retired'" + NOT_SUPERSEDED + NOT_CANON + " ORDER BY confidence DESC LIMIT ?",
				)
				.all(like, limit) as Array<{ statement: string; level: string; confidence: number; evidence?: string; last_verified?: string | null }>;
			if (rows.length === 0) return `(nothing in the belief graph about '${term}')`;
			return rows.map((r) => tierLine(r)).join("\n");
		} catch {
			return "(recall failed)";
		}
	}

	/** Near-duplicate check (token overlap) — one send must never mint two rows for the same fact. Twin
	 *  paraphrases fake corroboration past downstream anti-overfit gates, so dedupe at WRITE time (7/2).
	 *  Searches ACROSS types: the model mints freeform type labels ("pattern" vs "behavior"), so a
	 *  near-identical statement is the same belief no matter what it was filed under. */
	private findSimilar(d: DatabaseSync, type: string, statement: string): { id: number; confidence: number; ratio: number; statement: string } | null {
		const tok = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2));
		const target = tok(statement);
		if (!target.size) return null;
		try {
			const rows = d
				.prepare("SELECT id, statement, confidence FROM claims WHERE COALESCE(status,'active')!='retired' ORDER BY id DESC LIMIT 60")
				.all() as Array<{ id: number; statement: string; confidence: number }>;
			for (const r of rows) {
				const other = tok(r.statement);
				if (!other.size) continue;
				let inter = 0;
				for (const w of target) if (other.has(w)) inter++;
				const ratio = inter / Math.min(target.size, other.size);
				// Long statements can share an identical CORE but differ in the tail ("…watching passion
				// content" vs "…watching bakery videos"), diluting the ratio — 8+ shared distinctive tokens
				// is the same fact cluster even at a lower ratio (real twins measured 0.53 on 7/2).
				if (ratio >= 0.7 || (inter >= 8 && ratio >= 0.45)) return { id: r.id, confidence: r.confidence, ratio, statement: r.statement };
			}
		} catch { /* fall through to insert */ }
		return null;
	}

	// ---------- WRITE-BACK: conversation updates beliefs (integrity rules intact) ----------
	remember(type: string, level: string, statement: string, confidence: number, today: string): string {
		const d = this.db();
		if (!d) return "(can't persist — belief graph unavailable)";
		try {
			const conf = level === "frame" ? Math.min(confidence, FRAME_CAP) : confidence; // frame-cap in CODE
			const ev = JSON.stringify([{ source: "conversation", date: today }]);
			const row = d.prepare("SELECT id, confidence, evidence FROM claims WHERE type=? AND statement=?").get(type, statement) as
				| { id: number; confidence: number; evidence: string }
				| undefined;
			if (row) {
				const merged = Math.max(row.confidence, conf, Math.min(1, row.confidence + 0.1));
				d.prepare("UPDATE claims SET confidence=?, last_verified=? WHERE id=?").run(Math.round(merged * 1000) / 1000, today, row.id);
			} else {
				const twin = this.findSimilar(d, type, statement);
				const changed = twin ? CHANGE_RE.test(statement) !== CHANGE_RE.test(twin.statement) : false;
				if (twin && twin.ratio >= 0.7 && !changed) {
					// pure paraphrase → merge (no duplicate row)
					d.prepare("UPDATE claims SET confidence=?, last_verified=? WHERE id=?")
						.run(Math.round(Math.max(twin.confidence, conf) * 1000) / 1000, today, twin.id);
					this._coreCache = null;
					return `merged into an existing near-identical claim (no duplicate row): ${statement}`;
				}
				if (twin) {
					// same fact-cluster, CHANGED content ("was a paralegal" → "started law school") →
					// SUPERSEDE: new row wins every read; the chain keeps "used to X, now Y" queryable.
					d.prepare(
						"INSERT INTO claims(type,level,statement,confidence,evidence,decay,first_seen,last_verified,status,supersedes) VALUES(?,?,?,?,?,?,?,?,'active',?)",
					).run(type, level, statement, Math.round(conf * 1000) / 1000, ev, "slow", today, today, twin.id);
					this._coreCache = null;
					return `remembered (supersedes an earlier version of this fact): ${statement}`;
				}
				d.prepare(
					"INSERT INTO claims(type,level,statement,confidence,evidence,decay,first_seen,last_verified,status) VALUES(?,?,?,?,?,?,?,?,'active')",
				).run(type, level, statement, Math.round(conf * 1000) / 1000, ev, "slow", today, today);
			}
			this._coreCache = null; // invalidate so the resident core picks up new identity/patterns
			return `remembered: ${statement}`;
		} catch (e) {
			return `(persist failed: ${(e as Error).message})`;
		}
	}

	/** Honor pending viewer corrections (user_corrections contract, 7/2) — the engine-side twin of
	 *  claims/correction_ingest.py, run on recall so a mid-conversation flag lands before the next reply.
	 *  'wrong' → retire + tombstone (never re-asserted); 'edit' → user text becomes a 0.95 claim
	 *  superseding the old. Cheap when idle (one COUNT). */
	processCorrections(today: string): number {
		const d = this.db();
		if (!d) return 0;
		try {
			const n = (d.prepare("SELECT COUNT(*) AS n FROM user_corrections WHERE processed=0").get() as { n: number })?.n ?? 0;
			if (!n) return 0;
			const rows = d.prepare("SELECT id, claim_id, action, text FROM user_corrections WHERE processed=0 ORDER BY id").all() as
				Array<{ id: number; claim_id: number; action: string; text?: string }>;
			const ev = JSON.stringify([{ source: "user_correction", date: today }]);
			let did = 0;
			for (const c of rows) {
				const old = d.prepare("SELECT type, level, statement FROM claims WHERE id=?").get(c.claim_id) as
					| { type: string; level: string; statement: string }
					| undefined;
				if (old && c.action === "wrong") {
					d.prepare("UPDATE claims SET confidence=0, status='retired', last_verified=? WHERE id=?").run(today, c.claim_id);
					d.prepare(
						"INSERT OR IGNORE INTO claims(type,level,statement,confidence,evidence,decay,first_seen,last_verified,status,supersedes) VALUES('correction','fact',?,0.9,?,'slow',?,?,'active',?)",
					).run(`User explicitly corrected this — it is NOT true that: ${old.statement}`, ev, today, today, c.claim_id);
					did++;
				} else if (old && c.action === "edit" && (c.text ?? "").trim()) {
					d.prepare(
						"INSERT OR IGNORE INTO claims(type,level,statement,confidence,evidence,decay,first_seen,last_verified,status,supersedes) VALUES(?,?,?,0.95,?,'slow',?,?,'active',?)",
					).run(old.type, old.level === "pattern" ? "pattern" : "fact", (c.text ?? "").trim(), ev, today, today, c.claim_id);
					did++;
				}
				d.prepare("UPDATE user_corrections SET processed=1 WHERE id=?").run(c.id);
			}
			if (did) {
				this._coreCache = null;
				try { if (existsSync(this.coreCachePath)) writeFileSync(this.coreCachePath, this.rawCore(true)); } catch { /* regenerate lazily */ }
			}
			return did;
		} catch (e) {
			console.error(`[memory] corrections failed: ${(e as Error).message}`);
			return 0;
		}
	}

	disconfirm(statement: string, today: string, drop = 0.35): string {
		const d = this.db();
		if (!d) return "(belief graph unavailable)";
		try {
			let row = d.prepare("SELECT id, confidence FROM claims WHERE statement=?").get(statement) as { id: number; confidence: number } | undefined;
			if (!row) {
				const key = `%${statement.split(/\s+/).slice(0, 4).join("%")}%`;
				row = d.prepare("SELECT id, confidence FROM claims WHERE statement LIKE ? ORDER BY confidence DESC LIMIT 1").get(key) as
					| { id: number; confidence: number }
					| undefined;
			}
			if (!row) return "(no matching prior belief)";
			const nc = Math.max(0, row.confidence - drop);
			const status = nc < RETIRE_FLOOR ? "retired" : "active";
			d.prepare("UPDATE claims SET confidence=?, status=?, last_verified=? WHERE id=?").run(Math.round(nc * 1000) / 1000, status, today, row.id);
			this._coreCache = null;
			return `updated → ${Math.round(nc * 100)}%${status === "retired" ? " (retired)" : ""}`;
		} catch (e) {
			return `(update failed: ${(e as Error).message})`;
		}
	}
}

// ---------- the tenant pool (the shared server reuses one Memory per person) ----------
const POOL = new Map<string, Memory>();
export function makeMemory(claimsDb: string, coreCache?: string): Memory {
	let m = POOL.get(claimsDb);
	if (!m) {
		m = new Memory(claimsDb, coreCache ?? `${claimsDb}.core.md`);
		POOL.set(claimsDb, m);
	}
	return m;
}

// ---------- the DEFAULT instance + backward-compatible function exports ----------
// One handle (CO_CLAIMS_DB) keys a user's db + core; unset = the founder's legacy paths. The single-process
// callers (agent.ts, firstcontact.ts) import these functions unchanged.
const _defaultDb = process.env.CO_CLAIMS_DB || DEFAULT_DB;
const _defaultCore =
	process.env.CO_CORE_CACHE || (process.env.CO_CLAIMS_DB ? `${process.env.CO_CLAIMS_DB}.core.md` : join(homedir(), ".co_core_self.md"));
const _default = new Memory(_defaultDb, _defaultCore);

export function defaultMemory(): Memory { return _default; }
export function coreSelf(refresh = false): string { return _default.coreSelf(refresh); }
export function refreshCore(): Promise<string> { return _default.refreshCore(); }
export function recall(query: string, limit = 8): Promise<string> { return _default.recall(query, limit); }
export function remember(type: string, level: string, statement: string, confidence: number, today: string): string {
	return _default.remember(type, level, statement, confidence, today);
}
export function disconfirm(statement: string, today: string, drop = 0.35): string { return _default.disconfirm(statement, today, drop); }
