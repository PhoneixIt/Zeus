/**
 * INCREMENT 2 TEST: the sha256 a read-back verifier emits must be the hash of the BYTES ON DISK,
 * not of anything a tool claimed, and must change when the file changes.
 *
 * Read-only with respect to packages/ - this exercises shipped code.
 */
import { readBackConfirmedVerifier, sha256 } from './packages/mission-engine/live/folder-tools.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const DIR = mkdtempSync(join(tmpdir(), 'mc-inc2-'))
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} })

const v = readBackConfirmedVerifier()
async function verify(path: string, firstLine: string) {
  const r = await v.verify(
    { id: 'confirm-report', intent: '', mode: 'filesystem', rationale: '', status: 'pending' } as never,
    {} as never, { path, firstLine })
  return r as { evidence: { kind: string; path: string; bytes: number; heading: string; sha256?: string } }
}

const p = join(DIR, 'report.md')
const BODY = 'Folder report\n- a.ts\n- b.ts\n'
writeFileSync(p, BODY, 'utf8')

const r = await verify(p, 'Folder report')
const independent = createHash('sha256').update(BODY, 'utf8').digest('hex')

assert.equal(r.evidence.sha256, independent, 'the emitted digest is sha256 of the real bytes')
assert.equal(r.evidence.sha256, sha256(BODY), 'and matches the shared helper')
assert.equal(r.evidence.bytes, Buffer.byteLength(BODY, 'utf8'))
assert.equal(r.evidence.heading, 'Folder report', 'heading is still the first line')
console.log('  emitted sha256      :', r.evidence.sha256)
console.log('  independent sha256  :', independent)
console.log('  MATCH               :', r.evidence.sha256 === independent)

// Change one byte of the middle. The first line is unchanged, so the OLD verifier's checks all pass.
writeFileSync(p, 'Folder report\n- a.ts\n- X.ts\n', 'utf8')
const r2 = await verify(p, 'Folder report')
assert.notEqual(r2.evidence.sha256, r.evidence.sha256,
  'a change below the first line moves the digest, which is exactly what the old evidence could not see')
assert.equal(r2.evidence.heading, 'Folder report', 'the first line is genuinely unchanged')
assert.equal(r2.evidence.bytes, r.evidence.bytes, 'and the length is identical - a size-only check cannot catch this')
console.log('  after tampering     :', r2.evidence.sha256)
console.log('  digest changed      :', r2.evidence.sha256 !== r.evidence.sha256)
console.log('  bytes identical     :', r2.evidence.bytes === r.evidence.bytes, '(so byte-count alone was blind to it)')

console.log('\n  OK - increment 2 verified')
