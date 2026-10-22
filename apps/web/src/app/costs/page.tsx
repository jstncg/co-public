// model cost dashboard (goal.md §25.6) — records by task once model_runs exist.
// no hard-coded cost estimates: the table is empty until live pricing + runs land.

import { modelCosts } from "@/lib/stubs";

export default function CostsPage() {
  return (
    <>
      <h1>model costs</h1>
      <p className="subtitle">by task: provider · model · tokens · search calls · transcription · latency · estimated cost</p>

      <table>
        <thead>
          <tr>
            <th>provider</th>
            <th>model</th>
            <th>feature</th>
            <th>tokens</th>
            <th>search</th>
            <th>transcribe (min)</th>
            <th>p50 latency</th>
            <th style={{ textAlign: "right" }}>est. cost</th>
          </tr>
        </thead>
        <tbody>
          {modelCosts.length === 0 ? (
            <tr>
              <td colSpan={8} className="empty">
                no model runs recorded — do not hard-code an estimate without live
                pricing (§25.6). BLOCKED: supabase project.
              </td>
            </tr>
          ) : (
            modelCosts.map((row) => (
              <tr key={`${row.provider}-${row.model}-${row.feature}-${row.userLabel}`}>
                <td>{row.provider}</td>
                <td>{row.model}</td>
                <td>{row.feature}</td>
                <td>{row.tokens}</td>
                <td>{row.searchCalls}</td>
                <td>{row.transcriptionMinutes}</td>
                <td>{row.latencyMsP50}ms</td>
                <td className="metric-value">${row.estimatedCostUsd.toFixed(4)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <p className="note">
        beta targets (§25.6): under $3 per monthly active user · hard alert above $5 ·
        under $0.03 per ordinary save · dedupe radar searches · batch non-urgent
        embeddings · small models for extraction, expensive models only for synthesis.
      </p>
    </>
  );
}
