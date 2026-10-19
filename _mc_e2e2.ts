/**
 * END-TO-END, isolated: one fresh output directory per case, so a refusing-to-overwrite tool
 * cannot masquerade as a failed objective check.
 */
import { execute } from './packages/mission-engine/executor.ts'
import { DeterministicPlanProvider } from './packages/planner/deterministic.ts'
import { compilePlan } from './packages/planner/compile.ts'
import { ToolRegistry } from './packages/tool-router/router.ts'
import { FOLDER_TOOLS, folderVerifiers } from './packages/mission-engine/live/folder-tools.ts'
import { fakeControl } from './packages/mission-engine/test/fakes.ts'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ObjectivePostcondition } from './packages/mission-engine/state.ts'

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const byName = (n: string) => FOLDER_TOOLS.find((t) => t.name === n)!
const mkReg = () => new ToolRegistry({ registrations: [
  { tool: byName('read-folder'), capabilities: ['filesystem.inspect'] },
  { tool: byName('inspect-folder'), capabilities: ['filesystem.list'] },
  { tool: byName('compose-summary'), capabilities: ['filesystem.transform'] },
  { tool: byName('write-report'), capabilities: ['filesystem.write'] },
  { tool: byName('read-report'), capabilities: ['filesystem.confirm'] },
]})
const provider = new DeterministicPlanProvider()

/** Runs the real folder-summary recipe in its own world, optionally overriding the postconditions. */
async function run(label: string, override?: (base: readonly ObjectivePostcondition[], outPath: string) => readonly ObjectivePostcondition[] | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'mc-e-'))
  const src = join(root, 'src'); const out = join(root, 'out')
  mkdirSync(src, { recursive: true }); mkdirSync(out, { recursive: true })
  for (const n of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) writeFileSync(join(src, n), 'x'.repeat(40 + n.length))

  let t = 0
  const plan = await provider.plan(`summarise all 5 files in ${src}`, {
    now: () => ++t, outputRoot: out, outputFileName: 'report.txt',
    world: { observationId: 'obs-1', observedAt: 1, fingerprint: 'fp', scope: { root }, files: [], errors: [], truncated: false },
  } as never)
  if (!plan.ok) { console.log(`${label}: planner refused - ${plan.reason}`); rmSync(root, { recursive: true, force: true }); return }

  const outPath = join(out, 'report.txt')
  const pc = override ? override(plan.proposal.objectivePostconditions ?? [], outPath) : plan.proposal.objectivePostconditions
  const c = compilePlan({ ...plan.proposal, objectivePostconditions: pc }, 'm1', 0)
  if (!c.ok) { console.log(`${label}: compiler refused - ${c.reason}`); rmSync(root, { recursive: true, force: true }); return }

  const r = await execute(c.mission, {
    tools: mkReg(), verifier: folderVerifiers(out) as never, control: fakeControl() as never,
    config: { now: () => ++t, maxAttempts: 2 },
  })
  console.log(`\n${label}`)
  console.log(`  steps verified   : ${Object.keys(r.record.verified).length}`)
  console.log(`  record.complete  : ${r.record.complete}`)
  console.log(`  objective        : ${r.record.objective.kind}`)
  console.log(`  finalState       : ${r.record.finalState}`)
  let realHash = ''
  try { realHash = sha(readFileSync(outPath, 'utf8')); console.log(`  report on disk   : yes (${realHash.slice(0, 12)}...)`) }
  catch { console.log('  report on disk   : NO') }
  rmSync(root, { recursive: true, force: true })
  return { complete: r.record.complete, kind: r.record.objective.kind, realHash }
}

console.log('='.repeat(74))
console.log('EACH CASE IN ITS OWN FRESH WORLD')
console.log('='.repeat(74))

const a = await run('[1] planner-declared postconditions (honest mission)')
console.log(`\n  --> success: ${a?.complete}   EXPECTED true`)

const b = await run('[2] postconditions REMOVED (post-review tampering)', () => undefined)
console.log(`\n  --> success: ${b?.complete}   EXPECTED false`)

const c = await run('[3] content postcondition, WRONG hash', (_base, outPath) => [
  { kind: 'artifact-exists', path: outPath },
  { kind: 'artifact-content-matches', path: outPath, sha256: sha('a summary that was never written') },
])
console.log(`\n  --> success: ${c?.complete}   EXPECTED false`)

const d = await run('[4] content postcondition, hash of a TRUNCATED summary', (_base, outPath) => [
  { kind: 'artifact-exists', path: outPath },
  { kind: 'artifact-content-matches', path: outPath, sha256: c!.realHash },
])
console.log(`\n  --> success: ${d?.complete}   EXPECTED true (this is the genuine report)`)

const e = await run('[5] content postcondition, hash of the REAL report', (_base, outPath) => [
  { kind: 'artifact-exists', path: outPath },
  { kind: 'artifact-read-back', path: outPath },
  { kind: 'artifact-content-matches', path: outPath, sha256: d!.realHash },
])
console.log(`\n  --> success: ${e?.complete}   EXPECTED true`)
