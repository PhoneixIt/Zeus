/**
 * END-TO-END content verification, with the source folder held CONSTANT.
 *
 * The earlier attempt gave every case its own temp root, which also changed the SOURCE path - and
 * `StructuredSummarizer` embeds the folder label in the summary text, so the content hash was
 * different every run. That is a property of the world, not a defect: it is precisely why a planner
 * that reads the folder at execution time cannot pin the hash in advance.
 *
 * Here the source is created ONCE and reused, and only the output directory varies, so the expected
 * content is identical across runs and the hash is knowable.
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

// ONE source, reused by every case.
const ROOT = mkdtempSync(join(tmpdir(), 'mc-fixed-'))
const SRC = join(ROOT, 'src')
mkdirSync(SRC, { recursive: true })
for (const n of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) writeFileSync(join(SRC, n), 'x'.repeat(40 + n.length))

async function run(label: string, pc?: (outPath: string) => readonly ObjectivePostcondition[]) {
  const out = join(ROOT, 'out-' + Math.abs(label.length * 7919 + label.charCodeAt(0)))
  mkdirSync(out, { recursive: true })
  let t = 0
  const plan = await provider.plan(`summarise all 5 files in ${SRC}`, {
    now: () => ++t, outputRoot: out, outputFileName: 'report.txt',
    world: { observationId: 'obs-1', observedAt: 1, fingerprint: 'fp', scope: { root: ROOT }, files: [], errors: [], truncated: false },
  } as never)
  if (!plan.ok) { console.log(`${label}: refused - ${plan.reason}`); return }
  const outPath = join(out, 'report.txt')
  const c = compilePlan({ ...plan.proposal, objectivePostconditions: pc ? pc(outPath) : plan.proposal.objectivePostconditions }, 'm1', 0)
  if (!c.ok) { console.log(`${label}: compile refused - ${c.reason}`); return }
  const r = await execute(c.mission, {
    tools: mkReg(), verifier: folderVerifiers(out) as never, control: fakeControl() as never,
    config: { now: () => ++t, maxAttempts: 2 },
  })
  const onDisk = readFileSync(outPath, 'utf8')
  console.log(`\n${label}`)
  console.log(`  steps verified  : ${Object.keys(r.record.verified).length}`)
  console.log(`  record.complete : ${r.record.complete}`)
  console.log(`  objective       : ${r.record.objective.kind}`)
  console.log(`  finalState      : ${r.record.finalState}`)
  console.log(`  report sha256   : ${sha(onDisk).slice(0, 16)}...`)
  return { complete: r.record.complete, kind: r.record.objective.kind, hash: sha(onDisk), bytes: onDisk }
}

console.log('='.repeat(74))
console.log('CONTENT VERIFICATION END-TO-END (source folder held constant)')
console.log('='.repeat(74))

const base = await run('[1] planner-declared (exists + read-back)')
const withTrue = await run('[2] + content hash of the GENUINE report', (outPath) => [
  { kind: 'artifact-exists', path: outPath },
  { kind: 'artifact-read-back', path: outPath },
  { kind: 'artifact-content-matches', path: outPath, sha256: base!.hash },
])
const withWrong = await run('[3] + content hash of a TRUNCATED report', (outPath) => [
  { kind: 'artifact-exists', path: outPath },
  { kind: 'artifact-read-back', path: outPath },
  { kind: 'artifact-content-matches', path: outPath, sha256: sha(base!.bytes.slice(0, 20)) },
])
const hashOfOther = await run('[4] content hash taken from a DIFFERENT world', (outPath) => [
  { kind: 'artifact-exists', path: outPath },
  { kind: 'artifact-read-back', path: outPath },
  { kind: 'artifact-content-matches', path: outPath, sha256: sha('# Contents of ' + 'C:\\somewhere\\else\n') },
])

console.log('\n' + '='.repeat(74))
console.log('VERDICT')
console.log('='.repeat(74))
console.log(`  [1] honest mission                  -> complete=${base!.complete}   (want true)`)
console.log(`  [2] genuine content                -> complete=${withTrue!.complete}   (want true)`)
console.log(`  [3] truncated content              -> complete=${withWrong!.complete}  (want false)`)
console.log(`  [4] content from another world      -> complete=${hashOfOther!.complete} (want false)`)

rmSync(ROOT, { recursive: true, force: true })
