/**
 * MUTATION TEST for the GATING itself.
 *
 * The earlier mutation run covered the evaluator. This covers the places that decide whether the
 * evaluator is CONSULTED - the executor's record, the executor's terminal state, and the persisted
 * summary. A correct evaluator that nothing calls is not a fix.
 *
 * Restores every file afterwards and verifies byte-identity.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const MUTATIONS = [
  {
    file: 'packages/mission-engine/executor.ts',
    name: 'G1  ExecutionRecord.complete ignores the objective verdict',
    find: "    complete: isMissionSuccessful(m, verified),",
    replace: "    complete: isComplete(m),",
  },
  {
    file: 'packages/mission-engine/executor.ts',
    name: 'G2  terminal state gated on steps alone (the original defect)',
    find: "  const complete = stepsComplete && verdictPermitsSuccess(objective)",
    replace: "  const complete = stepsComplete",
  },
  {
    file: 'packages/persistence/query.ts',
    name: 'G3  persisted summary re-derives completion from steps alone',
    find: "    complete: isMissionSuccessful(m, evidenceByStep(recovered.evidence)),",
    replace: "    complete: isComplete(m),",
  },
  {
    file: 'packages/persistence/store.ts',
    name: 'G4  postconditions silently dropped on recovery',
    find: "      objectivePostconditions: h.objective_postconditions === null || h.objective_postconditions === undefined\n        ? undefined\n        : JSON.parse(String(h.objective_postconditions)),",
    replace: "      objectivePostconditions: undefined,",
  },
  {
    file: 'packages/planner/compile.ts',
    name: 'G5  postconditions not carried from proposal to mission',
    find: "    objectivePostconditions: proposal.objectivePostconditions,",
    replace: "    objectivePostconditions: undefined,",
  },
]

const CMD = ['--experimental-strip-types', '--no-warnings', '--test',
  'packages/mission-engine/test/objective.test.ts',
  'packages/mission-engine/test/executor.test.ts',
  'packages/persistence/test/executor-persistence.test.ts',
  'packages/review/test/objective-review.test.ts',
  'packages/planner/test/compile-objective.test.ts',
  'packages/persistence/test/persistence.test.ts',
  'packages/mission-engine/test/approval.test.ts']

const originals = new Map(MUTATIONS.map((m) => [m.file, readFileSync(m.file, 'utf8')]))

function run() {
  const r = spawnSync('node', CMD, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out = r.stdout || ''
  const t = /tests (\d+)/.exec(out)
  const f = /fail (\d+)/.exec(out)
  return { code: r.status, tests: t ? t[1] : '?', fail: f ? f[1] : '?' }
}

const baseline = run()
console.log(`BASELINE (unmutated): tests=${baseline.tests} fail=${baseline.fail} exit=${baseline.code}\n`)

let allBit = true
for (const m of MUTATIONS) {
  const orig = originals.get(m.file)!
  if (!orig.includes(m.find)) {
    console.log(`${m.name.padEnd(64)}  ANCHOR NOT FOUND`)
    allBit = false
    continue
  }
  writeFileSync(m.file, orig.replace(m.find, m.replace), 'utf8')
  const r = run()
  const bit = Number(r.fail) > 0
  if (!bit) allBit = false
  console.log(`${m.name.padEnd(64)}  tests=${r.tests} fail=${r.fail} exit=${r.code}  ${bit ? 'BIT' : 'DID NOT BIT'}`)
  writeFileSync(m.file, orig, 'utf8')
}

const restored = run()
console.log(`\nRESTORED: tests=${restored.tests} fail=${restored.fail} exit=${restored.code}`)
for (const [f, o] of originals) console.log(`  ${f} byte-identical: ${readFileSync(f, 'utf8') === o}`)
console.log(allBit && restored.code === 0 ? '\nRESULT: every gating control BIT.' : '\nRESULT: A CONTROL DID NOT BIT.')

