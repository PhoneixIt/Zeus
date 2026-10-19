/**
 * DIAGNOSTIC: replicate the IN-SUITE harness exactly, and print why the short report is not written.
 *
 * Mirrors packages/planner/test/expected-content.test.ts's `planAndRun` + `folderRegistry` +
 * `makeWorld` line for line, then prints every step outcome and the failure reason.
 */
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeterministicPlanProvider } from './packages/planner/deterministic.ts'
import { compilePlan } from './packages/planner/compile.ts'
import { LocalObservationProvider } from './packages/observation/local.ts'
import { execute } from './packages/mission-engine/executor.ts'
import { ToolRegistry } from './packages/tool-router/router.ts'
import { FOLDER_TOOLS, folderVerifiers } from './packages/mission-engine/live/folder-tools.ts'
import { fakeControl } from './packages/mission-engine/test/fakes.ts'
import type { Tool, ToolContext, ToolResult } from './packages/mission-engine/executor.ts'

const byName = (n: string) => FOLDER_TOOLS.find((t) => t.name === n)!

function folderRegistry(override?: { name: string; tool: Tool }) {
  return new ToolRegistry({ registrations: [
    { tool: byName('read-folder'), capabilities: ['filesystem.inspect'] },
    { tool: byName('inspect-folder'), capabilities: ['filesystem.list'] },
    override ?? { tool: byName('compose-summary'), capabilities: ['filesystem.transform'] },
    { tool: byName('write-report'), capabilities: ['filesystem.write'] },
    { tool: byName('read-report'), capabilities: ['filesystem.confirm'] },
  ] })
}

function makeWorld(files: Record<string, number | null>, root: string) {
  mkdirSync(root, { recursive: true })
  for (const [name, size] of Object.entries(files)) {
    if (size === null) mkdirSync(join(root, name), { recursive: true })
    else writeFileSync(join(root, name), 'x'.repeat(size), 'utf8')
  }
}

const root = mkdtempSync(join(tmpdir(), 'mc-diag-'))
const src = join(root, 'src')
makeWorld({ 'a.ts': 50, 'b.ts': 50, 'c.ts': 50, 'd.ts': 50, 'e.ts': 50 }, src)

const shortCompose: Tool = {
  name: 'compose-summary', mode: 'filesystem',
  async run(ctx: ToolContext): Promise<ToolResult> {
    const listing = ctx.prior?.['inspect-folder']?.output as { entries?: { name: string }[] } | undefined
    const entries = listing?.entries ?? []
    console.log('  [compose] entries seen:', entries.length, entries.map((e) => e.name).join(','))
    const text = `# Contents of ${src}\n\n- ${entries.length} entries total: ${entries.length} file(s), 0 folder(s)\n\n- ${entries[0]?.name} - only this one\n`
    return {
      kind: 'data',
      data: { text, provenance: 'deterministic', entryCount: entries.length, folderLabel: src },
      summary: 'composed a short summary',
    }
  },
}

const out = mkdtempSync(join(root, 'out-'))
let t = 0
const now = () => ++t

const obs = await new LocalObservationProvider().observe({ root } as never)
const world = 'world' in obs ? (obs as unknown as { world: never }).world : obs
const worldObj = obs as unknown as { entries: { path: string; depth: number; kind: string }[]; truncated: boolean; errors: unknown[] }
console.log('OBSERVATION')
console.log('  entries under src:')
for (const e of worldObj.entries.filter((x) => x.path.includes(join(root, 'src')))) {
  console.log(`    depth=${e.depth} kind=${e.kind} path=${e.path}`)
}
console.log('  truncated:', worldObj.truncated, ' errors:', worldObj.errors.length)

const plan = await new DeterministicPlanProvider().plan(`summarise all the files in ${src}`, {
  now, outputRoot: out, outputFileName: 'summary.txt', world,
} as never)
if (!plan.ok) { console.log('planner refused:', plan.reason); process.exit(1) }
console.log('\nPLAN')
console.log('  steps:', plan.proposal.steps.map((s) => `${s.id}[${s.tool}]`).join(' -> '))
console.log('  postconditions:', (plan.proposal.objectivePostconditions ?? []).map((p) => p.kind).join(', '))
console.log('  write-report args:', JSON.stringify(plan.proposal.steps.find((s) => s.id === 'write-report')?.args))

const compiled = compilePlan(plan.proposal, 'm1', 0)
if (!compiled.ok) { console.log('compile refused:', compiled.reason); process.exit(1) }

console.log('\nEXECUTE')
const r = await execute(compiled.mission, {
  tools: folderRegistry({ name: 'compose-summary', tool: shortCompose }),
  verifier: folderVerifiers(out) as never,
  control: fakeControl() as never,
  config: { now, maxAttempts: 2 },
})

console.log('\nSTEP OUTCOMES')
for (const s of r.mission.plan) {
  const o = s.result?.outcome
  console.log(`  ${s.id.padEnd(16)} status=${String(s.status).padEnd(10)} outcome=${o?.kind ?? 'none'}` +
    (o && 'reason' in o && o.reason ? `  reason="${String(o.reason).slice(0, 150)}"` : ''))
}
console.log('\nverified evidence:', Object.keys(r.record.verified).length)
console.log('record.complete   :', r.record.complete)
console.log('objective         :', r.record.objective.kind)
console.log('finalState        :', r.record.finalState)
try { console.log('report written    :', JSON.stringify(readFileSync(join(out, 'summary.txt'), 'utf8').slice(0, 60))) }
catch { console.log('report written    : NO') }

rmSync(root, { recursive: true, force: true })
