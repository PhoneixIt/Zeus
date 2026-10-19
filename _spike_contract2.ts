/**
 * READ-ONLY feasibility probe (corrected + extended).
 *
 * Nothing under packages/ is touched. The candidate matcher lives here, in a scratch file, and
 * consumes the REAL `Evidence` union and REAL evidence objects produced by the repo's own
 * verifiers, so the verdicts below are evidence-backed rather than asserted.
 */
import { readBackConfirmedVerifier } from './packages/mission-engine/live/folder-tools.ts'
import type { Evidence } from './packages/mission-engine/state.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---- candidate contract (NOT production) -----------------------------------------------

type ObjectivePostcondition =
  | { kind: 'artifact-exists'; path: string }
  | { kind: 'artifact-byte-count'; path: string; bytes: number }
  | { kind: 'artifact-read-back'; path: string }
  | { kind: 'artifact-names-each'; path: string; names: readonly string[] }
  | { kind: 'directory-entry-count'; path: string; entries: number }
  | { kind: 'consequential-deleted'; path: string; effect?: string }
  | { kind: 'command-exited'; executable: string; exitCode: number }

type ObjectiveVerdict =
  | { kind: 'satisfied'; proved: readonly string[] }
  | { kind: 'unmet'; failed: readonly string[] }
  | { kind: 'contradicted'; reason: string }
  | { kind: 'unproven'; reason: string }

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()

function evaluate(
  declared: readonly ObjectivePostcondition[] | undefined,
  evidence: readonly Evidence[],
): ObjectiveVerdict {
  if (declared === undefined) return { kind: 'unproven', reason: 'the plan declared no objective postcondition' }
  if (declared.length === 0) return { kind: 'unproven', reason: 'the plan declared zero postconditions' }

  // Contradiction pass: the same path asserted both present and deleted.
  const deleted = new Set(evidence.filter(e => e.kind === 'file-deleted').map(e => norm(e.path)))
  for (const e of evidence) {
    if ((e.kind === 'file-read-back' || e.kind === 'file-written') && deleted.has(norm(e.path))) {
      return { kind: 'contradicted', reason: `path ${e.path} is evidenced both written and deleted` }
    }
  }

  const failed: string[] = []
  const proved: string[] = []
  for (const pc of declared) {
    let hit = false
    switch (pc.kind) {
      case 'artifact-exists':
        hit = evidence.some(e =>
          (e.kind === 'file-exists' || e.kind === 'file-written' || e.kind === 'file-read-back')
          && norm(e.path) === norm(pc.path))
        break
      case 'artifact-byte-count':
        hit = evidence.some(e =>
          (e.kind === 'file-written' || e.kind === 'file-read-back')
          && norm(e.path) === norm(pc.path) && e.bytes === pc.bytes)
        break
      case 'artifact-read-back':
        hit = evidence.some(e => e.kind === 'file-read-back' && norm(e.path) === norm(pc.path))
        break
      case 'directory-entry-count':
        hit = evidence.some(e =>
          (e.kind === 'directory-present' || e.kind === 'folder-contents')
          && norm(e.path) === norm(pc.path) && e.entries === pc.entries)
        break
      case 'consequential-deleted':
        hit = evidence.some(e => e.kind === 'file-deleted' && norm(e.path) === norm(pc.path)
          && (pc.effect === undefined || e.effect === pc.effect))
        break
      case 'command-exited':
        hit = evidence.some(e => e.kind === 'command-verified'
          && e.executable === pc.executable && e.exitCode === pc.exitCode && e.corroboratedBy !== '')
        break
      case 'artifact-names-each': {
        const rb = evidence.find(e => e.kind === 'file-read-back' && norm(e.path) === norm(pc.path))
        if (!rb || rb.kind !== 'file-read-back') { hit = false; break }
        const hay = (rb.heading ?? '').toLowerCase()
        hit = pc.names.every(n => hay.includes(n.toLowerCase()))
        break
      }
    }
    if (hit) proved.push(pc.kind)
    else failed.push(pc.kind)
  }
  return failed.length === 0 ? { kind: 'satisfied', proved } : { kind: 'unmet', failed }
}

// ---- real evidence from the repo's own verifier ---------------------------------------

const DIR = mkdtempSync(join(tmpdir(), 'spike2-'))
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} })

async function realReadBack(path: string, firstLine: string): Promise<Evidence> {
  const v = readBackConfirmedVerifier()
  const r = await v.verify(
    { id: 'confirm-report', intent: '', mode: 'filesystem', rationale: '', status: 'pending' } as never,
    {} as never, { path, firstLine })
  return (r as { evidence: Evidence }).evidence
}

const NAMES = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']
const body = (names: string[]) => 'Folder report\n' + names.map(n => `- ${n}`).join('\n') + '\n'

const good = join(DIR, 'summary.md');      writeFileSync(good, body(NAMES), 'utf8')
const partial = join(DIR, 'partial.md');    writeFileSync(partial, body(['a.ts']), 'utf8')
const gone = join(DIR, 'gone.md');          writeFileSync(gone, body(NAMES), 'utf8')

const folderContents: Evidence = { kind: 'folder-contents', path: DIR, entries: 5, names: NAMES }
const fullEv = [
  folderContents,
  { kind: 'file-written', path: good, bytes: Buffer.byteLength(body(NAMES)), lines: 6 } as Evidence,
  await realReadBack(good, 'Folder report'),
]
const partialEv = [
  folderContents,
  { kind: 'file-written', path: partial, bytes: Buffer.byteLength(body(['a.ts'])), lines: 2 } as Evidence,
  await realReadBack(partial, 'Folder report'),
]
const browserEv: Evidence[] = [
  { kind: 'file-read-back', path: good, bytes: Buffer.byteLength(body(NAMES)) } as unknown as Evidence,
]

console.log('=== A. THE THREE REQUIRED DISTINCTIONS ===\n')

console.log('(1) ALL STEPS VERIFIED, OBJECTIVE UNMET')
console.log('    declared: artifact-exists(partial.md) + artifact-names-each(partial.md, all 5)')
const v1 = evaluate([
  { kind: 'artifact-exists', path: partial },
  { kind: 'artifact-names-each', path: partial, names: NAMES },
], partialEv)
console.log('    verdict:', JSON.stringify(v1), '<- exists PASSES, content FAILS. Correct discrimination.\n')

console.log('(2) OBJECTIVE SATISFIED - provable postconditions only')
const v2 = evaluate([
  { kind: 'artifact-exists', path: good },
  { kind: 'artifact-read-back', path: good },
  { kind: 'artifact-byte-count', path: good, bytes: Buffer.byteLength(body(NAMES)) },
  { kind: 'directory-entry-count', path: DIR, entries: 5 },
], fullEv)
console.log('    verdict:', JSON.stringify(v2), '\n')

console.log('(3) OBJECTIVE STATUS UNKNOWN (plan declared nothing)')
console.log('    verdict:', JSON.stringify(evaluate(undefined, fullEv)), '\n')

console.log('(3b) OBJECTIVE STATUS UNKNOWN (zero declared)')
console.log('    verdict:', JSON.stringify(evaluate([], fullEv)), '\n')

console.log('(4) CONTRADICTORY EVIDENCE (written AND deleted)')
const contraEv = [...fullEv, { kind: 'file-deleted', path: good, corroboratedBy: 'walked the tree again' } as Evidence]
console.log('    verdict:', JSON.stringify(evaluate([
  { kind: 'artifact-exists', path: good }, { kind: 'artifact-read-back', path: good },
], contraEv)), '\n')

console.log('=== B. THE REAL BLOCKER: content postconditions ===\n')
console.log('(5) summary on disk is CORRECT, require it names all 5')
console.log('    verdict:', JSON.stringify(evaluate([
  { kind: 'artifact-names-each', path: good, names: NAMES }], fullEv)))
console.log('    ^ file is byte-correct; evidence cannot prove it. heading =',
  JSON.stringify((fullEv[2] as { heading: string }).heading), '\n')

console.log('(6) same, but browser evidence (browser-tools.ts:577 omits heading at runtime)')
console.log('    verdict:', JSON.stringify(evaluate([
  { kind: 'artifact-names-each', path: good, names: NAMES }], browserEv)))
console.log('    heading on browser evidence:',
  JSON.stringify((browserEv[0] as { heading?: string }).heading), '(undefined -> nothing can match)\n')

console.log('=== C. command-verified DOES carry independent corroboration ===\n')
const cmdEv: Evidence[] = [{
  kind: 'command-verified', executable: 'node.exe', path: 'out/report.txt', bytes: 128,
  exitCode: 0, durationMs: 412, envVarCount: 0,
  corroboratedBy: 'recomputed by walking the folder again in this process',
}]
console.log('    exit 0, corroborated:', JSON.stringify(evaluate([
  { kind: 'command-exited', executable: 'node.exe', exitCode: 0 }], cmdEv)))
console.log('    exit 1 required    :', JSON.stringify(evaluate([
  { kind: 'command-exited', executable: 'node.exe', exitCode: 1 }], cmdEv)))
console.log('    same but corroboratedBy EMPTY (process self-witness only):', JSON.stringify(evaluate([
  { kind: 'command-exited', executable: 'node.exe', exitCode: 0 }],
  [{ ...(cmdEv[0] as object), corroboratedBy: '' } as Evidence])))

console.log('\n=== D. DELETED-THEN-CLAIMED ===\n')
console.log('    verdict:', JSON.stringify(evaluate([
  { kind: 'consequential-deleted', path: gone }], [
  { kind: 'file-deleted', path: gone, effect: 'file is gone', corroboratedBy: 'walked' } as Evidence])))
