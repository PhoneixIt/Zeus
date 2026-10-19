/**
 * The destination a goal names is the DELIVERABLE, not every file a plan writes.
 *
 * Regression test for mission 2a1995ef-dd4f-44d4-ae61-5e0cf4b7ac4a, 2026-10-19.
 *
 * THE FAILURE. Goal: "Open the NAKIVO folder visibly in File Explorer, scan all files inside it
 * recursively, and save a CSV inventory ... to C:\Users\Samer\.aios\agent\out\nakivo-scan.csv. Then
 * read that CSV back and verify it."
 *
 * Attempt 2 produced a correct four-step plan:
 *
 *   a2-s1  launch-app   open a visible File Explorer window
 *   a2-s2  write-file   write the scanner script
 *   a2-s3  terminal     run the scanner
 *   a2-s4  read-file    read the CSV back
 *
 * The goal names exactly ONE destination. Validation applied it to EVERY producing step, so
 * a2-s2's path was rewritten from `scan_nakivo.py` to `nakivo-scan.csv`. a2-s3 then ran
 * `python ...\out\scan_nakivo.py` and got `No such file or directory`, and the mission failed.
 *
 * The residue was the real damage: `nakivo-scan.csv` - the file the person asked for - was left
 * holding PYTHON SOURCE rather than an inventory. The objective verdict correctly refused to call
 * that success. Refusing is right, and it is not a repair: the wrong bytes were still sitting at
 * the requested path.
 *
 * THE INVARIANT. When another step in the same plan refers to a producing step's own filename,
 * that filename is load-bearing and must not be replaced. The goal's destination may still be
 * applied to a producing step that nothing else depends on, which is the case the original rule
 * existed for.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'live', 'agent', 'agent.ts')
const src = readFileSync(SRC, 'utf8')

test('a producing step keeps its own filename when another step refers to it', () => {
  assert.match(
    src,
    /usedByAnotherStep/,
    'validation must check whether a producing step\'s own filename is used elsewhere in the plan.',
  )
  assert.match(
    src,
    /other\.id\s*!==\s*s\.id/,
    'the check must exclude the step itself - a step always mentions its own path.',
  )
  assert.match(
    src,
    /goalPathUsable\s*&&\s*usedByAnotherStep/,
    'the goal\'s destination must NOT be imposed when the plan depends on the original filename.',
  )
})

test('the goal destination is still applied to a producing step nothing else depends on', () => {
  // The rule this replaces existed for a real failure: a model wrote its deliverable to
  // `C:\Users\Samer\AppData\Local\opencode\output\data-protection-companies.csv`, which is outside
  // every writable folder, and the mission died on a detail the user had no opinion about.
  // Guarding the substitution must not remove it.
  assert.match(
    src,
    /\}\s*else if\s*\(goalPathUsable\)\s*\{[\s\S]{0,200}?args\.path\s*=\s*fromGoal/,
    'when nothing else in the plan uses the step\'s filename, the goal\'s destination still wins.',
  )
})

test('the substitution is announced rather than done silently', () => {
  assert.match(
    src,
    /kept the plan's own/,
    'keeping the plan\'s filename must be reported in the inferred list, so a reader of the '
    + 'transcript can see why the goal\'s destination was not used on this step.',
  )
})

test('confinement is unaffected: only the goal-imposed substitution is guarded', () => {
  // The branches that keep the MODEL's filename and merely relocate it into the output directory
  // must be untouched, or a model-invented path outside every allowlisted folder would become
  // writable again.
  assert.match(
    src,
    /if \(given\.length > 0\) args\.planRequestedPath = given/,
    'the plan\'s original path must still be recorded before any branch can move it.',
  )
  const guardAt = src.indexOf('usedByAnotherStep')
  const relocateAt = src.indexOf('const base = fromGoal ?? fromPlan')
  assert.ok(guardAt > -1 && relocateAt > guardAt,
    'the relocation branch that preserves the model\'s filename must remain after the guard, so it '
    + 'still runs when the goal named nothing usable.')
})

test('the real mission transcript is the evidence this came from', () => {
  // Guards against the fix being "simplified" back out on the grounds that the case is theoretical.
  assert.match(src, /2a1995ef/, 'the incident this rule addresses must stay named in the source.')
})