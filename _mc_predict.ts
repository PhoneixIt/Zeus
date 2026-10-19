/**
 * THE REAL PATH: planner -> compiler -> executor, with a real folder.
 *
 * Question: does `expectedFolderSummary` predict the bytes the tool will actually write?
 * If the composer, the entry transport or the label disagree anywhere, this returns false and the
 * whole approach is unsound - so this is checked against the real pipeline rather than asserted.
 */
import { DeterministicPlanProvider } from './packages/planner/deterministic.ts'
import { compilePlan } from './packages/planner/compile.ts'
import { LocalObservationProvider } from './packages/observation/local.ts'
import { execute } from './packages/mission-engine/executor.ts'
import { ToolRegistry } from './packages/tool-router/router.ts'
import { FOLDER_TOOLS, folderVerifiers } from './packages/mission-engine/live/folder-tools.ts'
import { fakeControl } from './packages/mission-engine/test/fakes.ts'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = mkdtempSync(join(tmpdir(), 'mc-pred-'))
const SRC = join(ROOT, 'src'); const OUT = join(ROOT, 'out')
mkdirSync(SRC, { recursive: true }); mkdirSync(OUT, { recursive: true })
mkdirSync(join(SRC, 'sub'), { recursive: true })
writeFileSync(join(SRC, 'alpha.ts'), 'x'.repeat(120))
writeFileSync(join(SRC, 'beta.ts'), 'y'.repeat(80))
writeFileSync(join(SRC, 'gamma.md'), 'z'.repeat(200))
writeFileSync(join(SRC, 'beta.ts'), 'y'.repeat(80))
writeFileSync(join(SRC, 'same.ts'), 'q'.repeat(80))     // byte-tie with beta.ts
writeFileSync(join(SRC, 'same2.ts'), 'q'.repeat(80))    // and another
writeFileSync(join(SRC, 'noext'), 'n'.repeat(10))
writeFileSync(join(SRC, 'sub', 'deep.ts'), 'd'.repeat(5))

const byName = (n: string) => FOLDER_TOOLS.find((t) => t.name === n)!
const reg = new ToolRegistry({ registrations: [
  { tool: byName('read-folder'), capabilities: ['filesystem.inspect'] },
  { tool: byName('inspect-folder'), capabilities: ['filesystem.list'] },
  { tool: byName('compose-summary'), capabilities: ['filesystem.transform'] },
  { tool: byName('write-report'), capabilities: ['filesystem.write'] },
  { tool: byName('read-report'), capabilities: ['filesystem.confirm'] },
]})

const observer = new LocalObservationProvider()
const provider = new DeterministicPlanProvider()
let t = 0
const now = () => ++t

const obs = await observer.observe({ root: ROOT } as never)
const world = 'world' in obs ? (obs as { world: never }).world : obs

const plan = await provider.plan(`summarise all the files in ${SRC}`, {
  now, outputRoot: OUT, outputFileName: 'summary.txt', world,
} as never)
if (!plan.ok) { console.log('planner refused:', plan.reason); process.exit(1) }

const pc = plan.proposal.objectivePostconditions ?? []
console.log('DECLARED POSTCONDITIONS')
for (const p of pc) {
  console.log('  -', p.kind, p.kind === 'artifact-content-matches' ? `sha256=${p.sha256.slice(0, 16)}...` : '')
}
const content = pc.find((p) => p.kind === 'artifact-content-matches')
console.log('\ncontent postcondition present?', !!content)

const c = compilePlan(plan.proposal, 'm1', 0)
if (!c.ok) { console.log('compile refused:', c.reason); process.exit(1) }

const r = await execute(c.mission, {
  tools: reg, verifier: folderVerifiers(OUT) as never, control: fakeControl() as never,
  config: { now, maxAttempts: 2 },
})

const actual = readFileSync(join(OUT, 'summary.txt'), 'utf8')
const actualHash = createHash('sha256').update(actual, 'utf8').digest('hex')

console.log('\nRESULT')
console.log('  declared sha256 :', content && content.kind === 'artifact-content-matches' ? content.sha256 : '(none)')
console.log('  actual   sha256 :', actualHash)
console.log('  PREDICTION MATCH:', content && content.kind === 'artifact-content-matches' ? content.sha256 === actualHash : 'n/a')
console.log('  steps verified  :', Object.keys(r.record.verified).length)
console.log('  record.complete :', r.record.complete)
console.log('  objective       :', r.record.objective.kind)
console.log('\n--- the artefact that was actually written ---')
console.log(actual)

rmSync(ROOT, { recursive: true, force: true })
