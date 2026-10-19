/**
 * READ-ONLY feasibility probe for Option A.
 *
 * Defines a CANDIDATE ObjectivePostcondition matcher here, in a scratch file, so that nothing in
 * packages/ is touched. It consumes the REAL `Evidence` type and REAL evidence objects drawn from
 * the repo's own verifiers, to test whether the three required distinctions are expressible today.
 */
import { readBackConfirmedVerifier } from './packages/mission-engine/live/folder-tools.ts'
import type { Evidence } from './packages/mission-engine/state.ts'

// ---- candidate contract (NOT production) -----------------------------------------------

type ObjectivePostcondition =
  | { kind: 'artifact-exists'; path: string }
  | { kind: 'artifact-byte-count'; path: string; bytes: number }
  | { kind: 'artifact-read-back'; path: string }
  | { kind: 'artifact-naming'; path: string; names: readonly string[] }
  | { kind: 'directory-entry-count'; path: string; entries: number }
  | { kind: 'consequential-deleted'; path: string; effect: string }

type ObjectiveVerdict =
  | { kind: 'satisfied'; proved: readonly string[] }
  | { kind: 'unmet'; failed: readonly string[] }
  | { kind: 'unproven'; reason: string }

function evaluate(
  declared: readonly ObjectivePostcondition[] | undefined,
  evidence: readonly Evidence[],
): ObjectiveVerdict {
  if (declared === undefined) return { kind: 'unproven', reason: 'the plan declared no objective postcondition' }
  if (declared.length === 0) return { kind: 'unproven', reason: 'the plan declared zero postconditions' }

  const failed: string[] = []
  const proved: string[] = []
  for (const pc of declared) {
    const hit = evidence.some((e) => {
      switch (pc.kind) {
        case 'artifact-exists':
          return (e.kind === 'file-exists' || e.kind === 'file-written' || e.kind === 'file-read-back')
            && norm(e.path) === norm(pc.path)
        case 'artifact-byte-count':
          return (e.kind === 'file-written' || e.kind === 'file-read-back')
            && norm(e.path) === norm(pc.path) && e.bytes === pc.bytes
        case 'artifact-read-back':
          return e.kind === 'file-read-back' && norm(e.path) === norm(pc.path)
        case 'directory-entry-count':
          return (e.kind === 'directory-present' || e.kind === 'folder-contents')
            && norm(e.path) === norm(pc.path) && e.entries === pc.entries
        case 'consequential-deleted':
          return e.kind === 'file-deleted' && norm(e.path) === norm(pc.path)
            && (pc.effect === '' || (e.effect ?? '') === pc.effect)
        case 'artifact-naming': {
          // Can today's evidence answer "the artefact names each of these"? Check honestly.
          const rb = evidence.find((e) => e.kind === 'file-read-back' && norm(e.path) === norm(pc.path))
          if (!rb || rb.kind !== 'file-read-back') return false
          const hay = (rb.heading ?? '').toLowerCase()
          return pc.names.every((n) => hay.includes(n.toLowerCase()))
        }
      }
    })
    if (hit) proved.push(pc.kind)
    else failed.push(pc.kind)
  }
  return failed.length === 0 ? { kind: 'satisfied', proved } : { kind: 'unmet', failed }
}

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()

// ---- real evidence, drawn from the repo's own verifier -------------------------------
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DIR = mkdtempSync(join(tmpdir(), 'spike-obj-'))
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} })

async function realReadBackEvidence(path: string, firstLine: string): Promise<Evidence | undefined> {
  const v = readBackConfirmedVerifier()
  const r = await v.verify(
    { id: 'confirm-report', intent: '', mode: 'filesystem', rationale: '', status: 'pending' } as never,
    {} as never,
    { path, firstLine },
  )
  return 'evidence' in r ? r.evidence : undefined
}

const SUMMARY = join(DIR, 'summary.md')
const full = 'Folder report\n' + ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map(n => `- ${n}`).join('\n') + '\n'
writeFileSync(SUMMARY, full, 'utf8')

const rbEvidence = await realReadBackEvidence(SUMMARY, 'Folder report')
console.log('real file-read-back evidence:', JSON.stringify(rbEvidence))
console.log('  -> heading field carries ONLY:', JSON.stringify((rbEvidence as never as { heading: string }).heading))
console.log('  -> does the heading mention b.ts?', String((rbEvidence as never as { heading: string }).heading).includes('b.ts'))
console.log()

const folderContents: Evidence = { kind: 'folder-contents', path: DIR, entries: 5, names: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] }
const fileWritten: Evidence = { kind: 'file-written', path: SUMMARY, bytes: Buffer.byteLength(full), lines: 6 }
const ev = [folderContents, fileWritten, rbEvidence].filter(Boolean) as Evidence[]

console.log('=== THE THREE REQUIRED DISTINCTIONS ===')
console.log()
console.log('(1) all steps verified, OBJECTIVE UNMET (summary omits 2 of 5 files)')
const partialPath = join(DIR, 'partial.md')
writeFileSync(partialPath, 'Folder report\n- a.ts\n', 'utf8')
const partialRb = await realReadBackEvidence(partialPath, 'Folder report')
const partialEv = [folderContents, { kind: 'file-written', path: partialPath, bytes: 26, lines: 2 } as Evidence, partialRb]
  .filter(Boolean) as Evidence[]
const v1 = evaluate([
  { kind: 'artifact-exists', path: SUMMARY },
  { kind: 'artifact-naming', path: SUMMARY, names: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] },
], partialEv)
console.log('   verdict:', JSON.stringify(v1))
console.log()
console.log('(2) OBJECTIVE SATISFIED (full summary present)')
const v2 = evaluate([
  { kind: 'artifact-exists', path: SUMMARY },
  { kind: 'artifact-naming', path: SUMMARY, names: ['a.ts', 'b.ts'] },
], ev)
console.log('   verdict:', JSON.stringify(v2))
console.log()
console.log('(3) OBJECTIVE STATUS UNKNOWN (plan declared nothing)')
const v3 = evaluate(undefined, ev)
console.log('   verdict:', JSON.stringify(v3))
console.log()
console.log('=== FEASIBILITY OF artifact-naming AGAINST REAL EVIDENCE ===')
const v4 = evaluate([
  { kind: 'artifact-naming', path: SUMMARY, names: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] },
], ev)
console.log('   full summary, require all 5 names -> verdict:', JSON.stringify(v4))
console.log('   ^ this is the honest answer: the file IS correct, but evidence cannot prove it.')