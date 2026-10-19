/**
 * READ-ONLY probe 3: does a MINIMAL additive evidence field close the content gap?
 *
 * Nothing under packages/ is touched. This asks: if `file-read-back` carried a content DIGEST
 * instead of / in addition to the first line, could an objective postcondition prove content
 * deterministically without a model, a new subsystem, or a new dependency?
 */
import { readBackConfirmedVerifier } from './packages/mission-engine/live/folder-tools.ts'
import type { Evidence } from './packages/mission-engine/state.ts'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()

/** What the CURRENT verifier would emit if it also hashed the body it just read. */
type DigestEvidence = Evidence & { sha256?: string }

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

const DIR = mkdtempSync(join(tmpdir(), 'spike3-'))
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} })

const NAMES = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']
const body = (names: string[]) => 'Folder report\n' + names.map(n => `- ${n}`).join('\n') + '\n'

const full = join(DIR, 'full.md');     writeFileSync(full, body(NAMES), 'utf8')
const partial = join(DIR, 'partial.md'); writeFileSync(partial, body(['a.ts']), 'utf8')

// The postcondition the PLANNER would emit: it knows the expected content, so it can state the hash.
type Postcondition =
  | { kind: 'artifact-exists'; path: string }
  | { kind: 'artifact-content-matches'; path: string; sha256: string }
  | { kind: 'directory-entry-count'; path: string; entries: number }

function evaluate(
  declared: readonly Postcondition[],
  evidence: readonly DigestEvidence[],
): 'satisfied' | 'unmet' {
  for (const pc of declared) {
    let hit = false
    switch (pc.kind) {
      case 'artifact-exists':
        hit = evidence.some(e =>
          (e.kind === 'file-exists' || e.kind === 'file-written' || e.kind === 'file-read-back')
          && norm(e.path) === norm(pc.path))
        break
      case 'artifact-content-matches':
        hit = evidence.some(e => e.kind === 'file-read-back'
          && norm(e.path) === norm(pc.path) && e.sha256 === pc.sha256)
        break
      case 'directory-entry-count':
        hit = evidence.some(e =>
          (e.kind === 'directory-present' || e.kind === 'folder-contents')
          && norm(e.path) === norm(pc.path) && e.entries === pc.entries)
        break
    }
    if (!hit) return 'unmet'
  }
  return 'satisfied'
}

async function realReadBack(path: string, firstLine: string): Promise<DigestEvidence> {
  const v = readBackConfirmedVerifier()
  const r = await v.verify(
    { id: 'confirm-report', intent: '', mode: 'filesystem', rationale: '', status: 'pending' } as never,
    {} as never, { path, firstLine })
  const ev = (r as { evidence: Evidence }).evidence
  // ADDITIVE SHIM: hash exactly the bytes the verifier already read. No new read, no new tool.
  return { ...ev, sha256: sha(readFileSync(path, 'utf8')) } as DigestEvidence
}

const fullRb = await realReadBack(full, 'Folder report')
const partialRb = await realReadBack(partial, 'Folder report')

console.log('=== WITH AN ADDITIVE sha256 FIELD (node:crypto only) ===\n')
console.log('verifier emitted:', JSON.stringify(fullRb), '\n')

const folder: DigestEvidence = { kind: 'folder-contents', path: DIR, entries: 5, names: NAMES }
const goodEv: DigestEvidence[] = [folder, fullRb]
const badEv: DigestEvidence[] = [folder, partialRb]

const decl = [
  { kind: 'artifact-exists', path: full },
  { kind: 'artifact-content-matches', path: full, sha256: sha(body(NAMES)) },
  { kind: 'directory-entry-count', path: DIR, entries: 5 },
] as const

console.log('(1) objective SATISFIED, evidence from the correct file :', evaluate(decl, goodEv))
console.log('(2) objective UNMET, evidence from the truncated file   :', evaluate(decl, badEv))
console.log('    ^ both steps verified in both runs; only content decides. THE M-b CONTROL NOW BITES.\n')

// Tamper test: someone edits the file AFTER the verifier read it.
console.log('(3) TAMPER - file changed after the verifier read it')
writeFileSync(full, body(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) + 'extra line\n', 'utf8')
const tamperedRb = await realReadBack(full, 'Folder report')
console.log('    postcondition still demands the original hash; verdict:',
  evaluate(decl, [folder, tamperedRb]))
console.log('    ^ a later write cannot inherit an earlier read\'s approval.\n')

// Does the hash survive a CRLF/LF difference? (cross-platform determinism check)
console.log('(4) CROSS-PLATFORM: same bytes, LF vs CRLF')
const lf = body(NAMES)
const crlf = lf.replace(/\n/g, '\r\n')
const crlfPath = join(DIR, 'crlf.md'); writeFileSync(crlfPath, crlf, 'utf8')
const crlfRb = await realReadBack(crlfPath, 'Folder report')
console.log('    LF   sha:', sha(lf).slice(0, 16))
console.log('    CRLF sha:', sha(crlf).slice(0, 16))
console.log('    verdict if the postcondition pins the LF hash:',
  evaluate([{ kind: 'artifact-content-matches', path: crlfPath, sha256: sha(lf) }], [crlfRb]))
console.log('    ^ a line-ending difference FAILS. The planner must pin the hash of what')
console.log('      it actually wrote, or normalise before hashing. Design constraint found.\n')

// What about hashing the tool's own output rather than the file? (weaker - self-witness)
console.log('(5) SELF-WITNESS WARNING: hashing the tool-reported first line only')
console.log('    verifier compares heading to the tool-reported firstLine. A hash of that same')
console.log('    value proves only that the tool did not lie about line 1 - NOT that content is right.')
