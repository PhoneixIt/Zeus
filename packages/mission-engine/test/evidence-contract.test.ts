import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeReadBackVerifier } from '../live/summary-tools.ts'
import { objectiveVerdict, type Evidence, type ObjectivePostcondition, type Step } from '../state.ts'
import type { ToolContext } from '../executor.ts'

/**
 * THE EVIDENCE CONTRACT: AN OPERAND IS AN OPERAND.
 *
 * `makeReadBackVerifier` used to emit
 *
 *   { kind: 'file-exists', path: "<path> (368 bytes, independently re-read; first line \"â€¦\")" }
 *
 * Two defects in one line. The `path` was not a path, so no path comparison could ever match it -
 * which is why `run-world-aware` reported four verified steps and could not satisfy its own
 * objective. And the kind was `file-exists`, which does not claim the contents were read, while
 * `artifact-read-back` requires `file-read-back`.
 *
 * The symptom was a mission that did everything right and reported failure. That is the worst
 * possible direction for a defect to point, so these tests pin the contract rather than the outcome.
 */

const step = (capability: string, args: Record<string, unknown> = {}): Step => ({
  id: 'confirm', intent: 'read it back', mode: 'filesystem', rationale: 'test',
  capability, args, status: 'pending',
} as Step)

async function verify(outRoot: string, target: string, text: string, args: Record<string, unknown> = {}) {
  const v = makeReadBackVerifier(outRoot)
  const r = await v.verify(step('filesystem.read', args), {} as ToolContext, { path: target, text })
  if ('rejected' in r) throw new Error(`verifier rejected: ${r.rejected}`)
  return r.evidence
}

function workspace(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mc-ev-'))
  const out = join(dir, 'out')
  mkdirSync(out, { recursive: true })
  const file = join(out, 'summary.md')
  writeFileSync(file, body, 'utf8')
  return { dir, out, file }
}

const BODY = '# Contents of C:\\demo\n\n- 3 entries total: 3 file(s), 0 folder(s)\n'

// ============================================================ THE PATH IS A PATH

test('the read-back evidence path is EXACTLY the file that was read', async () => {
  const { dir, out, file } = workspace(BODY)
  try {
    const ev = await verify(out, file, BODY)
    assert.equal(ev.kind, 'file-read-back')
    assert.equal(ev.path, file, 'no prose, no suffix - an operand must be comparable')
    assert.equal(ev.path.includes('bytes'), false, 'and nothing descriptive leaked back into it')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the diagnostic sentence survives, in a field nothing matches on', async () => {
  const { dir, out, file } = workspace(BODY)
  try {
    const ev = await verify(out, file, BODY) as Extract<Evidence, { kind: 'file-read-back' }>
    assert.ok(typeof ev.note === 'string' && ev.note.length > 0,
      'losing the provenance entirely would be a second way of losing information')
    assert.equal(ev.bytes, Buffer.byteLength(BODY, 'utf8'), 'size is a number field')
    assert.equal(ev.heading, BODY.split('\n')[0], 'and the first line is its own field')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('bytes counts BYTES, not characters', async () => {
  const { dir, out, file } = workspace('hÃ©llo wÃ¶rld\n')
  try {
    const ev = await verify(out, file, 'hÃ©llo wÃ¶rld\n') as Extract<Evidence, { kind: 'file-read-back' }>
    assert.equal(ev.bytes, Buffer.byteLength('hÃ©llo wÃ¶rld\n', 'utf8'),
      'the old field counted UTF-16 code units and disagreed with the on-disk size for non-ASCII')
    assert.notEqual(ev.bytes, 'hÃ©llo wÃ¶rld\n'.length)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ============================================================ THE TYPE SUPPORTS THE CLAIM

test('the emitted evidence SATISFIES artifact-read-back; the old kind could not', async () => {
  const { dir, out, file } = workspace(BODY)
  try {
    const ev = await verify(out, file, BODY)
    const declared: readonly ObjectivePostcondition[] = [{ kind: 'artifact-read-back', path: file }]
    assert.equal(objectiveVerdict(declared, { confirm: ev }).kind, 'satisfied',
      'a read-back step must be able to prove the artefact was read back')

    // The kind the verifier used to emit proves existence and nothing about content.
    const asFileExists: Evidence = { kind: 'file-exists', path: file }
    assert.equal(objectiveVerdict(declared, { confirm: asFileExists }).kind, 'unmet',
      'a bare existence check is not a read-back, and must not satisfy one')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('without an independent read-back, the objective stays UNMET', async () => {
  // The control: the fix must not have turned "no read-back evidence" into "no requirement".
  const { dir, out, file } = workspace(BODY)
  try {
    const declared: readonly ObjectivePostcondition[] = [
      { kind: 'artifact-exists', path: file },
      { kind: 'artifact-read-back', path: file },
    ]
    // Only an existence observation - no verifier ever re-read the file.
    const existsOnly: Evidence = { kind: 'file-exists', path: file }
    const v = objectiveVerdict(declared, { write: existsOnly })
    assert.equal(v.kind, 'unmet')
    assert.deepEqual(v.kind === 'unmet' ? v.failed : [], ['artifact-read-back'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a read-back of the WRONG file does not satisfy the objective', async () => {
  const { dir, out, file } = workspace(BODY)
  try {
    const otherPath = join(out, 'other.md')
    writeFileSync(otherPath, BODY, 'utf8')
    const elsewhere = await verify(out, otherPath, BODY)
    const declared: readonly ObjectivePostcondition[] = [{ kind: 'artifact-read-back', path: file }]
    assert.equal(objectiveVerdict(declared, { confirm: elsewhere }).kind, 'unmet',
      'canonical paths mean a different file is a different file')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the verifier still REJECTS rather than inventing evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mc-ev-rej-'))
  try {
    const out = join(dir, 'out'); mkdirSync(out, { recursive: true })
    const v = makeReadBackVerifier(out)
    const missing = await v.verify(step('filesystem.read'), {} as ToolContext, { path: join(out, 'nope.md') })
    assert.ok('rejected' in missing, 'a file that is not there produces no evidence')

    const empty = join(out, 'empty.md'); writeFileSync(empty, '   \n', 'utf8')
    const blank = await v.verify(step('filesystem.read'), {} as ToolContext, { path: empty })
    assert.ok('rejected' in blank, 'nor does one with nothing in it')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ============================================================ THE REPO-WIDE INVARIANT

test('no evidence producer in live/ decorates its path field', () => {
  // The guard that would have caught this the first time. Scans the producers for the pattern that
  // broke three of them: a `path:` value carrying interpolated prose rather than an operand.
  //
  // Deliberately a source scan rather than a behavioural one - a producer that only misbehaves for
  // paths containing parentheses would pass every behavioural test.
  // Resolved from this module's own URL rather than `import.meta.dirname`, which is not populated
  // under type-stripping and silently produced a path at the REPOSITORY ROOT - the scan then read
  // nothing and passed vacuously.
  const dir = fileURLToPath(new URL('../live/', import.meta.url))
  const offenders: string[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ts') || f.startsWith('run-')) continue
    const src = readFileSync(join(dir, f), 'utf8')
    // A `path:` whose value is a template literal containing a space or a bracket inside the
    // interpolation - i.e. prose glued onto an operand.
    for (const m of src.matchAll(/path:\s*`\$\{[^}]*\}[^`]*[ (\[]/g)) {
      offenders.push(`${f}: ${m[0].slice(0, 80)}`)
    }
  }
  assert.deepEqual(offenders, [], `evidence path fields must hold a path:\n  ${offenders.join('\n  ')}`)
})
