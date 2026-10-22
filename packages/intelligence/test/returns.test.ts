import { describe, expect, it } from "vitest";
import { selectReturnCandidate } from "../src/returns";

describe("memory returns", () => {
  it("requires a newer trigger and an exact overlapping old receipt", () => {
    const result = selectReturnCandidate(
      { id: "new", capturedAt: "2026-07-20T12:00:00Z", title: "community studio membership", text: "a ceramics room", note: null },
      [
        { id: "unrelated", capturedAt: "2026-07-01T12:00:00Z", title: "trail map", text: "hiking", note: null },
        { id: "old", capturedAt: "2026-07-02T12:00:00Z", title: "ceramics studio", text: "community workshop", note: "a room to make things" },
      ],
    );
    expect(result).toMatchObject({ oldArtifactId: "old" });
    expect(result?.overlap).toEqual(expect.arrayContaining(["community", "studio"]));
    expect(result?.copy).toContain("ceramics studio");
  });

  it("abstains without cross-time evidence instead of inventing relevance", () => {
    expect(selectReturnCandidate(
      { id: "new", capturedAt: "2026-07-20T12:00:00Z", title: "ceramics", text: null, note: null },
      [{ id: "old", capturedAt: "2026-07-20T10:00:00Z", title: "ceramics", text: null, note: null }],
    )).toBeNull();
    expect(selectReturnCandidate(
      { id: "new", capturedAt: "2026-07-20T12:00:00Z", title: "ceramics", text: null, note: null },
      [{ id: "old", capturedAt: "2026-07-01T10:00:00Z", title: "running", text: null, note: null }],
    )).toBeNull();
  });
});

