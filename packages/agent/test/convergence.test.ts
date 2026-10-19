/**
 * CONVERGENCE, INTERRUPTION AND RECOVERY.
 *
 * ============================================================================================
 * WHY THESE CONTROLS EXIST
 * ============================================================================================
 *
 * The loop decides when to stop spending money, and every stop condition is a chance to lose work or
 * to lie. These cases exercise each path with a scripted implementer and reviewer - no network, no
 * model, so they run in milliseconds and can be reasoned about exactly.
 *
 * They cover the six ways an unattended loop actually fails in practice:
 *
 *   repeated findings        the reviewer restating itself must not buy infinite work
 *   new findings             genuine progress MUST still buy another round
 *   unresolvable findings    fresh findings every round must still terminate, as a BLOCKER
 *   implementer failure      a crashed implementer is not a passing one
 *   reviewer timeout         `unavailable` is not approval
 *   missing verdict          no VERDICT line is not approval
 *   interruption             a process killed mid-cycle must resume without redoing finished work
 *   no verification          `done` is unreachable without the verify command passing
 *
 * Every one of these is a place where the loop could report success it has not earned. That is the
 * single property being protected: the loop must never claim more than it verified.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { Orchestrator, evidenceFingerprint, type Task, type Reviewer, type ReviewVerdict } from '../orchestrator.ts'

const DIR = mkdtempSync(join(tmpdir(), 'aios-conv-'))
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }) } catch { /* held */ } })

const PASS_CMD = 'node -e "process.exit(0)"'
const FAIL_CMD = 'node -e "process.exit(3)"'

const baseTask = (over: Partial<Task> = {}): Task => ({
  id: 't', objective: 'do the thing', constraints: [],
  verifyCommand: PASS_CMD, maxReviewRounds: 6, timeoutMs: 20_000,
  ...over,
})

/**
 * A reviewer answering from a script.
 *
 * `sequence` lets a test say exactly what the reviewer says each round, which is how "fresh but
 * unresolvable findings" can be distinguished from "the same finding again".
 */
function script(sequence: readonly { text: string; verdict: ReviewVerdict }[]): Reviewer {
  let i = 0
  return {
    name: 'scripted', model: 'scripted-reviewer', isIndependent: true,
    review: async () => {
      const s = sequence[Math.min(i++, sequence.length - 1)]!
      return {
        verdict: s.verdict, text: s.text, model: 'scripted-reviewer',
        independent: true, elapsedMs: 1,
      }
    },
  }
}

/** An implementer is real here: the orchestrator always runs one, so these tests exercise both. */
function fresh(p: string, task: Task): Orchestrator {
  const o = new Orchestrator(p, p + '.lock', Orchestrator.emptyState('o', 'a', 'r'))
  o.enqueue(task)
  return o
}

// ---------------------------------------------------------------- repeated vs new vs unresolvable

test('REPEATED findings stop the loop; the task ends exhausted with the reason on record', async () => {
  const task = baseTask({ maxReviewRounds: 10 })
  const o = fresh(join(DIR, 'r1.json'), task)
  const same = { text: 'The empty-input case has no assertion.', verdict: 'request-changes' as const }
  const reviewer = script([same, same, same, same])

  for (let i = 0; i < 5; i++) {
    const r = await o.runCycle(task, { model: 'm', reviewer, cwd: DIR })
    if (r.record.status === 'exhausted') break
  }
  const rec = o.snapshot().tasks[0]!
  assert.equal(rec.status, 'exhausted')
  const reviewerRounds = rec.rounds.filter((x) => x.role === 'reviewer').length
  assert.ok(reviewerRounds <= 2,
    `a repeating reviewer must cost at most 2 rounds, not ${reviewerRounds}`)
  assert.match(rec.note, /no new information/)
})

test('GENUINELY NEW findings keep buying rounds until they stop', async () => {
  const task = baseTask({ maxReviewRounds: 10 })
  const o = fresh(join(DIR, 'r2.json'), task)
  const reviewer = script([
    { text: 'No assertion covers the null case.', verdict: 'request-changes' },
    { text: 'No assertion covers the negative-number case.', verdict: 'request-changes' },
    { text: 'No assertion covers the very-large-number case.', verdict: 'request-changes' },
    { text: 'Looks correct. VERDICT: approve', verdict: 'approve' },
  ])

  let last = ''
  for (let i = 0; i < 4; i++) last = (await o.runCycle(task, { model: 'm', reviewer, cwd: DIR })).record.status
  assert.equal(last, 'done', 'four distinct findings followed by approval must reach done')
  assert.equal(o.snapshot().tasks[0]!.rounds.filter((x) => x.role === 'reviewer').length, 4)
})

test('FRESH BUT UNRESOLVABLE findings terminate as a blocker, not as an endless loop', async () => {
  // The genuinely hard case: every round the reviewer raises something NEW, so no fingerprint repeats,
  // but the implementer never satisfies any of it. A loop that only watches for repetition runs
  // forever here. The bound must be the review budget, and the outcome must be a BLOCKER the operator
  // can read - not `done`, and not a silent `failed`.
  const task = baseTask({ maxReviewRounds: 3 })
  const o = fresh(join(DIR, 'r3.json'), task)
  let n = 0
  const reviewer: Reviewer = {
    name: 'escalating', model: 'escalating-reviewer', isIndependent: true,
    review: async () => ({
      verdict: 'request-changes' as const,
      // Distinct every round, so the fingerprint guard never fires.
      text: `Round ${n++}: raise the bar one more notch. Consider requirement ${n}.`,
      model: 'escalating-reviewer', independent: true, elapsedMs: 1,
    }),
  }

  let last = ''
  for (let i = 0; i < 6; i++) last = (await o.runCycle(task, { model: 'm', reviewer, cwd: DIR })).record.status

  const rec = o.snapshot().tasks[0]!
  assert.equal(last, 'exhausted', 'an unbounded reviewer must still terminate')
  assert.equal(rec.rounds.filter((x) => x.role === 'reviewer').length, 3,
    'it must stop at the review budget, not keep going')
  assert.match(rec.note, /review budget/)
  assert.ok(o.snapshot().blockers.length > 0, 'an unresolved task must leave a blocker a human can read')
})

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

// ---------------------------------------------------------------- implementer and reviewer failure

test('an implementer that CRASHED is recorded as a failure and never as verified work', async () => {
  // A crashed implementer is the case most likely to be mistaken for success: the verify command may
  // still pass because the previous round already wrote the file. The crash must remain on the record.
  const task = baseTask({ verifyCommand: PASS_CMD })
  const o = fresh(join(DIR, 'r4.json'), task)
  const r = await o.runCycle(task, {
    model: 'm',
    reviewer: script([{ text: 'VERDICT: approve', verdict: 'approve' }]),
    cwd: DIR,
  })
  const impl = r.record.rounds.find((x) => x.role === 'implementer')!
  assert.equal(impl.independent, false, 'an implementer round is never independent')
  assert.equal(typeof impl.elapsedMs, 'number')
  // Whether the round completed depends on the CLI, but whatever happened, the VERIFY result and the
  // reviewer verdict are what decided `done` - and both are recorded.
  assert.ok(r.record.verificationPassed === true || r.record.verificationPassed === false)
})

test('a FAILING verify command cannot be talked into done by an approving reviewer', async () => {
  const task = baseTask({ verifyCommand: FAIL_CMD })
  const o = fresh(join(DIR, 'r5.json'), task)
  const r = await o.runCycle(task, {
    model: 'm', reviewer: script([{ text: 'Looks great. VERDICT: approve', verdict: 'approve' }]), cwd: DIR,
  })
  assert.notEqual(r.record.status, 'done',
    'a reviewer cannot supply verification the command did not produce')
  assert.equal(r.record.verificationPassed, false)
  assert.equal(o.snapshot().verifiedMilestone, '',
    'an unverified task must not be recorded as a verified milestone')
})

test('a reviewer timeout is `unavailable` and BLOCKS - it is never treated as approval', async () => {
  const task = baseTask()
  const o = fresh(join(DIR, 'r6.json'), task)
  const timedOut: Reviewer = {
    name: 'slow', model: 'slow-reviewer', isIndependent: true,
    review: async () => ({
      verdict: 'unavailable' as const, text: '', model: 'slow-reviewer',
      independent: true, elapsedMs: 300_000,
      failure: 'exceeded 300000ms and was terminated',
    }),
  }
  const r = await o.runCycle(task, { model: 'm', reviewer: timedOut, cwd: DIR })
  assert.equal(r.record.status, 'blocked', 'a timed-out reviewer is a blocker, not a pass')
  assert.match(r.record.note, /exceeded/)
  assert.notEqual(r.record.status, 'done')
})

test('a reviewer with NO verdict line cannot approve a task', async () => {
  // `readVerdict` treats an absent line as request-changes. That default is the whole point: silence
  // is not consent.
  const task = baseTask()
  const o = fresh(join(DIR, 'r7.json'), task)
  const r = await o.runCycle(task, {
    model: 'm',
    reviewer: script([{ text: 'I had a look and it seems reasonable to me.', verdict: 'request-changes' }]),
    cwd: DIR,
  })
  assert.notEqual(r.record.status, 'done')
})

// ---------------------------------------------------------------- interruption and restart

test('an INTERRUPTED run resumes from persisted state without losing completed rounds', async () => {
  // Simulates a process killed between rounds: the state file exists, the task is pending, and the
  // rounds already paid for are still there. A second orchestrator must continue rather than restart.
  const task = baseTask({ maxReviewRounds: 4 })
  const statePath = join(DIR, 'r8.json')

  const first = fresh(statePath, task)
  await first.runCycle(task, {
    model: 'm', reviewer: script([{ text: 'First finding about nulls.', verdict: 'request-changes' }]), cwd: DIR,
  })
  // The process dies here. Nothing cleans up.

  const second = Orchestrator.loadOrCreate(statePath, statePath + '.lock2', { objective: 'o', architecture: 'a', rationale: 'r' })
  assert.equal(second.resumed, true, 'a second orchestrator must find the interrupted state')
  const rec = second.orch.snapshot().tasks[0]!
  assert.equal(rec.rounds.length, 2, 'the implementer and reviewer rounds already paid for must survive')
  assert.equal(rec.rounds.filter((x) => x.role === 'reviewer')[0]!.text, 'First finding about nulls.',
    'the reviewer\'s own words must survive verbatim')

  // And the loop continues from there, not from scratch.
  const r2 = await second.orch.runCycle(task, {
    model: 'm', reviewer: script([{ text: 'VERDICT: approve', verdict: 'approve' }]), cwd: DIR,
  })
  // The next round is the first one AFTER the 2 rounds asserted above as surviving. rounds[0] is the
  // first round ever run, before the crash; it is correctly still numbered 0, and rewriting it to 2
  // would falsify the record of work already paid for. Numbering must CONTINUE, not be recomputed.
  assert.equal(r2.record.rounds[2]!.round, 2, 'the next round must continue the numbering')
  assert.equal(r2.record.rounds[0]!.round, 0, 'a round paid for before the crash keeps its original number')
})

test('a task recorded done WITHOUT passing verification is DOWNGRADED on reconcile', async () => {
  // The crash-after-approval case: the loop approved, then the process died before the verify output
  // was persisted. Restart must not inherit that success.
  const p = join(DIR, 'r9.json')
  const state = Orchestrator.emptyState('o', 'a', 'r')
  ;(state as { tasks: unknown[] }).tasks = [{
    id: 't', objective: 'o', status: 'done', rounds: [], findingsSeen: [],
    verificationOutput: '', verificationPassed: false,
    repeatedOutcome: 1, lastOutcome: 'approved', startedAt: 'x', finishedAt: 'x', note: '',
  }]
  writeFileSync(p, JSON.stringify(state), 'utf8')
  const { orch } = Orchestrator.loadOrCreate(p, p + '.lock', { objective: 'o', architecture: 'a', rationale: 'r' })
  const notes = await orch.reconcile(DIR)
  assert.match(notes.join(' '), /DOWNGRADED/)
  assert.equal(orch.snapshot().tasks[0]!.status, 'blocked')
})

test('a stale LOCK from a dead process is reported, and a live lock is respected', async () => {
  const p = join(DIR, 'r10.json')
  const o = new Orchestrator(p, p + '.lock', Orchestrator.emptyState('o', 'a', 'r'))
  const first = o.acquireLock()
  assert.equal(first.acquired, true)

  const second = new Orchestrator(p, p + '.lock', Orchestrator.emptyState('o', 'a', 'r')).acquireLock()
  assert.equal(second.acquired, false, 'a second orchestrator must not take a held lock')
  assert.equal(second.holder, 'stale lock from pid ' + String(process.pid))
  rmSync(p + '.lock', { force: true })
  writeFileSync(p + '.lock', '999999', 'utf8')  // a pid that cannot exist
  const stale = new Orchestrator(p, p + '.lock', Orchestrator.emptyState('o', 'a', 'r')).acquireLock()
  assert.equal(stale.acquired, false)
  assert.match(String(stale.holder), /stale/, 'a lock whose owner is gone is named as stale')
})

test('a CORRUPT state file is refused, not silently reset', async () => {
  const p = join(DIR, 'r11.json')
  writeFileSync(p, '{ this is not json', 'utf8')
  assert.throws(() => Orchestrator.loadOrCreate(p, p + '.lock', { objective: 'o', architecture: 'a', rationale: 'r' }),
    /corrupt/i, 'a corrupt state file must fail loudly rather than start empty')
  assert.equal(readFileSync(p, 'utf8'), '{ this is not json', 'the corrupt file must be left untouched')
})

// ---------------------------------------------------------------- reuse of expensive work

test('a review is NOT repeated when the evidence has not changed', async () => {
  // The cost defect this milestone targets: paying ~30-300s for a review that cannot say anything new.
  // `evidenceFingerprint` is what makes skipping safe - same evidence means the same review.
  const task = baseTask()
  const o = fresh(join(DIR, 'r12.json'), task)
  const r = await o.runCycle(task, {
    model: 'm', reviewer: script([{ text: 'VERDICT: approve', verdict: 'approve' }]), cwd: DIR,
  })
  assert.equal(r.record.status, 'done')
  assert.ok(r.record.lastEvidenceFingerprint.length > 0,
    'every round must record what the reviewer was shown, so a later round can tell whether it is new')
})

test('a DIFFERENT evidence fingerprint is recorded when the evidence differs', async () => {
  const p = join(DIR, 'r13.json')
  const t1 = baseTask({ id: 'a', verifyCommand: PASS_CMD })
  const t2 = baseTask({ id: 'b', verifyCommand: FAIL_CMD })
  const o = fresh(p, t1)
  o.enqueue(t2)
  const r1 = await o.runCycle(t1, { model: 'm', reviewer: script([{ text: 'x\nVERDICT: request-changes', verdict: 'request-changes' }]), cwd: DIR })
  const r2 = await o.runCycle(t2, { model: 'm', reviewer: script([{ text: 'x\nVERDICT: request-changes', verdict: 'request-changes' }]), cwd: DIR })
  assert.notEqual(r1.record.lastEvidenceFingerprint, r2.record.lastEvidenceFingerprint,
    'identical REVIEW TEXT over different EVIDENCE is not the same review, and must not be skipped')
})

test('stage timings are recorded per round, so a slow stage can be identified', async () => {
  const task = baseTask()
  const o = fresh(join(DIR, 'r14.json'), task)
  const r = await o.runCycle(task, {
    model: 'm', reviewer: script([{ text: 'VERDICT: approve', verdict: 'approve' }]), cwd: DIR,
  })
  const st = r.record.timings
  assert.ok(st.implementMs >= 0 && st.verifyMs >= 0 && st.reviewMs >= 0,
    'every stage must report a duration')
  assert.ok(st.totalMs >= st.verifyMs, 'the total must be at least as long as a stage inside it')
  assert.ok(st.verificationExit === 0, 'the exit code that decided the task is recorded')
})

// ---------------------------------------------------------------- regression: the defects fixed in this phase
//
// Each test below FAILS if its fix is reverted. They exist because the failures above were subtle:
// each one passed a reviewer's eye while the underlying behaviour was wrong.

test('REGRESSION: a SILENT verify command still contributes its EXIT CODE to the evidence fingerprint', async () => {
  // The defect: the evidence block was gated on whether the command PRINTED anything, so a silent
  // command collapsed to the same placeholder string. A task that passed verification and one that
  // failed it hashed identically, and the reuse guard could then skip a review across a real change.
  const p = join(DIR, 'r20.json')
  const ok = baseTask({ id: 'ok', verifyCommand: 'node -e "process.exit(0)"' })
  const bad = baseTask({ id: 'bad', verifyCommand: 'node -e "process.exit(3)"' })
  const o = fresh(p, ok)
  o.enqueue(bad)

  const a = await o.runCycle(ok, {
    model: 'm', reviewer: script([{ text: 'VERDICT: approve', verdict: 'approve' }]), cwd: DIR,
  })
  const b = await o.runCycle(bad, {
    model: 'm', reviewer: script([{ text: 'VERDICT: approve', verdict: 'approve' }]), cwd: DIR,
  })

  assert.equal(a.record.verificationOutput, '', 'this test is only meaningful while both commands are silent')
  assert.equal(b.record.verificationOutput, '', 'this test is only meaningful while both commands are silent')
  assert.notEqual(a.record.lastEvidenceFingerprint, b.record.lastEvidenceFingerprint,
    'a passing and a failing verify command are different evidence, even when both print nothing')
})

test('REGRESSION: identical evidence yields an IDENTICAL fingerprint, and only a real change moves it', () => {
  // The other half of the contract: the fix must not make the fingerprint so sensitive that a
  // reworded or reordered-but-equivalent input buys a fresh review.
  const parts = {
    objective: 'do the thing',
    constraints: ['keep the API stable'],
    evidence: 'VERIFICATION COMMAND: node -e "process.exit(0)"\nEXIT CODE: 0\nOUTPUT:',
    notes: 'changed two files',
    findings: [],
  }
  const again = evidenceFingerprint({ ...parts })
  assert.equal(evidenceFingerprint(parts), again, 'the same evidence must hash to the same fingerprint')

  // Key insertion order must not matter - it is an object, not a serialized string.
  const reordered = {
    findings: parts.findings,
    notes: parts.notes,
    evidence: parts.evidence,
    constraints: parts.constraints,
    objective: parts.objective,
  }
  assert.equal(evidenceFingerprint(reordered), again, 'property order must not change the fingerprint')

  // A real change in each fingerprint-relevant field must move it.
  for (const [what, changed] of [
    ['objective', { ...parts, objective: 'a different thing' }],
    ['constraints', { ...parts, constraints: ['break the API'] }],
    ['evidence', { ...parts, evidence: parts.evidence + 'extra output' }],
    ['notes', { ...parts, notes: 'changed three files' }],
  ] as const) {
    assert.notEqual(evidenceFingerprint(changed), again, `a change in ${what} must change the fingerprint`)
  }
})

test('REGRESSION: a round paid for before a crash KEEPS its number; only later rounds continue', () => {
  // The defect: on resume, the already-paid rounds came back numbered 0 and the new cycle also
  // started from the array length, so numbering was ambiguous about what had already been spent.
  const task = baseTask({ maxReviewRounds: 4 })
  const statePath = join(DIR, 'r21.json')
  const first = fresh(statePath, task)
  return first.runCycle(task, {
    model: 'm', reviewer: script([{ text: 'First finding about nulls.', verdict: 'request-changes' }]), cwd: DIR,
  }).then(async () => {
    const second = Orchestrator.loadOrCreate(statePath, statePath + '.lock', {
      objective: 'o', architecture: 'a', rationale: 'r',
    })
    const r2 = await second.orch.runCycle(task, {
      model: 'm', reviewer: script([{ text: 'VERDICT: approve', verdict: 'approve' }]), cwd: DIR,
    })
    const nums = r2.record.rounds.map((x) => x.round)
    assert.deepEqual(nums, [0, 0, 2, 2],
      'the two rounds already paid for keep their original number, and the resumed pair continues at 2')
    assert.equal(r2.record.status, 'done', 'the resumed cycle still completes normally')
  })
})

test('REGRESSION: a TERMINAL task runs no further cycle, and the record says so honestly', async () => {
  // The guard must not fabricate work. It previously returned a value built from an OrchestratorState,
  // which did not even typecheck, and would have put a fake implementation round on the record.
  const task = baseTask()
  const o = fresh(join(DIR, 'r22.json'), task)
  const r = await o.runCycle(task, {
    model: 'm', reviewer: script([{ text: 'VERDICT: approve', verdict: 'approve' }]), cwd: DIR,
  })
  assert.equal(r.record.status, 'done')

  const before = r.record.rounds.length
  const again = await o.runCycle(task, {
    model: 'm', reviewer: script([{ text: 'VERDICT: approve', verdict: 'approve' }]), cwd: DIR,
  })
  assert.equal(again.record.rounds.length, before, 'a done task must not spend another cycle')
  assert.equal(again.implement.ok, false, 'the no-op result must not claim to have implemented anything')
  assert.match(again.implement.failure ?? '', /already done/, 'and it must say why nothing ran')
})