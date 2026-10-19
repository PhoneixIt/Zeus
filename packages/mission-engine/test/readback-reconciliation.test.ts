/**
 * THE CLOSING READ MUST READ WHAT THE PLAN ACTUALLY WROTE
 * ============================================================================================
 *
 * Observed end to end on this machine. A three-step plan - research, write a spreadsheet, read
 * it back - produced:
 *
 *     s2 [spreadsheet] verified=true   wrote 984 bytes
 *     s3 [read-file]   verified=false  "C:\...\Temp\aios-planner-1Hym1b\companies.csv" is outside
 *                                      the folders a mission may read
 *
 * The same file, two paths. The write was relocated into the output directory because the model's
 * destination was a temp folder no mission may write to, and the read-back kept the model's
 * original temp path. So the step whose entire job is to prove the write happened was looking
 * somewhere the write never went - and its refusal then read to the user as "the file could not
 * be written", which is the opposite of what happened.
 *
 * This is worth a test because it is INVISIBLE when it goes right and very visible when it does
 * not, and because the natural fix - trusting the model's path - would re-open the write
 * confinement this repository relies on. The reconciliation below replaces one model's path
 * with the path the SAME plan already established, which widens nothing.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const AGENT = pathToFileURL(join(HERE, '..', 'live', 'agent', 'agent.ts')).href

const TEMP_PATH = 'C:\\Users\\Samer\\AppData\\Local\\Temp\\aios-planner-1Hym1b\\companies.csv'

test('a read-back follows the path the producing step actually used', async () => {
  const { validatePlan } = await import(AGENT)
  const { AGENT_OUT } = await import(pathToFileURL(join(HERE, '..', 'live', 'agent', 'capabilities.ts')).href)

  const v = validatePlan({
    reply: '',
    model: 'test',
    steps: [
      { id: 's1', intent: 'research', tool: 'web-research', args: { url: 'https://x.com', objective: 'y' } },
      { id: 's2', intent: 'write the sheet', tool: 'spreadsheet', args: { path: TEMP_PATH, headers: 'A', rows: [['r']] } },
      { id: 's3', intent: 'read it back', tool: 'read-file', args: { path: TEMP_PATH } },
    ],
  }, 'data protection companies')

  assert.equal(v.refusals.length, 0)
  const wrote = String(v.steps.find((s: { id: string }) => s.id === 's2')!.args.path)
  const read = String(v.steps.find((s: { id: string }) => s.id === 's3')!.args.path)

  assert.equal(wrote, join(AGENT_OUT, 'companies.csv'), 'the write is confined to the output folder')
  assert.equal(read, wrote, 'THE READ-BACK MUST POINT AT THE SAME FILE THE WRITE USED')
  // And the correction must be announced, not silent.
  //
  // The wording assertion was `/read-back was pointed there/`, which matched the note written by the
  // FILENAME heuristic this file used to reconcile with. The heuristic is gone - it missed real
  // pairings when the two names differed and matched unrelated pairs when they agreed - and the
  // read-back is now attached to a deliverable by id. The property this test exists for is
  // unchanged and is asserted unchanged: the correction is REPORTED, it names the step it changed,
  // and it names both the old and the new path. Only the sentence describing how the pairing was
  // decided has changed, so that is what the assertion now checks.
  assert.ok(
    v.inferred.some((i: string) => i.includes('s3') && /so it reads that file rather than/i.test(i)),
    `the path correction must be reported: ${JSON.stringify(v.inferred)}`,
  )
  assert.ok(
    v.inferred.some((i: string) => i.includes('s3') && i.includes(join(AGENT_OUT, 'companies.csv'))),
    'and the note must name the file the read-back now opens',
  )
})

test('a read-back with NO path at all reads the file the preceding step wrote', async () => {
  // Observed as well: the model emitted `read-file` with an empty `args`, and the step failed
  // with "no path was given" while the file sat in the output folder, written two positions
  // earlier by the plan's own hand. Nothing in the goal named it, so `inferReadPath` had nothing
  // to recover - and the step whose entire purpose is to prove the write existed could not.
  const { validatePlan } = await import(AGENT)
  const v = validatePlan({
    reply: '',
    model: 'test',
    steps: [
      { id: 's1', intent: 'research', tool: 'web-research', args: { url: 'https://x.com', objective: 'y' } },
      { id: 's2', intent: 'write the sheet', tool: 'spreadsheet', args: { path: 'C:\\temp\\cos.csv', headers: 'A', rows: [['r']] } },
      { id: 's3', intent: 'read it back', tool: 'read-file', args: {} },
    ],
  }, 'data protection companies')

  assert.equal(v.refusals.length, 0, `a read with no path must not be refused: ${v.refusals.join('; ')}`)
  const wrote = String(v.steps.find((s: { id: string }) => s.id === 's2')!.args.path)
  const read = String(v.steps.find((s: { id: string }) => s.id === 's3')!.args.path)
  assert.equal(read, wrote, 'a read-back with no path must read the file the plan wrote')
  assert.ok(
    v.inferred.some((i: string) => i.includes('s3') && /no path was given/i.test(i)),
    `the supplied path must be announced: ${JSON.stringify(v.inferred)}`,
  )
})

test('a read of a file this plan never wrote is left exactly as given', async () => {
  const { validatePlan } = await import(AGENT)
  const v = validatePlan({
    reply: '',
    model: 'test',
    steps: [
      { id: 's1', intent: 'write one thing', tool: 'write-file', args: { path: 'a.csv', content: 'x' } },
      { id: 's2', intent: 'read a DIFFERENT file', tool: 'read-file', args: { path: 'b.txt' } },
    ],
  }, 'do two unrelated things')
  const read = String(v.steps.find((s: { id: string }) => s.id === 's2')!.args.path)
  assert.equal(read, 'b.txt', 'a read of an unrelated file must not be redirected')
})

test('the reconciliation does not widen the write confinement', async () => {
  const { validatePlan } = await import(AGENT)
  const { AGENT_OUT, resolveReadablePath } = await import(
    pathToFileURL(join(HERE, '..', 'live', 'agent', 'capabilities.ts')).href
  )
  const v = validatePlan({
    reply: '',
    model: 'test',
    steps: [
      { id: 's1', intent: 'write', tool: 'spreadsheet', args: { path: 'C:\\Windows\\System32\\evil.csv', headers: 'A', rows: [['r']] } },
      { id: 's2', intent: 'read back', tool: 'read-file', args: { path: 'C:\\Windows\\System32\\evil.csv' } },
    ],
  }, 'a list of companies')
  const wrote = String(v.steps.find((s: { id: string }) => s.id === 's1')!.args.path)
  const read = String(v.steps.find((s: { id: string }) => s.id === 's2')!.args.path)
  // The dangerous destination is still refused; both steps land in the output folder instead.
  assert.ok(wrote.startsWith(AGENT_OUT), `write escaped: ${wrote}`)
  assert.equal(read, wrote)
  assert.ok(!resolveReadablePath(wrote).refused, 'the resulting path must be readable')
})