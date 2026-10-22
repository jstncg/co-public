#!/usr/bin/env python3
"""The Understanding Benchmark — question battery (the instrument).

100 questions spanning an INFERABILITY GRADIENT (L1 retrieval → L5 deep triangulation). The gradient IS
the result: plot accuracy vs level → "where machine understanding of a human falls off a cliff."

Levels:
  L1 RETRIEVAL    — directly stated in email; pure lookup ("what bank?")
  L2 AGGREGATION  — simple counting/aggregation ("who do you email most?")
  L3 PATTERN      — behavior over time ("what's your routine when stressed?")
  L4 INFERENCE    — connect dots across signals ("what are you working on / avoiding?")
  L5 FRAME        — triangulated, against-the-room ("what are you insecure about / won't admit?")

Universal battery (works for any subject) — the reproducible instrument. The agent answers from whatever
model-of-the-person it built; the SUBJECT grades truth. Fixed core now; expand toward 100 over time.
"""

QUESTIONS = [
    # ---- L1: RETRIEVAL (directly in email) ----
    (1, "L1", "facts", "What bank(s) does the user have accounts with?"),
    (1, "L1", "facts", "What airline does the user fly most / have status with?"),
    (1, "L1", "facts", "What credit cards does the user hold?"),
    (1, "L1", "facts", "What investing/brokerage platforms does the user use?"),
    (1, "L1", "facts", "What city does the user primarily live in?"),
    (1, "L1", "possessions", "What phone does the user own?"),
    (1, "L1", "possessions", "What computer/laptop brand does the user use?"),
    (1, "L1", "facts", "What email newsletters does the user actually subscribe to?"),
    (1, "L1", "facts", "What food-delivery services does the user use?"),
    (1, "L1", "facts", "What ride-share / transportation services does the user use?"),
    (1, "L1", "possessions", "What wearable or fitness device does the user own?"),
    (1, "L1", "facts", "What gym or fitness service does the user belong to?"),

    # ---- L2: AGGREGATION (count / rank across email) ----
    (2, "L2", "behavior", "What does the user spend the most money on?"),
    (2, "L2", "relationships", "Who does the user correspond with most?"),
    (2, "L2", "behavior", "What category of email does the user ignore most?"),
    (2, "L2", "behavior", "How much of their email does the user actually read?"),
    (2, "L2", "behavior", "What year did the user stop keeping up with their inbox?"),
    (2, "L2", "behavior", "What subscriptions is the user paying for that they may not use?"),
    (2, "L2", "behavior", "How often does the user travel, and where most?"),
    (2, "L2", "preferences", "Is the user more price-sensitive or convenience-sensitive?"),

    # ---- L3: PATTERN (behavior over time) ----
    (3, "L3", "routine", "What is the user's daily/weekly routine like?"),
    (3, "L3", "routine", "What does the user do when they're stressed or burnt out?"),
    (3, "L3", "behavior", "What does the user repeatedly start and then abandon?"),
    (3, "L3", "behavior", "What does the user reliably follow through on?"),
    (3, "L3", "routine", "When is the user most active / what are their hours?"),
    (3, "L3", "behavior", "What does the user buy impulsively?"),
    (3, "L3", "relationships", "Which relationships has the user let go quiet that used to matter?"),
    (3, "L3", "behavior", "What kind of commitments does the user make and not keep?"),
    (3, "L3", "preferences", "What does the user keep paying for year after year (never lets lapse)?"),
    (3, "L3", "behavior", "What does the user's spending reveal about a recent life change?"),

    # ---- L4: INFERENCE (connect dots across signals) ----
    (4, "L4", "identity", "What is the user actually working on right now?"),
    (4, "L4", "identity", "What is the user's profession / what do they do?"),
    (4, "L4", "behavior", "What is the user currently avoiding or procrastinating on?"),
    (4, "L4", "identity", "What is the user trying to become / their aspiration?"),
    (4, "L4", "relationships", "Who matters most to the user right now?"),
    (4, "L4", "behavior", "What is a deadline or obligation the user is at risk of missing?"),
    (4, "L4", "identity", "What phase of life is the user in (transition, building, settling)?"),
    (4, "L4", "preferences", "What does the user value that their calendar/spending actually proves?"),
    (4, "L4", "behavior", "What new thing has the user recently picked up?"),
    (4, "L4", "identity", "What community or scene is the user part of?"),

    # ---- L5: FRAME (triangulated, against-the-room, the moat) ----
    (5, "L5", "frame", "What is the gap between what the user SAYS they want and what they actually do?"),
    (5, "L5", "frame", "What is the user insecure about?"),
    (5, "L5", "frame", "What is the user optimizing for that they wouldn't admit out loud?"),
    (5, "L5", "frame", "What is the user about to quit or give up on?"),
    (5, "L5", "frame", "What comfortable belief is the user avoiding examining?"),
    (5, "L5", "frame", "Where is the user fooling themselves?"),
    (5, "L5", "frame", "What would the user most regret in a year if they don't change it?"),
    (5, "L5", "frame", "What does the user do that contradicts their stated identity?"),
    (5, "L5", "frame", "What is the user's blind spot that others can see but they can't?"),
    (5, "L5", "frame", "What pattern is the user repeating that they think is new each time?"),
]


def by_level():
    from collections import defaultdict
    d = defaultdict(list)
    for q in QUESTIONS:
        d[q[1]].append(q)
    return d


if __name__ == "__main__":
    d = by_level()
    print(f"{len(QUESTIONS)} questions across {len(d)} inferability levels:")
    for lvl in ["L1", "L2", "L3", "L4", "L5"]:
        print(f"  {lvl}: {len(d[lvl])}")
