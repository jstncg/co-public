/**
 * The shape gate: what a reply looks like when it lands on a phone.
 *
 * The incumbent brain had this and the runtime did not, which is the first measurable drift from
 * the 9/6 cutover — on the first afternoon 8 of 42 bubbles ran past the 450-character cap the old
 * gate enforced, median 297, longest 720. Nothing was holding the line.
 *
 * Two things this is deliberately NOT.
 *
 * It is not a content quota. The composer document's own addendum warns that "requiring every
 * answer under 450 characters can mutilate an explanation the member requested," and it is right —
 * the long bubbles that afternoon were answering direct questions about agent infrastructure, and
 * cutting them would have made the product worse. So the cap is proportional: a reply to a question
 * gets room, unsolicited prose does not.
 *
 * It is not a truncator. Cutting a sentence mid-thought to satisfy a number ships a mutilated claim,
 * which is worse than a long one. Violations are reported so the composer can revise and so
 * evals/register.py can measure them; the only repair applied here is the one that is safe by
 * construction — dropping a trailing question that follows a question, where what remains still
 * stands on its own.
 */

/** A link rides its own bubble under the unfurl law, so two thoughts plus a URL is a correct three. */
export const MAX_BEATS = 3;
/** Texting register. Past this it reads as a briefing. */
export const MAX_BUBBLE = 450;
/** What a direct question buys. Enough for a real explanation, not enough for an essay. */
export const ANSWER_BUBBLE = 900;

export function beats(text: string): string[] {
  return text.trim().split(/\n\n+/).map((beat) => beat.trim()).filter(Boolean);
}

const plain = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** A position opener ("do it.", "no. leave it") is never a question, whatever it starts with. */
const STANCE_OPEN = /^(no|yes|yep|nah|don'?t|do it|skip|leave|take|keep|drop|ship|send)\b/i;

/** Question SHAPE rather than punctuation, because the register drops the mark: "what's the pull
 *  there" is a question with no "?" and was scoring clean on the old detector. */
export function asksBack(text: string): boolean {
  const beat = beats(text).at(-1) ?? "";
  if (/\?/.test(beat)) return true;
  if (STANCE_OPEN.test(beat)) return false;
  return (/^(what|why|how|when|where|which|who|whose)\b/i.test(beat)
      && /['’]s\b|\b(is|are|do|did|can|could|would|should|have|has)\b/i.test(beat))
    || /(^|[.,;!]\s*)((so|and|but|or|ok|okay|wait),?\s+)?(is|are|was|were|do|does|did|can|could|would|will|should|has|have)\s+(it|that|this|he|she|they|you|we|there|i)\b/i.test(beat);
}

/** A reply built mostly from their own words, when they asked nothing, is an echo. Word overlap,
 *  nothing cleverer. An A-or-B question needs A and B named, so it is exempt. */
export function echoes(draft: string, last: string): boolean {
  if (/\?/.test(last) || /\S+\s+\bor\b\s+\S+/i.test(last)) return false;
  const words = (text: string) => plain(text).split(" ").filter((word) => word.length > 3);
  const theirs = new Set(words(last));
  const mine = words(draft);
  if (mine.length < 5 || theirs.size < 3) return false;
  return mine.filter((word) => theirs.has(word)).length / mine.length >= 0.6;
}

/** Two question-shaped replies in a row, with no question from them, is the nag. */
export function nags(draft: string, last: string, previousReply: string): boolean {
  return asksBack(draft) && asksBack(previousReply) && !/\?/.test(last);
}

/** The one repair that is safe by construction: drop a trailing question that followed a question,
 *  but only when what remains is still a real reply. "hah." alone is not, so an ack-then-question
 *  keeps its question. */
export function dropTrailingQuestion(text: string, last: string, previousReply: string): string {
  const parts = beats(text);
  if (parts.length < 2 || !nags(text, last, previousReply)) return text;
  const rest = parts.slice(0, -1).join("\n\n");
  return !asksBack(rest) && rest.split(/\s+/).length >= 4 ? rest : text;
}

export interface ShapeContext {
  /** Their message. A direct question raises the cap and exempts the echo check. */
  last: string;
  /** Co's previous reply, for the two-questions-running rule. */
  previousReply?: string;
}

/** Violations in the composer's own register, so a revision pass can act on them directly rather
 *  than being told a number. */
export function shapeViolations(draft: string, context: ShapeContext): string[] {
  const violations: string[] = [];
  const last = context.last ?? "";
  const previousReply = context.previousReply ?? "";
  if (!draft.trim()) return violations;

  if (echoes(draft, last)) {
    violations.push("this hands their own words back. add one thing they did not have, or say less.");
  }
  if (nags(draft, last, previousReply)) {
    violations.push("your previous reply already ended in a question and they did not ask one. "
      + "this one ends on a statement.");
  }
  const parts = beats(draft);
  if (parts.length > MAX_BEATS) {
    violations.push(`${parts.length} beats — that lands as ${parts.length} separate texts at once `
      + `(max ${MAX_BEATS}). Say the one that matters.`);
  }
  // Proportional: an answer to a direct question may run long, unsolicited prose may not.
  const answering = /\?/.test(last) || asksBack(last);
  const cap = answering ? ANSWER_BUBBLE : MAX_BUBBLE;
  const longest = parts.reduce((a, b) => (b.length > a.length ? b : a), "");
  if (longest.length > cap) {
    violations.push(`one text is ${longest.length} characters (max ${cap}${answering ? " when answering a question" : ""}) `
      + "— this is briefing register, not texting. Cut it to the single thing worth saying.");
  }
  return violations;
}

export interface ShapeResult {
  text: string;
  violations: string[];
  repaired: boolean;
}

/** Check, apply the one safe repair, and report. Never truncates. */
export function applyShape(draft: string, context: ShapeContext): ShapeResult {
  const kept = dropTrailingQuestion(draft, context.last ?? "", context.previousReply ?? "");
  return {
    text: kept,
    violations: shapeViolations(kept, context),
    repaired: kept !== draft,
  };
}
