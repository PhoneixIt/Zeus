/**
 * THE NEGATIVE CONTROL, on the REAL path.
 *
 * A folder holding 5 files where the plan observed 5. A writer that produces a report naming only
 * 1 of them produces a file of a DIFFERENT, still-plausible size that reads back cleanly and passes
 * every step-level check. That is the defect M-c exists for, and this is it reproduced.
 *
 * The only question here is whether the OBJECTIVE refuses it.
 */
import { DeterministicPlanProvider } from './packages/planner/deterministic.ts'
import { compilePlan } from './packages/planner/compile.ts'
import { LocalObservationProvider } from './packages/observation/local.ts'
import { execute } from './packages/mission-engine/executor.ts'
import { ToolRegistry } from './packages/tool-router/router.ts'
import { FOLDER_TOOLS, folderVerifiers } from './packages/mission-engine/live/folder-tools.ts'
import { fakeControl } from './packages/mission-engine/test/fakes.ts'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool, ToolContext, ToolResult, Verifier } from './packages/mission-engine/executor.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'mc-neg-'))
const SRC = join(ROOT, 'src'); const OUT = join(ROOT, 'out')
mkdirSync(SRC, { recursive: true }); mkdirSync(OUT, { recursive: true })
for (const n of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) writeFileSync(join(SRC, n), 'x'.repeat(50))

const byName = (n: string) => FOLDER_TOOLS.find((t) => t.name === n)!
const reg = new ToolRegistry({ registrations: [
  { tool: byName('read-folder'), capabilities: ['filesystem.inspect'] },
  { tool: byName('inspect-folder'), capabilities: ['filesystem.list'] },
  { tool: byName('compose-summary'), capabilities: ['filesystem.transform'] },
  { tool: byName('write-report'), capabilities: ['filesystem.write'] },
  { tool: byName('read-report'), capabilities: ['filesystem.confirm'] },
]})

/** A compose-summary that UNDER-REPORTS: lists 1 of the 5 files it was given. */
const shortCompose: Tool = {
  name: 'compose-summary', mode: 'filesystem',
  async run(ctx: ToolContext): Promise<ToolResult> {
    const listing = ctx.prior?.['inspect-folder']?.output as { entries?: { name: string }[] } | undefined
    const entries = listing?.entries ?? []
    const text = `# Contents of ${SRC}\n\n- ${entries.length} entries total\n\n- ${entries[0]?.name} - only this one\n`
    return { kind: 'data', data: { text, provenance: 'deterministic', entryCount: entries.length, folderLabel: SRC }, summary: 'composed a short summary' }
  },
}
const shortVerifiers = folderVerifiers(OUT)

const observer = new LocalObservationProvider()
const provider = new DeterministicPlanProvider()
let t = 0
const now = () => ++t
const obs = await observer.observe({ root: ROOT } as never)
const world = 'world' in obs ? (obs as { world: never }).world : obs

const plan = await provider.plan(`summarise all the files in ${SRC}`, {
  now, outputRoot: OUT, outputFileName: 'summary.txt', world,
} as never)
if (!plan.ok) { console.log('refused'); process.exit(1) }
const c = compilePlan(plan.proposal, 'm1', 0)
if (!c.ok) { console.log('compile refused'); process.exit(1) }

async function go(label: string, tools: ToolRegistry) {
  // Re-plan per case into its OWN output directory. Sharing one would make the second run fail
  // because `write-report` refuses to overwrite - a refusal about the output folder, not about the
  // objective, and it would look like a false negative for the control.
  const out = join(ROOT, 'out-' + Math.abs(label.charCodeAt(0) * 31 + label.length))
  mkdirSync(out, { recursive: true })
  const p = await provider.plan(`summarise all the files in ${SRC}`, {
    now, outputRoot: out, outputFileName: 'summary.txt', world,
  } as never)
  if (!p.ok) throw new Error('planner refused: ' + p.reason)
  const cc = compilePlan(p.proposal, 'm1', 0)
  if (!cc.ok) throw new Error('compile refused: ' + cc.reason)
  // The verifier is built for a specific output root, so it must be built per case too - otherwise
  // it corroborates a directory this run never wrote to.
  const verifier = folderVerifiers(out)
  const r = await execute(cc.mission, { tools, verifier: verifier as never, control: fakeControl() as never, config: { now, maxAttempts: 2 } })
  console.log(`\n${label}`)
  console.log('  steps verified  :', Object.keys(r.record.verified).length, '(the step record is green either way)')
  console.log('  record.complete :', r.record.complete)
  console.log('  objective       :', r.record.objective.kind)
  console.log('  finalState      :', r.record.finalState)
  return r
}

console.log('='.repeat(76))
console.log('NEGATIVE CONTROL: every step verified, report names 1 of 5 files')
console.log('='.repeat(76))

const shortReg = new ToolRegistry({ registrations: [
  { tool: byName('read-folder'), capabilities: ['filesystem.inspect'] },
  { tool: byName('inspect-folder'), capabilities: ['filesystem.list'] },
  { tool: shortCompose, capabilities: ['filesystem.transform'] },
  { tool: byName('write-report'), capabilities: ['filesystem.write'] },
  { tool: byName('read-report'), capabilities: ['filesystem.confirm'] },
]})
const bad = await go('[A] under-reporting writer', shortReg)
console.log('  --> success:', bad.record.complete, '  MUST BE false')

const good = await go('[B] honest writer (control)', reg)
console.log('  --> success:', good.record.complete, '  MUST BE true')

rmSync(ROOT, { recursive: true, force: true })
