/**
 * WHY A CASE CAN TIME OUT, AND WHAT THAT MEANS.
 *
 * MEASURED on the first full run (nemotron-3.5-lightning-free, 1,212.9s for 6 cases): two of six
 * cases hit the 300s wall and returned `unavailable`. A reviewer agent that explores the filesystem,
 * reads several files and reasons at length is simply slower than a wall-clock bound chosen for a
 * quick check.
 *
 * That is a REAL limit and it is reported as a failure rather than quietly dropped. `unavailable` is
 * not `approve`, so the case counts as incorrect - the suite will not let a reviewer pass by being
 * unavailable on exactly the hard questions. The cure is a model that answers within the bound, or a
 * larger bound; it is not a case list that removes the two hard questions.
 */
const perCaseTimeout = (): number => Number(process.env.AIOS_EVAL_CASE_TIMEOUT_MS ?? 300_000)

/**
 * Runs the reviewer evaluation against a free model and reports the result.
 *
 * Free models only. No paid provider is reachable from here: the reviewer is built from
 * `OpenCodeReviewer`, which talks to the local OpenCode CLI, and the model id must contain `free`
 * unless `AIOS_REVIEW_MODEL_ALLOW_PAID=1` is set - which exists so that spending money can never
 * happen by forgetting to pass a flag.
 *
 *   node --experimental-strip-types packages/agent/run-reviewer-eval.ts
 *   AIOS_REVIEW_MODEL=opencode/step-5-preview-free node ... run-reviewer-eval.ts
 */

import { runSuite, renderReport } from './reviewer-eval.ts'

const IMPLEMENT = process.env.AIOS_IMPL_MODEL ?? 'opencode/space-bunny-free'
const REVIEWER = process.env.AIOS_REVIEW_MODEL ?? 'opencode/nemotron-3.5-lightning-free'
const TIMEOUT = perCaseTimeout()

/**
 * Refuse a paid model unless the operator said so explicitly.
 *
 * The check is on the model NAME, which is crude but it is the only signal available before the call,
 * and a crude check that stops a $30 mistake is worth more than an exact one that arrives afterwards.
 * `free` is required in the id unless the override is set.
 */
if (!REVIEWER.includes('free') && process.env.AIOS_REVIEW_MODEL_ALLOW_PAID !== '1') {
  console.log(`REFUSING: "${REVIEWER}" does not look like a free model, and this suite must not spend money.`)
  console.log('Choose a model whose id contains "free", or set AIOS_REVIEW_MODEL_ALLOW_PAID=1 deliberately.')
  process.exit(2)
}

console.log(`reviewer evaluation: ${REVIEWER} reviewing ${IMPLEMENT}'s work`)
const only = process.env.AIOS_EVAL_ONLY
  ? process.env.AIOS_EVAL_ONLY.split(',').map((s) => s.trim()).filter(Boolean)
  : undefined

const report = await runSuite({
  reviewerModel: REVIEWER,
  implementerModel: IMPLEMENT,
  timeoutMs: perCaseTimeout(),
  ...(only ? { only } : {}),
})
console.log(renderReport(report))
process.exit(report.passed ? 0 : 1)