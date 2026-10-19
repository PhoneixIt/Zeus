/**
 * THE CLOSED LOOP: WHAT HAPPENED, AND WHETHER THE STEPS THAT HAPPENED WERE WORTH DOING.
 * ============================================================================================
 *
 * THE DEFECT THIS EXISTS TO FIX
 * -----------------------------
 * Observed end to end on this machine. Asked for "data protection companies", AIOS ran three
 * steps, verified all three, and reported:
 *
 *     Completed 3 step(s); every step and the objective were independently verified.
 *     ok=true
 *
 * and wrote this file:
 *
 *     Company,Founded,Description
 *     To be populated from the research results,,
 *
 * That is the worst possible outcome: a fully green report attached to an empty deliverable. Every
 * check that ran passed, and every check that ran was checking the WRONG THING - that a file
 * existed, was rectangular, and read back identically. None of them asked whether it contained
 * anything.
 *
 * WHY IT HAPPENED
 * ---------------
 * The model writes the spreadsheet step's rows at PLAN time, before any research has run. The
 * research results arrive afterwards, in a different step, in a context the planner never sees.
 * So the model is asked to write data it does not have, and the only honest-looking thing to
 * write is a promise. "To be populated from the research results" is the model telling the truth
 * about what it can see, and the system recorded that truth as a success.
 *
 * WHY A PARSER FIX DID NOT SOLVE IT
 * --------------------------------
 * Earlier sessions spent a long time repairing the model's JSON - unescaped quotes, raw newlines,
 * stray braces. Those repairs were real and they were worth doing, and they were also not this
 * bug. Once the plan parsed, the rows inside it were still placeholders. Parsing the plan and
 * producing a useful deliverable are two separate problems, and only the second one matters here.
 *
 * THE TWO THINGS THIS MODULE DOES
 * -------------------------------
 * 1. `findPlaceholderContent` - decide, deterministically and without asking anyone, whether a
 *    piece of content is a promise rather than a deliverable. No model call: this is string
 *    matching, it must be cheap, and it must give the same answer every time.
 *
 * 2. `buildReplanFeedback` - turn what actually happened into the context the model needs for a
 *    second attempt, INCLUDING THE REAL CONTENT of what the earlier steps produced. Without the
 *    content, a replan is just the same plan asked twice.
 *
 * The content is the whole point. Feeding back "step s1 succeeded" does not help a model write
 * rows; feeding back the eight quoted facts it collected does.
 *
 * NOTHING HERE EXECUTES ANYTHING. This module reads and decides. The governed executor still
 * runs every step, and a replan is an ordinary plan that goes through the same validation,
 * the same permission check and the same verifiers as the first one.
 */

import { readFileSync } from 'node:fs'

// ===========================================================================================
// 1. placeholder content
// ===========================================================================================

/**
 * Markers that mean "this is a promise, not a deliverable".
 *
 * Every entry is deliberately UNAMBIGUOUS. A detector that fires on legitimate text is worse than
 * no detector at all: it would discard a real answer and go looking for another one, and the user
 * would never learn why the good answer they could have had was thrown away. So nothing that can
 * legitimately appear in a finished deliverable is on this list.
 *
 * Specifically ABSENT, on purpose: `n/a`, `example`, `unknown`, `-`, `none`, `0`. All of those
 * appear in real, correct data. "Unknown headquarters" is a fact; "to be populated" is not.
 */
const PLACEHOLDER_MARKERS: ReadonlyArray<Readonly<RegExp>> = [
  /to be populated/i,
  /to be (?:determined|confirmed|added|filled|completed|inserted|supplied)/i,
  /\bTBD\b/,
  /\bTODO\b/,
  /\bplaceholder\b/i,
  /\bfrom step s\d/i,
  /\bresearch (?:findings|results) from\b/i,
  /\bfill (?:this )?in\b/i,
  /\blorem ipsum\b/i,
  /\bXXX\b/,
  /\bto be determined\b/i,
]

/** Longest excerpt of the offending text kept for the report and the replan prompt. */
const SAMPLE_CHARS = 160

/**
 * Every placeholder marker present in a piece of text, in the order they were found.
 *
 * Returns an empty array for text that carries substance. That asymmetry matters: the caller uses
 * "did this find anything" as the judgement, so an empty array has to mean a clean bill of health
 * rather than "no opinion".
 */
export function findPlaceholderContent(text: string): string[] {
  if (typeof text !== 'string' || text.trim().length === 0) return []
  const hits: string[] = []
  for (const re of PLACEHOLDER_MARKERS) {
    const m = re.exec(text)
    if (m) hits.push(m[0])
  }
  return hits
}

/**
 * The same question, asked about a spreadsheet's rows and a document's text.
 *
 * A spreadsheet can arrive as an array of arrays (the form this system asks for) or as a
 * newline-separated string (still accepted, because plans written before the change keep
 * arriving). Both are flattened to text here so there is ONE detector rather than two that can
 * drift apart.
 */
export function placeholderInArgs(args: Record<string, unknown>): string[] {
  const parts: string[] = []
  for (const key of ['rows', 'headers', 'content', 'text', 'body', 'markdown']) {
    const v = args[key]
    if (v === undefined || v === null) continue
    if (Array.isArray(v)) {
      for (const row of v) {
        parts.push(Array.isArray(row) ? row.map((c) => String(c ?? '')).join(' | ') : String(row ?? ''))
      }
    } else {
      parts.push(String(v))
    }
  }
  return parts.flatMap((p) => findPlaceholderContent(p))
}

/**
 * How much of the text is placeholder.
 *
 * A deliverable that mentions "TBD" once in a footnote is fine. A deliverable whose every row is
 * "to be populated" is a promise. The fraction is what separates them, so the caller gets a
 * number rather than a yes/no and can decide for itself.
 *
 * "Empty" here means NO CONTENT, not "a non-empty string". A row of nothing but separators - `,,`
 * - is three characters long and contains no information at all, and a table made entirely of
 * those is exactly as empty as a table of blank lines. Measuring string length therefore rated a
 * sheet of pure separators as 0% placeholder, which is precisely backwards: it is 100%. The row
 * content is stripped of separators and whitespace before the test.
 */
export function placeholderRatio(rows: readonly string[]): number {
  const hasContent = (r: string): boolean => r.replace(/[\s,;|]+/g, '').length > 0
  const nonEmpty = rows.filter((r) => hasContent(String(r ?? '')))
  if (nonEmpty.length === 0) return 1
  const bad = nonEmpty.filter((r) => findPlaceholderContent(String(r ?? '')).length > 0)
  return bad.length / nonEmpty.length
}

/** A short excerpt for the report, cut on a whole-word boundary so it does not end mid-word. */
export function placeholderSample(rows: readonly string[]): string {
  const hit = rows.find((r) => findPlaceholderContent(r).length > 0)
  const raw = (hit ?? rows.join(' / ') ?? '').trim().slice(0, SAMPLE_CHARS)
  if (raw.length <= SAMPLE_CHARS) return raw
  const cut = raw.lastIndexOf(' ', SAMPLE_CHARS)
  return `${raw.slice(0, cut > 40 ? cut : SAMPLE_CHARS)}...`
}

/**
 * A produced artifact is a promise, not a deliverable, when at least this fraction of its rows say
 * so - or when most of them are simply blank.
 *
 * Half, not all. A single blank row in an otherwise complete table is a gap in a real answer; a
 * table where the majority of rows announce that they are to be filled in later is a document that
 * has described its own emptiness, and reporting that as a completed deliverable is the failure
 * this threshold exists to catch.
 */
export const PLACEHOLDER_RATIO_LIMIT = 0.5

export interface SubstanceVerdict {
  readonly path: string
  readonly ratio: number
  readonly sample: string
  readonly lines: number
}

/**
 * Read a file that this system just wrote and judge whether it holds anything.
 *
 * The post-hoc half of the substance check. The plan-time check can see only what the MODEL
 * proposed; this sees what actually reached the disk, which is the only thing the user will ever
 * receive. Both are needed - a plan that promises is caught before it wastes a run, and a file
 * that ends up empty is caught after, when it matters.
 *
 * A file that cannot be read returns null rather than a verdict. "I could not check this" must not
 * be reported as "this is empty", and neither may be reported as "this is fine".
 */
export function assessArtifactSubstance(path: string): SubstanceVerdict | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0)
  // A single-line file cannot be judged by row fraction - a report that is one paragraph long is
  // perfectly good. Only a multi-row table has rows to be promises in.
  const ratio = lines.length <= 1 ? (findPlaceholderContent(raw).length > 0 ? 1 : 0) : placeholderRatio(lines)
  return { path, ratio, sample: placeholderSample(lines), lines: lines.length }
}

// ===========================================================================================
// 2. feedback
// ===========================================================================================

/** One step's real outcome, as the reporter recorded it. */
export interface StepOutcome {
  readonly id: string
  readonly tool: string
  readonly intent: string
  readonly verified: boolean
  readonly summary: string
}

export interface ReplanFeedbackInput {
  readonly goal: string
  readonly attempt: number
  readonly steps: readonly StepOutcome[]
  readonly objectiveKind: string
  readonly objectiveReason: string
  /**
   * Files produced by earlier steps whose CONTENT should be handed to the model.
   *
   * This is the parameter the whole design turns on. An outcome list tells the model that research
   * happened; the file's contents tell it what was found. Only the second one can produce real
   * rows.
   */
  readonly evidencePaths?: readonly string[]
  /** Why the last attempt is being retried, in one sentence. */
  readonly reason: string
}

/** Longest excerpt of any one evidence file placed into the prompt. */
const EVIDENCE_CHARS = 6_000

/**
 * Read back what an earlier step actually produced, so the model can use it.
 *
 * Bounded, and bounded for a reason: a brief can be tens of kilobytes of evidence apparatus, and a
 * prompt that carries all of it gets worse, not better. The excerpt is cut from the END of the
 * file when the file is long, because a research brief puts its findings last - the headers and
 * evidence-composition counters are process notes, the quoted facts are the answer.
 *
 * A file that cannot be read is skipped, not reported as empty. "I could not read it" and "it was
 * empty" are different facts and only one of them is true.
 */
function readEvidence(path: string): { path: string; text: string } | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const text = raw.length <= EVIDENCE_CHARS
    ? raw
    : `...(earlier content omitted; ${raw.length} characters total)...\n${raw.slice(-EVIDENCE_CHARS)}`
  return { path, text }
}

/**
 * The context a second attempt needs, as one block of text.
 *
 * Four parts, and the order is the argument:
 *
 *   1. what the goal was          - it has not changed
 *   2. why this attempt exists    - so the model is not simply re-planning from scratch
 *   3. what each step actually did, with the verifier's own words
 *   4. THE CONTENT the earlier steps produced, in full enough to use
 *
 * Part 4 is why this exists. Without it the model is asked to fill in a table from the same empty
 * context it filled it in from the first time, and it will write the same promise again - and
 * there is no reason to expect otherwise, because nothing changed on its side of the boundary.
 *
 * The closing instructions are load-bearing too, and each one names a failure this system has
 * actually made:
 *
 *   - real values, never a description of values. The model writes "To be populated from the
 *     research results" because describing the data feels like reporting it. It is not.
 *   - `rows` as an array of arrays. Inlining CSV in a JSON string is what made plans unparseable.
 *   - do not invent a URL. The verifier drops unsourced URLs, so an invented one costs the sheet
 *     a cell and gains nothing.
 *   - if the evidence genuinely does not contain the answer, say so in the reply rather than
 *     writing a placeholder. A plan that reports a gap is a plan that can be acted on; a file
 *     full of promises is not.
 */
export function buildReplanFeedback(input: ReplanFeedbackInput): string {
  const lines: string[] = []
  lines.push(`Goal (unchanged): ${input.goal}`)
  lines.push('')
  lines.push(`This is attempt ${input.attempt + 1}. The previous attempt did not finish the job.`)
  lines.push(`Why: ${input.reason}`)
  lines.push('')
  lines.push('What the previous attempt actually did, and what the verifier said:')

  if (input.steps.length === 0) {
    lines.push('  (it produced no executable steps at all)')
  }
  for (const s of input.steps) {
    const mark = s.verified ? 'VERIFIED' : 'NOT VERIFIED'
    const summary = s.summary.trim().replace(/\s+/g, ' ').slice(0, 400)
    lines.push(`  ${s.id} [${s.tool}] ${s.intent}`)
    lines.push(`      ${mark}: ${summary}`)
  }

  lines.push('')
  lines.push(`Objective verdict: ${input.objectiveKind}${input.objectiveReason ? ` - ${input.objectiveReason}` : ''}`)

  const evidence = (input.evidencePaths ?? [])
    .map((p) => readEvidence(p))
    .filter((e): e is { path: string; text: string } => e !== null)

  if (evidence.length === 0) {
    lines.push('')
    lines.push(
      'No earlier step left readable content behind, so there is nothing to fill a table from. '
      + 'Research FIRST and use what comes back.',
    )
  } else {
    lines.push('')
    lines.push('HERE IS THE CONTENT THE EARLIER STEPS ACTUALLY PRODUCED. Use these real values:')
    for (const e of evidence) {
      lines.push('')
      lines.push(`--- BEGIN ${e.path} ---`)
      lines.push(e.text)
      lines.push(`--- END ${e.path} ---`)
    }
  }

  lines.push('')
  lines.push('RULES FOR THE PLAN YOU ARE ABOUT TO WRITE:')
  lines.push(
    '1. Put REAL VALUES in the output. Never write a description of the data, a promise to fill it '
    + 'in later, or a phrase like "to be populated" or "based on the research findings". A cell '
    + 'either holds a value you can point at in the evidence above, or it is empty.',
  )
  lines.push(
    '2. Write spreadsheet "rows" as a JSON ARRAY OF ARRAYS, e.g. [["Veeam","2006"],["Rubrik",'
    + '"2014"]]. Do not write them as one comma-separated string: a comma or a quote inside a cell '
    + 'then makes the whole plan unparseable and everything you just planned is lost.',
  )
  lines.push(
    '3. Do not invent a URL or a citation. Only use a URL that appears in the evidence above. '
    + 'Unsourced URLs are dropped by the verifier, so inventing one loses a cell and gains nothing.',
  )
  lines.push(
    '4. Do not repeat a step that already VERIFIED above unless the goal genuinely changed.',
  )
  lines.push(
    '5. If the evidence above does not actually contain the answer, then the honest move is to say '
    + 'so in your reply and to run the research that would find it. A plan that reports a gap can '
    + 'be acted on. A file full of promises cannot.',
  )

  return lines.join('\n')
}

/**
 * Whether a second attempt is worth making.
 *
 * The rule is a defect test, not a success test. That sounds like a distinction and is one: the
 * first version of this returned `true` for a completely clean run, because it asked "is there a
 * reason to believe something is fine?" and answered "a step verified" - so the tidiest possible
 * mission, the one with nothing to fix, was the one that got retried.
 *
 * A retry happens when a DEFECT is visible and something actually ran:
 *
 *   - the objective is not satisfied, or
 *   - a step did not verify, or
 *   - a produced artifact contains a promise rather than data.
 *
 * Two things veto it regardless. The attempt budget, because an unbounded loop is not autonomy,
 * it is a hang. And `stepsExecuted === 0`, because re-asking an identical model about an identical
 * goal returns an identical plan; without that, a plan the system could not even build would be
 * rebuilt the same unbuildable way on every retry.
 *
 * Note that "every step failed" IS a retry - the verifier's refusal is the single most useful
 * input the next attempt can have, and withholding it because nothing succeeded would throw away
 * the one case the feedback channel was built for.
 */
export function shouldReplan(input: {
  readonly attempt: number
  readonly maxAttempts: number
  /** How many steps actually executed. Zero means there is nothing to react to. */
  readonly stepsExecuted: number
  readonly allStepsVerified: boolean
  readonly objectiveSatisfied: boolean
  readonly placeholderFound: boolean
}): boolean {
  if (input.attempt + 1 >= input.maxAttempts) return false
  if (input.stepsExecuted <= 0) return false
  const defect = !input.objectiveSatisfied || !input.allStepsVerified || input.placeholderFound
  return defect
}