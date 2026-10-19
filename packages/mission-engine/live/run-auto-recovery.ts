/**
 * AUTOMATIC RECOVERY - performed by the EXECUTOR, not by a harness.
 *
 * Run: npm run mission:auto-recovery
 *
 * =============================================================================
 * WHAT IS DIFFERENT FROM `mission:recovery-dev`
 * =============================================================================
 *
 * That harness detected a failure, then ran a ROLLBACK MISSION, then re-ran the development mission.
 * Three separate `execute()` calls, sequenced by the harness. That demonstrated the parts. This
 * demonstrates the wiring: ONE mission, ONE `execute()` call, and the executor itself decides to
 * recover, obtains the authorisation, runs the recovery, and verifies it.
 *
 * The proof that it is the executor and not the harness is structural:
 *
 *   - there is exactly ONE `execute()` call in this file that runs the development mission
 *   - the harness never mentions `rollback`, never mentions the recovery policy, and never sequences
 *     anything - it passes `recovery:` into the config and then reads the result
 *   - the recovery is only possible because the executor consulted the policy on a failure
 *
 * =============================================================================
 * THE SCENARIO
 * =============================================================================
 *
 * A tool that claims success and lies. The edit step RETURNS success, the file is NOT actually
 * changed, and independent verification re-derives the expected content from the backup and rejects
 * it. The executor sees a verification rejection on an in-scope fault, asks the policy, obtains
 * authorisation for the rollback, runs it, verifies the rollback, re-runs the failed step, and
 * verifies again.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { execute } from '../executor.ts'
import { DurableStore } from '../../persistence/store.ts'
import { StoreRecorder } from '../../persistence/recorder.ts'
import { liveControl, livePermission, blockOnHost, hostAvailability } from './live-control.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { ApprovalStore, keyFor } from '../../governance/approval.ts'
import { editFileRegistration, editFileVerifier } from './edit-tools.ts'
import { rollbackRegistration, rollbackVerifier } from './rollback-tools.ts'
import { rollbackRecoveryPolicy } from './rollback-recovery.ts'
import type { Tool } from '../executor.ts'
import type { Evidence, Mission, Step } from '../state.ts'

const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:/Windows'
const PROGRAM_FILES = process.env.ProgramFiles ?? 'C:/Program Files'

let failures = 0
const check = (what: string, ok: unknown, detail = ''): void => {
  if (ok) { console.log(`   PASS  ${what}`); return }
  console.log(`   FAIL  ${what}${detail ? ` - ${detail}` : ''}`)
  failures += 1
}

const work = mkdtempSync(join(tmpdir(), 'aios-m30-'))
/** Every store this file opens, so cleanup can CLOSE them. A live SQLite handle is what has been
 *  preventing the directory from being removed - Windows will not delete a file that is open. */
const openStores: DurableStore[] = []
const dbPath = join(work, 'mission.sqlite')
const APP = join(work, 'src', 'app.js')
mkdirSync(join(work, 'src'), { recursive: true })
const ORIGINAL = "// fixture\nexport const VERSION = '1.0.0'\n"

const mkStore = (p: string) => { const s = new DurableStore({ path: p }); openStores.push(s); return s }

/**
 * A tool that reports success and changes NOTHING - the lie this milestone is about.
 *
 * `times` bounds the lie. A tool that lies FOREVER cannot be recovered by anything: the rollback
 * would restore the world and the retry would lie again, and a harness that expected that to
 * succeed would be testing a fantasy. The realistic fault is a DIVERGENCE - the action did not take
 * effect - which recovery genuinely repairs, so the tool lies once and then behaves.
 *
 * `times = Infinity` is available for the control that proves a permanent fault is NOT recovered.
 */
function lyingEditTool(target: string, times: number | 'always' = 1, honest?: Tool): Tool {
  let calls = 0
  return {
    name: 'edit-file', mode: 'filesystem',
    async run(ctx, args) {
      calls += 1
      const lie = times === 'always' || calls <= times
      if (lie || !honest) {
        return { kind: 'data', data: { path: target, backup: target + '.aios-backup', occurrences: 1 }, summary: 'claims an edit' }
      }
      return honest.run(ctx, args)
    },
  }
}

function buildMission(id: string): Mission {
  const steps = [
    {
      id: 'edit-source', intent: `set the version in ${APP}`, mode: 'filesystem' as const,
      capability: 'filesystem.edit' as const, rationale: 'the change under test',
      tool: 'edit-file', args: { path: APP, find: "'1.0.0'", replace: "'1.1.0'" },
      dependsOn: [] as string[],
      effect: { kind: 'delete' as const, target: APP, reason: `replace the version in ${APP}`, irreversible: false },
    },
  ]
  return {
    id, objective: `set the version in ${APP} to 1.1.0`, constraints: ['one file', 'the edit declares an effect'],
    state: 'executing', startedAt: Date.now(), history: [], pendingApprovals: [],
    plan: steps.map((s) => ({ ...s, status: 'pending' as const, attempts: 0 })),
  }
}

/**
 * ONE registry, and the edit tool it serves is chosen by the caller. That is the only difference
 * between the successful and the failing run - no other wiring changes.
 */
const registry = (editTool: Tool) => new ToolRegistry({
  registrations: [
    { tool: editTool, capabilities: ['filesystem.edit'] },
    rollbackRegistration({ workspaceRoot: work }),
  ],
})

const verifier = {
  verifies: (s: Step) => s.tool === 'edit-file' || s.tool === 'rollback-file',
  async verify(step: Step, ctx: unknown, data: unknown) {
    if (step.tool === 'rollback-file') return rollbackVerifier({ workspaceRoot: work }).verify(step, ctx as never, data)
    return editFileVerifier({ workspaceRoot: work }).verify(step, ctx as never, data)
  },
}


async function runOnce(opts: {
  id: string; editTool: Tool; recovery?: boolean; approvals?: ApprovalStore; db?: string
}) {
  const db = opts.db ?? join(work, `${opts.id}.sqlite`)
  const store = mkStore(db)
  const cfg = (recovery: boolean) => ({
    maxAttempts: 2,
    permission: livePermission as never,
    emergencyStop: async () => false,
    recorder: new StoreRecorder(store),
    ...(recovery ? { recovery: rollbackRecoveryPolicy({ workspaceRoot: work, maxRecoveries: 1 }) } : {}),
  })
  const go = () => execute(buildMission(opts.id), {
    tools: registry(opts.editTool), verifier, control: liveControl as never,
    config: cfg(!!opts.recovery),
    ...(opts.approvals ? { approvals: opts.approvals } : {}),
  })

  // REQUEST, THEN GRANT, THEN RUN.
  //
  // ApprovalStore.decide refuses to record an approval for an action nobody asked about - which is
  // correct, and which means the grant must come AFTER a run that requested one. Granting first (as
  // an earlier version did) means every decide throws, every scenario stops at the EDIT's own gate,
  // and no control ever reaches the behaviour it is meant to be testing.
  if (!opts.approvals) return { r: await go(), store }
  await go()
  const k = keyFor(opts.id, 'edit-source',
    { kind: 'delete', target: APP, reason: 'replace the version in ' + APP, irreversible: false }, 0)
  try { opts.approvals.decide(k, 'approved', 'human', Date.now()) } catch { /* reported by the scenario */ }
  return { r: await go(), store }
}

/** The rollback the executor builds has a DETERMINISTIC identity: mission::recovery-1. */
function rollbackKeyFor(missionId: string) {
  return keyFor(missionId + '::recovery-1', 'recovery-rollback',
    { kind: 'delete', target: APP, reason: 'restore ' + APP + ' from the backup written before the failed edit', irreversible: false }, 0)
}

// ============================================================================================

// A prerequisite, checked before anything runs. Every mission in this harness passes
// `permission: livePermission`, so with the operator host absent nothing reaches step 1 - the edit
// stays `pending`, and all seventeen controls then report FAIL for a reason that has nothing to do
// with recovery. A missing prerequisite is a third outcome, not a failed control.
blockOnHost(await hostAvailability())

console.log('=== 1. NORMAL SUCCESS: an honest edit, no recovery configured ===')
{
  writeFileSync(APP, ORIGINAL, 'utf8')
  rmSync(APP + '.aios-backup', { force: true })
  const honest = editFileRegistration({ workspaceRoot: work })
  const { r, store } = await runOnce({ id: 'auto-ok', editTool: { ...honest.tool, name: 'edit-file' } as Tool, approvals: new ApprovalStore() })
  const st = r.mission.plan[0]!
  console.log(`  edit-source -> ${st.status} (${st.result?.outcome.kind})`)
  check('a normal mission still succeeds unchanged', st.status === 'done' && st.result?.outcome.kind === 'verified',
    `${st.status}/${st.result?.outcome.kind}`)
  check('and the file really changed', readFileSync(APP, 'utf8').includes("'1.1.0'"))
  check('and no recovery was involved', !JSON.stringify(r.mission.plan).includes('rollback'))
  store.close()
}

console.log('')
console.log('=== 2. DETECTION: a tool that lies, with NO recovery configured ===')
{
  writeFileSync(APP, ORIGINAL, 'utf8')
  rmSync(APP + '.aios-backup', { force: true })
  const { r, store } = await runOnce({ id: 'auto-lie-norec', editTool: lyingEditTool(APP), approvals: new ApprovalStore() })
  const st = r.mission.plan[0]!
  const reason = (st.result?.outcome as { reason?: string } | undefined)?.reason ?? ''
  console.log(`  edit-source -> ${st.status} (${st.result?.outcome.kind})`)
  console.log(`  reason: ${reason.slice(0, 130)}`)
  check('the executor REJECTED the tool\'s claim of success', st.status !== 'done', `status=${st.status}`)
  check('and the reason names the divergence', /does not match|backup|Something other than/.test(reason), reason.slice(0, 120))
  check('the mission did NOT complete', !r.record.complete)
  check('and the file was never changed', readFileSync(APP, 'utf8') === ORIGINAL)
  store.close()
}

console.log('')
console.log('=== 3. AUTOMATIC RECOVERY: the executor recovers on its own ===')
{
  writeFileSync(APP, ORIGINAL, 'utf8')
  // A REAL backup exists, produced by the REAL edit tool, so a rollback has something to restore.
  rmSync(APP + '.aios-backup', { force: true })
  writeFileSync(APP + '.aios-backup', ORIGINAL, 'utf8')
  writeFileSync(APP, ORIGINAL, 'utf8')

  const honestEdit = editFileRegistration({ workspaceRoot: work }).tool
  const approvals = new ApprovalStore()
  const db = join(work, 'rec.sqlite')
  const policy = () => rollbackRecoveryPolicy({ workspaceRoot: work, maxRecoveries: 1 })

  // PHASE A - prime the EDIT approval with an HONEST tool, then throw that tool away.
  //
  // The flaky tool below counts its own calls, and it must spend its single lie on the REAL run. An
  // earlier version shared one tool across the priming and the real run, so the lie was spent while
  // priming and the real run never failed at all - which "passed" for entirely the wrong reason.
  await execute(buildMission('auto-rec'), {
    tools: registry(honestEdit), verifier, control: liveControl as never,
    config: { maxAttempts: 1, permission: livePermission as never, emergencyStop: async () => false, recorder: new StoreRecorder(mkStore(join(work, 'prime.sqlite'))) },
    approvals,
  })
  // Grant what priming REQUESTED. Without this the real run stops at the EDIT's own gate and never
  // reaches the tool, so every control below would be measuring authorisation instead of recovery.
  const ek = keyFor('auto-rec', 'edit-source',
    { kind: 'delete', target: APP, reason: 'replace the version in ' + APP, irreversible: false }, 0)
  let editGranted = false
  try { approvals.decide(ek, 'approved', 'human', Date.now()); editGranted = true } catch { editGranted = false }
  check('the edit step was authorised for the real run', editGranted, 'the priming run never requested it')
  // The honest edit already applied during priming; put the world back and keep the backup.
  writeFileSync(APP, ORIGINAL, 'utf8')

  // PHASE B - the real run, from a DIVERGED world. The divergence matters: with the file equal to
  // its backup the rollback refuses ("already matches its backup") BEFORE reaching the approval gate,
  // so no request is ever made and the rollback would never be authorised - a scenario that would
  // then "pass" for the wrong reason.
  writeFileSync(APP, "// corrupted after the edit claimed success\nexport const VERSION = undefined\n", 'utf8')
  const flaky = lyingEditTool(APP, 1, honestEdit)
  const held = await execute(buildMission('auto-rec'), {
    tools: registry(flaky), verifier, control: liveControl as never,
    // maxAttempts 1, and that is the POINT rather than a limitation. With a retry budget the blind
    // retry heals a transient fault and recovery is never needed - correct behaviour. Recovery is
    // what remains when retrying CANNOT fix the fault, so the demonstration spends the budget first.
    config: { maxAttempts: 1, permission: livePermission as never, emergencyStop: async () => false, recorder: new StoreRecorder(mkStore(db)), recovery: policy() },
    approvals,
  })
  const heldStep = held.mission.plan[0]!
  const heldReason = (heldStep.result?.outcome as { reason?: string } | undefined)?.reason ?? ''
  console.log(`  without rollback approval -> ${heldStep.status} (${heldStep.result?.outcome.kind})`)
  console.log(`  reason: ${heldReason.slice(0, 150)}`)
  check('the executor DETECTED the tool\'s false claim of success', /verification rejected/i.test(heldReason), heldReason.slice(0, 130))
  check('and ATTEMPTED recovery on its own', /recovery/i.test(heldReason), heldReason.slice(0, 150))
  check('but stopped because the ROLLBACK ITSELF needs authorisation',
    /recovery (?:attempted and did not succeed|not succeed)|needs authoris|needs a human/i.test(heldReason), heldReason.slice(0, 160))
  check('the mission did NOT complete', !held.record.complete)
  check('and the file is untouched by the refused recovery', readFileSync(APP, 'utf8').includes('corrupted'), readFileSync(APP, 'utf8'))

  // PHASE C - authorise the rollback the executor asked for, and run again.
  const rk = rollbackKeyFor('auto-rec')
  let grantable = false
  try { approvals.decide(rk, 'approved', 'human', Date.now()); grantable = true } catch { grantable = false }
  check('the executor REQUESTED approval for the rollback it wanted to run', grantable,
    'the store refused the grant, so nothing was ever requested')

  // The world DIVERGED: the file no longer matches its backup. Without this the rollback correctly
  // refuses with "the file already matches its backup" - which is the right answer and would make
  // this phase measure nothing.
  writeFileSync(APP, "// corrupted after the edit claimed success\nexport const VERSION = undefined\n", 'utf8')
  const flaky2 = lyingEditTool(APP, 1, honestEdit)
  const done = await execute(buildMission('auto-rec'), {
    tools: registry(flaky2), verifier, control: liveControl as never,
    config: { maxAttempts: 1, permission: livePermission as never, emergencyStop: async () => false, recorder: new StoreRecorder(mkStore(db)), recovery: policy() },
    approvals,
  })
  const doneStep = done.mission.plan[0]!
  console.log(`  with rollback authorised  -> ${doneStep.status} (${doneStep.result?.outcome.kind})`)
  check('the recovery RAN, VERIFIED, and the step was re-run and re-verified',
    doneStep.result?.outcome.kind === 'verified', `${doneStep.status}/${doneStep.result?.outcome.kind}`)
  check('the mission COMPLETED on the recovered retry', done.record.complete === true)
  check('the file is genuinely the edited content', readFileSync(APP, 'utf8').includes("'1.1.0'"), readFileSync(APP, 'utf8'))

  // The durable evidence that a recovery happened - not the tool's word for it, the store's.
  const st = mkStore(db)
  const notes = st.readHistory('auto-rec').filter((n: { kind?: string }) => n.kind === 'recovery')
  for (const n of notes) console.log(`  recorded: ${String((n as { detail?: unknown; summary?: string }).summary ?? JSON.stringify(n)).slice(0, 110)}`)
  check('a RECOVERY was recorded durably', notes.length > 0, 'nothing was recorded')
  check('and at least one says it FAILED first - the authorisation gate, seen from the store',
    notes.some((n) => /FAILED/i.test(JSON.stringify(n))), JSON.stringify(notes).slice(0, 140))
  const m = st.readMission('auto-rec')
  check('the mission survives close/reopen', m !== undefined)
  const stepsAfter = m?.mission?.plan ?? []
  check('completion is RE-DERIVED from persisted step statuses',
    stepsAfter.length > 0 && stepsAfter.every((s) => s.status === 'done'), JSON.stringify(stepsAfter.map((s) => s.status)))
  check('and its evidence survives', st.readEvidence('auto-rec').length >= 1)
  st.close()
}

console.log('=== 4. CONTROL: recovery is NOT attempted without a backup ===')
{
  writeFileSync(APP, ORIGINAL, 'utf8')
  rmSync(APP + '.aios-backup', { force: true })
  const { r, store } = await runOnce({ id: 'auto-nobackup', editTool: lyingEditTool(APP), recovery: true, approvals: new ApprovalStore() })
  const st = r.mission.plan[0]!
  const reason = (st.result?.outcome as { reason?: string } | undefined)?.reason ?? ''
  console.log(`  reason: ${reason.slice(0, 150)}`)
  // Detection is the verifier's: there is no backup, so the file cannot be shown to have been edited
  // at all. The recovery policy then refuses for the SAME reason, which is why no rollback ran.
  check('the failure names the missing backup - the very thing recovery would need', /backup .* does not exist/i.test(reason),
    reason.slice(0, 140))
  check('and no recovery was fabricated over it', !/recovery verified/i.test(reason))
  check('and the mission failed rather than claiming recovery', st.status !== 'done')
  check('the file is untouched', readFileSync(APP, 'utf8') === ORIGINAL)
  store.close()
}

console.log('')
console.log('=== 5. CONTROL: an ineligible failure is NOT recovered ===')
{
  writeFileSync(APP, ORIGINAL, 'utf8')
  // A POLICY refusal, which recovery must never route around.
  const policyRefusing: Tool = {
    name: 'edit-file', mode: 'filesystem',
    async run() { return { kind: 'failed', reason: 'edit refused by policy: refusing to edit outside the workspace root' } },
  }
  const { r, store } = await runOnce({ id: 'auto-policy', editTool: policyRefusing, recovery: true, approvals: new ApprovalStore() })
  const st = r.mission.plan[0]!
  const reason = (st.result?.outcome as { reason?: string } | undefined)?.reason ?? ''
  console.log(`  reason: ${reason.slice(0, 160)}`)
  check('a POLICY refusal is not recovered', /POLICY refusal/i.test(reason), reason.slice(0, 150))
  check('and no rollback was attempted', !existsSync(APP + '.aios-backup'))
  store.close()
}

console.log('')
console.log('=== 6. CONTROL: budget exhaustion refuses a SECOND recovery ===')
{
  const b = (await import('../recovery.ts')).RecoveryBudget
  const budget = new b(1)
  budget.spend()
  check('a spent budget refuses further recovery', budget.available() === false)
  check('and the counter did not run past the limit', budget.spent === 1)
}

console.log('')
console.log('=== 7. CLEANUP ===')
for (const s2 of openStores) { try { s2.close() } catch { /* already closed */ } }
for (let i = 0; i < 6; i += 1) {
  try { rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); break }
  catch { await new Promise((r) => setTimeout(r, 400)) }
}
check('this run left no temporary directory behind', !existsSync(work), work)

console.log('')
if (failures) {
  console.log(`   === ${failures} FAILURE(S) ===`)
  process.exit(1)
}
console.log('   === PASS: the EXECUTOR detected the lie, obtained authorisation for a bounded')
console.log('             recovery, ran it through the ordinary step path, and verified the result ===')
process.exit(0)