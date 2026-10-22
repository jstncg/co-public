import { movePlanSchema, type MovePlan } from "@co/contracts";

export type MoveState = "prepared" | "approved" | "completed" | "dismissed" | "expired";
const transitions: Record<MoveState, MoveState[]> = {
  prepared: ["approved", "dismissed", "expired"],
  approved: ["completed", "dismissed", "expired"],
  completed: [],
  dismissed: [],
  expired: [],
};

export function prepareMove(input: unknown): MovePlan {
  return movePlanSchema.parse(input);
}

export function transitionMove(current: MoveState, next: MoveState, userConfirmed: boolean): MoveState {
  if (!transitions[current].includes(next)) throw new Error(`invalid move transition: ${current} -> ${next}`);
  if ((next === "approved" || next === "completed") && !userConfirmed) throw new Error("final user confirmation is required");
  return next;
}

export function outcomeObservation(input: { moveState: MoveState; result: string; valueRating: number; repeatIntent: "yes" | "maybe" | "no" }) {
  if (input.moveState !== "completed") throw new Error("outcomes require a completed move");
  return {
    observationType: "move_outcome",
    statement: input.result.slice(0, 500),
    confidence: input.valueRating >= 4 && input.repeatIntent === "yes" ? 0.85 : 0.55,
    scope: "this move under these conditions",
  };
}
