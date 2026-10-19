---

## PHASE 3 — the round-budget exhaustion test is MISSING, not broken (open)

**This is a coverage gap, not a defect.** Recorded because the passing test it currently rests on
passed for the wrong reason, and that will not hold if the code moves.

`FRESH BUT UNRESOLVABLE findings terminate as a blocker` asserts that a fresh task with
`maxReviewRounds: 3` runs exactly 3 reviewer rounds. It passes — but it passes because of the
**terminal guard** (a `done`/`exhausted` task spends no further cycle), not because any test exercises
the review-budget branch itself. Measured: reverting that guard makes the test run **6** rounds instead
of 3, so the guard is load-bearing and the budget check is only reached incidentally.

| | status |
|---|---|
| A fresh task stops at its configured review budget | **PROVEN**, but indirectly |
| The `roundCount >= task.maxReviewRounds` branch is directly exercised | **NOT PROVEN** |
| A task is exhausted at exactly N rounds for N = 1, 2, 3, 5 | **NOT PROVEN** |
| The budget note and a readable blocker are produced by that branch | **NOT PROVEN** |

Why it matters: the budget is the ceiling that makes the loop *bounded* when the reviewer keeps raising
genuinely new findings — the case where the repetition guard correctly does not fire. Nothing currently
pins the boundary itself. A refactor that reordered the status chain, or made the terminal guard
unreachable, could make every task exhaust at 2 rounds and this suite would still be green.

Follow-up: add a boundary-sweep test — for `maxReviewRounds` in {1, 2, 3, 5}, assert the exact reviewer
round count, `status === 'exhausted'`, a note matching `/review budget/`, and at least one blocker.
Assert the count is reached **by the budget**, i.e. that the note says the budget and not repetition,
so the two exhaustion causes cannot be confused again.