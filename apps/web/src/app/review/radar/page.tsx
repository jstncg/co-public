// radar candidate review (goal.md §31, §24). every send must carry
// "why this reached you" + a source receipt before it can be approved.

import ReviewQueue from "@/components/ReviewQueue";
import { radarCandidates } from "@/lib/stubs";

export default function RadarReviewPage() {
  return (
    <>
      <h1>radar candidates</h1>
      <p className="subtitle">
        proactive sends awaiting review. caps and quiet hours are enforced
        server-side (§18) — this queue is the human gate.
      </p>
      <ReviewQueue initial={radarCandidates} />
    </>
  );
}
