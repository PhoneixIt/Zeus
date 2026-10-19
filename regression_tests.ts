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