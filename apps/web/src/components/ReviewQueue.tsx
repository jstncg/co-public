"use client";

// review queue (goal.md §31 card mockup): candidate statement, evidence,
// alternatives, confidence, proposed move, approve/edit/reject/unsafe.
// wired to a local in-memory store — decisions persist for the session only.
// BLOCKED: supabase project — real decisions go through authenticated server
// routes with an immutable audit record (§25.3).
//
// consent rule (§31): "the console must never allow review of users without
// valid consent." expired-consent cards render blocked with content withheld.

import { useState } from "react";
import type { Decision, DecidedCandidate, ReviewCandidate } from "@/lib/types";

function consentValid(candidate: ReviewCandidate, today: string): boolean {
  return candidate.consentActiveUntil >= today;
}

export default function ReviewQueue({ initial }: { initial: ReviewCandidate[] }) {
  // in-memory store stub
  const [pending, setPending] = useState<ReviewCandidate[]>(initial);
  const [decided, setDecided] = useState<DecidedCandidate[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const today = new Date().toISOString().slice(0, 10);

  function decide(candidate: ReviewCandidate, decision: Decision, editedStatement?: string) {
    setPending((rest) => rest.filter((c) => c.id !== candidate.id));
    setDecided((done) => [{ ...candidate, decision, editedStatement }, ...done]);
    setEditingId(null);
  }

  return (
    <>
      {pending.length === 0 && <div className="card empty">queue is empty.</div>}

      {pending.map((candidate) => {
        const valid = consentValid(candidate, today);

        if (!valid) {
          return (
            <div className="card blocked" key={candidate.id}>
              <div className="consent-line expired">
                user consent: expired {candidate.consentActiveUntil} — review blocked
              </div>
              <div>{candidate.userLabel} · content withheld by consent check</div>
            </div>
          );
        }

        const editing = editingId === candidate.id;

        return (
          <div className="card" key={candidate.id}>
            <div className="consent-line">
              user consent: active until {candidate.consentActiveUntil} · {candidate.userLabel}
            </div>

            {editing ? (
              <textarea
                rows={2}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                aria-label="edit candidate statement"
              />
            ) : (
              <div className="statement">“{candidate.statement}”</div>
            )}

            <div className="kv">evidence [{candidate.evidence.length}]</div>
            <ul className="evidence">
              {candidate.evidence.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>

            <div className="kv">alternatives [{candidate.alternatives.length}]</div>
            <ul className="evidence">
              {candidate.alternatives.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>

            <div className="kv">confidence</div>
            <div>{candidate.confidence.toFixed(2)}</div>

            <div className="kv">proposed move</div>
            <div>{candidate.proposedMove ?? "none — hold as observation"}</div>

            <div className="actions">
              {editing ? (
                <>
                  <button className="primary" onClick={() => decide(candidate, "edited", draft)}>
                    save edit + approve
                  </button>
                  <button onClick={() => setEditingId(null)}>cancel</button>
                </>
              ) : (
                <>
                  <button className="primary" onClick={() => decide(candidate, "approved")}>
                    approve
                  </button>
                  <button
                    onClick={() => {
                      setEditingId(candidate.id);
                      setDraft(candidate.statement);
                    }}
                  >
                    edit
                  </button>
                  <button onClick={() => decide(candidate, "rejected")}>reject</button>
                  <button className="danger" onClick={() => decide(candidate, "unsafe")}>
                    unsafe
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}

      {decided.length > 0 && (
        <>
          <h2>decided this session (in-memory only)</h2>
          {decided.map((candidate) => (
            <div className="card" key={candidate.id}>
              <span>“{candidate.editedStatement ?? candidate.statement}”</span>
              <span className={`badge ${candidate.decision}`}>{candidate.decision}</span>
            </div>
          ))}
        </>
      )}
    </>
  );
}
