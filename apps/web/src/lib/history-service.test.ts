import { describe, expect, it, vi } from "vitest";
import { correctArtifact, listRelationshipHistory } from "./history-service";

const artifactId = "0198c5d2-bfed-75e0-b7d1-8a89b7c04310";
const clientArtifactId = "0198c5d2-bfed-75e0-b7d1-8a89b7c04311";
const messageId = "0198c5d2-bfed-75e0-b7d1-8a89b7c04312";

class Query {
  private head = false;
  constructor(private readonly table: string, private readonly rows: Record<string, unknown[]>, private readonly counts: Record<string, number>) {}
  select(_columns: string, options?: { head?: boolean }) { this.head = options?.head ?? false; return this; }
  eq() { return this; }
  is() { return this; }
  in() { return this; }
  order() { return this; }
  limit() { return this; }
  then(resolve: (value: any) => unknown) {
    return Promise.resolve(resolve(this.head
      ? { data: null, count: this.counts[this.table] ?? 0, error: null }
      : { data: this.rows[this.table] ?? [], count: null, error: null }));
  }
}

describe("relationship history", () => {
  it("joins owned catches to honest source receipts and bounded message context", async () => {
    const rows = {
      artifacts: [{
        id: artifactId, client_artifact_id: clientArtifactId, source_type: "article",
        canonical_url: "https://example.com/source", title: "A useful source", publisher: "Example",
        captured_at: "2026-07-20T19:00:00Z", raw_text: "specific evidence", transcript: null,
        user_note: "because of the room", source_coverage: "text", processing_status: "ready",
      }],
      source_receipts: [{
        artifact_id: artifactId, canonical_url: "https://example.com/source", source_title: "A useful source",
        publisher: "Example", coverage: "text", retrieved_at: "2026-07-20T19:01:00Z",
      }],
      message_artifacts: [{ artifact_id: artifactId, message_id: messageId }],
      messages: [{
        id: messageId, direction: "inbound", transport: "sendblue", text: "I saved this because it changes the room",
        sent_at: "2026-07-20T19:00:00Z", delivered_at: null, read_at: null, media_urls: ["https://provider.invalid/private"],
      }],
    };
    const admin: any = {
      from: (table: string) => new Query(table, rows, { messages: 278, artifacts: 58, threads: 12, hypotheses: 3, radar_candidates: 2 }),
    };

    const result = await listRelationshipHistory(admin, "user-1", "ROOM");
    expect(result.summary).toEqual({
      messageCount: 278, sharedMomentCount: 58, recurringThreadCount: 12,
      thingsTakingShapeCount: 3, radarCount: 2,
    });
    expect(result.catches[0]).toMatchObject({
      artifactId, clientArtifactId, textPreview: "specific evidence",
      messageContext: { messageId, mediaCount: 1 },
      receipt: { canonicalUrl: "https://example.com/source", coverage: "text" },
    });
    expect(JSON.stringify(result)).not.toContain("provider.invalid/private");
  });

  it("persists correction only through the scoped transaction", async () => {
    const rpc = vi.fn(async () => ({ data: "0198c5d2-bfed-75e0-b7d1-8a89b7c04313", error: null }));
    await expect(correctArtifact({ rpc } as any, "user-1", {
      clientArtifactId, correction: "  this was about the room  ",
    })).resolves.toEqual({ corrected: true, annotationId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04313" });
    expect(rpc).toHaveBeenCalledWith("correct_user_artifact", {
      p_user_id: "user-1", p_client_artifact_id: clientArtifactId, p_correction: "this was about the room",
    });
  });
});

