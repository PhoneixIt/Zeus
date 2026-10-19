import io

TARGET = r'C:\Users\Samer\Projects\AIOS\packages\agent\test\convergence.test.ts'

NEW_TEST = r'''
// The boundary itself, swept. `FRESH BUT UNRESOLVABLE` above proves the loop terminates; it does not
// prove WHICH check stopped it, and it only does so at one budget. This runs the same unresolvable
// reviewer at several budgets and asserts the reviewer-round count equals the budget exactly.
//
// Two assertions make this a boundary test rather than a second copy of the test above:
//   - `findingsSeen.length` must equal the budget, so a REPEATED finding can never be what stopped
//     the loop - every round really did contribute a new fingerprint;
//   - the note must name the budget and must NOT name either repetition reason, so the outcome
//     repetition guard and the findings guard are both positively excluded rather than assumed away.
test('the REVIEW BUDGET is the boundary: N rounds buys exactly N rounds, and the reason says so', async () => {
  for (const budget of [1, 2, 3, 5]) {
    const task = baseTask({ maxReviewRounds: budget })
    const o = fresh(join(DIR, `budget-${budget}.json`), task)
    let n = 0
    const reviewer: Reviewer = {
      name: 'escalating', model: 'escalating-reviewer', isIndependent: true,
      review: async () => ({
        verdict: 'request-changes' as const,
        // Distinct every round. `normalizedFindings` preserves digits, so these do not collide - and
        // the findingsSeen assertion below proves it rather than trusting it.
        text: `Round ${n++}: raise the bar one more notch. Consider requirement ${n}.`,
        model: 'escalating-reviewer', independent: true, elapsedMs: 1,
      }),
    }

    // budget + 3 cycles: enough to prove termination. Were the loop not bounded, the reviewer-round
    // count would come out ABOVE the budget instead of equal to it.
    for (let i = 0; i < budget + 3; i++) await o.runCycle(task, { model: 'm', reviewer, cwd: DIR })

    const rec = o.snapshot().tasks[0]!
    const reviewerRounds = rec.rounds.filter((x) => x.role === 'reviewer').length

    assert.equal(reviewerRounds, budget, `a budget of ${budget} must buy exactly ${budget} reviewer rounds`)
    assert.equal(rec.status, 'exhausted', `a budget of ${budget} must end exhausted`)
    assert.match(rec.note, /review budget/, `a budget of ${budget} must name the budget as the reason`)

    // The budget stopped it, not repetition. Both other exhaustion reasons are ruled out by name.
    assert.doesNotMatch(rec.note, /repeating the reviewer's own findings/,
      `a budget of ${budget} must not be reported as a repeated finding`)
    assert.doesNotMatch(rec.note, /repeating outcome/,
      `a budget of ${budget} must not be reported as a repeated outcome`)

    // One distinct fingerprint per round: proof that no round was ever detected as a repeat.
    assert.equal(rec.findingsSeen.length, budget,
      `every round of a ${budget}-round budget must have contributed a NEW finding`)

    assert.ok(o.snapshot().blockers.length > 0, `a ${budget}-round budget must leave a blocker`)
    assert.ok(o.snapshot().blockers.some((b) => /review budget/.test(b)),
      `the blocker a human reads must carry the budget reason`)
  }
})
'''

ANCHOR = "  assert.ok(o.snapshot().blockers.length > 0, 'an unresolved task must leave a blocker a human can read')\n})\n\n// ---------------------------------------------------------------- implementer and reviewer failure"

src = io.open(TARGET, encoding='utf-8').read()

# Refuse to edit unless the anchor is exactly where we expect it, exactly once.
assert src.count(ANCHOR) == 1, ('anchor count', src.count(ANCHOR))
assert 'the REVIEW BUDGET is the boundary' not in src, 'already present - refusing to duplicate'

src = src.replace(ANCHOR, ANCHOR.replace(
    '})\n\n// ---------------------------------------------------------------- implementer and reviewer failure',
    '})\n' + NEW_TEST + '\n// ---------------------------------------------------------------- implementer and reviewer failure'))

io.open(TARGET, 'w', encoding='utf-8').write(src)
print('inserted review-budget boundary sweep after line 137')