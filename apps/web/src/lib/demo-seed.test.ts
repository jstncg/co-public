import { describe, expect, it } from "vitest";
import { buildDemoSeed } from "./demo-seed";

const users = {
  maya: "00000000-0000-4000-8000-000000000001",
  alex: "00000000-0000-4000-8000-000000000002",
  priya: "00000000-0000-4000-8000-000000000003",
  sam: "00000000-0000-4000-8000-000000000004",
};

describe("deterministic demo journeys", () => {
  const seed = buildDemoSeed(users);

  it("is stable and contains all four named personas", () => {
    expect(buildDemoSeed(users)).toEqual(seed);
    expect(seed.profiles.map((row) => row.id)).toEqual(Object.values(users));
    expect(seed.artifacts).toHaveLength(16);
  });

  it("gives Maya a receipt-backed completed move and outcome", () => {
    const pattern = seed.hypotheses.find((row) => row.user_id === users.maya);
    expect(pattern).toMatchObject({ status: "delivered" });
    expect(seed.evidenceLinks.filter((row) => row.hypothesis_id === pattern?.id)).toHaveLength(5);
    expect(seed.moves.find((row) => row.user_id === users.maya)).toMatchObject({ status: "completed" });
    expect(seed.outcomes[0]).toMatchObject({ result: "The people mattered; I attended again." });
  });

  it("gives Alex and Priya explicit, sourced radar journeys", () => {
    expect(seed.watches).toHaveLength(2);
    expect(seed.watches.every((row) => row.approved_at)).toBe(true);
    expect(seed.radarCandidates).toHaveLength(2);
    expect(seed.sourceReceipts).toHaveLength(2);
    expect(seed.moves.filter((row) => [users.alex, users.priya].includes(row.user_id as string))).toHaveLength(2);
  });

  it("keeps Sam's false running pattern in review with an explicit contradiction", () => {
    const pattern = seed.hypotheses.find((row) => row.user_id === users.sam);
    expect(pattern).toMatchObject({ status: "review", reason_to_send: "blocked by explicit contradiction" });
    expect(seed.evidenceLinks.some((row) => row.hypothesis_id === pattern?.id && row.direction === "contradict")).toBe(true);
    expect(seed.modelRuns.find((row) => row.user_id === users.sam)).toBeTruthy();
  });
});
