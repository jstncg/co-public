// pattern candidate review (goal.md §31, §23 "founder review").
// approving is the only path to a user-facing pattern in beta.

import ReviewQueue from "@/components/ReviewQueue";
import { patternCandidates } from "@/lib/stubs";

export default function PatternReviewPage() {
  return (
    <>
      <h1>pattern candidates</h1>
      <p className="subtitle">
        approve · edit · reject · unsafe — decisions stub to an in-memory store.
        sam&apos;s card shows a contradiction that must block the send (§37).
      </p>
      <ReviewQueue initial={patternCandidates} />
    </>
  );
}
