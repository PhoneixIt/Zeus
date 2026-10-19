/**
 * M21 - THE FILE-SUMMARY MISSION, END TO END.
 *
 * =============================================================================
 * WHAT THIS EXERCISES, AND WHAT IT DOES NOT
 * =============================================================================
 *
 * The real planner (which routes this objective to the file-summary recipe), the real executor, the
 * real tool-routing path, the real `fileSummaryVerifier`, and the real `StoreRecorder` over a real
 * SQLite file that is closed and reopened.
 *
 * NOTHING here calls `measureFile` or `renderSummary` directly to manufacture a pass. If the planner
 * refuses, the harness refuses. If a tool fails, the mission fails. If the verifier rejects, the
 * step cannot complete.
 *
 * THE PLANNING MODE IS DETERMINISTIC, AND THIS FILE SAYS SO.
 *
 * `DeterministicPlanProvider` matched the phrase and emitted the recipe. No language model read this
 * objective. The M20 comparison measured 0 valid plans from the local model under both a naive and a
 * capability-primed prompt, so presenting this as model-driven planning would be false. The provider's
 * own name is printed below precisely so the distinction is visible rather than assumed.
 */

import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { execute } from '../executor.ts'
import { DurableStore } from '../../persistence/store.ts'
import { StoreRecorder } from '../../persistence/recorder.ts'
import { liveControl, livePermission } from './live-control.ts'
import { DeterministicPlanProvider } from '../../planner/deterministic.ts'
import {
  readInputFileTool, summariseFileTool, writeSummaryTool, fileSummaryVerifier, measureFile,
} from './file-tools.ts'
import type { Mission, Step } from '../state.ts'

const out = mkdtempSync(join(tmpdir(), 'aios-m21-mission-'))
let failures = 0
const check = (what: string, ok: unknown, detail = ''): void => {
  if (ok) { console.log(`   PASS  ${what}`); return }
  console.log(`   FAIL  ${what}${detail ? ` - ${detail}` : ''}`)
  failures++
}

// A fixture OUTSIDE the repository, so the mission cannot be accused of having changed what it read.
const SOURCE = join(out, 'notes.md')
writeFileSync(SOURCE, '# Release Notes\n\n' + 'alpha beta gamma delta epsilon zeta\n'.repeat(5) + '\n', 'utf8')

const independent = measureFile(SOURCE)
if ('error' in independent) {
  console.log(`  cannot continue: ${independent.error}`)
  process.exit(1)
}

const OBJECTIVE = `Summarise the file ${SOURCE}`

console.log('\n=== 1. THE FIXTURE (outside the repository) ===')
console.log(`  source     ${SOURCE}`)
console.log(`  lines=${independent.facts.lines} words=${independent.facts.words} heading="${independent.facts.heading}"`)

console.log('\n=== 2. THE PLANNER ===')
const planner = new DeterministicPlanProvider()
const proposalResult = await planner.plan(OBJECTIVE, {
  outputRoot: out,
  now: () => Date.now(),
  world: {
    observationId: `m21-${Date.now()}`,
    observedAt: Date.now(),
    scope: { root: out, maxDepth: 1 },
    entries: [], fingerprint: 'm21-fixture', capabilities: [], truncated: false, errors: [],
  },
})

console.log(`  provider   ${planner.name}`)
console.log(`  PLANNING MODE: DETERMINISTIC PHRASE MATCHING - no language model read this objective.`)

if (!proposalResult.ok) {
  console.log(`  PLANNER REFUSED: ${proposalResult.code}: ${proposalResult.reason}`)
  rmSync(out, { recursive: true, force: true })
  process.exit(1)
}
const proposal = proposalResult.proposal
console.log(`  steps      ${proposal.steps.map((s) => `${s.id}(${s.capability})`).join(' -> ')}`)

const reportPath = join(out, 'notes.md.summary.txt')
const mission: Mission = {
  id: 'file-summary-mission-1',
  objective: proposal.objective,
  constraints: proposal.constraints,
  state: 'executing',
  startedAt: Date.now(),
  history: [],
  pendingApprovals: [],
  plan: proposal.steps.map((st) => ({
    id: st.id, intent: st.intent, mode: st.mode, capability: st.capability, rationale: st.rationale,
    tool: st.tool, args: st.args, dependsOn: st.dependsOn, status: 'pending' as const, attempts: 0,
  })),
}

console.log('\n=== 3. THE MISSION ===')
const dbPath = join(out, 'mission.sqlite')
const store = new DurableStore({ path: dbPath })
const recorder = new StoreRecorder(store)

const tools = { 'read-input-file': readInputFileTool, 'summarise-file': summariseFileTool, 'write-file-summary': writeSummaryTool }

let result: Awaited<ReturnType<typeof execute>>
try {
  result = await execute(mission, {
    tools: {
      resolve: (s: Step) => {
        const t = tools[s.tool as keyof typeof tools]
        return t ? { tool: t, fellBack: false, reason: 'exact' } : { unavailable: `no tool for ${s.tool}`, candidates: [] }
      },
    },
    verifier: fileSummaryVerifier(SOURCE),
    control: liveControl as never,
    config: { maxAttempts: 2, permission: livePermission, emergencyStop: async () => false, recorder },
  })
} catch (e) {
  console.log('\n  execute() THREW')
  console.log(String((e as Error)?.stack ?? e))
  store.close(); rmSync(out, { recursive: true, force: true })
  process.exit(1)
}

const outcomes = result.mission.plan
  .map((st) => `${st.id}:${st.status}:${st.result?.outcome.kind ?? '-'}` +
    (st.result?.outcome.kind === 'failed' ? `(${JSON.stringify(st.result.outcome)})` : '')).join(' ')

console.log(`  outcomes   ${outcomes}`)
check('the mission completed', result.record.complete, `state=${result.mission.state}`)
check('every step is independently verified',
  Object.keys(result.record.verified).length === result.mission.plan.length,
  `verified ${Object.keys(result.record.verified).join(',')}`)

console.log('\n=== 4. THE ARTIFACT, RE-READ FROM DISK ===')
const exists = existsSync(reportPath)
check('the summary file exists', exists, reportPath)
if (exists) {
  const text = readFileSync(reportPath, 'utf8')
  console.log(text.split('\n').map((l) => `    ${l}`).join('\n'))
  check('it carries the SOURCE file\'s current line count', text.includes(`- lines: ${independent.facts.lines}`))
  check('and word count', text.includes(`- words: ${independent.facts.words}`))
  check('and its heading', text.includes(`- heading: ${independent.facts.heading}`))
  check('and it discloses that no model read it', /no model read this file/i.test(text))
  check('and the artifact is OUTSIDE the repository', !reportPath.toLowerCase().includes('\\projects\\aios\\packages\\'))
}

console.log('\n=== 5. ACROSS A RESTART ===')
store.close()
const reopened = new DurableStore({ path: dbPath })
const recovered = reopened.readMission(result.mission.id)
const evidenceAfter = reopened.readEvidence(result.mission.id)
const historyAfter = reopened.readHistory(result.mission.id)
const approvalsAfter = reopened.readApprovals(result.mission.id)
check('the mission survives closing and reopening the store', recovered !== undefined)
check('its evidence survives', evidenceAfter.length >= 1, `rows=${evidenceAfter.length}`)
check('its history survives', historyAfter.length >= 1, `rows=${historyAfter.length}`)
const stepsAfter = recovered?.mission?.plan ?? []
check('completion is RE-DERIVED from persisted step statuses',
  stepsAfter.length > 0 && stepsAfter.every((s) => s.status === 'done'),
  JSON.stringify(stepsAfter.map((s) => s.status)))
check('and no approval carries authority across the restart',
  approvalsAfter.every((a) => String(a.state) !== 'granted'))
reopened.close()

console.log('')
rmSync(out, { recursive: true, force: true })
if (failures) { console.log(`   === ${failures} FAILURE(S) ===`); process.exit(1) }
console.log('   === PASS ===')
process.exit(0)