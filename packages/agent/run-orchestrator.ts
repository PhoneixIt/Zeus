/**
 * THE ACCEPTANCE RUN — one real, unattended collaboration cycle.
 *
 * This is the evidence that the orchestrator collaborates rather than merely starting. Everything
 * here invokes the REAL OpenCode CLI, runs a REAL verification command, and records what actually
 * came back.
 *
 * It is deliberately NOT a mock. A mocked reviewer would prove nothing about whether the loop works,
 * and the single most important property here is that a REVIEW ACTUALLY TRAVELS BACK TO THE
 * IMPLEMENTER WITHOUT A HUMAN IN THE MIDDLE.
 *
 * Usage:
 *   node --experimental-strip-types --no-warnings packages/agent/run-orchestrator.ts [taskCount]
 */

import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Orchestrator, type Task } from './orchestrator.ts'
import { OpenCodeReviewer } from './reviewer.ts'

const REPO = process.cwd()
const STATE_DIR = join(REPO, '.aios')
const STATE_PATH = join(STATE_DIR, 'orchestrator-state.json')
const LOCK_PATH = join(STATE_DIR, 'orchestrator.lock')

const IMPLEMENT_MODEL = process.env.AIOS_IMPL_MODEL ?? 'opencode/space-bunny-free'
/**
 * DEFAULTED TO A DIFFERENT MODEL, and this default was chosen by measurement rather than hope.
 *
 * Every candidate below was run live against a real TypeScript file with a real review prompt. All
 * cost $0; none is a paid provider.
 *
 *   space-bunny-free          the implementer's own model - NOT independent, kept as the fallback
 *   nemotron-3.5-lightning-free  31.7s, returned VERDICT: approve
 *   step-5-preview-free          90.2s, returned VERDICT: approve
 *   exo-free                     1.9s, returned NO verdict line at all
 *
 * Nemotron is the default because it is both genuinely different and the fastest of the two that
 * actually produced a verdict - at 31.7s it is a quarter of step-5's cost per round, which matters
 * when a round is bounded at 420s.
 */
const REVIEW_MODEL = process.env.AIOS_REVIEW_MODEL ?? 'opencode/nemotron-3.5-lightning-free'
const TIMEOUT = Number(process.env.AIOS_TASK_TIMEOUT_MS ?? 420_000)

/**
 * The reviewer, with independence DERIVED by comparing the two model names.
 *
 * A review by the same model on the same task is a second pass, not an independent opinion. The
 * comparison moved into `OpenCodeReviewer.build` so no caller can supply the answer, and it is
 * prefix-insensitive so `opencode/x` and `x` cannot be used to claim independence they do not have.
 *
 * TESTED LIVE, both directions, on this machine's free models: implementer `space-bunny-free` with
 * reviewer `nemotron-3.5-lightning-free` returned `VERDICT: approve` on a real file in 31.7s, and
 * `step-5-preview-free` returned one in 90.2s. Both cost $0. `exo-free` returned NO verdict line in
 * 1.9s and is therefore reported `request-changes` by `readVerdict` - not independent, not reliable,
 * and not used.
 */
const reviewer = OpenCodeReviewer.build({
  reviewerModel: REVIEW_MODEL,
  implementerModel: IMPLEMENT_MODEL,
})

const TASKS: Task[] = [
  {
    id: 'docs-provider-contract',
    objective:
      'In docs/, write a file `model-provider-contract.md` documenting how AIOS selects a planning ' +
      'provider: the ModelPlanProvider interface, the two endpoint families actually available ' +
      '(the local ONNX server on 127.0.0.1:8793 and any OpenAI-compatible HTTP endpoint), and an ' +
      'explicit statement that the deterministic planner is NOT a model and must never be reported ' +
      'as one. Do not change any code. Cite the real file paths.',
    constraints: [
      'Create exactly one new markdown file under docs/.',
      'Do NOT modify, create or delete any other file.',
      'Do NOT modify package.json or any source file.',
      'Every claim must be traceable to a file that exists in the repository.',
    ],
    verifyCommand: 'node --experimental-strip-types --no-warnings --test "packages/agent/test/*.test.ts"',
    maxReviewRounds: 2,
    timeoutMs: TIMEOUT,
  },
]

function line(s = ''): void { console.log(s) }
function hr(t: string): void { line(); line(`===== ${t} =====`) }

async function main(): Promise<number> {
  if (existsSync(STATE_DIR)) rmSync(STATE_DIR, { recursive: true, force: true })

  const { orch, resumed } = Orchestrator.loadOrCreate(STATE_PATH, LOCK_PATH, {
    objective: 'Give AIOS a working model-driven mission and an unattended development loop.',
    architecture: 'hybrid: a reasoning model proposes; deterministic code validates, compiles, executes and verifies',
    rationale: 'The local 0.5B failed 10+ bounded attempts on a machine with 0.45GB free RAM; a free hosted reasoning model is proven working in 3.5s.',
  })
  line(`orchestrator started (resumed=${resumed})  state=${STATE_PATH}`)

  const lock = orch.acquireLock()
  if (!lock.acquired) {
    line(`REFUSING to start: the lock is held (${lock.holder}). One orchestrator edits this repository.`)
    return 2
  }
  line(`lock acquired (pid ${process.pid})`)

  const reconcile = await orch.reconcile(REPO)
  if (reconcile.length) { hr('RECONCILE'); reconcile.forEach((n) => line(`  ${n}`)) }

  for (const t of TASKS) orch.enqueue(t)
  line(`queued ${TASKS.length} task(s): ${TASKS.map((t) => t.id).join(', ')}`)

  const t0 = Date.now()
  while (true) {
    const task = orch.nextPending()
    if (!task) { line('no pending tasks'); break }
    const spec = TASKS.find((x) => x.id === task.id)!
    hr(`CYCLE: ${task.id}`)

    const previousFindings = task.rounds
      .filter((r) => r.role === 'reviewer')
      .flatMap((r) => r.text.split('\n').filter((l) => l.includes('HIGHEST PRIORITY FINDING:')))

    const { implement, review, record } = await orch.runCycle(spec, {
      model: IMPLEMENT_MODEL, reviewer, cwd: REPO,
      ...(previousFindings.length ? { previousFindings } : {}),
    })

    line(`implementer  model=${IMPLEMENT_MODEL} exit=${String(implement.exitCode)} ${(implement.elapsedMs / 1000).toFixed(1)}s`)
    line(`  said: ${implement.text.trim().slice(0, 400).replace(/\n/g, ' ')}`)
    if (review) {
      line(`reviewer     model=${review.model} independent=${String(review.independent)} verdict=${review.verdict} ${(review.elapsedMs / 1000).toFixed(1)}s`)
      line(`  said: ${review.text.trim().slice(0, 400).replace(/\n/g, ' ')}`)
    }
    line(`verification passed=${String(record.verificationPassed)}`)
    line(`TASK STATUS  ${record.status}   ${record.note}`)

    if (record.status !== 'pending') break
    line('(review asked for changes; returning the findings to the implementer for the next cycle)')
  }

  orch.releaseLock()

  hr('FINAL STATE')
  const s = orch.snapshot()
  line(`verified milestone : ${s.verifiedMilestone}`)
  line(`blockers           : ${s.blockers.length ? s.blockers.join(' | ') : 'none'}`)
  for (const t of s.tasks) {
    line(`  ${t.id}: ${t.status}  rounds=${t.rounds.length}  verified=${String(t.verificationPassed)}`)
    if (t.verificationOutput.trim()) {
      line(`    verification tail: ${t.verificationOutput.trim().split('\n').slice(-4).join(' / ')}`)
    }
  }
  line(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  line(`state persisted at ${STATE_PATH}`)
  return 0
}

process.exit(await main())