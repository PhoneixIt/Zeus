### RESOLVED — M-a, 2026-10-11

The sweep exists and is mutation-verified. `packages/agent/test/convergence.test.ts` now carries
`the REVIEW BUDGET is the boundary: N rounds buys exactly N rounds, and the reason says so`, covering
`maxReviewRounds` in {1, 2, 3, 5}. Each budget asserts the exact reviewer-round count, `exhausted`, a
`/review budget/` note, `findingsSeen.length === budget`, **both** repetition reasons excluded by name
(the findings-repetition note and the outcome-repetition note), and a blocker carrying the budget
reason. The loop runs `budget + 3` cycles, so an unbounded loop overshoots the budget rather than
matching it.

Mutation evidence: the test fails when the budget branch is disabled (`false && ...`) and on an
off-by-one (`>=` changed to `>`), which would let every budget overshoot by one round. The N=3
scenario test above is retained: it proves termination, the sweep proves the boundary.

Gates after M-a: convergence 19/19, agent 36/36, repository unit 684/684, type-check 131 files /
0 errors. Production code unchanged - `orchestrator.ts` sha256 `f27f3f60a6c3155b` before and after.

The three NOT PROVEN rows in the entry above are now covered. That entry is kept rather than
rewritten, because what it recorded was true when it was recorded.