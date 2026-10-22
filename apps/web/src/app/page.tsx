"use client";

import { useState } from "react";
import type { FounderReviewCard } from "../lib/founder-review";

const rubricOptions = [
  "evidence fidelity",
  "novel",
  "useful",
  "calibrated",
  "non-creepy",
  "actionable",
  "character holds",
];

type FounderMetrics = {
  rates: Record<string, number | null>;
  counts: Record<string, number>;
  killLine: { eligible: boolean; triggered: boolean };
};

const metricLabels: Record<string, string> = {
  activationRate: "activation",
  threeDaySaveHabitRate: "three-day habit",
  patternToMoveRate: "pattern → move",
  weekFourRetentionRate: "week-four retention",
  radarUsefulActionRate: "radar useful/action",
  notificationMuteRate: "notification mute",
  founderEditRejectRate: "founder edit/reject",
};

export default function FounderHome() {
  const [token, setToken] = useState("");
  const [reviews, setReviews] = useState<FounderReviewCard[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<Record<string, string[]>>({});
  const [metrics, setMetrics] = useState<FounderMetrics>();

  async function loadReviews() {
    setLoading(true);
    setError(undefined);
    try {
      const headers = { authorization: `Bearer ${token}` };
      const [response, metricsResponse] = await Promise.all([
        fetch("/api/founder/reviews", { headers, cache: "no-store" }),
        fetch("/api/founder/metrics", { headers, cache: "no-store" }),
      ]);
      const body = await response.json() as { reviews?: FounderReviewCard[]; error?: string };
      const metricsBody = await metricsResponse.json() as { metrics?: FounderMetrics; error?: string };
      if (!response.ok) throw new Error(body.error ?? "access denied");
      if (!metricsResponse.ok) throw new Error(metricsBody.error ?? "metrics unavailable");
      setReviews(body.reviews ?? []);
      setMetrics(metricsBody.metrics);
      setAuthenticated(true);
    } catch (caught) {
      setAuthenticated(false);
      setReviews([]);
      setMetrics(undefined);
      setError(caught instanceof Error ? caught.message : "access denied");
    } finally {
      setLoading(false);
    }
  }

  async function decide(card: FounderReviewCard, decision: "approve" | "edit" | "reject" | "unsafe") {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch("/api/founder/reviews", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          hypothesisId: card.id,
          decision,
          editedStatement: decision === "edit" ? edits[card.id] : undefined,
          rubricLabels: labels[card.id] ?? [],
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "decision failed");
      setReviews((current) => current.filter((review) => review.id !== card.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "decision failed");
    } finally {
      setLoading(false);
    }
  }

  function toggleLabel(cardId: string, label: string) {
    setLabels((current) => {
      const selected = current[cardId] ?? [];
      return { ...current, [cardId]: selected.includes(label) ? selected.filter((item) => item !== label) : [...selected, label] };
    });
  }

  return <main>
    <header>
      <span className="wordmark">co</span>
      <span className="environment">consent-gated founder console</span>
    </header>

    {!authenticated ? <section className="access-panel">
      <p className="eyebrow">separate admin access</p>
      <h1>review without<br />looking past consent.</h1>
      <p>The access token stays in this tab. Every candidate view and decision is written to the audit log.</p>
      <div className="access-form">
        <label htmlFor="founder-token">founder access token</label>
        <input id="founder-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="current-password" />
        <button className="primary" type="button" onClick={loadReviews} disabled={loading || token.length < 32}>
          {loading ? "checking…" : "open review queue"}
        </button>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </section> : <>
      <section className="console-heading">
        <div>
          <p className="eyebrow">pattern candidates</p>
          <h1>{reviews.length} awaiting judgment</h1>
        </div>
        <button type="button" onClick={loadReviews} disabled={loading}>refresh</button>
      </section>
      {metrics ? <section className="metrics" aria-label="weekly aggregate metrics">
        {Object.entries(metricLabels).map(([key, label]) => <div key={key}>
          <span>{label}</span>
          <strong>{metrics.rates[key] == null ? "—" : `${Math.round((metrics.rates[key] ?? 0) * 100)}%`}</strong>
        </div>)}
        <div><span>model cost / active</span><strong>{metrics.rates.averageModelCostPerActiveUser == null ? "—" : `$${metrics.rates.averageModelCostPerActiveUser.toFixed(2)}`}</strong></div>
        <div className={metrics.killLine.triggered ? "kill-triggered" : ""}><span>kill line</span><strong>{metrics.killLine.eligible ? metrics.killLine.triggered ? "triggered" : "clear" : "not eligible"}</strong></div>
      </section> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {reviews.length === 0 ? <section className="empty-state">
        <h2>the queue is quiet.</h2>
        <p>No review-status hypothesis currently has active, unrevoked, expiring founder consent.</p>
      </section> : <section className="review-queue" aria-label="consented pattern review queue">
        {reviews.map((card) => <article className="review-card" key={card.id}>
          <div className="review-meta">
            <span>user {card.userReference}</span>
            <span className="consent">consent until {new Date(card.consentExpiresAt).toLocaleDateString()}</span>
            <span>{Math.round(card.confidence * 100)}% confidence · {card.sensitivity}</span>
          </div>

          <div className="candidate">
            <p className="eyebrow">candidate</p>
            <h2>{card.statement}</h2>
            {card.proposedCopy ? <><p className="eyebrow spaced">proposed copy</p><p>{card.proposedCopy}</p></> : null}
            {card.reasonToSend ? <><p className="eyebrow spaced">reason to send</p><p>{card.reasonToSend}</p></> : null}
          </div>

          <div className="review-columns">
            <section>
              <p className="eyebrow">evidence receipts</p>
              {card.evidence.length === 0 ? <p className="quiet">No valid evidence receipts. Reject rather than infer.</p> : <ol className="evidence-list">
                {card.evidence.map((item) => <li key={`${item.artifactId}-${item.direction}`}>
                  <strong>{item.title ?? item.sourceType}</strong>
                  <span>{item.direction} · {item.coverage} · {new Date(item.capturedAt).toLocaleDateString()}</span>
                  {item.observation ? <p>{item.observation}</p> : null}
                </li>)}
              </ol>}
            </section>
            <section>
              <p className="eyebrow">alternatives</p>
              <pre>{JSON.stringify(card.alternatives, null, 2)}</pre>
              <p className="raw-note">Raw text, transcripts, and media remain hidden.</p>
            </section>
          </div>

          <fieldset className="rubric">
            <legend>rubric labels</legend>
            {rubricOptions.map((label) => <label key={label}>
              <input type="checkbox" checked={(labels[card.id] ?? []).includes(label)} onChange={() => toggleLabel(card.id, label)} />
              {label}
            </label>)}
          </fieldset>

          <label className="edit-field">
            edited statement
            <textarea value={edits[card.id] ?? card.statement} onChange={(event) => setEdits((current) => ({ ...current, [card.id]: event.target.value }))} />
          </label>

          <div className="actions">
            <button className="primary" type="button" onClick={() => decide(card, "approve")} disabled={loading || card.evidence.length < 3}>approve</button>
            <button type="button" onClick={() => decide(card, "edit")} disabled={loading}>edit + approve</button>
            <button type="button" onClick={() => decide(card, "reject")} disabled={loading}>reject</button>
            <button className="unsafe" type="button" onClick={() => decide(card, "unsafe")} disabled={loading}>unsafe</button>
          </div>
        </article>)}
      </section>}
    </>}
    <footer>Consent is checked again inside the database transaction before every decision.</footer>
  </main>;
}
