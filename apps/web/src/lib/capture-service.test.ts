import { describe, expect, it, vi } from "vitest";
import { captureArtifact } from "./capture-service";

function fakeClient() {
  const rows = new Map<string, unknown>();
  const chain: any = {
    insert: vi.fn(() => chain), upsert: vi.fn(() => chain), update: vi.fn(() => chain), select: vi.fn(() => chain),
    eq: vi.fn(() => chain), maybeSingle: vi.fn(async () => ({ data: { id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04112", created_at: "2026-07-20T19:00:00Z", processing_status: "processing", source_coverage: "url_only" }, error: null })),
    single: vi.fn(async () => ({ data: { id: "0198c5d2-bfed-75e0-b7d1-8a89b7c04113" }, error: null })), then: (resolve: (value: unknown) => unknown) => resolve({ error: null, data: rows }),
  };
  const client: any = { from: vi.fn(() => chain), schema: vi.fn(() => client) };
  return { client, chain };
}

describe("capture service", () => {
  it("preserves save-without-analysis", async () => {
    const { client, chain } = fakeClient();
    const result = await captureArtifact(client, "0198c5d2-bfed-75e0-b7d1-8a89b7c04110", {
      clientArtifactId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04111", sourceType: "voice", sourceApp: "co", canonicalUrl: null,
      suppliedText: "private thought", userNote: null, timestampSeconds: null, coverage: "text", analysisAllowed: false,
      capturedAt: "2026-07-20T12:00:00-07:00", idempotencyKey: "capture:private:0198c5d2", uploadObjectKeys: [],
    });
    expect(result.receipt.status).toBe("saved_without_analysis");
    expect(result.immediate.response).toBe("saved without analysis.");
    expect(client.schema).not.toHaveBeenCalled();
    expect(chain.update).not.toHaveBeenCalled();
  });

  it("dispatches one idempotent worker job when async processing is enabled", async () => {
    const { client } = fakeClient();
    const dispatch = vi.fn(async () => undefined);
    const result = await captureArtifact(client, "0198c5d2-bfed-75e0-b7d1-8a89b7c04110", {
      clientArtifactId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04111", sourceType: "text", sourceApp: "co", canonicalUrl: null,
      suppliedText: "a thing worth keeping", userNote: null, timestampSeconds: null, coverage: "text", analysisAllowed: true,
      capturedAt: "2026-07-20T12:00:00-07:00", idempotencyKey: "capture:worker:0198c5d2", uploadObjectKeys: [],
    }, { environment: { FEATURE_ASYNC_PROCESSING: "true" }, dispatch });
    expect(result.receipt.status).toBe("queued");
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "capture:worker:0198c5d2" }));
  });
});
