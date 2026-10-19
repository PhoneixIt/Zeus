import { LocalObservationProvider } from './packages/observation/local.ts'
import { DeterministicPlanProvider } from './packages/planner/deterministic.ts'
import { compilePlan } from './packages/planner/compile.ts'
import { execute } from './packages/mission-engine/executor.ts'
import { ToolRegistry } from './packages/tool-router/router.ts'
import { FOLDER_TOOLS, folderVerifiers } from './packages/mission-engine/live/folder-tools.ts'
import { fakeControl } from './packages/mission-engine/test/fakes.ts'
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const byName = (n: string) => FOLDER_TOOLS.find((t) => t.name === n)!
const reg = new ToolRegistry({ registrations: [
  { tool: byName('read-folder'), capabilities: ['filesystem.inspect'] },
  { tool: byName('inspect-folder'), capabilities: ['filesystem.list'] },
  { tool: byName('compose-summary'), capabilities: ['filesystem.transform'] },
  { tool: byName('write-report'), capabilities: ['filesystem.write'] },
  { tool: byName('read-report'), capabilities: ['filesystem.confirm'] },
]})

const root = mkdtempSync(join(tmpdir(), 'mc-h2-'))
const sourceDir = join(root, 'src'); const outDir = join(root, 'out')
mkdirSync(sourceDir, { recursive: true }); mkdirSync(outDir, { recursive: true })
writeFileSync(join(sourceDir, 'a.ts'), 'a'.repeat(120))
writeFileSync(join(sourceDir, 'b.ts'), 'b'.repeat(80))
writeFileSync(join(sourceDir, 'c.md'), 'c'.repeat(200))
const outName = 'summary.txt'

// EXACTLY run-folder-summary.ts's objective text and ctx.
const OBJECTIVE = `Summarise the contents of the folder "${sourceDir}" and write a summary file`
const observed = new LocalObservationProvider().observe({ root: sourceDir, maxDepth: 4 } as never)

const plan = await new DeterministicPlanProvider().plan(OBJECTIVE, {
  outputRoot: outDir, outputFileName: outName, now: () => (observed as unknown as { observedAt: number }).observedAt,
  world: observed, maxObservationAgeMs: 60_000, refetched: observed,
} as never)
if (!plan.ok) { console.log('refused:', plan.reason); process.exit(1) }

console.log('DECLARED POSTCONDITIONS')
for (const p of plan.proposal.objectivePostconditions ?? []) {
  console.log('  -', JSON.stringify(p).slice(0, 130))
}

let t = 0
const compiled = compilePlan(plan.proposal, 'm1', 0)
if (!compiled.ok) { console.log('compile refused:', compiled.reason); process.exit(1) }
const r = await execute(compiled.mission, {
  tools: reg, verifier: folderVerifiers(outDir) as never,
  control: fakeControl() as never, config: { now: () => ++t, maxAttempts: 2 },
})

console.log('\nsteps verified :', Object.keys(r.record.verified).length)
console.log('complete       :', r.record.complete)
console.log('objective      :', JSON.stringify(r.record.objective).slice(0, 220))
console.log('finalState     :', r.record.finalState)
console.log('integrity      :', r.events.filter((e) => e.type === 'integrity-violation').length, 'violations')
const { expectedFolderSummary } = await import('./packages/planner/expected-content.ts')
const pred = await expectedFolderSummary(observed as never, sourceDir)
console.log('predicted text:'); console.log(pred.ok ? pred.text : '(declined)')
try {
  const bytes = readFileSync(join(outDir, outName), 'utf8')
  console.log('written sha256 :', createHash('sha256').update(bytes, 'utf8').digest('hex').slice(0, 20))
} catch { console.log('written        : NONE') }

rmSync(root, { recursive: true, force: true })
