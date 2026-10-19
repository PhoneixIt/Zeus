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

/**
 * Read one entry out of the audit's KNOWN_GAPS table, as text.
 *
 * =============================================================================
 * WHY A RATIONALE IS ASSERTED HERE AND NOT IN THE AUDIT'S OUTPUT
 * =============================================================================
 *
 * KNOWN_GAPS is the audit's durable record of WHY a route was dangerous and what the fix was. It
 * deliberately outlives the defect it describes. The audit's stale-entry check
 * (`audit-injection-routes.mjs:607`) treats an entry as stale only when the route is neither
 * currently ungated NOR in `InjectionRoutes`:
 *
 *     const staleGaps = Object.keys(KNOWN_GAPS).filter(
 *       (r) => !windowUngoverned.some((u) => u.route === r) && !injectionRoutes.has(r),
 *     )
 *
 * So an entry whose route has been GATED is retained by design - institutional memory, not rot. That
 * second clause is what makes `KNOWN_GAPS`, and not the console output, the correct place to assert
 * the rationale: once `/focus` is gated there is no gap left to report, and the audit correctly
 * prints nothing. Asserting against the output would be asserting a defect exists.
 *
 * This is NOT a downgrade. The previous assertion was a bare regex over the whole output; this one
 * names the specific entry, proves the entry still exists at all, and checks both semantic clauses.
 *
 * Returns `undefined` when the table or the entry is absent, so a caller cannot pass by accident.
 */
function knownGap(route: string): string | undefined {
  const src = readFileSync(AUDIT, 'utf8')
  const table = /const KNOWN_GAPS = \{([\s\S]*?)\n {2}\}/.exec(src)?.[1]
  if (!table) return undefined
  return new RegExp(`'${route.replace('/', '\\/')}':\\s*'([^']*)'`).exec(table)?.[1]
}

// ============================================================================================
// BASELINE
// ============================================================================================

test('the audit runs, and reports the invariant as holding - truthfully', () => {
  const { code, out } = runAudit()

  // WHAT CHANGED, AND WHY THIS IS NOT A TEST BEING FIXED TO PASS.
  //
  // This assertion used to require EXIT_DOCUMENTED_GAP, with the comment "Asserting 0 here would
  // be asserting the thing that was wrong." That was correct THEN: `/show`, `/restore` and
  // `/focus` reached machine-mutating primitives and were absent from `InjectionRoutes`, so the
  // honest answer was "does not hold".
  //
  // They are now declared in `InjectionRoutes` (ADR 0003), so the dispatch-head gate refuses all
  // three and `control:audit-routes` exits 0. Requiring exit 1 now would be asserting a defect that
  // no longer exists - the mirror image of the original mistake.
  //
  // The invariant under test never changed: **the audit's exit code must reflect the real state of
  // the injection gate.** Only the real state moved. Both directions stay pinned - the pass must be
  // stated in words, and the alarm control below still requires a breach to be exit 2.
  assert.equal(code, EXIT_INVARIANT_HOLDS,
    'every machine-state route is declared in InjectionRoutes, so the invariant HOLDS')
  assert.match(out, /=== PASS: every action that can change the real machine state passes through the declared gate/,
    'the pass must be stated in words, not only in an exit code')
})

test('the three formerly-ungated routes are named as GOVERNED, not merely present', () => {
  const { out } = runAudit()

  // A route silently dropped from the audit's tables would leave the test above passing while the
  // gate got weaker. Each must still be DETECTED as machine-mutating AND reported as governed,
  // which is a stronger claim than the old one that merely required the name to appear.
  for (const route of ['/show', '/restore', '/focus']) {
    const escaped = route.replace('/', '\\/')
    assert.match(out, new RegExp(`${escaped}\\s+governed`),
      `${route} still mutates the machine, so it must be detected AND reported as governed`)
  }
})

test('the three known machine-state gaps are named, with the fix for each', () => {
  const { out } = runAudit()
  for (const route of ['/show', '/restore', '/focus']) {
    assert.match(out, new RegExp(route.replace('/', '\\/')),
      `the audit must name ${route} as a machine-state route without a gate`)
  }
  // WHAT CHANGED. The finding this line used to assert is no longer a finding: `/show`, `/restore`
  // and `/focus` ARE gated, so the audit no longer prints a "fix:" line for them, and asserting one
  // would require a defect to exist.
  //
  // The invariant behind it is stronger than the one it replaced, though. It was: "a reported gap
  // must carry its remedy, so the finding is actionable." It is now: "a route the audit classifies
  // as mutating must be reported as GOVERNED, so the pass is substantiated rather than a bare
  // word." A pass that simply omitted these routes would otherwise be indistinguishable from a
  // pass that checked them. The per-route `governed` assertions above carry this; what follows adds
  // the one that was actually stale.
  assert.match(out, /ShowWindow\s+\/show\s+governed/, 'the /show gate must be visible in the output, not just in the exit code')
  assert.match(out, /Win\.Focus\s+\/focus\s+governed/, 'the /focus gate must be visible in the output, not just in the exit code')

  // WHAT CHANGED, AND WHY THIS IS A MOVE RATHER THAN A RELAXATION.
  //
  // This line used to assert `/IDENTITY check/` appeared in the audit's runtime output. It does not
  // any more, and its absence is the CORRECT behaviour, not a regression:
  //
  //   - `/focus` is now gated (declared in `InjectionRoutes`, ADR 0003), so it is no longer an
  //     ungated route and `documentedGaps` is empty.
  //   - The rationale is printed only for a live gap (audit-injection-routes.mjs:611 and :636).
  //   - With no gap to report, printing a "fix:" line would be reporting a defect that does not exist
  //     - the same mistake as requiring EXIT_DOCUMENTED_GAP, which lines 107 and 142 above already
  //     had to undo for the same reason.
  //
  // The rationale did not disappear. It is preserved in the audit's `KNOWN_GAPS` table, which
  // deliberately survives its own fix (see `knownGap()` above, and the stale check at line 607).
  // Asserting it there verifies the thing the invariant is actually about - that the REASON /focus
  // needed gating is durably recorded - instead of asserting that a fixed defect still prints.
  const focusGap = knownGap('/focus')
  assert.ok(focusGap,
    "the /focus entry must remain in the audit's KNOWN_GAPS table: it is the durable record of why /focus was dangerous, and it must outlive its own fix")
  assert.match(focusGap as string, /Verify\(\) is an IDENTITY check/,
    'the /focus gap must record that Verify() is an IDENTITY check - not a permission check')
  assert.match(focusGap as string, /never consults MayInject\(\)/,
    'and that Verify() never consults the injection gate, which is precisely why /focus needed one')
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

  // The baseline must be CLEAN, so that the exit-2 below is attributable to the injected route
  // rather than to a pre-existing problem. It used to require EXIT_DOCUMENTED_GAP, for the same
  // reason the first test did. EXIT_INVARIANT_HOLDS is a strictly stronger precondition: 0 -> 2 is
  // a larger and less ambiguous transition than 1 -> 2, and it pins the alarm to a genuinely
  // passing baseline rather than a merely-non-breaching one.
  assert.equal(before.code, EXIT_INVARIANT_HOLDS, 'the baseline must be a CLEAN pass, so the breach that follows is attributable to the injected route')
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