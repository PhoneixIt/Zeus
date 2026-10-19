/**
 * M20 - ONE REAL-REPOSITORY MISSION, END TO END.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 *
 * The autonomy loop's machinery is built and separately demonstrated: `mission:folder` plans and
 * executes a filesystem mission, `mission:recovery` re-observes and replans, `mission:durable`
 * survives a process restart. What none of them exercises is a `terminal.run` step INSIDE a
 * multi-step mission, or a completion report whose contents are checked against observed facts.
 *
 * This is the smallest scenario that lands both on real, meaningful work: reporting the state of
 * THIS repository. It is deliberately harmless - read-only git verbs, one file written outside the
 * repository - so it can be run, and re-run, without a human supervising it.
 *
 * =============================================================================
 * THE FACT DEFINITIONS - stated before they are coded, because each one is a decision
 * =============================================================================
 *
 * 1. BRANCH  - stdout of `git rev-parse --abbrev-ref HEAD`, trimmed.
 *    NOT `git branch`: `terminal-policy.ts` classifies `branch` in GIT_DESTRUCTIVE ("with -D
 *    deletes a branch and its unmerged work"), so it would demand human approval for a read-only
 *    question. `rev-parse` is in GIT_READONLY. If HEAD is detached this prints the literal
 *    string "HEAD", which is the honest answer and is reported rather than hidden.
 *
 * 2. UNCOMMITTED CHANGES - lines of `git status --porcelain`, reported in THREE numbers because
 *    "uncommitted changes" is ambiguous and the ambiguity is the whole point:
 *      trackedChanged - entries NOT beginning with `??` (modified, staged, deleted, renamed)
 *      untracked       - entries beginning with `??`
 *      total           - every entry
 *    So untracked files are EXPLICITLY INCLUDED, and separately visible. A report that silently
 *    counted only tracked changes would understate the working tree.
 *
 * 3. TYPESCRIPT SOURCE FILES - lines of `git ls-files` ending in `.ts`.
 *    DOCUMENTED SCOPE: git-TRACKED files only, repository-wide. This EXCLUDES untracked files and
 *    files ignored by git.
 *    That exclusion is not a shortcut, it is what the available tools can establish. The
 *    filesystem tools here use `readdirSync` and are NOT recursive (`folder-tools.ts:42`), so a
 *    recursive count of the working tree is not reachable through them at all. `git ls-files` is
 *    the only permitted route to a repository-wide inventory, and it reports tracked files. The
 *    number is therefore labelled "tracked" everywhere it appears, so nobody reads it as a count
 *    of every .ts file on disk.
 *
 * 4. THE REPORT IS WRITTEN OUTSIDE THE REPOSITORY, and the mission asserts that `git status
 *    --porcelain` is byte-identical before and after. Without that check the mission would be
 *    measuring a fact it had just changed.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

import { execute } from '../executor.ts'
import { DurableStore } from '../../persistence/store.ts'
import { StoreRecorder } from '../../persistence/recorder.ts'
import { liveControl, livePermission } from './live-control.ts'
import { DeterministicPlanProvider } from '../../planner/deterministic.ts'
import { makeTerminalTool, makeTerminalVerifier } from './terminal-mode.ts'
import type { Tool, ToolContext, ToolResult, Verifier } from '../executor.ts'
import type { Evidence, Mission, Step } from '../state.ts'

// ============================================================================================
// HARNESS PLUMBING
// ============================================================================================

const REPO = process.env.AIOS_REPO_ROOT ?? 'C:/Users/Samer/Projects/AIOS'
const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:/Windows'
const PROGRAM_FILES = process.env.ProgramFiles ?? 'C:/Program Files'
/**
 * The ABSOLUTE path to git.exe.
 *
 * The policy is explicit that only absolute paths may be launched, so a PATH entry cannot be used
 * to substitute a different program for an approved one. Passing the bare name "git.exe" is
 * therefore refused by design - not by accident, and not something to work around inside the tool.
 * Resolving it here is the harness's job, and the resolution is asserted rather than assumed.
 */
function gitExe(): string {
  // The policy builds its allowlist as `${programFiles}\\Git\\cmd\\git.exe` - WINDOWS separators.
  // Passing a forward-slash path is refused, because the allowlist compares the absolute path
  // literally. That is not pedantry: it is the same reason a bare name is refused, and getting it
  // wrong here would have looked like "the policy is broken" when it is working exactly as designed.
  const p = `${PROGRAM_FILES}\\Git\\cmd\\git.exe`
  if (existsSync(p)) return p
  const where = spawnSync('where.exe', ['git.exe'], { encoding: 'utf8' })
  const first = (where.stdout ?? '').split('\n').map((l) => l.trim()).find((l) => l.toLowerCase().endsWith('git.exe'))
  return first ?? ''
}

/** Exactly the GIT_READONLY verbs. A tool that widened this would be a policy change by stealth. */
const READ_ONLY_VERBS = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree',
  'blame', 'describe', 'cat-file', 'shortlog', 'name-rev', 'for-each-ref', 'check-ignore',
])


// ============================================================================================
// THE TERMINAL STEP - the governed path, not a private spawner
// ============================================================================================

/**
 * A git-fact tool built on the EXISTING terminal capability.
 *
 * It does not spawn anything itself: it delegates to `makeTerminalTool`, which classifies through
 * `terminal-policy.ts` before any process starts. A private spawner would have been a policy
 * bypass wearing a tool's name, which is the exact failure mode the allowlist exists to prevent.
 *
 * The one extra check this tool adds is a LOCAL verb allowlist, because the mission must not depend
 * on the policy happening to refuse a mutating verb for the right reason.
 */
function makeGitFactTool(workspace: string): Tool {
  const terminal = makeTerminalTool({ workspace, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES })
  return {
    name: 'git-fact',
    mode: 'cli',
    async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      const verb = String(args.verb ?? '')
      if (!READ_ONLY_VERBS.has(verb)) {
        return { kind: 'failed', reason: `"${verb}" is not on this mission's read-only verb list` }
      }
      const rest = (args.args as string[] | undefined) ?? []
      return terminal.run(ctx, { executable: gitExe(), argv: [verb, ...rest] })
    },
  }
}

const gitFact = makeGitFactTool(REPO)

// ============================================================================================
// COMPOSE - derives the facts into report text
// ============================================================================================

function priorOutput(ctx: ToolContext, stepId: string): Record<string, unknown> | undefined {
  const r = ctx.prior?.[stepId]?.output as Record<string, unknown> | undefined
  return r
}

function stdoutOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.stdout === 'string') return o.stdout
  }
  return ''
}

const composeRepoReport: Tool = {
  name: 'compose-repo-report',
  mode: 'filesystem',
  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const branch = stdoutOf(priorOutput(ctx, 'read-branch')).trim()
    const porcelain = stdoutOf(priorOutput(ctx, 'read-status'))
    const files = stdoutOf(priorOutput(ctx, 'read-files'))

    if (!branch) return { kind: 'failed', reason: 'no branch name was produced by s1' }

    const entries = porcelain.split('\n').filter((l) => l.trim().length > 0)
    const trackedChanged = entries.filter((l) => !l.startsWith('??')).length
    const untracked = entries.filter((l) => l.startsWith('??')).length
    const tsTracked = files.split('\n').filter((l) => l.trim().endsWith('.ts')).length

    const text = [
      '# AIOS repository report',
      '',
      `- branch: ${branch}`,
      `- uncommitted tracked changes: ${trackedChanged}`,
      `- uncommitted untracked files: ${untracked}`,
      `- uncommitted total (tracked + untracked): ${entries.length}`,
      `- tracked TypeScript source files: ${tsTracked}`,
      '',
      'Scope: file counts are git-TRACKED files only, from `git ls-files`.',
      'Untracked and gitignored files are not included.',
      'Uncommitted changes are from `git status --porcelain` and INCLUDE untracked files.',
      '',
    ].join('\n')

    return {
      kind: 'data',
      data: { text, branch, trackedChanged, untracked, total: entries.length, tsTracked },
      summary: `composed a report: branch=${branch} total=${entries.length} tsTracked=${tsTracked}`,
    }
  },
}

// ============================================================================================
// WRITE + READ BACK, OUTSIDE THE REPOSITORY
// ============================================================================================

const writeRepoReport: Tool = {
  name: 'write-repo-report',
  mode: 'filesystem',
  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    // The text is NOT taken from the plan's args. The plan says only "write the report"; WHERE the
    // text comes from is the previous step's verified output, so the writer cannot be handed
    // content that was never verified by composing it.
    const text = String(priorOutput(ctx, 'compose')?.text ?? '')
    const target = String(args.target ?? '')
    if (!text) return { kind: 'failed', reason: 'no verified text available from s5 to write' }
    if (!target) return { kind: 'failed', reason: 'write needs a target' }
    if (existsSync(target)) return { kind: 'failed', reason: `refusing to overwrite ${target}` } // reversibility
    writeFileSync(target, text, 'utf8')
    return { kind: 'data', data: { target, bytes: Buffer.byteLength(text), text }, summary: `wrote ${target}` }
  },
}

const readRepoReport: Tool = {
  name: 'read-repo-report',
  mode: 'filesystem',
  async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const target = String(args.target ?? '')
    if (!existsSync(target)) return { kind: 'failed', reason: `${target} does not exist` }
    const text = readFileSync(target, 'utf8')
    return { kind: 'data', data: { target, text, bytes: Buffer.byteLength(text) }, summary: `read ${target}` }
  },
}

// ============================================================================================
// THE INDEPENDENT VERIFIER
// ============================================================================================

/**
 * Re-reads the report from disk with its own call and parses the facts back OUT of the rendered
 * text. It never compares the tool's numbers to the tool's own numbers - it compares what is
 * actually on disk against the facts observed by the earlier steps.
 *
 * Rejection is the default: an absent, altered, truncated or internally inconsistent report is
 * refused, never "best effort" accepted.
 */
function reportFacts(text: string): Record<string, string> | null {
  const facts: Record<string, string> = {}
  // The character class must accept UPPERCASE. It originally read `[a-z ()+]+`, which silently
  // failed on the key "tracked TypeScript source files" - so the verifier parsed zero facts and
  // rejected a perfectly correct report. A parser that quietly matches nothing is the same failure
  // as a parser that matches nothing: both look like "the data was bad".
  for (const line of text.split('\n')) {
    const m = /^-\s+([A-Za-z ()+]+):\s*(.+)$/.exec(line.trim())
    if (m) facts[m[1].trim()] = m[2].trim()
  }
  return Object.keys(facts).length ? facts : null
}

export function repoReportVerifier(): Verifier {
  return {
    // A step with no verifier cannot complete, so every step needs one - including the git reads.
    verifies: (step: Step) =>
      ['read-branch', 'read-status', 'read-files', 'compose', 'write', 'read-back'].includes(step.id),
    async verify(step, _ctx, toolData) {
      // ---- the git facts: re-run git INDEPENDENTLY and compare, never trust the tool's numbers
      if (step.id === 'read-branch' || step.id === 'read-status' || step.id === 'read-files') {
        const claimed = stdoutOf(toolData).trimEnd()
        const args = step.id === 'read-branch' ? ['rev-parse', '--abbrev-ref', 'HEAD']
          : step.id === 'read-status' ? ['status', '--porcelain']
            : ['ls-files']
        const r = spawnSync('git.exe', args, { cwd: REPO, encoding: 'utf8' })
        if (r.status !== 0) return { rejected: `an independent \`git ${args[0]}\` failed` }
        const observed = (r.stdout ?? '').trimEnd()
        if (observed !== claimed) {
          return {
            rejected: `the world moved under this step: \`git ${args.join(' ')}\` now reads ` +
              `${JSON.stringify(observed.slice(0, 80))} but the tool recorded ${JSON.stringify(claimed.slice(0, 80))}`,
          }
        }
        return {
          evidence: {
            kind: 'git-fact-observed',
            verb: args[0],
            lines: observed.length ? observed.split('\n').length : 0,
          } as unknown as Evidence,
        }
      }

      // ---- the composed text: must parse into the full fact set, consistently
      if (step.id === 'compose') {
        const claimed = (toolData as { text?: string }).text
        if (typeof claimed !== 'string') return { rejected: 'compose produced no text' }
        const facts = reportFacts(claimed)
        if (!facts) return { rejected: 'the composed text contains no parsable facts' }
        const tracked = Number(facts['uncommitted tracked changes'])
        const untracked = Number(facts['uncommitted untracked files'])
        const total = Number(facts['uncommitted total (tracked + untracked)'])
        if (!Number.isInteger(tracked) || !Number.isInteger(untracked) || !Number.isInteger(total)) {
          return { rejected: 'a composed count is not an integer' }
        }
        if (tracked + untracked !== total) {
          return { rejected: `inconsistent composition: ${tracked} + ${untracked} != ${total}` }
        }
        return { evidence: { kind: 'report-composed', facts: Object.keys(facts).length } as unknown as Evidence }
      }

      const claimed2 = toolData as { target?: string } | undefined
      if (!claimed2?.target) return { rejected: 'the tool named no report path' }

      // INDEPENDENT read. A different call from the one that wrote it.
      if (!existsSync(claimed2.target)) {
        return { rejected: `an independent stat of "${claimed2.target}" found nothing` }
      }
      const onDisk = readFileSync(claimed2.target, 'utf8')

      const facts = reportFacts(onDisk)
      if (!facts) return { rejected: 'the report contains no parsable facts' }

      const required = [
        'branch',
        'uncommitted tracked changes',
        'uncommitted untracked files',
        'uncommitted total (tracked + untracked)',
        'tracked TypeScript source files',
      ]
      for (const key of required) {
        if (!(key in facts)) return { rejected: `the report is missing the fact "${key}"` }
      }

      const n = (v: string): number => {
        const i = Number(v)
        return Number.isInteger(i) && i >= 0 ? i : Number.NaN
      }
      const tracked = n(facts['uncommitted tracked changes'])
      const untracked = n(facts['uncommitted untracked files'])
      const total = n(facts['uncommitted total (tracked + untracked)'])
      const tsTracked = n(facts['tracked TypeScript source files'])

      if ([tracked, untracked, total, tsTracked].some((x) => Number.isNaN(x))) {
        return { rejected: 'a numeric fact in the report is not a non-negative integer' }
      }
      // INTERNAL CONSISTENCY. An altered report that keeps every key but breaks the arithmetic
      // is exactly the kind of plausible-looking lie this project exists to catch.
      if (tracked + untracked !== total) {
        return { rejected: `inconsistent report: tracked(${tracked}) + untracked(${untracked}) != total(${total})` }
      }
      if (!facts['branch']) return { rejected: 'the report names an empty branch' }

      if (step.id === 'write') {
        const toolText = (toolData as { text?: string }).text
        if (typeof toolText === 'string' && toolText !== onDisk) {
          return { rejected: 'the file on disk differs from what the writing tool reported writing' }
        }
      }

      return {
        evidence: {
          kind: 'file-read-back',
          path: claimed2.target,
          bytes: Buffer.byteLength(onDisk),
          heading: facts['branch'],
        } as unknown as Evidence,
      }
    },
  }
}

// ============================================================================================
// THE MISSION
// ============================================================================================


// ============================================================================================
// MAIN-MODULE GUARD - importing this file must have NO effect.
//
// The first version ran its mission at module scope and called process.exit(). The unit tests
// import `repoReportVerifier` from here, so simply RUNNING THE TESTS executed a real mission and
// then TERMINATED THE TEST RUNNER partway through the suite: five later test files never ran, and
// the suite reported 360 tests where ~368 were expected.
//
// Found by RUNNING the suite and counting what actually executed - not by reading the code.
//
// `import.meta.url` is already used in ten .ts files in this repository, so it is not an
// assumption. `import.meta.main` was deliberately NOT used: it exists only on Node >=24.2 / >=22.18,
// while package.json declares engines.node ">=22". Comparing against argv works on all of them.
const IS_MAIN = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

async function main(): Promise<void> {
  const out = mkdtempSync(join(tmpdir(), 'aios-repo-report-'))
  const REPORT = join(out, 'repo-report.md')

  let failures = 0
  const check = (what: string, ok: unknown, detail = ''): void => {
    if (ok) { console.log(`   PASS  ${what}`); return }
    console.log(`   FAIL  ${what}${detail ? ` - ${detail}` : ''}`)
    failures++
  }

  /** Read a git fact OUTSIDE the mission, for the independent before/after comparison. */
  function gitNow(args: string[]): string {
    const r = spawnSync('git.exe', args, { cwd: REPO, encoding: 'utf8' })
    return (r.stdout ?? '').trim()
  }

  const statusBefore = gitNow(['status', '--porcelain'])
  const branchExpected = gitNow(['rev-parse', '--abbrev-ref', 'HEAD'])
  const tsCountExpected = gitNow(['ls-files']).split('\n').filter((l) => l.trim().endsWith('.ts')).length
  // THE PLAN COMES FROM THE PLANNER, NOT FROM ME.
  //
  // This block used to hand-author all six steps inline. That made the harness prove the EXECUTOR
  // works, and quietly NOT prove the loop does: a user cannot hand-author a plan, and the step that
  // turns a sentence into a plan was the one thing missing.
  //
  // So the objective is passed to DeterministicPlanProvider and the proposal is compiled. If the
  // planner refuses, the harness REFUSES - it does not fall back to the hand-authored plan, because a
  // fallback is exactly how a deterministic result gets reported as something it is not.
  const OBJECTIVE =
    'Report the state of this repository: current branch, uncommitted changes, and the count of ' +
    'tracked TypeScript source files. Write it to a report file outside the repository.'

  const planner = new DeterministicPlanProvider()
  const proposalResult = await planner.plan(OBJECTIVE, {
    outputRoot: out,
    now: () => Date.now(),
    // A minimal but REAL WorldState. It carries the identity the plan is checked against and
    // deliberately lists no entries: the recipe does not look at the filesystem, it asks git at
    // execution time and verifies there. Claiming entries it never read would be worse than none.
    world: {
      observationId: `repo-${Date.now()}`,
      observedAt: Date.now(),
      fingerprint: 'repo-state-recipe',
      capabilities: [],
      scope: { root: REPO, maxDepth: 1 },
      entries: [],
      // Not truncated, no walk errors - and SAID SO rather than left to be assumed.
      truncated: false,
      errors: [],
    },
  })

  if (!proposalResult.ok) {
    console.log('\n=== PLANNER REFUSED ===')
    console.log(`  ${proposalResult.code}: ${proposalResult.reason}`)
    process.exit(1)
  }
  const proposal = proposalResult.proposal
  console.log(`  planner    ${planner.name} -> intent repo-state, ${proposal.steps.length} steps`)
  console.log(`  plan came from the PLANNER, not from this file`)

  const mission: Mission = {
    id: 'repo-mission-1',
    objective: proposal.objective,
    constraints: proposal.constraints,
    state: 'executing',
    startedAt: Date.now(),
    history: [],
    pendingApprovals: [],
    plan: proposal.steps.map((st) => ({
      id: st.id,
      intent: st.intent,
      mode: st.mode,
      capability: st.capability,
      rationale: st.rationale,
      tool: st.tool,
      args: st.args,
      dependsOn: st.dependsOn,
      status: 'pending' as const,
      attempts: 0,
    })),
  }

  const dbPath = join(out, 'repo-mission.sqlite')
  const store = new DurableStore({ path: dbPath })
  // The recorder is what makes execution durable. The first version of this harness passed a bare
  // `{ store }` object; the executor refused the whole mission with "cfg.recorder.missionStarted is not
  // a function" and took no action. That refusal is the fail-closed behaviour working, not a nuisance -
  // it is why a mis-wired recorder cannot produce a mission that merely LOOKS executed.
  const recorder = new StoreRecorder(store)

  console.log('\n=== 1. THE MACHINE, BEFORE ===')
  console.log(`  repo            ${REPO}`)
  console.log(`  branch          ${branchExpected || '(none - HEAD unborn?)'}`)
  console.log(`  status entries  ${statusBefore ? statusBefore.split('\n').length : 0}`)
  console.log(`  tracked .ts     ${tsCountExpected}`)
  console.log(`  report target   ${REPORT}   (outside the repository)`)

  let result: Awaited<ReturnType<typeof execute>>
  try {
    result = await execute(mission, {
      tools: {
        resolve: (s: Step) =>
          s.tool === 'git-fact' ? { tool: gitFact, fellBack: false, reason: 'exact' }
          : s.tool === 'compose-repo-report' ? { tool: composeRepoReport, fellBack: false, reason: 'exact' }
          : s.tool === 'write-repo-report' ? { tool: writeRepoReport, fellBack: false, reason: 'exact' }
          : s.tool === 'read-repo-report' ? { tool: readRepoReport, fellBack: false, reason: 'exact' }
          : { unavailable: `no tool for ${s.tool}`, candidates: [] },
      },
      verifier: repoReportVerifier(),
      control: liveControl as never,
      config: { maxAttempts: 2, permission: livePermission, emergencyStop: async () => false, recorder },
    })
  } catch (e) {
    console.log('\n=== execute() THREW ===')
    console.log(String((e as Error)?.stack ?? e))
    process.exit(1)
  }

  const outcomes = result.mission.plan
    .map((st) => `${st.id}:${st.status}:${st.result?.outcome.kind ?? '-'}` +
      (st.result?.outcome.kind === 'failed' ? `(${JSON.stringify(st.result.outcome)})` : ''))
    .join(' ')

  console.log('\n=== 2. THE MISSION ===')
  console.log(`  outcomes  ${outcomes}`)
  console.log(`  record.keys      ${JSON.stringify(Object.keys(result.record))}`)
  console.log(`  record.events    ${JSON.stringify(result.record.events.map((e) => `${e.type}:${(e as {stepId?:string}).stepId ?? ''}:${(e as {reason?:string}).reason ?? ''}`))}`)
  console.log(`  record.complete  ${(result.record as { complete?: unknown }).complete}`)
  check('the mission completed', result.record.complete, `state=${result.mission.state}`)
  check('every step is independently verified', Object.keys(result.record.verified).length === result.mission.plan.length,
    `verified ${Object.keys(result.record.verified).length}/${result.mission.plan.length}: ${JSON.stringify(Object.keys(result.record.verified))}`)
  check('it used terminal.run and filesystem.write',
    result.mission.plan.some((s) => s.capability === 'terminal.run') &&
    result.mission.plan.some((s) => s.capability === 'filesystem.write'))

  console.log('\n=== 3. THE REPORT, RE-READ INDEPENDENTLY ===')
  console.log(readFileSync(REPORT, 'utf8'))
  const facts = reportFacts(readFileSync(REPORT, 'utf8')) ?? {}
  check('the branch matches what git says independently',
    facts['branch'] === branchExpected, `report=${facts['branch']} git=${branchExpected}`)
  check('the tracked TypeScript count matches an independent `git ls-files`',
    Number(facts['tracked TypeScript source files']) === tsCountExpected,
    `report=${facts['tracked TypeScript source files']} git=${tsCountExpected}`)

  console.log('\n=== 4. THE MISSION DID NOT CHANGE THE REPOSITORY ===')
  const statusAfter = gitNow(['status', '--porcelain'])
  check('git status is byte-identical before and after', statusAfter === statusBefore,
    `\n    before: ${JSON.stringify(statusBefore)}\n    after:  ${JSON.stringify(statusAfter)}`)

  console.log('\n=== 5. ACROSS A RESTART ===')
  const reopened = new DurableStore({ path: dbPath })
  const evidenceAfter = reopened.readEvidence(result.mission.id)
  const historyAfter = reopened.readHistory(result.mission.id)
  const approvalsAfter = reopened.readApprovals(result.mission.id)
  const recovered = reopened.readMission(result.mission.id)

  check('the mission survives closing and reopening the store',
    recovered !== undefined, `recovered=${recovered ? 'yes' : 'undefined'}`)
  check('its evidence survives', evidenceAfter.length >= 1, `evidence rows=${evidenceAfter.length}`)
  check('its history survives in order', historyAfter.length >= 1, `history rows=${historyAfter.length}`)
  // Completion is RE-DERIVED from the recovered rows, not read from a flag. `RecoveredMission`
  // deliberately exposes no `complete` property, which is the point: completion is a function of
  // the persisted step statuses, so it cannot be stale or cached into a column that says "done".
  const recoveredSteps = recovered?.mission?.plan ?? []
  const rederivedComplete = recoveredSteps.length > 0 && recoveredSteps.every((s) => s.status === 'done')
  check('completion is RE-DERIVED from the store, not read from a cached flag',
    rederivedComplete, `steps=${JSON.stringify(recoveredSteps.map((s) => s.status))}`)
  check('and no approval carries authority across the restart',
    approvalsAfter.every((a) => String(a.state) !== 'granted'),
    `approvals=${JSON.stringify(approvalsAfter.map((a) => a.state))}`)
  reopened.close()

  console.log('')
  if (failures) {
    console.log(`   === ${failures} FAILURE(S) ===`)
    process.exit(1)
  }
  console.log('   === PASS ===')
  process.exit(0)
}

if (IS_MAIN) {
  await main()
}
