// node --experimental-strip-types --test frame/brain/shape.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { askedCall, asksBack, copiesExemplar, dropTrailingQuestion, echoes, shapeViolations, STANCE_OPEN_RE } from "./server.ts";

const nag = (v: string[]) => v.some((x) => x.includes("previous reply already ended in a question"));

test("two questions in a row with no question from them is a violation", () => {
	assert.ok(nag(shapeViolations("what kind of role?", "kelvin might be free", "what's the hook?")));
});
test("a question is fine when the previous reply was a statement", () => {
	assert.ok(!nag(shapeViolations("what kind of role?", "kelvin might be free", "6am club.")));
});
test("a question is fine when they asked one", () => {
	assert.ok(!nag(shapeViolations("the a7 or the fx3?", "what did she say about the timeline?", "what's the hook?")));
});
test("a question without its mark still counts", () => {
	assert.ok(nag(shapeViolations("hah. that tracks\n\nis that a new dennis fixation", "dennis wants a minecraft video", "what's her read on how they got to yes")));
	assert.ok(nag(shapeViolations("so for us, is it a find-someone-else or a wait-and-see", "kelvin might be free", "what's the pull there")));
});
test("a position after they asked for a call is never flagged", () => {
	assert.ok(!nag(shapeViolations("do it. she raised from index, hear her out", "meet ava or skip it", "what's the pull there")));
});
test("a statement after a question is fine, including ones that open with an aux", () => {
	for (const d of ["cursor pays. he'll take it", "could go either way", "will do", "should be fine either way", "she has it handled", "he did it last year", "can't tell from here", "have a good one"])
		assert.ok(!nag(shapeViolations(d, "kelvin might be free", "what's the hook?")), d);
});

test("asked-for-a-call catches the natural phrasings", () => {
	for (const m of ["should i text her back", "not sure if i should meet ava next week or skip it", "meet ava or skip?", "do i skip ava", "worth meeting ava or nah", "taking the cursor offer, thoughts?"])
		assert.ok(askedCall(m), m);
	for (const m of ["gym at 6 tmrw then heads down on the persona stuff", "kelvin might be free, he's interviewing at cursor tho", "how do i export a lut in resolve", "what do i even say to her", "when do we land", "that trip was so worth it"])
		assert.ok(!askedCall(m), m);
	assert.ok(askedCall("any thoughts? "));
});

test("asksBack reads shape", () => {
	for (const q of ["what's the pull there", "is that a new dennis fixation", "so for us, is it a or b", "how close are we talking?", "that's a clear signal. is that what you expected him to say", "got it\n\nso is it the video or the job"]) assert.ok(asksBack(q), q);
	for (const st of ["will do", "do it. hear her out", "6am gym, then straight into persona work"]) assert.ok(!asksBack(st), st);
});

test("a trailing question after a question is dropped only when a thought remains", () => {
	const last = "kelvin might be free", prev = "what's the hook?";
	assert.equal(dropTrailingQuestion("that tracks. dennis has been on that for a month.\n\nis that the new fixation", last, prev), "that tracks. dennis has been on that for a month.");
	for (const t of ["hah.\n\nis that the new dennis fixation", "ok.\n\nis he still at cursor", "is he still at cursor", "cursor pays.\n\nhe'll take it"])
		assert.equal(dropTrailingQuestion(t, last, prev), t);
	assert.equal(dropTrailingQuestion("that tracks. dennis has been on that for a month.\n\nis that the new fixation", "meet ava or skip it", prev).includes("fixation"), true);
});

test("an exemplar line, or a cut of one, is a copy", () => {
	for (const d of ["yeah. want the postmortem or the distraction", "6am club. that's four this week", "the lens costs more than the body. what are you actually shooting?", "sure\n\nthird escape-pod video this week. what's the actual plan"]) assert.ok(copiesExemplar(d), d);
	for (const d of ["yeah. rough one. want to talk it through or not tonight", "6am club.", "bet, i'll ping you in 20", "that's on me", "TOMORROWS THE DAY!!", "this week", "sleep early", "no. leave it till tomorrow"]) assert.ok(!copiesExemplar(d), d);
	assert.ok(shapeViolations("yeah. want the postmortem or the distraction").some((x) => x.includes("exemplar")));
});

test("a reply built from their own words is an echo, unless they asked", () => {
	assert.ok(echoes("pat sun wants to keep doing research, good to know.", "ok pat sun said he wants to keep doing research"));
	assert.ok(echoes("6am gym then heads down on persona stuff. you're locking it in.", "gym at 6 tmrw then heads down on the persona stuff"));
	assert.ok(!echoes("cursor pays more than we can. he takes it unless we have a number", "kelvin might be free, he's interviewing at cursor tho"));
	assert.ok(!echoes("6am club. that's a commitment", "gym at 6 tmrw then heads down on the persona stuff"));
	assert.ok(!echoes("the persona stuff is the whole product right now, gym first is right", "should i do gym or persona stuff first?"));
	assert.ok(!echoes("take the cursor offer over the anthropic one", "torn between the cursor offer and the anthropic offer honestly"));
	assert.ok(!echoes("the sigma lens over the sony body for that trip", "cant decide between the sigma lens and the sony body for the trip"));
	assert.ok(!echoes("the persona work goes first, the archive redesign can wait", "persona work or the archive redesign first this week, leaning archive"));
});

test("a stance opener commits; a hedge that starts with not does not", () => {
	for (const d of ["not worth it.", "not yet. wait for kelvin", "no. skip it.", "not tomorrow", "not a chance", "not until kelvin answers", "not the phone. call him"]) assert.ok(STANCE_OPEN_RE.test(d), d);
	for (const d of ["not sure if you should meet ava next week", "not a bad idea, what's the upside"]) assert.ok(!STANCE_OPEN_RE.test(d), d);
});
