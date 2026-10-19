/**
 * MUTATION TEST for the objective rule.
 *
 * A test that cannot be shown to fail when its protection is removed is decoration. Each mutation
 * below is a REAL, plausible regression - not a sabotage nobody would ever write - applied to the
 * shipped evaluator, and the suite is re-run to confirm the objective tests go red.
 *
 * Everything is restored afterwards and the suite is re-run to confirm green, so the run leaves the
 * tree exactly as it found it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const STATE = 'packages/mission-engine/state.ts'
const ORIGINAL = readFileSync(STATE, 'utf8')

/** Each mutation reverts ONE protection to the behaviour that existed before M-c. */
const MUTATIONS = [
  {
    name: 'M1  fail-open on an absent declaration (unproven treated as success)',
    find: "  if (postconditions === undefined) {\n    return {\n      kind: 'unproven',",
    replace: "  if (postconditions === undefined) {\n    return {\n      kind: 'satisfied', proved: [],",
  },
  {
    name: 'M2  an empty declaration list counts as satisfied',
    find: "      kind: 'unproven',\n      reason: 'the plan declared zero objective postconditions",
    replace: "      kind: 'satisfied', proved: [], /*x*/\n      reason: 'the plan declared zero objective postconditions",
  },
  {
    name: 'M3  a postcondition with no evidence is treated as proved',
    find: "  if (failed.length > 0) {\n    return {\n      kind: 'unmet',",
    replace: "  if (failed.length > 0) {\n    return {\n      kind: 'satisfied', proved: postconditions.map((p) => p.kind), /*x*/",
  },
  {
    name: 'M4  the step record is treated as the objective (the original defect)',
    find: "        proved = all.some((e) =>\n          (e.kind === 'file-exists' || e.kind === 'file-written' || e.kind === 'file-read-back')\n          && samePath(e.path, pc.path))\n        break\n      case 'artifact-read-back':",
    replace: "        proved = all.length > 0\n        break\n      case 'artifact-read-back':",
  },
  {
    name: 'M5  an un-hashed read-back satisfies a content postcondition',
    find: "          && samePath(e.path, pc.path) && typeof e.sha256 === 'string' && e.sha256 === pc.sha256)",
    replace: "          && samePath(e.path, pc.path) && typeof e.sha256 === 'undefined')",
  },
  {
    name: 'M6  contradictory evidence is not detected',
    find: "      return {\n        kind: 'contradicted',",
    replace: "      return {\n        kind: 'satisfied' as never, proved: [], /*x*/",
  },
  {
    name: 'M7  command corroboration is no longer required (self-witness allowed)',
    find: "          && typeof e.corroboratedBy === 'string' && e.corroboratedBy.length > 0)",
    replace: "          )",
  },
  {
    name: 'M8  success is reported from the step record alone',
    find: "  return isComplete(m) && verdictPermitsSuccess(objectiveVerdict(m.objectivePostconditions, evidence))",
    replace: "  return isComplete(m)",
  },
]

const CMD = ['--experimental-strip-types', '--no-warnings', '--test', 'packages/mission-engine/test/objective.test.ts']

function run() {
  const r = spawnSync('node', CMD, { encoding: 'utf8' })
  const out = r.stdout || ''
  const t = /^# tests (\d+)$/m.exec(out) ?? /tests (\d+)/.exec(out)
  const f = /^# fail (\d+)$/m.exec(out) ?? /fail (\d+)/.exec(out)
  return { code: r.status, tests: t ? t[1] : '?', fail: f ? f[1] : '?' }
}

const baseline = run()
console.log('BASELINE (unmutated): tests=%s fail=%s exit=%d\n', baseline.tests, baseline.fail, baseline.code)

let allBit = true
for (const m of MUTATIONS) {
  if (!ORIGINAL.includes(m.find)) {
    console.log(`${m.name.padEnd(66)}  ANCHOR NOT FOUND - mutation not applied`)
    allBit = false
    continue
  }
  const mutated = ORIGINAL.replace(m.find, m.replace)
  if (mutated === ORIGINAL) {
    console.log(`${m.name.padEnd(66)}  NO-OP MUTATION`)
    allBit = false
    continue
  }
  writeFileSync(STATE, mutated, 'utf8')
  const r = run()
  const bit = Number(r.fail) > 0
  if (!bit) allBit = false
  console.log(`${m.name.padEnd(66)}  tests=${r.tests} fail=${r.fail} exit=${r.code}  ${bit ? 'BIT' : 'DID NOT BIT'}`)
  writeFileSync(STATE, ORIGINAL, 'utf8')
}

const restored = run()
console.log('\nRESTORED: tests=%s fail=%s exit=%d', restored.tests, restored.fail, restored.code)
console.log(allBit && restored.code === 0 && Number(restored.fail) === 0
  ? '\nRESULT: every negative control BIT, and the tree is green again.'
  : '\nRESULT: AT LEAST ONE CONTROL DID NOT BIT - see above.')
