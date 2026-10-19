/**
 * M27 CONTROLS - governed file editing.
 * =============================================================================
 *
 * This is the first capability in the repository that DISCARDS existing content, so its tests are
 * weighted toward refusals. A capability that can destroy something and whose tests are mostly happy
 * paths is a capability that will eventually destroy something.
 *
 * Every negative case below is an edit that must NOT happen, and each asserts the specific reason -
 * a refusal that cannot say why is an alarm, not a control.
 *
 * No Chromium, no terminal, no network: pure filesystem behaviour against a temp workspace.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import {
  editFileRegistration, editFileVerifier, planEdit, resolveInside, BACKUP_SUFFIX, MAX_EDIT_BYTES,
} from '../live/edit-tools.ts'
import { isCapability } from '../../planner/plan.ts'
import type { Step } from '../state.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'aios-m27-'))
process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* held */ } })

let n = 0
const file = (name: string, body = "const VERSION = '1.0.0'\n") => {
  const p = join(ROOT, name)
  writeFileSync(p, body, 'utf8')
  return p
}
const reg = () => editFileRegistration({ workspaceRoot: ROOT })
const step = (args: Record<string, unknown>): Step =>
  ({ id: 'edit', tool: 'edit-file', args, mode: 'filesystem', capability: 'filesystem.edit' } as unknown as Step)
const ctx = () => ({ stepId: 'edit', prior: {} } as never)

// ============================================================================================
// THE SUCCESS PATH
// ============================================================================================

test('filesystem.edit is in the capability vocabulary', () => {
  assert.ok(isCapability('filesystem.edit'), 'a capability no plan can name is not a capability')
})

test('an exact single replacement edits the file and writes a readable backup', async () => {
  const p = file('app.js', "const VERSION = '1.0.0'\nconst NAME = 'demo'\n")
  const r = await reg().tool.run(ctx(), { path: p, find: "'1.0.0'", replace: "'1.1.0'" })
  assert.equal(r.kind, 'data', `the edit should have applied: ${r.kind === 'failed' ? r.reason : ''}`)
  assert.equal(readFileSync(p, 'utf8'), "const VERSION = '1.1.0'\nconst NAME = 'demo'\n")
  assert.equal(readFileSync(p + BACKUP_SUFFIX, 'utf8'), "const VERSION = '1.0.0'\nconst NAME = 'demo'\n",
    'the backup must hold the ORIGINAL content, so the change can be undone')
  assert.equal(existsSync(p), true)
})

test('a multi-line replacement is matched as one unit', async () => {
  const p = file('multi.js', 'function f() {\n  return 1\n}\n')
  const r = await reg().tool.run(ctx(), { path: p, find: 'function f() {\n  return 1\n}', replace: 'function f() {\n  return 2\n}' })
  assert.equal(r.kind, 'data')
  assert.equal(readFileSync(p, 'utf8'), 'function f() {\n  return 2\n}\n')
})

test('an asserted multi-occurrence edit applies', async () => {
  const p = file('three.js', "x();\ny();\nx();\n")
  const r = await reg().tool.run(ctx(), { path: p, find: 'x();', replace: 'z();', occurrences: 2 })
  assert.equal(r.kind, 'data')
  assert.equal(readFileSync(p, 'utf8'), "z();\ny();\nz();\n")
})

// ============================================================================================
// SCOPE - the workspace root is a tool constructor argument, never a step argument
// ============================================================================================

test('CONTROL: a path outside the workspace is refused', async () => {
  const outside = join(tmpdir(), `aios-outside-${Date.now()}.js`)
  writeFileSync(outside, 'x', 'utf8')
  try {
    const r = await reg().tool.run(ctx(), { path: outside, find: 'x', replace: 'y' })
    assert.equal(r.kind, 'failed', 'a file outside the workspace must not be edited')
    if (r.kind === 'failed') assert.match(r.reason, /outside the workspace root/, r.reason)
  } finally { rmSync(outside, { force: true }) }
})

test('CONTROL: path traversal is refused', async () => {
  // The decisive control. `resolve` collapses `..` BEFORE the prefix test, so this cannot be
  // satisfied by a string check on what was written.
  const victim = join(ROOT, 'victim.js')
  writeFileSync(victim, 'original', 'utf8')
  const escape = join(ROOT, 'sub', '..', '..', 'victim.js')
  mkdirSync(join(ROOT, 'sub'), { recursive: true })
  const outside = join(dirnameOf(ROOT), 'aios-traversal-victim.js')
  writeFileSync(outside, 'original', 'utf8')
  try {
    for (const bad of [
      join(ROOT, '..', '..', 'Windows', 'Temp', 'x.js'),
      join(ROOT, 'sub', '..', '..', 'outside.js'),
    ]) {
      const r = await reg().tool.run(ctx(), { path: bad, find: 'original', replace: 'PWNED' })
      assert.equal(r.kind, 'failed', `${bad} must be refused`)
    }
    assert.equal(readFileSync(victim, 'utf8'), 'original', 'the in-root victim is untouched')
    assert.equal(readFileSync(outside, 'utf8'), 'original', 'the out-of-root victim is untouched')
  } finally { rmSync(outside, { force: true }) }
})

test('CONTROL: a relative path is refused', async () => {
  const r = await reg().tool.run(ctx(), { path: 'app.js', find: 'x', replace: 'y' })
  assert.equal(r.kind, 'failed')
  if (r.kind === 'failed') assert.match(r.reason, /relative path/, r.reason)
})

test('resolveInside collapses traversal before deciding', () => {
  const inside = resolveInside(ROOT, join(ROOT, 'a', '..', 'b.js'))
  assert.ok(!('error' in inside) && inside.path === join(ROOT, 'b.js'),
    'a path that resolves back inside the root is fine - traversal that stays inside is not an escape')
  const outside = resolveInside(ROOT, join(ROOT, '..', 'elsewhere.js'))
  assert.ok('error' in outside, 'a path that resolves OUTSIDE is refused')
})

// ============================================================================================
// THE EDIT ITSELF MUST BE PRECISE
// ============================================================================================

test('CONTROL: text that does not occur is refused, and nothing is written', async () => {
  const p = file('absent.js', 'hello\n')
  const r = await reg().tool.run(ctx(), { path: p, find: 'GOODBYE', replace: 'x' })
  assert.equal(r.kind, 'failed')
  if (r.kind === 'failed') assert.match(r.reason, /does not appear/, r.reason)
  assert.equal(readFileSync(p, 'utf8'), 'hello\n', 'the file must be untouched')
  assert.equal(existsSync(p + BACKUP_SUFFIX), false, 'and no backup should have been written')
})

test('CONTROL: an unexpected occurrence count is REFUSED rather than applied everywhere', async () => {
  // The control that separates a one-line fix from a three-line surprise.
  const p = file('ambiguous.js', "a();\nb();\na();\n")
  const r = await reg().tool.run(ctx(), { path: p, find: 'a();', replace: 'z();' })
  assert.equal(r.kind, 'failed', 'two occurrences where one was implied must not both change')
  if (r.kind === 'failed') {
    assert.match(r.reason, /appears 2 time\(s\).*asserted 1/s, r.reason)
    assert.match(r.reason, /Nothing was changed/, r.reason)
  }
  assert.equal(readFileSync(p, 'utf8'), "a();\nb();\na();\n", 'the file must be untouched')
})

test('CONTROL: a nonsense occurrence count is refused', async () => {
  const p = file('n.js', 'a();\n')
  for (const bad of [0, -1, 1.5, 'two', null]) {
    const r = await reg().tool.run(ctx(), { path: p, find: 'a();', replace: 'b();', occurrences: bad })
    assert.equal(r.kind, 'failed', `occurrences=${JSON.stringify(bad)} must be refused`)
  }
  assert.equal(readFileSync(p, 'utf8'), 'a();\n')
})

test('CONTROL: find equal to replace is refused as a no-op', async () => {
  const p = file('noop.js', 'same\n')
  const r = await reg().tool.run(ctx(), { path: p, find: 'same', replace: 'same' })
  assert.equal(r.kind, 'failed')
  if (r.kind === 'failed') assert.match(r.reason, /identical/, r.reason)
})

test('CONTROL: editing a NON-EXISTENT file is refused - this capability does not create', async () => {
  const r = await reg().tool.run(ctx(), { path: join(ROOT, 'nope.js'), find: 'x', replace: 'y' })
  assert.equal(r.kind, 'failed')
  if (r.kind === 'failed') assert.match(r.reason, /no file at/, r.reason)
  assert.equal(existsSync(join(ROOT, 'nope.js')), false)
})

test('CONTROL: a directory is refused', async () => {
  mkdirSync(join(ROOT, 'adir.js'), { recursive: true })
  const r = await reg().tool.run(ctx(), { path: join(ROOT, 'adir.js'), find: 'x', replace: 'y' })
  assert.equal(r.kind, 'failed')
})

test('CONTROL: a non-text extension is refused', async () => {
  const p = file('thing.exe', 'MZ')
  const r = await reg().tool.run(ctx(), { path: p, find: 'MZ', replace: 'XX' })
  assert.equal(r.kind, 'failed')
  if (r.kind === 'failed') assert.match(r.reason, /not a text type/, r.reason)
})

test('CONTROL: an oversized file is refused', async () => {
  const p = file('big.js', 'x'.repeat(MAX_EDIT_BYTES + 10))
  const r = await reg().tool.run(ctx(), { path: p, find: 'x', replace: 'y' })
  assert.equal(r.kind, 'failed')
  if (r.kind === 'failed') assert.match(r.reason, /this is a rewrite, not an edit/, r.reason)
})

// ============================================================================================
// AUTHORISATION - the effect is declared and a refused edit declares none
// ============================================================================================

test('a valid edit declares an effect, so approval is required', () => {
  const p = file('eff.js', "v='1'\n")
  const e = reg().effectOf?.(step({ path: p, find: "'1'", replace: "'2'" }))
  assert.ok(e, 'editing discards the current content, so it must be authorised')
  assert.equal(e!.kind, 'delete', 'it declares what it does to the old content')
  assert.equal(e!.target, p, 'the target is the FILE, so an approval cannot carry to another file')
  assert.equal(e!.irreversible, false, 'a backup is written, so the change is reversible')
})

test('CONTROL: an OUT-OF-SCOPE edit is BLOCKED in preflight and declares NO effect', () => {
  // CHANGED as the gates moved from "complete" to "in scope".
  //
  // preflight receives the PLAN step, which carries no `prior`, so a search text handed down from an
  // earlier step cannot be resolved there. Requiring it made preflight refuse INCOMPLETE steps as
  // though they were FORBIDDEN - two different verdicts sharing one message, which is how a refusal
  // stops meaning anything.
  //
  // So preflight answers the only question it can answer honestly: may this action happen at all?
  // Completeness is settled by the TOOL at run time, where `ctx.prior` exists.
  const s = step({ path: join(ROOT, '..', 'outside-scope.js'), find: 'x', replace: 'y' })
  const pf = reg().preflight?.(s)
  assert.ok(pf, 'an out-of-scope edit must be blocked in preflight')
  assert.equal(pf!.needsHuman, false, 'a person cannot authorise writing outside the workspace')
  assert.match(pf!.blocked, /outside the workspace root/, pf!.blocked)
  assert.equal(reg().effectOf?.(s), undefined, 'and nothing is offered for approval')
})

test('CONTROL: an edit whose search text is absent is refused by the TOOL, not by preflight', async () => {
  const p = file('absent2.js', 'hello\n')
  const args = { path: p, find: 'NOT_PRESENT', replace: 'x' }
  // In scope, so preflight passes - and that is the correct division of labour, not a gap in it.
  assert.equal(reg().preflight?.(step(args)), undefined, 'an in-scope edit is not blocked by preflight')
  const r = await reg().tool.run(ctx(), args)
  assert.equal(r.kind, 'failed')
  if (r.kind === 'failed') assert.match(r.reason, /does not appear/, r.reason)
  assert.equal(readFileSync(p, 'utf8'), 'hello\n', 'and the file must be untouched')
})

test('CONTROL: preflight blocks an out-of-workspace edit BEFORE authorisation', () => {
  const s = step({ path: join(ROOT, '..', 'escape.js'), find: 'x', replace: 'y' })
  const pf = reg().preflight?.(s)
  assert.ok(pf, 'an out-of-workspace edit must be blocked in preflight')
  assert.match(pf!.blocked, /outside the workspace root/, pf!.blocked)
})

test('planEdit changes nothing - it is a decision function, not an action', () => {
  const p = file('pure.js', "v='1'\n")
  const plan = planEdit(ROOT, { path: p, find: "'1'", replace: "'2'" })
  assert.ok(plan.ok)
  assert.equal(readFileSync(p, 'utf8'), "v='1'\n", 'planning must not touch the file')
  assert.equal(existsSync(p + BACKUP_SUFFIX), false, 'and must not write a backup')
  n += 1
})

// ============================================================================================
// INDEPENDENT VERIFICATION
// ============================================================================================

const verify = async (args: Record<string, unknown>, data: unknown) =>
  editFileVerifier({ workspaceRoot: ROOT }).verify(step(args), ctx(), data)

test('a genuine edit verifies', async () => {
  const p = file(`ok${n++}.js`, "const VERSION = '1.0.0'\n")
  const args = { path: p, find: "'1.0.0'", replace: "'1.1.0'" }
  const r = await reg().tool.run(ctx(), args)
  assert.equal(r.kind, 'data')
  if (r.kind !== 'data') return
  const v = await verify(args, r.data)
  assert.ok('evidence' in v, `a correct edit must verify: ${('rejected' in v) ? v.rejected : ''}`)
})

test('CONTROL: a FORGED edit that was never applied does not verify', async () => {
  const p = file('forged.js', "v='1'\n")
  const args = { path: p, find: "'1'", replace: "'2'" }
  // No tool run at all - a report claiming success.
  const v = await verify(args, {
    path: p, backup: p + BACKUP_SUFFIX, before: "v='1'\n", occurrences: 1, find: "'1'", replace: "'2'",
  })
  assert.ok(!('evidence' in v), 'a claimed edit with no backup must not verify')
  if (!('evidence' in v)) assert.match(v.rejected, /backup .* does not exist/, v.rejected)
})

test('CONTROL: an edit with NO backup does not verify - it cannot be undone', async () => {
  const p = file('nobackup.js', "v='1'\n")
  writeFileSync(p, "v='2'\n", 'utf8') // pretend the edit happened but no backup was kept
  const v = await verify({ path: p, find: "'1'", replace: "'2'" }, { path: p, find: "'1'", replace: "'2'" })
  assert.ok(!('evidence' in v))
  if (!('evidence' in v)) assert.match(v.rejected, /named no backup/, v.rejected)
})

test('CONTROL: a file corrupted AFTER the edit does not verify', async () => {
  const p = file('corrupt.js', "const V = '1'\nconst KEEP = true\n")
  const args = { path: p, find: "'1'", replace: "'9'" }
  const r = await reg().tool.run(ctx(), args)
  assert.equal(r.kind, 'data')
  if (r.kind !== 'data') return
  // Something else touches the file afterwards.
  writeFileSync(p, "const V = '9'\nconst KEEP = false\nSOMETHING ELSE\n", 'utf8')
  const v = await verify(args, r.data)
  assert.ok(!('evidence' in v), 'a file that no longer matches the backup must not verify')
  if (!('evidence' in v)) assert.match(v.rejected, /Something other than the declared edit/, v.rejected)
})

test('CONTROL: a backup that does not match the claimed previous content does not verify', async () => {
  const p = file('liar.js', "v='1'\n")
  const args = { path: p, find: "'1'", replace: "'2'" }
  const r = await reg().tool.run(ctx(), args)
  if (r.kind !== 'data') return
  // The tool's report claims a DIFFERENT original than the backup holds.
  const v = await verify(args, { ...(r.data as object), before: "v='SOMETHING-ELSE'\n" })
  assert.ok(!('evidence' in v))
  if (!('evidence' in v)) assert.match(v.rejected, /does not match the previous content/, v.rejected)
})

test('CONTROL: a file still containing the search text does not verify', async () => {
  const p = file('nochange.js', "v='1'\n")
  const args = { path: p, find: "'1'", replace: "'2'" }
  const r = await reg().tool.run(ctx(), args)
  if (r.kind !== 'data') return
  writeFileSync(p + BACKUP_SUFFIX, "v='1'\n", 'utf8')
  writeFileSync(p, "v='1'\n", 'utf8') // undo the edit by hand
  const v = await verify(args, r.data)
  assert.ok(!('evidence' in v), 'an undone edit must not verify')
  if (!('evidence' in v)) assert.match(v.rejected, /still contains the text/, v.rejected)
})

test('CONTROL: the verifier refuses a path outside the workspace', async () => {
  const v = await verify({ path: join(ROOT, '..', 'x.js'), find: 'a', replace: 'b' }, { path: 'x' })
  assert.ok(!('evidence' in v))
  if (!('evidence' in v)) assert.match(v.rejected, /outside the workspace/, v.rejected)
})

test('the verifier covers only its own step', () => {
  const v = editFileVerifier({ workspaceRoot: ROOT })
  assert.ok(v.verifies({ id: 'x', tool: 'edit-file' } as Step))
  assert.equal(v.verifies({ id: 'x', tool: 'write-file-summary' } as Step), false)
})

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
  return i === -1 ? p : p.slice(0, i)
}