/**
 * A PERSON-NAMED DESTINATION IS NOT A RECOVERY, IT IS A FAILURE
 * ============================================================
 *
 * THE SHAPE
 * ---------
 * Asked for "AIOS-Desktop-Mission-Report.txt in my Documents folder", a mission reported
 * "goal satisfied" - and there was no such file in Documents. Every step had verified. The
 * objective postcondition had been derived from the path the SYSTEM substituted, so it could only
 * ever prove "a file exists where we chose to put it": a claim about the steps, not the goal.
 *
 * The file arrived at `~\.aios\agent\out\`, and nothing anywhere said so.
 *
 * WHY IT IS NOT ALWAYS A FAILURE
 * ------------------------------
 * Most plans name no destination, or name one the MODEL invented - a temp folder, an opencode
 * output path, something that was never going to be writable. Putting those somewhere writable is
 * a repair, and repairing them quietly is CORRECT. Nobody asked for that path, so announcing a
 * failure would train people to ignore the message.
 *
 * The distinction is WHO named the place. `inferReadPath` only finds a path written out in full
 * and `inferGoalFilename` only finds a name with an extension, so between them they miss the most
 * ordinary phrasing there is: "create the report in my Documents folder" contains neither.
 * `inferGoalFolder` reads the folder out of the PROSE, and that is what makes this case a failure
 * rather than a quiet repair.
 *
 * These tests pin the whole chain: the substitution is RECORDED, the work still HAPPENS, the
 * transcript NAMES BOTH PATHS, and - the part that actually stops the false success - the `ok`
 * gate refuses to report satisfaction while one is outstanding.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const AGENT = pathToFileURL(join(HERE, '..', 'live', 'agent', 'agent.ts')).href
const CAPS = pathToFileURL(join(HERE, '..', 'live', 'agent', 'capabilities.ts')).href

const loadAgent = () => import(AGENT)
const loadCaps = () => import(CAPS)

const REQUESTED = 'C:\\Users\\Samer\\Documents\\AIOS-Desktop-Mission-Report.txt'

// ============================================================================================
// THE PROSE PHRASE IS THE ONE THAT MATTERS
// ============================================================================================

test('a destination named in PROSE is recognised as person-named', async () => {
  // No drive letter, no filename with an extension. Just how people speak.
  const { inferGoalFolder } = await import(CAPS)
  assert.equal(inferGoalFolder('create the report in my Documents folder'),
    'C:\\Users\\Samer\\Documents')
  assert.equal(inferGoalFolder('save it to my documents as quarterly-summary.txt'),
    'C:\\Users\\Samer\\Documents')
})

test('a model-invented path with no folder named is NOT person-named', async () => {
  const { inferGoalFolder } = await import(CAPS)
  assert.equal(inferGoalFolder('write some notes'), null)
  assert.equal(inferGoalFolder('open a browser on my screen'), null)
})

// ============================================================================================
// VALIDATE PLAN: RECORDED, ANNOUNCED, STILL DONE
// ============================================================================================

test('a person-named destination in prose is RECORDED as a substitution', async () => {
  const { validatePlan } = await loadAgent()
  const { AGENT_OUT } = await loadCaps()

  const v = validatePlan({
    reply: '', model: 'test',
    steps: [{ id: 's3', intent: 'Create the report', tool: 'write-file', args: { path: REQUESTED, content: 'x' } }],
  }, 'create the report in my Documents folder')

  assert.equal(v.substitutions.length, 1,
    'the prose destination must be seen, not repaired quietly')
  assert.equal(v.substitutions[0].requested, REQUESTED, 'the REQUESTED path is kept verbatim')
  // The FILENAME the plan chose is kept; only the folder changes. Only the folder is ours, the name
  // is theirs.
  //
  // This was NOT always so, and the correction matters. An earlier revision fell back to
  // `${stepId}.txt` whenever the goal named a FOLDER but no filename, so the deliverable was
  // silently renamed to "s3.txt". Two things broke: the person asked for a report and got a file
  // called something else, and the read-back - which reconciles on filename - no longer matched
  // the write, so it kept pointing at the refused destination and verified a 0-byte stub there.
  // This test recorded that rename as expected behaviour, so the fault passed as a green test until
  // a real mission exposed it. The expectation is corrected, not the code.
  assert.match(v.substitutions[0].written, /^C:\\Users\\Samer\\\.aios\\agent\\out\\/,
    'the file lands inside the agent output directory')
  assert.equal(v.substitutions[0].written, join(AGENT_OUT, 'AIOS-Desktop-Mission-Report.txt'),
    'the deliverable keeps the name the plan gave it - only the folder is supplied')
  assert.ok(String(v.steps[0]?.args.path ?? '').startsWith(AGENT_OUT),
    'and the step carries the writable path, not the requested one')
  assert.equal(String(v.steps[0]?.args.requestedPath ?? ''), REQUESTED,
    'while requestedPath carries what was asked for, so nothing downstream has to re-derive it')
})

test('a model-invented destination is repaired WITHOUT a substitution', async () => {
  const { validatePlan } = await loadAgent()
  const { AGENT_OUT } = await loadCaps()

  const v = validatePlan({
    reply: '', model: 'test',
    steps: [{ id: 's3', intent: 'Write the notes', tool: 'write-file', args: { path: 'C:\\Users\\Samer\\AppData\\Local\\Temp\\aios-planner-x\\notes.txt', content: 'x' } }],
  }, 'write some notes')

  assert.equal(v.substitutions.length, 0,
    'a model-invented path is a repair, and repairs are not failures')
  assert.equal(String(v.steps[0]?.args.path ?? ''), join(AGENT_OUT, 'notes.txt'))
})

test('the transcript names BOTH paths', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [{ id: 's3', intent: 'Create the report', tool: 'write-file', args: { path: REQUESTED, content: 'x' } }],
  }, 'create the report in my Documents folder')

  assert.ok(v.inferred.some((i: string) => /Documents/.test(i)),
    'the note must name where it was asked to go')
  assert.ok(v.inferred.some((i: string) => /output/i.test(i)),
    'and where it went instead')
})

test('the work is NOT refused - the file is really written', async () => {
  // Obstruction would have been the easy fix and the wrong one. The person asked for a report;
  // they should get the report, plus an honest statement of where it is.
  const { validatePlan } = await loadAgent()
  const { resolveCapability } = await loadCaps()

  const v = validatePlan({
    reply: '', model: 'test',
    steps: [{ id: 's3', intent: 'Create the report', tool: 'write-file', args: { path: REQUESTED, content: 'AIOS Desktop Mission Report\n\nVerified content.\n' } }],
  }, 'create the report in my Documents folder')

  assert.equal(v.refusals.length, 0, 'nothing is refused - the work is done, elsewhere')
  const written = String(v.steps[0]?.args.path ?? '')
  const cap = resolveCapability('write-file')
  assert.ok(cap, 'write-file must resolve')
  const r = await cap.tool.run({}, { path: written, content: 'AIOS Desktop Mission Report\n\nVerified content.\n' })
  try {
    assert.notEqual(r.kind, 'failed', 'the file must actually be written')
    assert.ok(existsSync(written), `the file must exist at ${written}`)
    assert.match(readFileSync(written, 'utf8'), /Verified content/)
    assert.ok(!existsSync(REQUESTED), 'and it must NOT appear where the person asked, because Zeus cannot write there')
  } finally {
    rmSync(written, { force: true })
  }
})

// ============================================================================================
// THE GATE: THIS IS THE PART THAT STOPS THE FALSE SUCCESS
// ============================================================================================

test('THE EXACT SHAPE THAT PRODUCED THE FALSE SUCCESS IS NOW A FAILURE', async () => {
  const { validatePlan, toMissionForTest } = await loadAgent()
  const { resolveCapability } = await loadCaps()

  const content = 'AIOS Desktop Mission Report\n\nThree factual points.\n'
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [
      { id: 's3', intent: 'Create the report', tool: 'write-file', args: { path: REQUESTED, content } },
      { id: 's4', intent: 'Read it back', tool: 'read-file', args: { path: REQUESTED } },
    ],
  }, 'create AIOS-Desktop-Mission-Report.txt in my Documents folder and verify it')

  assert.equal(v.substitutions.length, 1, 'the destination was substituted')
  assert.equal(v.refusals.length, 0, 'and nothing was refused - the work was done, elsewhere')

  // Every step runs for real and every verifier passes. That is the point: the steps were never
  // the problem. The CLAIM was.
  const written = String(v.steps[0]?.args.path ?? '')
  const write = resolveCapability('write-file')
  const rr = await write.tool.run({}, { path: written, content })
  assert.equal(rr.kind, 'data')

  const read = resolveCapability('read-file')
  const readStep = { id: 's4', intent: 'read back', tool: 'read-file', args: { path: written } }
  const evidence = await read.verifier.verify(readStep as never, {} as never, (rr as { data: unknown }).data)
  assert.ok(!('rejected' in evidence), 'the read-back verifies, because the file really is there')

  // The mission's objective is declared against the path the SYSTEM chose...
  const mission = toMissionForTest('mission-under-test', 'create the report in Documents', v.steps)
  const pcs = (mission as unknown as { objectivePostconditions?: Array<{ kind: string; path?: string }> })
    .objectivePostconditions ?? []
  assert.ok(pcs.some((p) => p.path === written),
    'the postcondition still proves the file exists - it is a true claim')

  // ...which is exactly why the substitution, and not the postcondition, is what fails the mission.
  const substitutions = v.substitutions.filter((x: { requested: string; written: string }) => x.requested.toLowerCase() !== x.written.toLowerCase())
  assert.ok(substitutions.length > 0,
    'and the mission cannot be reported satisfied while a person-named destination was not honoured')
  assert.notEqual(written.toLowerCase(), REQUESTED.toLowerCase())

  try { rmSync(written, { force: true }) } catch { /* the test file is disposable */ }
})

test('THE OK GATE ARITHMETIC: a substitution alone defeats ok=true', async () => {
  // The gate is one expression inside runGoal. Evaluated here directly, because "it is correct in
  // isolation" is not the same as "it is the expression the loop actually uses".
  const { validatePlan } = await loadAgent()
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [{ id: 's3', intent: 'Create the report', tool: 'write-file', args: { path: REQUESTED, content: 'x' } }],
  }, 'create the report in my Documents folder')

  const allStepsVerified = true
  const complete = true
  const placeholderFound = false
  const destinationNotHonoured = v.substitutions.filter((x) => x.requested.toLowerCase() !== x.written.toLowerCase())
  const ok = allStepsVerified && complete && !placeholderFound && destinationNotHonoured.length === 0

  assert.equal(ok, false,
    'every step verified and the executor called the objective complete, and it must STILL be false')
  assert.equal(destinationNotHonoured.length, 1)
})

test('the gate is reachable in the real loop, not only in the expression above', async () => {
  // Reads the shipped source. A gate that is computed somewhere and never consulted is the exact
  // shape of the original false success: a correct calculation, absent from the decision.
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(fileURLToPath(new URL('../live/agent/agent.ts', import.meta.url)), 'utf8')
  assert.match(src, /const ok = allStepsVerified && complete && !placeholderFound && destinationNotHonoured\.length === 0/,
    'runGoal must compute ok with the destination term included')
  assert.match(src, /destinationNotHonoured = validated\.substitutions\.filter\(/,
    'and must populate it from validation')
  assert.match(src, /destinationNotHonoured\.length > 0/,
    'and must have a report branch for it, so the user is told rather than shown a bare false')
})