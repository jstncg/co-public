// privacy queue — deletion / export requests (goal.md §21.3, §31).
// deletion must cascade: artifacts → observations → embeddings → threads.

import { privacyRequests } from "@/lib/stubs";

export default function PrivacyPage() {
  return (
    <>
      <h1>privacy queue</h1>
      <p className="subtitle">
        deletion and export requests. deletion invalidates derived observations,
        embeddings, and thread memberships (cascade, §21.3) and must be verifiable.
      </p>

      <table>
        <thead>
          <tr>
            <th>request</th>
            <th>kind</th>
            <th>user</th>
            <th>requested</th>
            <th>status</th>
          </tr>
        </thead>
        <tbody>
          {privacyRequests.length === 0 ? (
            <tr>
              <td colSpan={5} className="empty">
                no requests queued. BLOCKED: supabase project — this table reads the
                deletion/export queue once the backend exists.
              </td>
            </tr>
          ) : (
            privacyRequests.map((request) => (
              <tr key={request.id}>
                <td>{request.id}</td>
                <td>{request.kind}</td>
                <td>{request.userLabel}</td>
                <td>{request.requestedAt}</td>
                <td>{request.status}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <p className="note">
        covenant: users can export or delete anything (§7). the queue exists so a
        human can verify every cascade completed, not to slow requests down.
      </p>
    </>
  );
}
