/**
 * M28 CONTROLS - rollback, the recovery primitive.
 * =============================================================================
 *
 * `filesystem.edit` claims its changes are reversible because it writes a backup. Until this
 * capability existed nothing could act on that backup, so the claim was unbacked. These tests pin
 * what rollback does, and - mostly - what it refuses.
 *
 * The refusals matter more than the success path. Rollback OVERWRITES. A rollback that runs against
 * the wrong file, against a truncated backup, or against a file someone else has since changed would
 * destroy work while reporting success, which is the failure mode this whole project exists to
 * prevent. So each of those has its own control.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { rollbackRegistration, rollbackVerifier, rollbackPlan, rollbackDigest } from '../live/rollback-tools.ts'
import { editFileRegistration, BACKUP_SUFFIX } from '../live/edit-tools.ts'
import { isCapability } from '../../planner/plan.ts'
import type { Step } from '../state.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'aios-m28-'))
process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* held */ } })

let n = 0
const ctx = () => ({ stepId: 'rb', prior: {} } as never)
const step = (args: Record<string, unknown>): Step =>
  ({ id: 'rollback', tool: 'rollback-file', args, mode: 'filesystem', capability: 'filesystem.rollback' } as unknown as Step)
const reg = () => rollbackRegistration({ workspaceRoot: ROOT })

/** An edited file with a real backup, produced by the REAL edit tool. */
async function edited(name: string, from: string, to: string): Promise<string> {
  const p = join(ROOT, `${name}${n++}.js`)
  writeFileSync(p, from, 'utf8')
  const r = await editFileRegistration({ workspaceRoot: ROOT }).tool.run(ctx(), { path: p, find: from, replace: to })
  assert.equal(r.kind, 'data', 'the fixture edit must apply, or this test is measuring nothing')
  return p
}

const verify = async (args: Record<string, unknown>, data: unknown) =>
  rollbackVerifier({ workspaceRoot: ROOT }).verify(step(args), ctx(), data)

// ============================================================================================
// THE SUCCESS PATH
// ============================================================================================

test('filesystem.rollback is in the capability vocabulary', () => {
  assert.ok(isCapability('filesystem.rollback'))
})

test('a rollback restores the file to the content its backup holds', async () => {
  const p = await edited('ok', "'1.0.0'", "'1.1.0'")
  assert.equal(readFileSync(p, 'utf8'), "'1.1.0'")
  const r = await reg().tool.run(ctx(), { path: p })
  assert.equal(r.kind, 'data')
  assert.equal(readFileSync(p, 'utf8'), "'1.0.0'", 'the file must be back to what it was')
})

test('a genuine rollback verifies', async () => {
  const p = await edited('okv', "'a'", "'b'")
  const args = { path: p }
  const r = await reg().tool.run(ctx(), args)
  if (r.kind !== 'data') return
  const v = await verify(args, r.data)
  assert.ok('evidence' in v, `a real rollback must verify: ${('rejected' in v) ? v.rejected : ''}`)
})

test('the backup is NOT consumed - two rollbacks are both possible', async () => {
  const p = await edited('twice', "'x'", "'y'")
  await reg().tool.run(ctx(), { path: p })
  assert.equal(readFileSync(p, 'utf8'), "'x'")
  assert.ok(existsSync(p + BACKUP_SUFFIX), 'undoing a change must not destroy the ability to undo it again')
})

// ============================================================================================
// THE REFUSALS
// ============================================================================================

test('CONTROL: no backup means there is nothing to restore', async () => {
  const p = join(ROOT, `nobackup${n++}.js`)
  writeFileSync(p, 'current', 'utf8')
  const r = await reg().tool.run(ctx(), { path: p })
  assert.equal(r.kind, 'failed', 'rolling back to nothing is not recovery')
  if (r.kind === 'failed') assert.match(r.reason, /nothing to restore/, r.reason)
  assert.equal(readFileSync(p, 'utf8'), 'current', 'and the file must be untouched')
})

test('CONTROL: an EMPTY backup is refused rather than restored', async () => {
  // The case worth naming: restoring a truncated backup succeeds and leaves an empty file, which
  // reads as "rolled back" and is in fact total data loss.
  const p = join(ROOT, `empty${n++}.js`)
  writeFileSync(p, 'content', 'utf8')
  writeFileSync(p + BACKUP_SUFFIX, '', 'utf8')
  const r = await reg().tool.run(ctx(), { path: p })
  assert.equal(r.kind, 'failed')
  if (r.kind === 'failed') assert.match(r.reason, /is EMPTY/, r.reason)
  assert.equal(readFileSync(p, 'utf8'), 'content', 'the file must NOT have been emptied')
})

test('CONTROL: a file outside the workspace is refused', async () => {
  const r = await reg().tool.run(ctx(), { path: join(ROOT, '..', 'elsewhere.js') })
  assert.equal(r.kind, 'failed')
  if (r.kind === 'failed') assert.match(r.reason, /outside the workspace root/, r.reason)
})

test('CONTROL: a relative path is refused', async () => {
  const r = await reg().tool.run(ctx(), { path: 'x.js' })
  assert.equal(r.kind, 'failed')
  if (r.kind === 'failed') assert.match(r.reason, /relative path/, r.reason)
})

test('CONTROL: a rollback that would clobber an INTERVENING change is refused', async () => {
  // The control that makes rollback safe in a shared workspace. Someone changed the file after the
  // backup was taken; rolling back now discards their work silently.
  const p = await edited('intervened', "'1.0.0'", "'1.1.0'")
  writeFileSync(p, "// somebody else's work\nconst X = 42\n", 'utf8')
  const staleDigest = rollbackDigest("'1.1.0'")
  const r = await reg().tool.run(ctx(), { path: p, expectCurrentDigest: staleDigest })
  assert.equal(r.kind, 'failed', 'an intervening change must not be silently discarded')
  if (r.kind === 'failed') assert.match(r.reason, /changed since the rollback was planned/, r.reason)
  assert.match(readFileSync(p, 'utf8'), /somebody else's work/, 'their change must survive')
})

test('a rollback that MATCHES the expected current state is allowed', async () => {
  const p = await edited('matching', "'a'", "'b'")
  const r = await reg().tool.run(ctx(), { path: p, expectCurrentDigest: rollbackDigest("'b'") })
  assert.equal(r.kind, 'data', 'the guard blocks a mismatch, not every rollback')
  assert.equal(readFileSync(p, 'utf8'), "'a'")
})

test('CONTROL: rolling back when the file already matches is refused as a no-op', async () => {
  const p = join(ROOT, `same${n++}.js`)
  writeFileSync(p, 'same', 'utf8')
  writeFileSync(p + BACKUP_SUFFIX, 'same', 'utf8')
  const r = await reg().tool.run(ctx(), { path: p })
  assert.equal(r.kind, 'failed')
  if (r.kind === 'failed') assert.match(r.reason, /nothing to roll back/, r.reason)
})

test('CONTROL: a nonsense expected digest is refused, not ignored', async () => {
  const p = await edited('nonsense', "'a'", "'b'")
  const r = await reg().tool.run(ctx(), { path: p, expectCurrentDigest: 42 })
  assert.equal(r.kind, 'failed')
  if (r.kind === 'failed') assert.match(r.reason, /must be a string/, r.reason)
})

// ============================================================================================
// AUTHORISATION
// ============================================================================================

test('a rollback declares an effect, so it needs its OWN approval', async () => {
  const p = await edited('eff', "'a'", "'b'")
  const e = reg().effectOf?.(step({ path: p }))
  assert.ok(e, 'a rollback overwrites, so it must be authorised')
  assert.equal(e!.target, p, 'the target is the FILE, so an approval cannot carry to another file')
})

test('CONTROL: a rollback with no backup is blocked in preflight and authorises nothing', () => {
  const s = step({ path: join(ROOT, `pf${n++}.js`) })
  const pf = reg().preflight?.(s)
  assert.ok(pf, 'a rollback with nothing to restore must be blocked')
  assert.equal(pf!.needsHuman, false, 'a person cannot authorise destroying a file to restore nothing')
  // Same discipline as `edit`: a step that cannot run declares nothing, so no approval is requested
  // for an action that will never happen.
  assert.equal(reg().effectOf?.(s), undefined, 'an un-runnable rollback declares no effect at all')
})

test('CONTROL: the workspace root cannot be widened by the step', () => {
  // Two registrations, different roots. A step argument is identical in both.
  const other = join(ROOT, 'sub')
  writeFileSync(join(ROOT, 'x.js'), 'a', 'utf8')
  writeFileSync(join(ROOT, 'x.js' + BACKUP_SUFFIX), 'b', 'utf8')
  const narrow = rollbackRegistration({ workspaceRoot: other })
  const r = narrow.tool.run(ctx(), { path: join(ROOT, 'x.js') })
  return r.then((res) => {
    assert.equal(res.kind, 'failed', 'a registration scoped to a subfolder must refuse a file above it')
    if (res.kind === 'failed') assert.match(res.reason, /outside the workspace root/, res.reason)
  })
})

// ============================================================================================
// INDEPENDENT VERIFICATION
// ============================================================================================

test('CONTROL: a rollback that never ran does not verify', async () => {
  const p = await edited('liar', "'a'", "'b'")
  const r = await verify({ path: p }, { path: p, backup: p + BACKUP_SUFFIX })
  assert.ok(!('evidence' in r), 'a claimed rollback with the file still edited must not verify')
  if (!('evidence' in r)) assert.match(r.rejected, /does not match its backup/, r.rejected)
})

test('CONTROL: a rollback with no backup on disk does not verify', async () => {
  const p = join(ROOT, `nob${n++}.js`)
  writeFileSync(p, 'x', 'utf8')
  const r = await verify({ path: p }, { path: p })
  assert.ok(!('evidence' in r))
  if (!('evidence' in r)) assert.match(r.rejected, /is gone|found no file/, r.rejected)
})

test('CONTROL: a rollback that restored an EMPTY file does not verify', async () => {
  const p = join(ROOT, `emptyv${n++}.js`)
  writeFileSync(p, '', 'utf8')
  writeFileSync(p + BACKUP_SUFFIX, '', 'utf8')
  const r = await verify({ path: p }, { path: p })
  assert.ok(!('evidence' in r), 'an empty file matching an empty backup is not a recovery')
  if (!('evidence' in r)) assert.match(r.rejected, /backup is empty/, r.rejected)
})

test('the verifier refuses a path outside the workspace', async () => {
  const r = await verify({ path: join(ROOT, '..', 'z.js') }, { path: 'z' })
  assert.ok(!('evidence' in r))
  if (!('evidence' in r)) assert.match(r.rejected, /outside the workspace/, r.rejected)
})

test('rollbackPlan is a pure decision - it changes nothing', async () => {
  const p = await edited('pure', "'a'", "'b'")
  const plan = rollbackPlan(ROOT, { path: p })
  assert.ok(plan.ok)
  assert.equal(readFileSync(p, 'utf8'), "'b'", 'planning a rollback must not perform it')
})

test('the verifier covers only its own step', () => {
  const v = rollbackVerifier({ workspaceRoot: ROOT })
  assert.ok(v.verifies({ id: 'x', tool: 'rollback-file' } as Step))
  assert.equal(v.verifies({ id: 'x', tool: 'edit-file' } as Step), false)
})