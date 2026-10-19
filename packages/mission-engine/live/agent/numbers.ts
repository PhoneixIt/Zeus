/**
 * A NUMBER IN THE REPORT MUST TRACE TO SOMETHING MEASURED.
 *
 * The failure this closes, observed live on 2026-10-19. Mission `2a1995ef` wrote a real 407-row
 * CSV and the model's narration said:
 *
 *   "The CSV inventory of the NAKIVO folder has been successfully created ... The file contains
 *    296 files recursively listed ... with columns: relative_path, name, extension, size_bytes,
 *    and last_modified."
 *
 * 413 files were there. 296 was invented. The file existed, the columns were roughly right, and
 * the number was simply false - and it was false in the sentence a person reads last.
 *
 * Why the earlier guard did not catch it: `model-prose-is-not-evidence` fenced the no-steps branch,
 * where a mission runs nothing and the model's prose stands in for a result. This was the
 * opposite case - steps ran, real work was done, the verdict was honest - and the model's opening
 * paragraph was prepended to that honest verdict unexamined (`agent.ts:2689`:
 * `` `${plan.reply}\n\n${text}` ``). The gate was right; the text beside it was not checked.
 *
 * So the check is not "did the mission succeed". It is, for every number the model wrote: **is this
 * number one of ours?**
 *
 * The rule is deliberately narrow in what it REFUSES and narrow in what it ACCEPTS:
 *
 *   - Numbers the mission measured - step counts, row counts, byte counts, file counts taken from a
 *     real artifact - pass.
 *   - Numbers nobody measured are removed and the removal is announced. A sentence that loses its
 *     number is awkward; a sentence with a wrong number is a lie, and the cost of the two is not
 *     comparable.
 *
 * A NUMBER IS NOT REMOVED SILENTLY. The report says which claims were dropped, because "the file
 * contains N files" becoming "the file contains files" with no explanation reads like a rendering
 * bug, and a reader who cannot tell the difference stops trusting the parts that ARE true.
 *
 * What this is NOT: it does not verify prose. A sentence can be false without containing a digit,
 * and that remains a limit of this approach. What it does do is make the cheapest and most common
 * form of fabrication - a confident count - impossible to state as fact.
 */

/** A quantity the mission actually measured, and where it came from. */
export interface MeasuredNumber {
  readonly value: number
  /** What produced it: a step id, a file, a tool result. This is what makes it checkable. */
  readonly source: string
}

/**
 * Values that are never treated as a quantity claim.
 *
 * EMPTY ON PURPOSE, after a test caught it being wrong. The first version excluded 0-5 as
 * "ordinals", on the reasoning that "step 1" is a position rather than a count. But the extractor
 * already requires a UNIT beside the number, so "step 1" and "1 of 4" never match in the first
 * place - and the exclusion then threw away real quantities like "5 columns" and "2 directories".
 *
 * A value-based filter was solving a problem the pattern had already solved, and creating a new
 * one. Units alone decide what is a claim.
 */
const NOT_A_CLAIM = new Set<number>()

/**
 * A number written with a unit or a noun that makes it a QUANTITY rather than a label.
 *
 * Bare digits are too noisy to police: a path, a version, a port and a date all contain them. What
 * identifies a quantity is the word next to it - "296 files", "407 rows", "12 columns" - so the
 * patterns require one.
 */
const COUNT_CLAIM = new RegExp(
  String.raw`(\d[\d,]*)\s+(?:` +
  String.raw`files?|rows?|columns?|records?|entries|items?|steps?|documents?|folders?|` +
  String.raw`directories|dirs|pages?|links?|images?|sheets?|tabs?|artifacts?|windows?|` +
  String.raw`results?|matches|errors?|warnings?|lines?|characters?|words?|` +
  String.raw`bytes?|kb|mb|gb|percent|%|%)`,
  'gi',
)

/**
 * Extract the quantitative claims a piece of text makes.
 *
 * Returns the RAW STRING rather than a parsed number, because "1,024" and "1024" are the same claim
 * written differently and the reader must see the text that is being removed.
 */
export function extractCountClaims(text: string): { raw: string; value: number; index: number }[] {
  const out: { raw: string; value: number; index: number }[] = []
  const re = new RegExp(COUNT_CLAIM.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = m[0]
    const digits = m[1] ?? ''
    const value = Number(digits.replace(/,/g, ''))
    if (!Number.isFinite(value)) continue
    if (NOT_A_CLAIM.has(value)) continue
    out.push({ raw, value, index: m.index })
  }
  return out
}

/** Does this claimed number appear among the numbers the mission actually measured? */
export function claimIsSupported(value: number, measured: readonly MeasuredNumber[]): MeasuredNumber | null {
  return measured.find((m) => m.value === value) ?? null
}

export interface NumberAudit {
  /** The text with every unsupported count removed. */
  readonly text: string
  /** Claims that were kept, with what supports them. */
  readonly supported: { claim: string; source: string }[]
  /** Claims that were removed. Empty means the narration stated nothing unmeasured. */
  readonly removed: string[]
}

/**
 * Remove every count the mission cannot support, and report exactly what was removed.
 *
 * `measured` is the whole of what the mission knows. A claim is kept only if it matches one of
 * these values, so a number that is merely plausible - 296 against a real 413 - is not "close
 * enough"; it is wrong, and it goes.
 */
export function auditNumbers(text: string, measured: readonly MeasuredNumber[]): NumberAudit {
  const claims = extractCountClaims(text)
  if (claims.length === 0) return { text, supported: [], removed: [] }

  const supported: { claim: string; source: string }[] = []
  const removed: string[] = []

  // Replace from the end so earlier indices stay valid.
  let out = text
  for (const c of [...claims].reverse()) {
    const hit = claimIsSupported(c.value, measured)
    if (hit) {
      supported.unshift({ claim: c.raw, source: hit.source })
      continue
    }
    removed.unshift(c.raw)
    // Drop the number and the unit, plus the connecting space, so the sentence still reads.
    const replacement = c.raw.replace(/\d[\d,]*\s+/, '')
    out = out.slice(0, c.index) + replacement + out.slice(c.index + c.raw.length)
  }

  return { text: out, supported, removed }
}

/**
 * The sentence appended when claims were removed.
 *
 * Written to be unmissable and unargumentable: it names the claim, says where the real figure
 * comes from, and does not apologise. A reader must be able to tell the difference between "the
 * system corrected itself" and "the report rendered oddly".
 */
export function removedClaimsNote(
  removed: readonly string[],
  measured: readonly MeasuredNumber[],
): string {
  if (removed.length === 0) return ''
  const facts = measured
    .filter((m) => !NOT_A_CLAIM.has(m.value))
    .map((m) => `${m.value} (${m.source})`)
    .join(', ')
  return '\n\n'
    + `Zeus removed ${removed.length} count(s) from its own description of this work because no `
    + 'step measured them: '
    + removed.map((r) => `"${r}"`).join(', ')
    + '. '
    + (facts.length > 0
      ? `The figures this mission did measure are: ${facts}. `
      : 'This mission measured no quantities it can stand behind. ')
    + 'A count that no step produced is not reported as fact, even when the file it describes really '
    + 'does exist.'
}

/**
 * Every number a mission can legitimately claim, gathered from what actually happened.
 *
 * Built from the execution result rather than from the plan, because a plan states an intention and
 * only a result states a fact. A step that was skipped contributes nothing - which is the point:
 * "5 steps, 2 verified" is measurable, "5 files" from a step that never ran is not.
 */
export function measuredNumbersFrom(
  steps: readonly { id: string; tool: string; verified: boolean; summary: string }[],
  extras: readonly MeasuredNumber[] = [],
): MeasuredNumber[] {
  const out: MeasuredNumber[] = [...extras]
  out.push({ value: steps.length, source: 'the plan' })
  out.push({ value: steps.filter((s) => s.verified).length, source: 'the verifiers' })

  for (const s of steps) {
    // Counts the step itself reported.
    //
    // The UNIT is allowed to sit a word or two away from the number, because that is how the
    // tools actually phrase it: "413 data row(s), 5 column(s)", not "413 rows". Requiring the
    // number to touch the unit meant this read nothing at all - and a measurement extractor that
    // silently finds nothing looks exactly like a mission that measured nothing.
    const nums = [
      ...s.summary.matchAll(
        /(\d[\d,]*)\s+(?:[a-z]+\s+){0,2}?(rows?|columns?|files?|items?|entries|windows?|characters?|chars?|steps?|records?)/gi),
      ...s.summary.matchAll(/(\d[\d,]*)\s*bytes?\b/gi),
    ]
    for (const m of nums) {
      const v = Number((m[1] ?? '').replace(/,/g, ''))
      if (Number.isFinite(v)) out.push({ value: v, source: `step ${s.id} (${s.tool})` })
    }
  }
  return out
}