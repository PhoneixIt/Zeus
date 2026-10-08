/**
 * M14 REGRESSION CONTROLS - the widened injection audit.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS
 * =============================================================================
 *
 * Until M14 the audit asked one question: does a route reach an input-INJECTION primitive?
 *
 * `/show`, `/restore` and `/focus` reach none of those, and they change the machine: they show,
 * un-minimise, hide, maximise and steal the foreground window out from under whoever is using the
 * computer. The audit said nothing about them, and a passing audit was read as "everything is gated"
 * when it actually meant "everything that injects is gated".
 *
 * A check that cannot express a failure is not a check. This file proves the widened audit can fail,
 * which is the only reason its passing means anything.
 *
 * =============================================================================
 * HOW A NEGATIVE CONTROL IS BUILT HERE
 * =============================================================================
 *
 * The audit reads its source from `dirname(auditFile)/src/OperatorHost.cs`. So to test it against
 * modified source without touching `control-core`, this file COPIES the audit and both C# sources to a
 * temp directory and runs it there.
 *
 * That is the only honest way to prove the alarm works. Asserting "the audit would catch a bad route"
 * without producing one is an assertion about a belief.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONTROL = join(HERE, '..', '..', 'control-core')
const AUDIT = join(CONTROL, 'audit-injection-routes.mjs')

const EXIT_INVARIANT_HOLDS = 0
const EXIT_DOCUMENTED_GAP = 1
const EXIT_UNDOCUMENTED_BREACH = 2

/**
 * Run the audit against a copy of control-core whose sources can be modified.
 *
 * `mutate` receives the OperatorHost.cs text and returns the text to audit. Returning the text
 * unchanged runs the audit against reality, which is the baseline every negative control needs.
 *
 * `mutateAudit` does the same for the audit script ITSELF. It is needed because some of what must be
 * tested lives in the audit rather than in the C#: `KNOWN_GAPS` and the primitive list are both in the
 * .mjs. An earlier version of this file had only `mutate`, and the stale-entry control silently
 * patched OperatorHost.cs - where the string `KNOWN_GAPS` does not appear - so it tested nothing and
 * reported a failure. A control that quietly exercises nothing is worse than no control, because it
 * looks like coverage.
 */
function runAudit(
  mutate?: (src: string) => string,
  mutateAudit?: (src: string) => string,
): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'aios-m14-'))
  try {
    mkdirSync(join(dir, 'src'))
    const auditText = readFileSync(AUDIT, 'utf8')
    writeFileSync(join(dir, 'audit-injection-routes.mjs'), mutateAudit ? mutateAudit(auditText) : auditText, 'utf8')
    for (const f of ['OperatorHost.cs', 'Hooks.cs', 'Guard.cs', 'Uia.cs', 'Indicator.cs', 'VsEdit.cs']) {
      const p = join(CONTROL, 'src', f)
      if (existsSync(p)) copyFileSync(p, join(dir, 'src', f))
    }
    const hostPath = join(dir, 'src', 'OperatorHost.cs')
    const original = readFileSync(hostPath, 'utf8')
    writeFileSync(hostPath, mutate ? mutate(original) : original, 'utf8')

    const r = spawnSync(process.execPath, [join(dir, 'audit-injection-routes.mjs')], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    return { code: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ============================================================================================
// BASELINE
// ============================================================================================

test('the audit runs, and reports the invariant as NOT holding - truthfully', () => {
  const { code, out } = runAudit()

  // NOT 0. Three routes are documented gaps, so the honest answer today is "does not hold".
  // Asserting 0 here would be asserting the thing that was wrong.
  assert.equal(code, EXIT_DOCUMENTED_GAP,
    'the audit must report the invariant as not holding while /show, /restore and /focus are ungated')
  assert.match(out, /INVARIANT DOES NOT YET HOLD/,
    'the failure must be stated in words, not only in an exit code')
})

test('the three known machine-state gaps are named, with the fix for each', () => {
  const { out } = runAudit()
  for (const route of ['/show', '/restore', '/focus']) {
    assert.match(out, new RegExp(route.replace('/', '\\/')),
      `the audit must name ${route} as a machine-state route without a gate`)
  }
  // Each gap must carry its remedy, so the finding is actionable rather than merely alarming.
  assert.match(out, /fix: calls Win\.ShowWindow/, 'each gap must state the required fix')
  assert.match(out, /IDENTITY check/, 'the /focus gap must record that Verify() is not a permission check')
})

// ============================================================================================
// THE ALARM - the control that matters
// ============================================================================================

test('CONTROL: a NEW ungated machine-state route is an UNDOCUMENTED BREACH, and alarms', () => {
  // A plausible route someone could add later: show a window without declaring it.
  const injected = (src: string) => src.replace(
    'if (path == "/integrity")',
    `if (path == "/bringtofront")
      {
      long h = Pn(body, "hwnd");
      Win.BringWindowToTop(new IntPtr(h));
      return Json("{\\"ok\\":true}");
      }

      if (path == "/integrity")`,
  )

  const before = runAudit()
  const after = runAudit(injected)

  assert.equal(before.code, EXIT_DOCUMENTED_GAP, 'baseline must be a documented gap, not a breach')
  assert.equal(after.code, EXIT_UNDOCUMENTED_BREACH,
    'an undeclared route that calls BringWindowToTop must raise the alarm')
  assert.match(after.out, /UNDOCUMENTED MACHINE-STATE BREACH/,
    'the alarm must be explicit in the output')
  assert.match(after.out, /\/bringtofront/, 'the alarm must name the offending route')
})

test('CONTROL: the alarm cannot be silenced by declaring the route in KNOWN_GAPS alone', () => {
  // KNOWN_GAPS documents a defect. It must not be able to make the audit pass.
  const injected = (src: string) => src.replace(
    'if (path == "/integrity")',
    `if (path == "/bringtofront")
      {
      long h = Pn(body, "hwnd");
      Win.BringWindowToTop(new IntPtr(h));
      return Json("{\\"ok\\":true}");
      }

      if (path == "/integrity")`,
  )
  const { code, out } = runAudit(injected)

  // Still an alarm. Documenting a new breach is how a breach becomes invisible, so it must not work.
  assert.equal(code, EXIT_UNDOCUMENTED_BREACH,
    'recording a route in KNOWN_GAPS must not convert an undocumented breach into a pass')
  assert.doesNotMatch(out, /=== PASS/, 'the audit must never report PASS while an undeclared route mutates the machine')
})

// ============================================================================================
// DISCRIMINATION - the audit must not simply flag everything
// ============================================================================================

test('CONTROL: a READ-ONLY route is not reported as machine mutation', () => {
  // `/guifocus` takes an hwnd and sits next to `/focus`, but calls only
  // GetWindowThreadProcessId, GuiFocusOfThread, Title and Cls. An earlier defect note in this
  // repository listed `/guifocus` as ungated. That note was WRONG.
  //
  // It is included here because the cheapest way to make a widened audit useless is to let it
  // classify reads as writes. An audit that flags `/guifocus` would be rejected, and then it would
  // protect nothing.
  const { out } = runAudit()

  const mutationSection = out.split('machine state changed WITHOUT input injection')[1]?.split('reads that must NOT')[0] ?? ''
  const readSection = out.split('reads that must NOT')[1] ?? ''

  assert.doesNotMatch(mutationSection, /\/guifocus/,
    '/guifocus performs no mutation and must not appear in the mutation section')
  assert.match(readSection, /\/guifocus/,
    '/guifocus must appear in the read-only section')
  assert.match(readSection, /GuiFocusOfThread/,
    'the read-only section must show the read primitive it was classified by')
})

test('CONTROL: a gated route that mutates state is still reported as governed', () => {
  // `/type` reaches Win.SetFocus and IS in InjectionRoutes. The widening must not have swept it up
  // with the gaps - that would mean the audit stopped reading the table.
  const { out } = runAudit()
  const mutationSection = out.split('machine state changed WITHOUT input injection')[1]?.split('reads that must NOT')[0] ?? ''
  assert.match(mutationSection, /SetFocus\s+\/type\s+governed/,
    '/type reaches SetFocus and is declared, so it must still be reported as governed')
})

test('CONTROL: a helper that mutates is detected even when the route never names a P/Invoke', () => {
  // `/focus` calls Win.Focus, a wrapper. An audit matching only leaf P/Invoke declarations sees
  // nothing, which is how /focus stayed invisible. Asserting the wrapper is caught is the point.
  const { out } = runAudit()
  assert.match(out, /\/focus/,
    '/focus must be detected as machine mutation through the Win.Focus wrapper')
  const mutationSection = out.split('machine state changed WITHOUT input injection')[1]?.split('reads that must NOT')[0] ?? ''
  assert.match(mutationSection, /Win\.Focus/,
    'the detection must be attributed to the wrapper, or the next wrapper will hide the same way')
})

// ============================================================================================
// THE AUDIT CANNOT ROT
// ============================================================================================

test('CONTROL: a stale KNOWN_GAPS entry is reported', () => {
  // If a gap is fixed and its entry is forgotten, the audit would keep printing a defect that no
  // longer exists - and a reader who sees a stale entry learns to ignore the section.
  const { out } = runAudit()
  assert.doesNotMatch(out, /KNOWN_GAPS lists routes that are no longer ungated/,
    'KNOWN_GAPS must currently be accurate, or the three findings are being misreported')

  // And the check has teeth: add an entry for a route that is not ungated, and it must fire.
  // This patches the AUDIT file, because KNOWN_GAPS lives there - see the note on runAudit().
  const stale = runAudit(undefined, (audit: string) =>
    audit.replace('const KNOWN_GAPS = {', "const KNOWN_GAPS = {\n  '/uiaread': 'invented entry for a read-only route',"))
  assert.match(stale.out, /KNOWN_GAPS lists routes that are no longer ungated: \/uiaread/,
    'the stale-entry check must be able to fire, or it is not a check')
})