// ops — failed source adapters + failed background jobs (goal.md §31).
// empty until trigger.dev tasks and adapters run against real infrastructure.

import { adapterFailures, jobFailures } from "@/lib/stubs";

export default function OpsPage() {
  return (
    <>
      <h1>ops</h1>
      <p className="subtitle">adapter and job health — populated by trigger.dev task telemetry (§25.3)</p>

      <h2>failed source adapters</h2>
      <table>
        <thead>
          <tr>
            <th>adapter</th>
            <th>target</th>
            <th>error</th>
            <th>failed at</th>
            <th>consecutive</th>
          </tr>
        </thead>
        <tbody>
          {adapterFailures.length === 0 ? (
            <tr>
              <td colSpan={5} className="empty">
                no adapter failures recorded — nothing has run yet. BLOCKED: supabase project.
              </td>
            </tr>
          ) : (
            adapterFailures.map((failure) => (
              <tr key={`${failure.adapter}-${failure.failedAt}`}>
                <td>{failure.adapter}</td>
                <td>{failure.target}</td>
                <td>{failure.error}</td>
                <td>{failure.failedAt}</td>
                <td>{failure.consecutiveFailures}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <h2>failed background jobs</h2>
      <table>
        <thead>
          <tr>
            <th>task</th>
            <th>run id</th>
            <th>error</th>
            <th>failed at</th>
            <th>retries</th>
          </tr>
        </thead>
        <tbody>
          {jobFailures.length === 0 ? (
            <tr>
              <td colSpan={5} className="empty">
                no job failures recorded — nothing has run yet.
              </td>
            </tr>
          ) : (
            jobFailures.map((failure) => (
              <tr key={failure.runId}>
                <td>{failure.task}</td>
                <td>{failure.runId}</td>
                <td>{failure.error}</td>
                <td>{failure.failedAt}</td>
                <td>{failure.retries}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
  );
}
