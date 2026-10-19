/**
 * A GOAL THAT NAMES A PLACE IS NOT MET BY A FILE SOMEWHERE ELSE
 * =============================================================
 *
 * THE DEFECT, AS OBSERVED
 * -----------------------
 * A mission was asked to create "AIOS-Desktop-Mission-Report.txt in my Documents folder". It
 * reported:
 *
 *     Done - 5 step(s), every step and the objective were independently verified.
 *     goal satisfied
 *
 * And there is no such file in Documents. Checking the machine directly:
 *
 *     >>> DOES NOT EXIST at C:\Users\Samer\Documents\AIOS-Desktop-Mission-Report.txt
 *     C:\Users\Samer\.aios\agent\out\AIOS-Desktop-Mission-Report.txt    1842 bytes
 *
 * Every step DID verify. Every verifier was honest about what it checked. The report was correct,
 * complete and readable. What went wrong is one decision, made long before execution:
 *
 *     the objective postcondition was derived from the path the SYSTEM substituted
 *
 * so it could only ever prove "a file exists where we chose to put it" - which is a claim about
 * the steps, not about the goal. The person asked for a file in Documents and received a success
 * for a file that does not exist there, with nothing anywhere saying where it went.
 *
 * WHY SUBSTITUTION IS NOT ALWAYS WRONG
 * -----------------------------------
 * Most plans name no destination, or name one the MODEL invented: a temp folder, an
 * opencode output path, something that was never going to be writable. Putting those somewhere
 * writable is a repair, and repairing them quietly is correct - nobody asked for that path.
 *
 * The case here is different in one respect and only one: the PERSON named the place. "In my
 * Documents folder" is part of the goal. A file anywhere else does not satisfy it, so the mission
 * has to say so rather than report a success it did not earn.
 *
 * These tests therefore pin BOTH halves: substitution of a model-invented path stays quiet, and
 * substitution of a person-named path fails the mission and names both paths.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const AGENT = pathToFileURL(join(HERE, '..', 'live', 'agent', 'agent.ts')).href
const CAPS = pathToFileURL(join(HERE, '..', 'live', 'agent', 'capabilities.ts')).href

const loadAgent = () => import(AGENT)
const loadCaps = () => import(CAPS)

const REQUESTED = 'C:\\Users\\Samer\\Documents\\AIOS-Desktop-Mission-Report.txt'

test('a person-named destination that was substituted is RECORDED, not silently accepted', async () => {
  const { validatePlan } = await loadAgent()
  const { AGENT_OUT } = await loadCaps()

  const v = validatePlan({
    reply: '',
    model: 'test',
    steps: [{
      id: 's3',
      intent: 'Create the report',
      tool: 'write-file',
      args: { path: REQUESTED, content: 'a report' },
    }],
  }, 'create AIOS-Desktop-Mission-Report.txt in my Documents folder')

  assert.equal(v.substitutions.length, 1, 'the substitution must be visible to the caller')
  assert.equal(v.substitutions[0].requested, REQUESTED, 'the REQUESTED path is kept verbatim')
  assert.equal(v.substitutions[0].written, join(AGENT_OUT, 'AIOS-Desktop-Mission-Report.txt'),
    'and the path actually written is recorded beside it')
  // And it is on the step, so anything downstream can see it without re-deriving.
  const step = v.steps.find((s: { id: string }) => s.id === 's3')
  assert.equal(String(step?.args.requestedPath ?? ''), REQUESTED)
})

test('a model-invented destination is repaired WITHOUT a substitution being recorded', async () => {
  // The other half, and it matters as much. A model that invents a temp folder is being corrected,
  // not contradicted: nobody asked for that path, so announcing a failure would be noise that
  // trains people to ignore the message.
  const { validatePlan } = await loadAgent()
  const { AGENT_OUT } = await loadCaps()

  const v = validatePlan({
    reply: '',
    model: 'test',
    steps: [{
      id: 's3',
      intent: 'Write the notes',
      tool: 'write-file',
      args: { path: 'C:\\Users\\Samer\\AppData\\Local\\Temp\\aios-planner-x\\notes.txt', content: 'x' },
    }],
  }, 'write some notes')

  assert.equal(v.substitutions.length, 0,
    'a model-invented path is a repair, and repairs are not failures')
  assert.equal(String(v.steps[0]?.args.path ?? ''), join(AGENT_OUT, 'notes.txt'))
})

test('the write still happened, and is still real - the file is not simply refused', async () => {
  // The point of the fix is honesty, not obstruction. Refusing to write would have been the easy
  // version and the wrong one: the person gets nothing, and the report they needed is lost.
  const { validatePlan } = await loadAgent()
  const { resolveCapability, AGENT_OUT } = await loadCaps()

  const v = validatePlan({
    reply: '',
    model: 'test',
    steps: [{
      id: 's3',
      intent: 'Create the report',
      tool: 'write-file',
      args: { path: REQUESTED, content: 'AIOS Desktop Mission Report\n\nVerified content.\n' },
    }],
  }, 'create AIOS-Desktop-Mission-Report.txt in my Documents folder')

  const written = String(v.steps[0]?.args.path ?? '')
  const cap = resolveCapability('write-file')
  assert.ok(cap, 'write-file must resolve')
  const r = await cap.tool.run({}, { path: written, content: 'AIOS Desktop Mission Report\n\nVerified content.\n' })

  try {
    assert.notEqual(r.kind, 'failed', 'the file must actually be written')
    assert.ok(existsSync(written), `the file must exist at ${written}`)
    assert.match(readFileSync(written, 'utf8'), /Verified content/)
    assert.ok(!existsSync(REQUESTED),
      'and it must NOT appear at the requested path, because Zeus cannot write there')
  } finally {
    rmSync(written, { force: true })
    void AGENT_OUT
  }
})

test('a substitution is announced in the notes, not only in the record', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({
    reply: '',
    model: 'test',
    steps: [{
      id: 's3',
      intent: 'Create the report',
      tool: 'write-file',
      args: { path: REQUESTED, content: 'x' },
    }],
  }, 'create the report in my Documents folder')

  assert.ok(v.inferred.some((i: string) => /Documents/.test(i) && /output/i.test(i)),
    'the transcript must say where it went and where it was asked to go')
})

test('THE EXACT SHAPE THAT PRODUCED THE FALSE SUCCESS IS NOW A FAILURE', async () => {
  // Reproduced end to end: plan the mission the way the model did, execute every step for real,
  // and require that the mission is NOT reported as satisfied.
  //
  // This is the assertion that would have failed before the fix. Before it, every step verified,
  // the objective postcondition matched the substituted path, and the mission reported success
  // with a file that was not where the person asked for it.
  const { validatePlan, toMissionForTest } = await loadAgent()
  const { resolveCapability, AGENT_OUT } = await loadCaps()

  const content = 'AIOS Desktop Mission Report\n\nThree factual points.\n'
  const v = validatePlan({
    reply: '',
    model: 'test',
    steps: [
      { id: 's3', intent: 'Create the report', tool: 'write-file', args: { path: REQUESTED, content } },
      { id: 's4', intent: 'Read it back', tool: 'read-file', args: { path: REQUESTED } },
    ],
  }, 'create AIOS-Desktop-Mission-Report.txt in my Documents folder and verify it')

  assert.equal(v.substitutions.length, 1, 'the destination was substituted')
  assert.equal(v.refusals.length, 0, 'and nothing was refused - the work was done, elsewhere')

  // Every step runs for real and every verifier passes. That is the point: the steps were never
  // the problem. The claim was.
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
  void AGENT_OUT

  try { rmSync(written, { force: true }) } catch { /* the test file is disposable */ }
})