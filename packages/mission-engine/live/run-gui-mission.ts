/**
 * THE FIRST DURABLE GUI MISSION.
 *
 * =============================================================================
 * WHAT THIS IS, AND WHAT IT IS NOT
 * =============================================================================
 *
 * A goal is accepted, planned into GUI steps, executed through the EXISTING permission
 * gate, checked against the REAL UI, written to a REAL durable store, and then shown to
 * survive a close/reopen. An interrupted copy of the same mission is shown to come back as
 * OBLIGATIONS rather than as completion.
 *
 * It builds no execution framework of its own. Every moving part already exists and is
 * reused exactly as the other live harnesses use it:
 *
 *   execute()          the one executor          (mission-engine/executor.ts)
 *   liveControl        the one control surface   (live-control.ts)
 *   livePermission     the one permission read   (live-control.ts)
 *   DurableStore       the one store             (persistence/store.ts)
 *   StoreRecorder      the one write-ahead log   (persistence/recorder.ts)
 *   resumeMission      the one recovery entry    (persistence/recover.ts)
 *   hostAvailability   the one host preflight    (live-control.ts)
 *
 * The authorization decision is NOT re-implemented here. This file cannot grant permission;
 * it can only ask `livePermission` and pass the answer to the executor, exactly as the gate
 * intends. That is why the blocked phase below is meaningful: it is the real gate refusing,
 * not this file choosing to refuse.
 *
 * =============================================================================
 * THE TARGET IS A DEDICATED, DISPOSABLE WINDOW
 * =============================================================================
 *
 * The mission opens its OWN Notepad instance on its OWN temporary file. It does not reuse
 * any window that already existed, because the reversible action is a TYPE into a document -
 * and typing into a document the human did not give us is not a harmless demonstration, it
 * is data loss. The file is created here, named with a unique marker, and removed at the end.
 * A pre-existing Notepad window, and every other window on the desktop, is left untouched.
 */

import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { execute } from '../executor.ts'
import { DurableStore } from '../../persistence/store.ts'
import { StoreRecorder } from '../../persistence/recorder.ts'
import { missionHistory } from '../../persistence/query.ts'
import { resumeMission } from '../../persistence/recover.ts'
import type { Mission, Step, Evidence } from '../state.ts'
import type { ToolContext } from '../executor.ts'
import {
  livePermission, liveControl, hostAvailability, blockOnHost,
} from './live-control.ts'
import { connect } from '../../control-core/operator-client.mjs'
import type { ControlSurface } from '../../governance/contract.ts'

// =============================================================================
// the harness
// =============================================================================

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed++
}
/** A third outcome. Never silently "passes". Never silently "fails". */
let unverified = 0
const unverifiable = (name: string, why: string) => {
  console.log(`  UNVERIFIED  ${name}  (${why})`)
  unverified++
}

const root = mkdtempSync(join(tmpdir(), 'aios-gui-mission-'))
const DOC_NAME = `aios-gui-mission-${process.pid}-${Date.now()}.txt`
const docPath = join(root, DOC_NAME)
const dbPath = join(root, 'missions.db')
const crashPath = join(root, 'crash.db')

/** The exact bytes the mission claims it will produce. Verification compares against THIS. */
const MARKER = 'AIOS-GUI-MISSION-VERIFIED\n'

const client = await connect()
const guardNow = async () => (await client.raw('/guard')).body as Record<string, unknown>
const hooksNow = async () => (await client.raw('/hooks')).body as Record<string, unknown>

/**
 * Reads the document's text back through UI Automation.
 *
 * This is the INDEPENDENT path, and it matters which one it is. The typing tool reports what
 * it believes it typed; this goes to the window and asks what is there. If the two are wired
 * to the same source the verification agrees with itself and proves nothing.
 */
const readDocumentText = async (hwnd: number): Promise<{ text: string; via: string } | { error: string }> => {
  const found = await client.raw('/uiafind', { method: 'POST', body: { hwnd } })
  const els = (found.body as { elements?: Array<{ index: number; className: string; controlType: string; name: string }> })
    .elements ?? []
  // The editor is identified by what it IS, not by position. Index 4 was correct on one
  // machine and would silently read the wrong control on another.
  const editor = els.find((e) => e.controlType === 'Document' || e.controlType === 'Edit'
    || e.className.startsWith('RichEdit') || e.className.startsWith('WindowsForms10'))
  if (!editor) return { error: `no editable control found among ${els.length} elements in hwnd ${hwnd}` }
  const read = await client.raw('/uiaread', {
    method: 'POST',
    body: { hwnd, index: editor.index, property: 'Text' },
  })
  const text = (read.body as { text?: string }).text
  if (typeof text !== 'string') return { error: `uiaread returned no text for hwnd ${hwnd}` }
  return { text, via: `UIA ${editor.className}#${editor.index}` }
}

// =============================================================================
// the tools
// =============================================================================

/**
 * Types the marker into the dedicated window, through the control surface.
 *
 * It calls `liveControl.type`, which posts to the host's gated `/type` route. The gate is
 * inside the host; this tool cannot reach past it. That is the whole point of routing the
 * action through `ControlSurface` rather than calling the client directly here.
 */
const typeMarker = {
  name: 'gui-type-marker',
  mode: 'gui' as const,
  needsTarget: true,
  async run(_ctx: ToolContext, args: Record<string, unknown>) {
    const hwnd = Number(args.hwnd)
    const text = String(args.text ?? MARKER)
    const g = await guardNow()

    // Ask the ONE permission reader. This file does not decide whether input is allowed -
    // it reads the answer and obeys it. Duplicating that decision here would create a
    // second authorization path, which is precisely what must not exist.
    const perm = await livePermission()
if (perm.input !== 'PERMITTED' || perm.infrastructureHealthy !== true) {
      return {
        kind: 'needs-human' as const,
        reason:
          `the control layer refused to inject: ${perm.blockedBy ?? 'input is not permitted'} ` +
          `(control=${perm.control}, input=${perm.input}, infrastructureHealthy=${perm.infrastructureHealthy}). ` +
          `No input was attempted.`,
      }
    }

    // Actually perform the action, through the control surface, so the host's gate is the
    // thing that admits or refuses it. A tool that only REPORTED what it would have done
    // would let the whole mission "succeed" without ever touching the machine.
    const r = await liveControl.type(
      { hwnd, pid: Number(args.pid ?? 0), expectedTitle: String(args.expectedTitle ?? DOC_NAME) },
      text,
    )
    if (!r.delivered || r.attempted !== true) {
      return { kind: 'needs-human' as const, reason: `the host refused the typed input: ${r.refusedBy ?? 'not delivered'}` }
    }
    return {
      kind: 'data' as const,
      data: { hwnd, typed: text, delivered: true, refusedBy: r.refusedBy, guardState: g.state },
      summary: `typed ${text.length} chars into hwnd ${hwnd} (guard=${g.state})`,
    }
  },
}

/** Reads the window back. Observation only; injects nothing. */
const readDocument = {
  name: 'gui-read-document',
  mode: 'cli' as const,
  async run(_ctx: ToolContext, args: Record<string, unknown>) {
    const hwnd = Number(args.hwnd)
    const r = await readDocumentText(hwnd)
    if ('error' in r) return { kind: 'failed' as const, reason: r.error }
    return {
      kind: 'data' as const,
      data: { hwnd, text: r.text, via: r.via },
      summary: `read ${r.text.length} chars from hwnd ${hwnd} via ${r.via}`,
    }
  },
}

// =============================================================================
// the verifier - the part that decides whether a claim is true
// =============================================================================

/**
 * `expect` is a PARAMETER, not a constant. That is what lets the negative control below ask
 * the same verifier to judge a deliberately wrong expectation and be shown refusing it. A
 * verifier with the answer baked in can only ever confirm itself.
 */
const makeVerifier = (expect: string, hwnd: number) => ({
  verifies: (s: Step) => s.tool === 'gui-type-marker' || s.tool === 'gui-read-document',
  async verify(step: Step) {
    if (step.tool !== 'gui-type-marker' && step.tool !== 'gui-read-document') {
      return { rejected: `no verifier for ${step.tool}` }
    }
    const r = await readDocumentText(hwnd)
    if ('error' in r) return { rejected: `independent read failed: ${r.error}` }
    if (!r.text.includes(expect)) {
      return {
        rejected:
          `the window does not contain what the mission claims it wrote. ` +
          `expected ${JSON.stringify(expect)}, read ${JSON.stringify(r.text.slice(0, 120))}`,
      }
    }
    return {
      evidence: {
        // `screen-text-present` rather than `window-present`: the claim being verified is a
        // CONTENT claim, and the evidence should carry the content, so a later reader can
        // confirm the verification independently instead of trusting that it happened.
        kind: 'screen-text-present',
        text: expect,
      } satisfies Evidence,
    }
  },
})

// =============================================================================
// the mission, built by a function so each phase gets its own isolated copy
// =============================================================================

const buildMission = (id: string, hwnd: number): Mission => ({
  id,
  objective: `Type ${JSON.stringify(MARKER)} into the dedicated window ${DOC_NAME} and verify it is really there`,
  constraints: ['the target must be the dedicated disposable window created by this harness'],
  state: 'executing',
  startedAt: Date.now(),
  history: [],
  pendingApprovals: [],
  plan: [
    {
      id: 's1',
      intent: `type the marker into ${DOC_NAME}`,
      mode: 'gui',
      capability: 'gui.input',
      rationale: 'the objective asks for the text to exist in the window',
      tool: 'gui-type-marker',
      args: { hwnd, text: MARKER },
      dependsOn: [],
      status: 'pending',
      attempts: 0,
    },
    {
      id: 's2',
      intent: 'read the window back and confirm the text',
      mode: 'cli',
      capability: 'gui.observe',
      rationale: 'reading the UI back is the independent check that the text was really typed',
      tool: 'gui-read-document',
      args: { hwnd },
      dependsOn: ['s1'],
      status: 'pending',
      attempts: 0,
    },
  ],
})

const runMissionWith = async (mission: Mission, hwnd: number, expect: string, recorder?: StoreRecorder) =>
  execute(mission, {
    tools: {
      resolve: (s: Step) =>
        s.tool === 'gui-type-marker' ? { tool: typeMarker, fellBack: false, reason: 'exact' }
        : s.tool === 'gui-read-document' ? { tool: readDocument, fellBack: false, reason: 'exact' }
        : { unavailable: `no tool for ${s.tool}`, candidates: [] },
    },
    verifier: makeVerifier(expect, hwnd),
    control: liveControl as ControlSurface,
    config: {
      maxAttempts: 2,
      permission: livePermission,
      emergencyStop: async () => false,
      ...(recorder ? { recorder } : {}),
    },
  })

// =============================================================================
// PHASE 0 - the window, and the host preflight
// =============================================================================

console.log('=== PHASE 0: dedicated window + host preflight ===')
blockOnHost(await hostAvailability())
check('the host is available', true)

// Snapshot the desktop BEFORE opening anything. Notepad is single-instance on Windows 11:
// `notepad.exe file.txt` opens a new TAB inside an already-running Notepad and REUSES that
// window's hwnd. Typing into that hwnd without proving the tab is ours would put text into
// the human's open document. So the hwnd we target must NOT be one that already existed.
const preExisting = new Set((await liveControl.observe()).windows.map((w) => w.hwnd))
console.log(`  ${preExisting.size} window(s) already open; their hwnds are off-limits`)

// Notepad CANNOT be used here, and the reason is worth recording rather than working around.
// Notepad is single-instance on Windows 11: `notepad.exe file.txt` opens a new TAB inside the
// already-running Notepad and REUSES that window's hwnd. The first version of this harness
// therefore found `hwnd 3737198` - the HUMAN's already-open Notepad - and would have typed into
// whatever tab happened to be active. Its fail-closed check caught exactly that and aborted,
// which is the correct outcome and the reason it exists.
//
// So the target is a genuinely separate PROCESS with its own hwnd and its own text control.
// A new process cannot be a tab in somebody else's window.
const winScript = join(root, 'window.ps1')
// The window hands its hwnd over through a FILE, not through stdout. PowerShell buffers its
// stdout when it is redirected, so the first version of this harness waited 20 seconds for a
// line that would not be flushed until the process exited - and the window it had created was
// invisible to it. `[System.IO.File]::WriteAllText` writes through to the filesystem
// immediately, so the value is observable while the window is still up.
const handoffPath = join(root, 'window.hwnd')
writeFileSync(winScript, [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '[System.Windows.Forms.Application]::EnableVisualStyles()',
  '$f = New-Object System.Windows.Forms.Form',
  `$f.Text = '${DOC_NAME}'`,
  '$f.Width = 900; $f.Height = 600; $f.StartPosition = "Manual"; $f.Left = 80; $f.Top = 80',
  '$t = New-Object System.Windows.Forms.TextBox',
  '$t.Multiline = $true; $t.Dock = "Fill"; $t.Font = "Consolas,12"; $t.Text = ""',
  '$f.Controls.Add($t)',
  // `Show()` + `Application.Run()`, NOT `ShowDialog()`. With ShowDialog the window never
  // became visible to the host's enumeration, so the target could not be identified at all.
  '$f.Show()',
  // The window reports its OWN hwnd, through the filesystem so it is observable immediately.
  // That is stronger than matching on a title: a title is a string any window can claim, an
  // hwnd handed over by the process that owns it cannot.
  `[System.IO.File]::WriteAllText('${handoffPath}', [string]$f.Handle)`,
  '[System.Windows.Forms.Application]::Run($f)',
].join("\r\n"), 'utf8')

const { spawn } = await import('node:child_process')
const child = spawn(
  'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
  ['-NoProfile', '-STA', '-File', winScript],
  // NOT `detached: true`. That was the whole defect: a detached child with `stdio: 'ignore'`
  // gets no console and no usable window station, so `Add-Type -AssemblyName
  // System.Windows.Forms` produced no window, no error, and no handoff file - and the harness
  // sat there concluding the window "did not exist". It was never created at all. Inheriting
  // this process's console is what makes the window real.
  { stdio: 'ignore' },
)
child.unref()
const childPid = child.pid ?? 0
console.log(`  launched a dedicated window process (pid ${childPid}) titled ${DOC_NAME}`)

// Wait for the window to hand over its hwnd through the file.
let hwnd = 0
for (let i = 0; i < 40 && hwnd === 0; i++) {
  await new Promise((r) => setTimeout(r, 500))
  const said = existsSync(handoffPath) ? readFileSync(handoffPath, 'utf8').trim() : ''
  hwnd = Number(/^\d+$/.test(said) ? said : 0)
}
check('the dedicated window handed over its own hwnd', hwnd > 0, `hwnd=${hwnd}`)

// --- IDENTITY. Three independent facts must all hold before any input is even considered.
//
// 1. NEW: the hwnd was not present before we created the window. Notepad reuses an existing
//    hwnd for a new tab, so this is the check that would have caught the collision that the
//    earlier Notepad-based version walked straight into.
// 2. OWNED: the window the host can SEE with that hwnd belongs to the process we started.
//    A stale hwnd recycled by Windows to an unrelated window would satisfy check 1.
// 3. TITLED: the window the host reports actually carries our unique title.
let seen: { hwnd: number; pid: number; title: string } | undefined
if (hwnd > 0) {
  for (let i = 0; i < 20 && !seen; i++) {
    seen = (await liveControl.observe()).windows.find((w) => w.hwnd === hwnd)
    if (!seen) await new Promise((r) => setTimeout(r, 250))
  }
}
const isNew = hwnd > 0 && !preExisting.has(hwnd)
const isOwned = Boolean(seen) && seen!.pid === childPid
const isTitled = Boolean(seen) && seen!.title.includes(DOC_NAME)
check('1/3 the hwnd is NEW (was not among the pre-existing windows)', isNew,
  isNew ? '' : `hwnd ${hwnd} was already open`)
check('2/3 the window belongs to the process this harness started', isOwned,
  isOwned ? `pid ${childPid}` : `host reports pid ${seen?.pid ?? 'none'}, we started ${childPid}`)
check('3/3 the window the host sees carries this harness\'s unique title', isTitled,
  isTitled ? '' : `title was "${seen?.title ?? '(not found)'}"`)
check('the dedicated window is NOT any pre-existing Notepad window',
  isNew && isOwned,
  `Notepad hwnds in use: ${[...preExisting].join(',')}`)

// Fail closed. If identity is not fully established we have NOT proven that typing reaches our
// window rather than the human's, and no amount of title matching substitutes for that.
if (!(hwnd > 0 && isNew && isOwned && isTitled)) {
  console.log('')
  console.log('=== ABORTED: no provably-isolated target window. Refusing to type. ===')
  if (child.pid !== undefined) { try { process.kill(child.pid) } catch { /* already gone */ } }
  rmSync(root, { recursive: true, force: true })
  process.exit(1)
}

// Prove the read path is LIVE before trusting it as a verifier. An earlier version required the
// text to be NON-EMPTY, which was wrong: the window is empty until something types into it, and
// while the host is unarmed nothing can. An empty string is the correct reading right now. What
// matters is that the read reaches a real editable control and returns a string at all.
const probeRead = await readDocumentText(hwnd)
const readIsReal = !('error' in probeRead) && typeof probeRead.text === 'string'
check('the independent read reaches a real editable control', readIsReal,
  ('error' in probeRead) ? probeRead.error : `via ${probeRead.via}, text=${JSON.stringify(probeRead.text)} (empty is expected before any action)`)

const before = await hooksNow()
const guard0 = await guardNow()
console.log(`  guard: state=${guard0.state} mayInject=${guard0.mayInject} takeoverPending=${guard0.takeoverPending}`)

// =============================================================================
// PHASE 1 - THE BLOCKED PATH (non-destructive; runs first, always)
// =============================================================================

console.log('')
console.log('=== PHASE 1: while unarmed, the mission is refused and injects nothing ===')
const blockedMission = buildMission('gui-mission-blocked', hwnd)
const blocked = await runMissionWith(blockedMission, hwnd, MARKER)
const after1 = await hooksNow()
const guard1 = await guardNow()

const s1 = blocked.mission.plan[0]
check('the typing step did NOT report success', s1.status !== 'done', `status=${s1.status}`)
check('the mission did NOT complete', blocked.record.complete === false, `state=${blocked.mission.state}`)
check(
  'no mouse input was injected by the refused mission',
  Number(after1.mouseEventsSeen) === Number(before.mouseEventsSeen)
  && Number(after1.mouseTaggedSeen) === Number(before.mouseTaggedSeen),
  `mouseSeen ${before.mouseEventsSeen}->${after1.mouseEventsSeen} tagged ${before.mouseTaggedSeen}->${after1.mouseTaggedSeen}`,
)
check(
  'the guard state was PRESERVED, not reset by the refusal',
  guard1.state === guard0.state && guard1.takeoverPending === guard0.takeoverPending,
  `${guard0.state}->${guard1.state}`,
)
check(
  'the refusal is classified, and names the authoritative reason',
  typeof (s1.result?.outcome as { reason?: string } | undefined)?.reason === 'string'
  && ((s1.result?.outcome as { reason?: string }).reason ?? '').length > 0,
  (s1.result?.outcome as { reason?: string }).reason,
)

// =============================================================================
// PHASE 2 - THE NEGATIVE CONTROL (non-destructive)
// =============================================================================

console.log('')
console.log('=== PHASE 2: negative control - the verifier must REFUSE a wrong expectation ===')
// A full mission CANNOT exercise the verifier while the host is unarmed: the permission gate
// refuses the action first, so verification is never reached. Asserting that the verifier
// "rejected for the wrong reason" here was asserting a detail of a run that never got that far.
// So the verifier is exercised DIRECTLY against the live window - which injects nothing,
// consults no permission, and bypasses nothing. Two calls, because a verifier that rejects
// everything is as useless as one that accepts everything.
const vRight = makeVerifier('', hwnd)
const vWrong = makeVerifier('THIS-TEXT-WAS-NEVER-TYPED-BY-THIS-MISSION', hwnd)
const probeStep = { tool: 'gui-read-document' } as Step
const rightOutcome = await vRight.verify(probeStep)
const wrongOutcome = await vWrong.verify(probeStep)
const rightRejection = ('evidence' in rightOutcome ? undefined : rightOutcome.rejected) ?? ''
const wrongRejection = ('rejected' in wrongOutcome ? wrongOutcome.rejected : undefined) ?? ''
check(
  'the verifier ACCEPTS the window\'s real (empty) content',
  'evidence' in rightOutcome,
  rightRejection ? `rejected: ${rightRejection.slice(0, 90)}` : 'accepted',
)
check(
  'the verifier REJECTS a deliberately wrong expectation, naming the content mismatch',
  /does not contain what the mission claims/.test(wrongRejection),
  wrongRejection ? wrongRejection.slice(0, 90) : 'ACCEPTED A WRONG CLAIM',
)

// And the same mission, run through the real executor, must still be refused - proving the gate
// refuses before the verifier is ever consulted.
const negMission = buildMission('gui-mission-negative', hwnd)
const neg = await runMissionWith(negMission, hwnd, 'THIS-TEXT-WAS-NEVER-TYPED-BY-THIS-MISSION')
const negS1 = neg.mission.plan[0]
check(
  'the blocked-path mission did NOT verify',
  negS1.status !== 'done',
  `status=${negS1.status}`,
)
check(
  'and it was refused by the PERMISSION GATE, before any verification could be reached',
  /the control layer refused to inject/.test(
    ((negS1.result?.outcome as { reason?: string }).reason ?? ''),
  ),
  ((negS1.result?.outcome as { reason?: string }).reason ?? '').slice(0, 90),
)

// =============================================================================
// PHASE 3 - THE AUTHORIZED PATH (only with a genuine human release)
// =============================================================================

console.log('')
console.log('=== PHASE 3: the authorized path ===')
// Re-read the guard IMMEDIATELY before deciding. Not the value read at the top of this file,
// and not the label. If a human moved the mouse while this ran, the answer changed.
const g3 = await guardNow()
const armed = g3.mayInject === true && g3.takeoverPending !== true && g3.emergencyLatched !== true
console.log(`  live guard right now: state=${g3.state} mayInject=${g3.mayInject} takeoverPending=${g3.takeoverPending} emergencyLatched=${g3.emergencyLatched}`)

if (!armed) {
  unverifiable(
    'the authorized GUI action ran',
    'the host is not armed. A human must press Ctrl+Alt+G to release the takeover; ' +
    '/release and /rearm are HTTP-refused by design and this file will not work around them.',
  )
  unverifiable('the authorized action was independently verified from the UI', 'no action ran')
  unverifiable('the authorized action persisted to disk and survived reopen', 'no action ran')
} else {
  const store = new DurableStore({ path: dbPath })
  const recorder = new StoreRecorder(store)
  const mission = buildMission('gui-mission-authorized', hwnd)
  const result = await runMissionWith(mission, hwnd, MARKER, recorder)

  check('the authorized mission completed', result.record.complete, `state=${result.mission.state}`)
  const text = await readDocumentText(hwnd)
  check(
    'the UI independently contains the marker',
    !('error' in text) && text.text.includes(MARKER),
    ('error' in text) ? text.error : `${text.via}`,
  )
  check(
    'and nothing was written to the human filesystem by this mission',
    !existsSync(docPath),
    `${docPath} should not exist`,
  )

  const history = missionHistory(store, mission.id)
  check('the store has a history for this mission', history.entries > 0, `entries=${history.entries}`)
  check('STEP transitions are durable', (history.byKind['step'] ?? 0) >= 2, JSON.stringify(history.byKind))
  const evidenceRows = store.readEvidence(mission.id)
  check('VERIFIED EVIDENCE is durable', evidenceRows.length >= 1, `${evidenceRows.length} row(s)`)
  const reopened = new DurableStore({ path: dbPath })
  check(
    'the evidence SURVIVES a close and reopen from the same path',
    reopened.readEvidence(mission.id).length === evidenceRows.length,
  )

  // --- interruption and recovery
  const crashStore = new DurableStore({ path: crashPath })
  const crashRecorder = new StoreRecorder(crashStore)
  const crashMission = buildMission('gui-mission-interrupted', hwnd)
  crashRecorder.missionStarted(crashMission)
  crashRecorder.attemptBegin({
    missionId: crashMission.id, stepId: 's1', attempt: 1,
  } as never)
  const permit = resumeMission(crashStore, crashMission.id)
  check('resumeMission finds the interrupted mission', Boolean(permit))
  const reopenedPermit = new DurableStore({ path: crashPath })
  check(
    'and the OBLIGATIONS survive a restart',
    Boolean(resumeMission(reopenedPermit, crashMission.id)),
  )
}

// =============================================================================
// PHASE 4 - the dedicated window is disposed of
// =============================================================================
console.log('')
console.log('=== PHASE 4: cleanup ===')
if (child.pid !== undefined) { try { process.kill(child.pid) } catch { /* may already be gone */ } }
rmSync(root, { recursive: true, force: true })
check('the dedicated window script and stores were removed', !existsSync(winScript) && !existsSync(dbPath))

console.log('')
const verdict = failed === 0 && unverified === 0
  ? 'PASS'
  : `${failed} FAILURE(S)` + (unverified ? `, ${unverified} UNVERIFIED` : '')
console.log(`=== ${verdict} ===`)
process.exit(verdict ? 0 : 1)