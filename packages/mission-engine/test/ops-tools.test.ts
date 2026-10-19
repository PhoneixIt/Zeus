/**
 * M31 CONTROLS - governed filesystem operations.
 * =============================================================================
 *
 * Four operations, and the tests are weighted by consequence rather than by count. `search` cannot
 * destroy anything, so it gets the least attention. `move` removes a file from its current location,
 * so it gets the most: the scope check, the approval requirement, and the refusal to overwrite.
 *
 * Every test here pins the REFUSAL REASON, not merely a failure status. A control that fails for
 * the wrong reason is worse than no control at all - it reads as coverage while measuring nothing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, symlinkSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  searchFiles, planMkdir, planTransfer, fsOpsRegistration, fsOpsVerifier, confine,
  MAX_SEARCH_RESULTS, MAX_OP_BYTES, filesAreIdentical,
} from '../live/ops-tools.ts'
import type { Step } from '../state.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'aios-m31-'))
process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* held */ } })

const OUTSIDE = mkdtempSync(join(tmpdir(), 'aios-m31-out-'))
process.on('exit', () => { try { rmSync(OUTSIDE, { recursive: true, force: true }) } catch { /* held */ } })

let n = 0
const fresh = (sub = ''): string => {
  const p = join(ROOT, `t${n++}${sub ? '/' + sub : ''}`)
  mkdirSync(sub ? join(ROOT, `t${n - 1}`, sub) : p, { recursive: true })
  return p
}
const step = (tool: string, args: Record<string, unknown>): Step =>
  ({ id: 's', tool, args, mode: 'filesystem' } as unknown as Step)

// ============================================================================================
// SCOPE - the rule that every operation shares
// ============================================================================================

test('CONTROL: traversal is refused AFTER resolution, not by string inspection', () => {
  // The naive check would be `".."` in the string. These paths must be caught by RESOLVING them.
  for (const bad of [
    join(ROOT, '..', 'escape.js'),
    join(ROOT, 'sub', '..', '..', 'escape.js'),
    join(ROOT, 'a', 'b', '..', '..', '..', '..', 'Windows', 'win.ini'),
  ]) {
    const r = confine(ROOT, bad)
    assert.ok('error' in r, `${bad} must be refused`)
    assert.match(r.error, /outside the workspace root/, r.error)
  }
})

test('CONTROL: a RELATIVE path is refused outright', () => {
  // A relative path has no trusted root until someone picks one, and picking one here would let the
  // step choose the workspace.
  const r = confine(ROOT, 'sub/file.js')
  assert.ok('error' in r)
  assert.match(r.error, /refusing a relative/, r.error)
})

test('a path inside the root is accepted', () => {
  const inside = confine(ROOT, join(ROOT, 'sub', 'ok.js'))
  assert.ok('path' in inside, 'a legitimate in-scope path must be accepted')
  assert.equal(inside.path, join(ROOT, 'sub', 'ok.js'))
})

test('the root ITSELF is in scope - refusing it would break every relative listing', () => {
  const r = confine(ROOT, ROOT)
  assert.ok('path' in r, 'the root must be usable as a search base')
})

test('a sibling directory sharing the root PREFIX is out of scope', () => {
  // `C:\a\root` vs `C:\a\root-sibling`. A prefix string comparison gets this exactly wrong, which
  // is why containment is tested on the resolved path with a separator.
  const sibling = ROOT + '-sibling'
  mkdirSync(sibling, { recursive: true })
  const r = confine(ROOT, join(sibling, 'x.js'))
  assert.ok('error' in r, `a prefix-sharing sibling must be refused: ${sibling}`)
  assert.match(r.error, /outside the workspace root/, r.error)
  rmSync(sibling, { recursive: true, force: true })
})

// ============================================================================================
// SEARCH
// ============================================================================================

test('search finds by name, recursively', () => {
  const d = fresh()
  mkdirSync(join(d, 'a', 'b'), { recursive: true })
  writeFileSync(join(d, 'a', 'b', 'config.json'), '{}', 'utf8')
  writeFileSync(join(d, 'other.txt'), 'x', 'utf8')
  const r = searchFiles(ROOT, { path: d, pattern: 'config' })
  assert.ok(r.ok)
  assert.equal(r.hits.length, 1)
  assert.equal(r.hits[0]!.relative, join('a', 'b', 'config.json'))
})

test('search finds by content and reports the matching line numbers', () => {
  const d = fresh()
  writeFileSync(join(d, 'a.ts'), 'line one\nconst NEEDLE = 1\nline three\n', 'utf8')
  writeFileSync(join(d, 'b.ts'), 'nothing here\n', 'utf8')
  const r = searchFiles(ROOT, { path: d, pattern: 'needle', mode: 'content' })
  assert.ok(r.ok)
  assert.equal(r.hits.length, 1)
  assert.deepEqual([...(r.hits[0]!.lines ?? [])], [2], 'the line number must be real, not invented')
})

test('CONTROL: search does not follow symlinks out of the workspace', () => {
  // The scope check is on the PATH. A symlink resolves elsewhere, so following it would defeat the
  // check completely - this is the single most important negative in the file.
  const d = fresh()
  const secret = join(OUTSIDE, 'secret.txt')
  writeFileSync(secret, 'TOKEN', 'utf8')
  let made = true
  try { symlinkSync(OUTSIDE, join(d, 'escape'), 'junction') } catch { made = false }
  if (!made) return // Windows refused the link; nothing to assert.
  writeFileSync(join(d, 'local.txt'), 'safe', 'utf8')
  const r = searchFiles(d, { path: d, pattern: 'secret', mode: 'content' })
  assert.ok(r.ok)
  assert.equal(r.hits.length, 0, 'a symlink must not become a window out of the workspace')
})

test('CONTROL: search is BOUNDED, and says so when it truncates', () => {
  const d = fresh()
  // More files than the cap, so the cap is what stops the search rather than the input running out.
  for (let i = 0; i < MAX_SEARCH_RESULTS + 20; i += 1) writeFileSync(join(d, `hit-${i}.txt`), 'x', 'utf8')
  const r = searchFiles(ROOT, { path: d, pattern: 'hit-' })
  assert.ok(r.ok)
  assert.equal(r.hits.length, MAX_SEARCH_RESULTS, 'the result cap must actually cap')
  assert.equal(r.truncated, true, 'a truncated search must REPORT being truncated')
  assert.ok(r.visited > 0, 'the walk must have actually visited nodes')
})

test('a search rooted outside the workspace is refused', () => {
  const r = searchFiles(ROOT, { path: OUTSIDE, pattern: 'x' })
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /outside the workspace root/, (r as { reason: string }).reason)
})

test('an empty pattern is refused rather than matching everything', () => {
  const r = searchFiles(ROOT, { pattern: '   ' })
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /no search pattern/, (r as { reason: string }).reason)
})

test('a content search skips binary and unsupported types instead of failing', () => {
  const d = fresh()
  writeFileSync(join(d, 'a.ts'), 'needle', 'utf8')
  writeFileSync(join(d, 'b.exe'), 'needle', 'utf8')
  const r = searchFiles(ROOT, { path: d, pattern: 'needle', mode: 'content' })
  assert.ok(r.ok)
  assert.equal(r.hits.length, 1, 'only the text file should match')
  assert.equal(r.hits[0]!.relative, 'a.ts')
})

// ============================================================================================
// MKDIR
// ============================================================================================

test('mkdir plans a creation, and reports an existing directory as NOT created', () => {
  const d = fresh()
  const p = planMkdir(ROOT, { path: join(d, 'sub') })
  assert.ok(p.ok && p.created, 'a new directory must be planned as created')
  // `planMkdir` PLANS; it does not create. Creating is the tool's job at run time, so the directory is
  // made here explicitly - otherwise the second call would plan a creation again and the "reused"
  // branch would never be reached, and a test that never reaches the branch it names proves nothing.
  mkdirSync(join(d, 'sub'))
  const again = planMkdir(ROOT, { path: join(d, 'sub') })
  assert.ok(again.ok && again.created === false,
    'an existing directory must be reported as reused, never as created')
})

test('CONTROL: mkdir onto an existing FILE is refused, not treated as a reuse', () => {
  const d = fresh()
  const f = join(d, 'notadir')
  writeFileSync(f, 'x', 'utf8')
  const r = planMkdir(ROOT, { path: f })
  assert.equal(r.ok, false, 'a file is not a directory')
  assert.match((r as { reason: string }).reason, /not a directory/, (r as { reason: string }).reason)
})

test('CONTROL: mkdir outside the workspace is refused', () => {
  const r = planMkdir(ROOT, { path: join(OUTSIDE, 'nope') })
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /outside the workspace root/, (r as { reason: string }).reason)
})

// ============================================================================================
// COPY and MOVE - the shared transfer plan
// ============================================================================================

const srcFixture = (): string => {
  const d = fresh()
  const f = join(d, 'src.ts')
  writeFileSync(f, 'export const A = 1\n', 'utf8')
  return f
}

test('copy plans a transfer that leaves the source alone', () => {
  const src = srcFixture()
  const r = planTransfer('copy', ROOT, { from: src, to: join(ROOT, 'dst.ts') })
  assert.ok(r.ok)
  assert.equal(r.plan.op, 'copy')
  assert.equal(r.plan.from, src)
})

test('CONTROL: an existing destination is REFUSED, never overwritten', () => {
  // The single most important refusal here. `overwrite` is not offered as a flag, and this test is
  // why that is defensible rather than merely cautious.
  const src = srcFixture()
  const dst = join(ROOT, 'exists.ts')
  writeFileSync(dst, 'ORIGINAL', 'utf8')
  const r = planTransfer('copy', ROOT, { from: src, to: dst })
  assert.equal(r.ok, false)
  const reason = (r as { reason: string }).reason
  assert.match(reason, /refusing to overwrite/, reason)
  assert.match(reason, /decision for a human/, 'the refusal must say WHO decides, not just that it failed')
  assert.equal(readFileSync(dst, 'utf8'), 'ORIGINAL', 'and the destination must be untouched')
})

test('CONTROL: a missing source is refused', () => {
  const r = planTransfer('copy', ROOT, { from: join(ROOT, 'nope.ts'), to: join(ROOT, 'dst.ts') })
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /no source at/, (r as { reason: string }).reason)
})

test('CONTROL: source and destination being the same file is refused', () => {
  const src = srcFixture()
  const r = planTransfer('move', ROOT, { from: src, to: src })
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /same file/, (r as { reason: string }).reason)
})

test('CONTROL: a destination whose folder does not exist is refused', () => {
  const src = srcFixture()
  const r = planTransfer('copy', ROOT, { from: src, to: join(ROOT, 'no-such-folder', 'dst.ts') })
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /destination folder/, (r as { reason: string }).reason)
})

test('CONTROL: a directory is refused - transferring one is a different capability', () => {
  const d = fresh()
  mkdirSync(join(d, 'adir'), { recursive: true })
  const r = planTransfer('copy', ROOT, { from: join(d, 'adir'), to: join(ROOT, 'bdir') })
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /not a file/, (r as { reason: string }).reason)
})

test('CONTROL: an oversized source is refused - above this it is a bulk transfer', () => {
  const d = fresh()
  const f = join(d, 'big.ts')
  writeFileSync(f, Buffer.alloc(MAX_OP_BYTES + 1, 0x61))
  const r = planTransfer('copy', ROOT, { from: f, to: join(ROOT, 'big2.ts') })
  assert.equal(r.ok, false)
  assert.match((r as { reason: string }).reason, /above the/, (r as { reason: string }).reason)
})

test('CONTROL: transfer is refused when either end escapes the workspace', () => {
  const src = srcFixture()
  const outside = join(OUTSIDE, 'dst.ts')
  const badTo = planTransfer('copy', ROOT, { from: src, to: outside })
  assert.equal(badTo.ok, false)
  assert.match((badTo as { reason: string }).reason, /outside the workspace root/, (badTo as { reason: string }).reason)
  const badFrom = planTransfer('copy', ROOT, { from: join(OUTSIDE, 'src.ts'), to: join(ROOT, 'd.ts') })
  assert.equal(badFrom.ok, false)
  assert.match((badFrom as { reason: string }).reason, /outside the workspace root/, (badFrom as { reason: string }).reason)
})

// ============================================================================================
// EFFECT DECLARATIONS AND APPROVAL
// ============================================================================================

const reg = (name: string) => fsOpsRegistration({ workspaceRoot: ROOT }).find((r) => r.tool.name === name)!

test('CONTROL: `move` declares a `delete` effect on the SOURCE - it is the only one that can lose work', () => {
  const src = srcFixture()
  const r = reg('move-file')
  assert.ok(r.effectOf, 'move MUST declare an effect, or it needs no approval and destroys files')
  const e = r.effectOf!(step('move-file', { from: src, to: join(ROOT, 'moved.ts') }))
  assert.ok(e, 'an effect must be produced for a legal move')
  assert.equal(e!.kind, 'delete')
  assert.equal(e!.target, src, 'the effect targets what DISAPPEARS, not what appears')
  assert.match(e!.reason, /REMOVES/, 'the reason must say the source is destroyed')
  assert.equal(e!.irreversible, false, 'a move is recoverable by moving it back')
})

test('CONTROL: `move` on an ILLEGAL operation declares NO effect', () => {
  // An effect on something that will not run would put an approval request in front of a human for
  // an action the machine was always going to refuse.
  const r = reg('move-file')
  assert.equal(r.effectOf!(step('move-file', { from: join(ROOT, 'nope.ts'), to: join(ROOT, 'd.ts') })), undefined)
  assert.equal(r.effectOf!(step('move-file', { from: join(OUTSIDE, 's.ts'), to: join(ROOT, 'd.ts') })), undefined)
})

test('CONTROL: `copy` declares NO effect - it is additive and refuses to overwrite', () => {
  const r = reg('copy-file')
  assert.equal(r.effectOf, undefined,
    'copy must not need approval: it cannot destroy anything existing, and reflexive approval trains people to approve reflexively')
})

test('CONTROL: `search` declares NO effect and has no preflight that could block it', () => {
  const r = reg('search-files')
  assert.equal(r.effectOf, undefined, 'reading a filename is not a change to the world')
  assert.equal(r.preflight, undefined, 'search needs no gate: it changes nothing')
})

test('`mkdir` has a preflight that refuses an illegal path', () => {
  const r = reg('make-directory')
  assert.ok(r.preflight, 'mkdir must be gated against out-of-scope paths')
  const blocked = r.preflight!(step('make-directory', { path: join(OUTSIDE, 'x') }))
  assert.ok(blocked, 'an out-of-scope mkdir must be blocked')
  assert.match(blocked!.blocked, /outside the workspace root/, blocked!.blocked)
  assert.equal(blocked!.needsHuman, false, 'a policy refusal must NOT be unlockable by a human')
})

test('`move` and `copy` preflight refuse before anything runs', async () => {
  for (const [tool, reason] of [['move-file', /move refused/], ['copy-file', /copy refused/]] as const) {
    const r = reg(tool)
    const blocked = r.preflight!(step(tool, { from: join(ROOT, 'nope.ts'), to: join(ROOT, 'd.ts') }))
    assert.ok(blocked, `${tool} must block a missing source`)
    assert.match(blocked!.blocked, reason, blocked!.blocked)
    assert.equal(blocked!.needsHuman, false)
  }
})

// ============================================================================================
// INDEPENDENT VERIFICATION - re-read the world
// ============================================================================================

const V = fsOpsVerifier({ workspaceRoot: ROOT })

/**
 * Normalise a verifier verdict into one shape the assertions can read.
 *
 * The verdict is a DISCRIMINATED UNION - `{ evidence }` or `{ rejected }`, never both - which is
 * correct and load-bearing, because it means a verifier cannot simultaneously claim proof and a
 * refusal. Reading it directly at every assertion site would repeat that branch thirty times, so it
 * is widened once, in one named place, rather than cast inline.
 */
async function verdict(p: Promise<unknown>): Promise<{ rejected?: string; evidence?: unknown }> {
  return (await p) as { rejected?: string; evidence?: unknown }
}

test('verifier re-runs the search and rejects an invented hit', async () => {
  // A tool that claims a file it never found is the failure this catches. Reporting the count alone
  // would let a fabricated result pass whenever the real count happened to match.
  const d = fresh()
  writeFileSync(join(d, 'real.txt'), 'x', 'utf8')
  const args = { path: d, pattern: 'real' }
  const lied = await verdict(V.verify(step('search-files', args), {} as never, {
    hits: [{ path: join(d, 'real.txt') }, { path: join(d, 'ghost.txt') }], count: 2,
  }))
  assert.ok(lied.rejected, 'an invented hit must be rejected')
  assert.match(lied.rejected!, /did not find|independent search found/, lied.rejected!)
  const honest = await verdict(V.verify(step('search-files', args), {} as never, { hits: [{ path: join(d, 'real.txt') }], count: 1 }))
  assert.ok(honest.evidence, 'an honest result must be accepted: ' + (honest.rejected ?? ''))
})

test('CONTROL: verifier rejects a "copy" that LOST the source', async () => {
  // A copy presented as a copy but which moved the file is the exact defect, and checking only the
  // destination would pass it.
  const d = fresh()
  const src = join(d, 's.ts')
  writeFileSync(src, 'body', 'utf8')
  const dst = join(d, 't.ts')
  writeFileSync(dst, 'body', 'utf8')
  rmSync(src)
  const v = await verdict(V.verify(step('copy-file', { from: src, to: dst }), {} as never, { from: src, to: dst, bytes: 4 }))
  assert.ok(v.rejected, 'a copy must leave the source in place')
  assert.match(v.rejected!, /must LEAVE the source/, v.rejected!)
})

test('CONTROL: verifier rejects a "move" that only COPIED', async () => {
  const d = fresh()
  const src = join(d, 'm.ts')
  const dst = join(d, 'n.ts')
  writeFileSync(src, 'body', 'utf8')
  writeFileSync(dst, 'body', 'utf8')
  const v = await verdict(V.verify(step('move-file', { from: src, to: dst }), {} as never, { from: src, to: dst, bytes: 4 }))
  assert.ok(v.rejected, 'a move must remove the source')
  assert.match(v.rejected!, /must REMOVE the source/, v.rejected!)
  assert.ok(existsSync(src), 'and the refusal must not have deleted anything')
})

test('CONTROL: verifier rejects a transfer that never happened', async () => {
  const d = fresh()
  const src = join(d, 'x.ts')
  writeFileSync(src, 'body', 'utf8')
  const v = await verdict(V.verify(step('copy-file', { from: src, to: join(d, 'missing.ts') }), {} as never,
    { from: src, to: join(d, 'missing.ts'), bytes: 4 }))
  assert.ok(v.rejected)
  assert.match(v.rejected!, /nothing at the destination/, v.rejected!)
})

test('CONTROL: verifier rejects a truncated or short-copied destination', async () => {
  const d = fresh()
  const src = join(d, 'p.ts')
  const dst = join(d, 'q.ts')
  writeFileSync(src, 'twelve chars', 'utf8')
  writeFileSync(dst, 'short', 'utf8')
  const v = await verdict(V.verify(step('copy-file', { from: src, to: dst }), {} as never, { from: src, to: dst, bytes: 12 }))
  assert.ok(v.rejected, 'a size mismatch is a failed copy')
  assert.match(v.rejected!, /bytes but the source was reported/, v.rejected!)
})

test('CONTROL: verifier re-derives both paths from the STEP, not the tool report', async () => {
  // A tool that transfers one file and reports two others must not verify. The step is the request;
  // the tool's report is only a claim.
  const d = fresh()
  const src = join(d, 'r.ts')
  const other = join(d, 's.ts')
  const decoy = join(d, 'decoy.ts')
  writeFileSync(src, 'x', 'utf8')
  writeFileSync(other, 'y', 'utf8')
  writeFileSync(decoy, 'x', 'utf8')
  const v = await verdict(V.verify(step('copy-file', { from: src, to: join(d, 'new.ts') }), {} as never,
    { from: src, to: decoy, bytes: 1 }))
  assert.ok(v.rejected, 'verifying a destination the step never asked for must be refused')
  assert.match(v.rejected!, /nothing at the destination/, v.rejected!)
})

test('CONTROL: the verifier refuses to verify an out-of-scope operation', async () => {
  const v = await verdict(fsOpsVerifier({ workspaceRoot: ROOT }).verify(
    step('copy-file', { from: join(OUTSIDE, 'a.ts'), to: join(ROOT, 'b.ts') }), {} as never,
    { from: join(OUTSIDE, 'a.ts'), to: join(ROOT, 'b.ts'), bytes: 1 }))
  assert.ok(v.rejected, 'verification must refuse a path the workspace does not cover')
  assert.match(v.rejected!, /refused to verify/, v.rejected!)
})

test('an honest copy and an honest move both verify', async () => {
  const d = fresh()
  const src = join(d, 'honest.ts')
  writeFileSync(src, 'good body', 'utf8')
  const cdst = join(d, 'honest-copy.ts')
  const bytes = statSync(src).size
  writeFileSync(cdst, readFileSync(src))
  const c = await verdict(V.verify(step('copy-file', { from: src, to: cdst }), {} as never, { from: src, to: cdst, bytes }))
  assert.ok(c.evidence, 'an honest copy must verify: ' + (c.rejected ?? ''))
  assert.ok(existsSync(src), 'and the source must still be there')

  const mdst = join(d, 'honest-move.ts')
  writeFileSync(mdst, readFileSync(src))
  rmSync(src)
  const m = await verdict(V.verify(step('move-file', { from: src, to: mdst }), {} as never, { from: src, to: mdst, bytes }))
  assert.ok(m.evidence, 'an honest move must verify: ' + (m.rejected ?? ''))
})

test('mkdir verification requires a real DIRECTORY, not merely a path that exists', async () => {
  const d = fresh()
  const asFile = join(d, 'looks-like')
  writeFileSync(asFile, 'x', 'utf8')
  const v = await verdict(V.verify(step('make-directory', { path: asFile }), {} as never, { path: asFile }))
  assert.ok(v.rejected, 'a file is not a directory')
  assert.match(v.rejected!, /not a directory/, v.rejected!)
})

test('filesAreIdentical compares CONTENT, and refuses a missing file', () => {
  const d = fresh()
  const a = join(d, 'a.txt')
  const b = join(d, 'b.txt')
  writeFileSync(a, 'same', 'utf8')
  writeFileSync(b, 'same', 'utf8')
  assert.equal(filesAreIdentical(a, b), true)
  writeFileSync(b, 'different', 'utf8')
  assert.equal(filesAreIdentical(a, b), false)
  assert.equal(filesAreIdentical(a, join(d, 'gone.txt')), false, 'a missing file is not identical to anything')
})
