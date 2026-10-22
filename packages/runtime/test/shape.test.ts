/**
 * The shape gate, and the two ways it must not overreach.
 *
 * The incumbent brain enforced beats and bubble length; the runtime shipped without it, and on the
 * first afternoon after the 9/6 cutover 8 of 42 bubbles ran past the old cap. But the composer
 * document's addendum is right that a flat cap "can mutilate an explanation the member requested",
 * and those long bubbles were answering direct questions about agent infrastructure. So the cases
 * below pin both directions: the gate catches the burst and the briefing, and it leaves a requested
 * answer alone and never truncates anything.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ANSWER_BUBBLE, MAX_BEATS, MAX_BUBBLE, applyShape, asksBack, beats, dropTrailingQuestion,
  echoes, nags, shapeViolations,
} from "../src/shape.ts";

const long = (n: number) => "word ".repeat(Math.ceil(n / 5)).slice(0, n);

describe("beats", () => {
  it("splits on blank lines and drops empties", () => {
    assert.deepEqual(beats("one\n\ntwo\n\n\n  \n\nthree"), ["one", "two", "three"]);
    assert.deepEqual(beats("   "), []);
  });

  it("flags a burst as separate texts landing at once", () => {
    const v = shapeViolations("a\n\nb\n\nc\n\nd\n\ne", { last: "hey" });
    assert.ok(v.some((line) => line.includes("5 beats")), v.join(" | "));
    assert.equal(shapeViolations("a\n\nb\n\nc", { last: "hey" }).length, 0);
    assert.equal(MAX_BEATS, 3);
  });
});

describe("the bubble cap is proportional, not flat", () => {
  it("holds unsolicited prose to texting register", () => {
    const v = shapeViolations(long(600), { last: "https://x.com/someone/status/1" });
    assert.ok(v.some((line) => line.includes(`max ${MAX_BUBBLE}`)), v.join(" | "));
  });

  it("gives a direct question room to be answered properly", () => {
    // The 9/6 case: "What would a product to handle this look like even?" got a real explanation.
    const v = shapeViolations(long(600), { last: "What would a product to handle this look like even?" });
    assert.deepEqual(v, [], "an answer to a question must not be flagged at 600 characters");
  });

  it("still stops an essay, even when answering", () => {
    const v = shapeViolations(long(1_400), { last: "how would that work?" });
    assert.ok(v.some((line) => line.includes(`max ${ANSWER_BUBBLE}`)), v.join(" | "));
    assert.ok(ANSWER_BUBBLE > MAX_BUBBLE);
  });

  it("recognises a question with no question mark", () => {
    assert.equal(asksBack("what's the pull there"), true);
    assert.equal(asksBack("is that the same thing"), true);
    assert.equal(asksBack("no. leave it till tomorrow"), false);
    assert.equal(asksBack("do it."), false);
  });
});

describe("the echo", () => {
  it("catches a reply built from their own words", () => {
    const last = "pat sun wants to keep doing research on the memory architecture problem";
    assert.equal(echoes("pat sun wants to keep doing research on memory architecture, good to know", last), true);
  });

  it("leaves a reply that adds something", () => {
    const last = "pat sun wants to keep doing research on the memory architecture problem";
    assert.equal(echoes("the forgetting half is the unsolved part, interference scoring and ttl expiry", last), false);
  });

  it("exempts an A-or-B question, which has to name A and B", () => {
    assert.equal(echoes("thursday or friday", "thursday or friday works for me"), false);
  });
});

describe("two questions running is the nag", () => {
  const previous = "what are you actually shooting?";

  it("flags a second question when they asked none", () => {
    assert.equal(nags("which lens did you land on?", "got the a7", previous), true);
    assert.ok(shapeViolations("which lens did you land on?", { last: "got the a7", previousReply: previous })
      .some((line) => line.includes("ends on a statement")));
  });

  it("allows a question when they asked one", () => {
    assert.equal(nags("which one?", "should i get the a7 or the fx3?", previous), false);
  });

  it("drops the trailing question only when what remains still stands alone", () => {
    const draft = "the lens costs more than the body\n\nwhich one did you land on?";
    assert.equal(dropTrailingQuestion(draft, "got the a7", previous), "the lens costs more than the body");
    const ack = "hah.\n\nwhich one?";
    assert.equal(dropTrailingQuestion(ack, "got the a7", previous), ack, "an ack alone is not a reply");
  });
});

describe("applyShape never truncates", () => {
  it("returns the draft unchanged when it only reports violations", () => {
    const draft = long(700);
    const result = applyShape(draft, { last: "https://x.com/a/status/1" });
    assert.equal(result.text, draft, "the gate reports, the composer revises — it must not cut");
    assert.equal(result.repaired, false);
    assert.ok(result.violations.length > 0);
  });

  it("applies the one safe repair and says so", () => {
    const result = applyShape("the lens costs more than the body\n\nwhich one did you land on?",
      { last: "got the a7", previousReply: "what are you actually shooting?" });
    assert.equal(result.repaired, true);
    assert.equal(result.text, "the lens costs more than the body");
  });

  it("is silent on a clean reply", () => {
    const result = applyShape("astra picked the obscure biotech end of the corpus\n\nfable picked familiar names",
      { last: "https://x.com/a/status/1" });
    assert.deepEqual(result.violations, []);
    assert.equal(result.repaired, false);
  });

  it("handles an empty draft without inventing a violation", () => {
    assert.deepEqual(applyShape("", { last: "hey" }).violations, []);
    assert.deepEqual(applyShape("   ", { last: "hey" }).violations, []);
  });
});

describe("the real transcript", () => {
  it("would have flagged the 720-character bubble sent on 9/6", () => {
    // Sent in reply to a bare link, not a question, so it gets the texting cap.
    const v = shapeViolations(long(720), { last: "https://x.com/signulll/status/2096664075975684422" });
    assert.ok(v.some((line) => line.includes("briefing register")), v.join(" | "));
  });

  it("would have left the agent-infrastructure answer alone", () => {
    const v = shapeViolations(long(720), { last: "What would a product to handle this look like even?" });
    assert.deepEqual(v, []);
  });
});
