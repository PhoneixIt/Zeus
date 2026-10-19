/**
 * END-TO-END: the original defect, through the REAL planner, REAL executor and REAL verifiers.
 *
 * The empirical defect was: objective "summarise all N files in the folder into report.md",
 * every step verified, `record.complete: true`, objective not achieved.
 *
 * This asserts the same scenario is now refused - and that a genuine completion still succeeds.
 * Read-only with respect to packages/.
 */
import { execute } from './packages/mission-engine/executor.ts'
import { DeterministicPlanProvider } from './packages/planner/deterministic.ts'
import { ToolRegistry } from './packages/tool-router/router.ts'
import {
  FOLDER_TOOLS, folderVerifiers,
} from './packages/mission-engine/live/folder-tools.ts'
import { fakeControl } from './packages/mission-engine/test/fakes.ts'
import { isMissionSuccessful, objectiveVerdict } from './packages/mission-engine/state.ts'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'mc-e2e-'))
const src = join(root, 'src')
const out = join(root, 'out')
writeFileSync(join(root, 'placeholder'), '', 'utf8')
const { mkdirSync } = await import('node:fs')
mkdirSync(src, { recursive: true }); mkdirSync(out, { recursive: true })
for (const n of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) writeFileSync(join(src, n), 'x'.repeat(50 + n.length))

const byName = (n: string) => FOLDER_TOOLS.find((t) => t.name === n)!
const reg = new ToolRegistry({
  registrations: [
    { tool: byName('read-folder'), capabilities: ['filesystem.inspect'] },
    { tool: byName('inspect-folder'), capabilities: ['filesystem.list'] },
    { tool: byName('compose-summary'), capabilities: ['filesystem.transform'] },
    { tool: byName('write-report'), capabilities: ['filesystem.write'] },
    { tool: byName('read-report'), capabilities: ['filesystem.confirm'] },
  ],
})
const verifier = folderVerifiers(out)

const provider = new DeterministicPlanProvider()
let t = 0
const ctx = {
  now: () => ++t, outputRoot: out, outputFileName: 'report.txt',
  world: {
    observationId: 'obs-1', observedAt: 1, fingerprint: 'fp',
    scope: { root }, files: [], errors: [], truncated: false,
  },
}

async function attempt(label: string) {
  const proposal = await provider.plan(`summarise all 5 files in ${src}`, ctx)
  if (!proposal.ok) { console.log(`${label}: planner REFUSED -`, proposal.reason); return }
  const { compilePlan } = await import('./packages/planner/compile.ts')
  const c = compilePlan(proposal.proposal, 'm1', 0)
  if (!c.ok) { console.log(`${label}: compiler refused -`, c.reason); return }
  const m = c.mission
  const r = await execute(m, { tools: reg, verifier: verifier as never, control: fakeControl() as never,
    config: { now: () => ++t, maxAttempts: 2 } })
  console.log(`\n${label}`)
  console.log(`  declared postconditions : ${m.objectivePostconditions?.length ?? 0}`)
  for (const pc of m.objectivePostconditions ?? []) console.log(`     - ${pc.kind}`)
  console.log(`  steps verified          : ${Object.keys(r.record.verified).length}`)
  console.log(`  record.complete         : ${r.record.complete}`)
  console.log(`  record.objective        : ${r.record.objective.kind}`)
  console.log(`  finalState              : ${r.record.finalState}`)
  console.log(`  expectedResult          : ${proposal.proposal.expectedResult.slice(0, 80)}...`)
  const p = join(out, 'report.txt')
  console.log(`  report on disk          : ${readFileSync(p, 'utf8').split('\n')[1]?.trim() ?? '(none)'}`)
  return r
}

console.log('='.repeat(78))
console.log('END-TO-END: a real mission, planned and executed for real')
console.log('='.repeat(78))

const r1 = await attempt('[1] HONEST MISSION (declared postconditions)')
console.log(`\n  --> success: ${r1?.record.complete === true}`)

console.log('\n' + '='.repeat(78))
console.log('THE DEFECT: same evidence, objective postconditions REMOVED')
console.log('='.repeat(78))

// Rebuild the mission with its objective checks deleted - the post-review tampering case.
const proposal = await provider.plan(`summarise all 5 files in ${src}`, ctx)
const { compilePlan } = await import('./packages/planner/compile.ts')
const stripped = { ...proposal.proposal, objectivePostconditions: undefined }
const c2 = compilePlan(stripped, 'm2', 0)
const r2 = await execute(c2.mission, { tools: reg, verifier: verifier as never, control: fakeControl() as never,
  config: { now: () => ++t, maxAttempts: 2 } })
console.log(`  steps verified   : ${Object.keys(r2.record.verified).length}  (identical to [1])`)
console.log(`  record.complete  : ${r2.record.complete}`)
console.log(`  objective        : ${r2.record.objective.kind}`)
console.log(`  finalState       : ${r2.record.finalState}`)
console.log(`  --> success: ${r2.record.complete === true}  <-- must be false`)

console.log('\n' + '='.repeat(78))
console.log('CONTENT POSTCONDITION: declare the TRUE hash, then a WRONG one')
console.log('='.repeat(78))
import { createHash } from 'node:crypto'
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const reportPath = join(out, 'report.txt')
const realBytes = readFileSync(reportPath, 'utf8')

for (const [label, hash] of [['TRUE hash', sha(realBytes)], ['WRONG hash', sha('not the report')]] as const) {
  const c3 = compilePlan({ ...proposal.proposal, objectivePostconditions: [
    { kind: 'artifact-exists', path: reportPath },
    { kind: 'artifact-read-back', path: reportPath },
    { kind: 'artifact-content-matches', path: reportPath, sha256: hash },
  ] }, 'm3', 0)
  const r3 = await execute(c3.mission, { tools: reg, verifier: verifier as never, control: fakeControl() as never,
    config: { now: () => ++t, maxAttempts: 2 } })
  console.log(`  ${label}: complete=${r3.record.complete}  objective=${r3.record.objective.kind}`)
}

rmSync(root, { recursive: true, force: true })
