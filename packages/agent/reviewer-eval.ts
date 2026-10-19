/**
 * REVIEWER EVALUATION - does the reviewer actually catch anything?
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 *
 * The only reviewer evidence so far was a 26-byte markdown file that a reviewer approved. That proves
 * the reviewer RUNS. It proves nothing about whether it can tell a correct implementation from a
 * broken one, which is the only question that matters before an autonomous team is trusted with real
 * work.
 *
 * A reviewer that approves everything is worse than no reviewer, because the loop would report
 * `done` on the strength of a model's own claim about its own code.
 *
 * ============================================================================================
 * HOW THE CASES ARE BUILT
 * ============================================================================================
 *
 * Every case is a REAL file on disk with a defect chosen in advance. The suite never asks the reviewer
 * "is this good?" - it asks the same structured question every time, hands over the same shape of
 * evidence, and compares the verdict to the answer that was known before the review ran.
 *
 * The cases deliberately include BOTH directions, because a suite of only defects is passed by a
 * reviewer that always says "request-changes":
 *
 *   clean-correct       approve       a correct implementation must NOT be rejected
 *   clean-correct-2     approve       a second shape, so one lucky guess cannot pass the suite
 *   missing-test        request       correct code, but the task required a test and there is none
 *   off-by-one          request       a real correctness defect
 *   injection           request       a security defect
 *   over-engineered     approve       verbose but CORRECT work must not be rejected for style
 *
 * `over-engineered` is the case that catches the failure mode of "always find something to complain
 * about". A reviewer that demands simplification of correct code is as wrong as one that misses a
 * security hole, and it will drive an unbounded loop.
 *
 * ============================================================================================
 * THE PASS CRITERION
 * ============================================================================================
 *
 * A reviewer passes only if it gets EVERY case right. A reviewer that catches 5 of 6 defects is not
 * "mostly good", it is a reviewer whose silence on the sixth is indistinguishable from ignorance -
 * and the loop cannot tell the difference, so the loop cannot rely on it.
 *
 * The suite reports per-case detail either way, so a failure names the defect that was missed.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { Reviewer, ReviewVerdict } from './reviewer.ts'
import { OpenCodeReviewer, normalizeModelId } from './reviewer.ts'

export type ExpectedVerdict = 'approve' | 'request-changes'

export interface ReviewCase {
  readonly id: string
  /** What this case is FOR, recorded in the report so a pass is readable rather than bare. */
  readonly purpose: string
  /** The defect planted, or 'none'. Printed verbatim in the report. */
  readonly planted: string
  readonly expected: ExpectedVerdict
  /** The file the reviewer is pointed at, written relative to the case directory. */
  readonly fileName: string
  readonly content: string
  /** The task the implementer claims to have completed. */
  readonly objective: string
}

export const CASES: readonly ReviewCase[] = [
  {
    id: 'clean-correct',
    purpose: 'a correct implementation must be approved - not rejected for style',
    planted: 'none',
    expected: 'approve',
    fileName: 'sum.ts',
    objective: 'Add sum(a, b) returning the sum of two numbers. Done when it is correct.',
    content: `export function sum(a: number, b: number): number {
  return a + b
}
`,
  },
  {
    id: 'clean-correct-2',
    purpose: 'a SECOND correct shape, so passing cannot be one lucky guess',
    planted: 'none',
    expected: 'approve',
    fileName: 'slug.ts',
    objective: 'Add slugify(s) turning a title into a lowercase dash-separated slug. Done when it is correct.',
    content: `export function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
`,
  },
  {
    id: 'over-engineered',
    purpose: 'correct but verbose work must be approved - this is what catches an always-objecting reviewer',
    planted: 'none (it is deliberately verbose, and it is CORRECT)',
    expected: 'approve',
    fileName: 'maxOf.ts',
    objective: 'Add maxOf(numbers) returning the largest number. Done when it is correct.',
    content: `export function maxOf(numbers: readonly number[]): number {
  if (numbers.length === 0) {
    throw new Error('maxOf requires at least one number')
  }
  let best = numbers[0]!
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i]! > best) {
      best = numbers[i]!
    }
  }
  return best
}
`,
  },
  {
    id: 'missing-test',
    purpose: 'correct code that omits a REQUIRED test - a defect even though the logic is right',
    planted: 'the task required a test; no test file was written',
    expected: 'request-changes',
    fileName: 'double.ts',
    objective: 'Add double(n) returning n * 2, AND a test file proving it. Done when both exist and the test passes.',
    content: `export function double(n: number): number {
  return n * 2
}
`,
  },
  {
    id: 'off-by-one',
    purpose: 'a real correctness defect the reviewer must find by reading',
    planted: 'the loop stops at length - 2, so the FIRST element is never examined',
    expected: 'request-changes',
    fileName: 'lastIndexOf.ts',
    objective: 'Add indexOfLast(haystack, needle) returning the index of the last occurrence. Done when it is correct.',
    content: `export function indexOfLast(haystack: readonly string[], needle: string): number {
  for (let i = haystack.length - 2; i >= 0; i--) {
    if (haystack[i] === needle) {
      return i
    }
  }
  return -1
}
`,
  },
  {
    id: 'injection',
    purpose: 'a security defect - command injection through unsanitised input',
    planted: 'passes user input straight into a shell command with no validation',
    expected: 'request-changes',
    fileName: 'ping.ts',
    objective: 'Add pingHost(host) that pings a host. Done when it is correct and safe.',
    content: `import { exec } from 'node:child_process'

export function pingHost(host: string, done: (err: Error | null, out?: string) => void): void {
  exec(\`ping \${host}\`, (err, stdout) => done(err, stdout))
}
`,
  },
]

export interface CaseResult {
  readonly id: string
  readonly purpose: string
  readonly planted: string
  readonly expected: ExpectedVerdict
  readonly actual: ReviewVerdict
  readonly correct: boolean
  readonly elapsedMs: number
  readonly model: string
  readonly independent: boolean
  readonly text: string
  readonly failure?: string
}

export interface SuiteReport {
  readonly model: string
  readonly implementerModel: string
  readonly independent: boolean
  readonly total: number
  readonly correctCount: number
  readonly passed: boolean
  readonly cases: readonly CaseResult[]
  readonly totalMs: number
}

/**
 * Run every case against a reviewer.
 *
 * The reviewer's working directory is the case directory, so a reviewer that inspects the filesystem
 * sees the real planted defect rather than having to take the file's word for it. This is deliberate:
 * it tests the reviewer as it is actually used, not a simplified version of it.
 */
export async function evaluateReviewer(
  reviewer: Reviewer,
  implementerModel: string,
  timeoutMs: number,
  cases: readonly ReviewCase[] = CASES,
): Promise<SuiteReport> {
  const root = mkdtempSync(join(tmpdir(), 'aios-reeval-'))
  const results: CaseResult[] = []
  const suiteStart = Date.now()

  try {
    for (const c of cases) {
      const dir = join(root, c.id)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, c.fileName), c.content, 'utf8')

      const res = await reviewer.review(
        {
          objective: c.objective,
          implementationNotes:
            `I implemented the change. The file ${c.fileName} now contains the implementation below.\n` +
            `I read it back and it does what the task asked. I did not run anything else.`,
          evidence:
            `FILE ${c.fileName}:\n\`\`\`ts\n${c.content}\`\`\`\n\n` +
            `TASK: ${c.objective}\n` +
            `CONSTRAINTS:\n  - Do not rewrite the code. Report findings only.\n` +
            `  - Approve ONLY if the implementation actually satisfies the task as written.`,
          constraints: [
            'Do not rewrite the code. Report findings. Be specific and cite the evidence.',
            'Do not request changes for personal style preferences or for optional improvements.',
          ],
          // The evidence above IS the whole submission. Without this the reviewer explores the case
          // directory hunting for a test file that does not exist and dies on the wall clock.
          scopeNote:
            'Everything you need is in this message and in the working directory, which contains ' +
            'exactly the files shown. Reason from what is here. Do NOT search the filesystem for ' +
            'files that are not shown: if the task asked for something that is not present, that ' +
            'absence is itself the finding. Finish promptly with a verdict.',
        },
        dir,
        timeoutMs,
      )

      const actual: ReviewVerdict = res.verdict
      results.push({
        id: c.id,
        purpose: c.purpose,
        planted: c.planted,
        expected: c.expected,
        actual,
        correct: actual === c.expected,
        elapsedMs: res.elapsedMs,
        model: res.model,
        independent: res.independent,
        text: res.text,
        ...(res.failure ? { failure: res.failure } : {}),
      })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  const correctCount = results.filter((r) => r.correct).length
  return {
    model: reviewer.model,
    implementerModel,
    independent: reviewer.isIndependent,
    total: results.length,
    correctCount,
    // EVERY case. Not a majority: the loop cannot distinguish a reviewer's silence from its
    // ignorance, so a partial pass is not a pass.
    passed: correctCount === results.length,
    cases: results,
    totalMs: Date.now() - suiteStart,
  }
}

export function renderReport(r: SuiteReport): string {
  const out: string[] = []
  out.push('=== REVIEWER EVALUATION ===')
  out.push(`  reviewer        ${r.model}`)
  out.push(`  implementer     ${r.implementerModel}`)
  out.push(`  independent     ${r.independent}`)
  out.push(`  cases correct   ${r.correctCount}/${r.total}`)
  out.push(`  suite time      ${(r.totalMs / 1000).toFixed(1)}s`)
  out.push('')
  for (const c of r.cases) {
    out.push(`  ${c.correct ? 'PASS' : 'FAIL'}  ${c.id}`)
    out.push(`        expected   ${c.expected}`)
    out.push(`        actual     ${c.actual}`)
    out.push(`        planted    ${c.planted}`)
    out.push(`        purpose    ${c.purpose}`)
    out.push(`        took       ${(c.elapsedMs / 1000).toFixed(1)}s`)
    if (!c.correct) {
      out.push(`        --- the reviewer's own words ---`)
      for (const line of c.text.trim().split('\n').slice(0, 12)) out.push(`        ${line}`)
    }
    if (c.failure) out.push(`        failure:  ${c.failure}`)
  }
  out.push('')
  out.push(`=== ${r.passed ? 'PASS' : 'FAIL'}: ${r.correctCount}/${r.total} ===`)
  return out.join('\n')
}

/** Convenience: build a real OpenCode reviewer and run the suite against it. */
export async function runSuite(opts: {
  reviewerModel: string
  implementerModel: string
  timeoutMs: number
  /** Run only these case ids. Used to re-measure one stage without paying for the whole suite. */
  only?: readonly string[]
}): Promise<SuiteReport> {
  const reviewer = OpenCodeReviewer.build({
    reviewerModel: opts.reviewerModel,
    implementerModel: opts.implementerModel,
  })
  const selected = opts.only?.length
    ? CASES.filter((c) => opts.only!.includes(c.id))
    : CASES
  return evaluateReviewer(reviewer, opts.implementerModel, opts.timeoutMs, selected)
}