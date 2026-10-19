/**
 * A failed mission must not be able to destroy a verified deliverable.
 *
 * These tests exercise the REAL write path - `write-file`'s own `run` - against the REAL
 * `validatePlan`, with no mock and no substitute implementation. A guard that only exists in a test
 * double is a guard that does not exist.
 *
 * THE INCIDENT BEING LOCKED DOWN. On 2026-10-19 a NAKIVO mission produced a correct 407-row
 * inventory, which I verified independently (row count matched a fresh enumeration, byte total
 * matched exactly at 941,397,427, spot-checks agreed). A LATER mission then resolved to the same
 * filename and overwrote it with PYTHON SOURCE. The verified artifact was gone.
 *
 * Nothing detected it:
 *   - `write-file` had no existence check; `writeFileSync` truncates silently.
 *   - `writeFileVerifier` compares the on-disk size to the size THE TOOL JUST RECORDED, so an
 *     overwrite verifies as a correct write of the wrong bytes.
 *   - `objectiveVerdict` matches evidence by path string, so a read-back of the clobbered file
 *     satisfied the original goal's `artifact-exists`.
 *
 * So the tests below assert the thing that was missing: that the protected file is BYTE-IDENTICAL
 * afterwards. Every protection test records the original SHA-256 and re-asserts it, because "the
 * mission failed" is not evidence that nothing was damaged - the whole failure was a mission that
 * reported failure while damaging something.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { validatePlan } from '../live/agent/agent.ts'
import {
  buildArtifactContract, contentLooksWrongFor, auditArtifactReferences, authorizeWrite,
  sha256Text, artifactKindFor,
} from '../live/agent/artifacts.ts'
import { resolveCapability } from '../live/agent/capabilities.ts'

/**
 * Run the real `write-file` tool. No mock: this is the code that touches the disk.
 *
 * Resolved through `resolveCapability` - the same lookup the live agent loop uses - so the test
 * exercises the registry entry a mission actually gets, not a local copy of the tool object.
 */
async function runWriteFile(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cap = resolveCapability('write-file')
  assert.ok(!('unavailable' in cap), 'write-file must be available in the real registry')
  const tool = (cap as { tool: { run: (ctx: unknown, a: unknown) => Promise<unknown> } }).tool
  return await tool.run({ prior: [], missionId: 'test-mission' }, args) as never
}

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex')

/** A directory the tests own completely, inside the agent output root the real tools accept. */
function fixtureDir(): string {
  const d = mkdtempSync(join(process.env.USERPROFILE ?? tmpdir(), '.aios', 'agent', 'out', 'fx-'))
  mkdirSync(d, { recursive: true })
  return d
}

// ===========================================================================================
// 1. THE PROTECTED FILE: an existing verified output must survive a failing mission
// ===========================================================================================

test('an existing deliverable is byte-identical after a refused overwrite', async () => {
  const dir = fixtureDir()
  try {
    const target = join(dir, 'inventory.csv')
    // A finished deliverable, exactly as a previous mission left it.
    const GOOD = '"Path","Size"\n"a.txt","10"\n"b.txt","20"\n'
    writeFileSync(target, GOOD, 'utf8')
    const originalSha = sha(readFileSync(target))

    // A later mission tries to write a DIFFERENT artifact to the same destination.
    const res = await runWriteFile({ path: target, content: 'import os\nprint("clobber")\n' })

    assert.equal(res.kind, 'failed', 'writing over an existing deliverable must be refused')
    assert.match(String(res.reason), /refusing to overwrite/i,
      'the refusal must name the reason a reader can act on')

    // The assertion that matters: the damage did not happen.
    assert.equal(sha(readFileSync(target)), originalSha,
      'the protected deliverable changed after a refused overwrite')
    assert.equal(readFileSync(target, 'utf8'), GOOD,
      'the protected deliverable\'s CONTENT changed after a refused overwrite')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a script cannot be written to a .csv destination', async () => {
  const dir = fixtureDir()
  try {
    // The exact shape of the real damage: a Python program aimed at the CSV path. Note the file
    // does NOT exist yet - so this is not an overwrite check doing the work, it is the content-kind
    // check refusing a write that would have been accepted silently.
    const target = join(dir, 'nakivo-scan.csv')
    const res = await runWriteFile({
      path: target,
      content: 'import os, csv, datetime\n\nfor dp, dn, fn in os.walk(base):\n    print(dp)\n',
    })

    assert.equal(res.kind, 'failed', 'Python source must not be written to a .csv destination')
    assert.match(String(res.reason), /csv/i)
    assert.equal(existsSync(target), false,
      'the refused write must not have created the file at all')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a legitimate CSV write to a new path still succeeds', async () => {
  // The guard must not have made writing impossible. A control, without which "refuses everything"
  // would pass every test above.
  const dir = fixtureDir()
  try {
    const target = join(dir, 'good.csv')
    const res = await runWriteFile({ path: target, content: '"A","B"\n"1","2"\n' })
    assert.equal(res.kind, 'data', 'a valid CSV to a new path must be written')
    assert.equal(readFileSync(target, 'utf8'), '"A","B"\n"1","2"\n')
    assert.ok(res.data && typeof res.data === 'object' && 'sha256' in (res.data as object),
      'a successful write must record the hash of what it wrote')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no staging file survives a successful write', async () => {
  const dir = fixtureDir()
  try {
    const target = join(dir, 'staged.csv')
    await runWriteFile({ path: target, content: '"A"\n"1"\n' })
    const strays = readdirSync(dir).filter((f) => f.includes('.staging') || f.endsWith('.tmp'))
    assert.deepEqual(strays, [], `staging files left behind: ${strays.join(', ')}`)
    assert.deepEqual(readdirSync(dir), ['staged.csv'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ===========================================================================================
// 2. THE PLAN: a write step with no declared destination
// ===========================================================================================

test('a plan whose later step runs a file no step produces is refused', () => {
  // The observed shape. The write step declares NO path, the goal names a CSV, so validation puts
  // the CSV path on it - and the script a LATER step runs is now something nobody creates. The
  // per-step guard cannot see this, because the write step had no filename of its own to protect.
  const csv = 'C:\\Users\\Samer\\.aios\\agent\\out\\nakivo-scan.csv'
  const v = validatePlan(
    {
      reply: '',
      model: 'test',
      steps: [
        { id: 's1', intent: 'write the scanner script', tool: 'write-file', args: { content: 'x=1\n' } },
        {
          id: 's2',
          intent: 'run the scanner to produce the CSV',
          tool: 'terminal',
          args: { command: 'python C:\\Users\\Samer\\.aios\\agent\\out\\scan_nakivo.py' },
        },
      ],
    },
    `save a CSV inventory to ${csv}`,
  )

  const dangling = v.refusals.filter((r) => /scan_nakivo\.py/.test(r))
  assert.ok(dangling.length > 0,
    'a plan that runs a file no step produces must be refused. refusals were: '
    + JSON.stringify(v.refusals))
})

test('the contract refuses two steps writing the same destination', () => {
  const dir = fixtureDir()
  try {
    const p = join(dir, 'same.csv')
    const c = buildArtifactContract([
      { id: 's1', intent: 'write', tool: 'write-file', args: { path: p, content: 'a' } },
      { id: 's2', intent: 'write again', tool: 'write-file', args: { path: p, content: 'b' } },
    ], null, dir)
    assert.ok(c.refusals.some((r) => /both write/i.test(r)),
      'two producers of one destination must be refused')
    assert.equal(c.artifacts.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ===========================================================================================
// 3. THE CONTRACT: identity, kind, and authorization
// ===========================================================================================

test('an artifact record carries identity, kind, and the pre-existing hash', () => {
  const dir = fixtureDir()
  try {
    const p = join(dir, 'present.csv')
    writeFileSync(p, '"A"\n"1"\n', 'utf8')
    const c = buildArtifactContract(
      [{ id: 's1', intent: 'w', tool: 'write-file', args: { path: p, content: 'x' } }],
      p, dir,
    )
    assert.equal(c.artifacts.length, 1)
    const a = c.artifacts[0]!
    assert.equal(a.id, 'artifact-1')
    assert.equal(a.kind, 'csv')
    assert.equal(a.producingStepId, 's1')
    assert.equal(a.existedBefore, true)
    assert.equal(a.preExistingSha256, sha('"A"\n"1"\n'),
      'the pre-existing hash must be recorded so a failure can prove it did not change')
    assert.equal(a.overwrite, 'never',
      'overwrite authority must default to never - nothing asks a person to approve a destination')
    assert.equal(a.requestedPath, p, 'the requested path is carried when it matches')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('authorizeWrite refuses an existing artifact and allows a fresh one', () => {
  const dir = fixtureDir()
  try {
    const present = join(dir, 'here.csv')
    const fresh = join(dir, 'new.csv')
    writeFileSync(present, '"A"\n"1"\n', 'utf8')
    const c = buildArtifactContract([
      { id: 's1', intent: 'a', tool: 'write-file', args: { path: present } },
      { id: 's2', intent: 'b', tool: 'write-file', args: { path: fresh } },
    ], null, dir)

    assert.match(String(authorizeWrite({ path: present, stepId: 's1', contract: c })), /refusing to overwrite/i)
    assert.equal(authorizeWrite({ path: fresh, stepId: 's2', contract: c }), null,
      'a fresh destination must be allowed')
    assert.match(String(authorizeWrite({ path: join(dir, 'undeclared.csv'), stepId: 's3', contract: c })),
      /not an artifact this plan declared/i,
      'writing to a path the plan never declared must be refused')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an artifact id that was never issued is refused', () => {
  const dir = fixtureDir()
  try {
    const p = join(dir, 'x.csv')
    const v = validatePlan(
      {
        reply: '', model: 'test',
        steps: [
          { id: 's1', intent: 'write', tool: 'write-file', args: { path: p, content: '"A"\n"1"\n' } },
          { id: 's2', intent: 'read it back', tool: 'read-file', args: { path: p, deliverableId: 'deliverable-99' } },
        ],
      },
      'save a report',
    )
    assert.ok(v.refusals.some((r) => /deliverable-99/.test(r)),
      'a read-back naming an id that was never issued must be refused')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ===========================================================================================
// 4. CONTENT KIND
// ===========================================================================================

test('content kind is judged by extension', () => {
  assert.equal(artifactKindFor('a.csv'), 'csv')
  assert.equal(artifactKindFor('a.CSV'), 'csv')
  assert.equal(artifactKindFor('a.json'), 'json')
  assert.equal(artifactKindFor('a.txt'), 'text')
  assert.equal(artifactKindFor('a.bin'), 'binary-or-other')
})

test('Python, JavaScript, and assignment-only content are refused at .csv destinations', () => {
  const csv = 'C:\\out\\thing.csv'
  assert.ok(contentLooksWrongFor(csv, 'import os\nfor x in y:\n    print(x)\n'))
  assert.ok(contentLooksWrongFor(csv, 'def main():\n    return 1\n'))
  assert.ok(contentLooksWrongFor(csv, '#!/usr/bin/env python\nprint(1)\n'))
  assert.ok(contentLooksWrongFor(csv, 'const a = require("fs")\nmodule.exports = a\n'))
  assert.ok(contentLooksWrongFor(csv, 'OUT = "x.csv"\nfound = None\n'), 'bare assignments are not rows')

  // Controls. These MUST pass, or the guard has simply stopped writing files.
  assert.equal(contentLooksWrongFor(csv, '"RelativePath","Size"\n"a.txt","10"\n'), null)
  assert.equal(contentLooksWrongFor(csv, 'name,size\na.txt,10\n'), null)
  assert.equal(contentLooksWrongFor('C:\\out\\notes.txt', 'import os\nprint(1)\n'), null,
    'a .txt destination is not a CSV and must not be judged as one')
})

test('JSON destinations must begin like JSON', () => {
  const j = 'C:\\out\\thing.json'
  assert.ok(contentLooksWrongFor(j, '"a","b"\n'))
  assert.equal(contentLooksWrongFor(j, '{"a":1}'), null)
  assert.equal(contentLooksWrongFor(j, '[1,2,3]'), null)
})

// ===========================================================================================
// 5. REFERENCES, TWO MISSIONS, AND THE SURVIVING-HASH PROPERTY
// ===========================================================================================

test('a reference to an existing file is not a dangling reference', () => {
  const dir = fixtureDir()
  try {
    const existing = join(dir, 'already.py')
    writeFileSync(existing, 'print(1)\n', 'utf8')
    const r = auditArtifactReferences(
      [{ id: 's1', intent: 'run it', tool: 'terminal', args: { command: `python ${existing}` } }],
      new Map(), dir,
    )
    assert.deepEqual(r, [], 'reading a file that already exists is legitimate')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two missions producing similarly named artifacts do not confuse each other', () => {
  const dir = fixtureDir()
  try {
    const a1 = join(dir, 'report.csv')
    const b1 = join(dir, 'report-2.csv')
    const c1 = buildArtifactContract(
      [{ id: 's1', intent: 'a', tool: 'write-file', args: { path: a1 } }], a1, dir)
    const c2 = buildArtifactContract(
      [{ id: 's1', intent: 'b', tool: 'write-file', args: { path: b1 } }], b1, dir)

    assert.equal(c1.artifacts[0]!.resolvedPath.toLowerCase(), a1.toLowerCase())
    assert.equal(c2.artifacts[0]!.resolvedPath.toLowerCase(), b1.toLowerCase())
    // Neither mission's contract knows anything about the other's destination.
    assert.match(String(authorizeWrite({ path: b1, stepId: 's1', contract: c1 })),
      /not an artifact this plan declared/i,
      'mission one must not be able to write mission two\'s destination')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a successful write followed by failed verification leaves the file intact', async () => {
  const dir = fixtureDir()
  try {
    const target = join(dir, 'deliverable.csv')
    const res = await runWriteFile({ path: target, content: '"A","B"\n"1","2"\n' })
    assert.equal(res.kind, 'data')
    const afterWrite = sha(readFileSync(target))

    // Verification fails afterwards. Nothing may touch the file in response.
    const failedVerify = await runWriteFile({ path: target, content: '"A"\n"z"\n' })
    assert.equal(failedVerify.kind, 'failed')
    assert.equal(sha(readFileSync(target)), afterWrite,
      'a failed retry must not have altered the already-written deliverable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sha256Text agrees with the hash of the bytes written', async () => {
  const dir = fixtureDir()
  try {
    const target = join(dir, 'h.csv')
    const content = '"A"\n"1"\n'
    const res = await runWriteFile({ path: target, content })
    assert.equal(res.kind, 'data')
    const reported = (res.data as { sha256: string }).sha256
    assert.equal(reported, sha(readFileSync(target)))
    assert.equal(reported, sha256Text(content))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})