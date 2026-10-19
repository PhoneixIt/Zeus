/**
 * IS THIS PLAN A GOAL, OR A GESTURE?
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 *
 * The system prompt tells the planner to complete the task rather than stop at the first action.
 * That instruction is necessary and it is not sufficient. Measured on this machine: the prompt
 * was rewritten to say "do not stop at the first action", and the same model, given the same
 * goal, still emitted exactly one step - open a browser - and stopped. The wording changed; the
 * behaviour did not.
 *
 * That is the expected result for a small local model. A prompt states a preference; it cannot
 * guarantee compliance. So the guarantee has to live in code, and the code's job is narrow: decide
 * whether the plan that came back actually delivers what the goal asked for, and if it plainly
 * does not, ask the model once more with the specific defect named.
 *
 * ============================================================================================
 * WHAT IT WILL AND WILL NOT DO
 * ============================================================================================
 *
 * It NEVER invents a step. A correction is a second question to the model, not a synthesised plan.
 * If the second answer is no better, the first plan is kept. A mechanism that fabricates work is
 * strictly worse than one that accepts an imperfect plan, because the fabricated step would then
 * be executed and verified like any other - and nobody could tell it was invented.
 *
 * It asks AT MOST ONCE. Two planning calls is a bounded cost; a loop until the plan looks right is
 * an unbounded one, and on free models that are already rate-limited it would eventually be the
 * thing that makes the system unusable.
 *
 * It only ever applies to INFORMATION goals. A goal whose deliverable is a file, a window, or a
 * change to an application is judged on its own terms by the existing step verifiers, and second
 * guessing those would be second guessing work that already has a proof.
 */

import type { GoalIntent } from './goal-intent.ts'

export interface PlannedStep {
  readonly id: string
  readonly intent: string
  readonly tool: string
  readonly args?: Record<string, unknown>
}

/** Tools that turn a mission into something the person KEEPS rather than merely SAW. */
const DELIVERING_TOOLS = ['write-file', 'spreadsheet', 'web-research', 'read-file']

/** Tools that only put something on screen. */
const DISPLAY_ONLY_TOOLS = ['launch-app', 'ocr', 'survey-window', 'list-windows', 'screen-diff']

export interface CompletionVerdict {
  /** True when the plan plainly does not deliver what the goal asked for. */
  readonly incomplete: boolean
  /** The specific defect, in one sentence, for the model to be told about. */
  readonly why: string
  /** What the goal actually wanted, for the correction prompt. */
  readonly requiredOutcome: string
}

/**
 * Decide whether a plan under-delivers on an INFORMATION goal.
 *
 * The test is deliberately narrow and mechanical: the goal wants the person to KNOW something,
 * and the plan contains no tool capable of telling them anything. Everything else is left alone.
 * A vague judgement ("this plan feels incomplete") would eventually reject correct plans, and a
 * rejected correct plan is a bug that costs the user real work.
 */
export function assessCompletion(
  goal: string,
  intent: GoalIntent,
  steps: readonly PlannedStep[],
): CompletionVerdict {
  const deliverableFor = (s: PlannedStep): boolean =>
    DELIVERING_TOOLS.some((t) => s.tool.includes(t))

  // Only information goals are second-guessed. Everything else has an existing verifier.
  if (intent !== 'information') {
    return { incomplete: false, why: '', requiredOutcome: '' }
  }

  if (steps.length === 0) {
    return {
      incomplete: false,
      why: '',
      requiredOutcome: '',
    }
  }

  // A plan that delivers something is, by this measure, complete - UNLESS the goal plainly asks
  // for a list, a table or a comparison and the plan produced only prose.
  //
  // This is the gap the first version of this check missed. "web-research" IS a delivering tool,
  // so a plan that researched three pages and stopped passed - even when the goal was "data
  // protection companies", which is a request for a LIST, not for a brief. The model produced a
  // brief and declared victory, and the person got a paragraph instead of a spreadsheet.
  //
  // So: when the goal is asking for a list and the plan contains no spreadsheet, the plan is
  // incomplete even though it contains a deliverable. A brief is not a list.
  if (steps.some(deliverableFor)) {
    const wantsList = /\b(list|companies|vendors|compare|comparison|vs\.?|versus|table|matrix|top\s+\d+|several|multiple)\b/i.test(goal)
    const hasSpreadsheet = steps.some((s) => s.tool.includes('spreadsheet'))
    if (wantsList && !hasSpreadsheet) {
      return {
        incomplete: true,
        why:
          'the plan produced a brief, but the goal is asking for a LIST, and a brief is not a list. '
          + 'The person cannot sort, filter or open a paragraph in Excel, and they asked for data '
          + 'protection companies, not a summary of them.',
        requiredOutcome:
          'After your last step the person should have a spreadsheet (CSV) of the companies, with '
          + 'columns such as name, headquarters, focus and website, every row traceable to a saved '
          + 'research artifact. Use web-research to read the pages, then the spreadsheet capability '
          + 'to write the file. The browser may still be opened, but it is not the deliverable.',
      }
    }
    return { incomplete: false, why: '', requiredOutcome: '' }
  }

  const displayOnly = steps.every((s) => DISPLAY_ONLY_TOOLS.some((t) => s.tool.includes(t)))
  if (!displayOnly) {
    // It does something that is neither a deliverable nor purely a display - some other kind of
    // work. Not this function's business.
    return { incomplete: false, why: '', requiredOutcome: '' }
  }

  return {
    incomplete: true,
    why:
      'the plan only puts something on screen, so the person ends up looking at a page rather than '
      + 'being told anything. A window is not information, and the mission cannot be graded as '
      + 'achieved because nothing was produced.',
    requiredOutcome:
      'After your last step the person should KNOW the answer to what they asked, and should have '
      + 'something they can keep. Use web-research to read real pages, and write the result with '
      + 'write-file or the spreadsheet capability - a list or a comparison belongs in a '
      + 'spreadsheet. Opening a browser may still be worth doing, but it cannot be the whole plan.',
  }
}

/**
 * The message sent to the model when its plan under-delivers.
 *
 * Carries the defect, what is wanted instead, and - importantly - permission to keep the steps it
 * already wrote. A model told only "your plan was wrong" tends to replace everything and lose the
 * parts that were right; the opening sentence exists to stop that.
 */
export function correctionMessage(goal: string, verdict: CompletionVerdict): string {
  return [
    'Your previous plan was not sufficient, and here is exactly why.',
    '',
    `GOAL: ${goal}`,
    '',
    `WHAT WAS WRONG: ${verdict.why}`,
    '',
    `WHAT IS NEEDED: ${verdict.requiredOutcome}`,
    '',
    'Keep any steps from your previous plan that were correct, and add the ones that are missing. '
    + 'Return the COMPLETE plan as JSON, not a diff. Only "reply" and "steps" are allowed - no '
    + 'markdown fences, no commentary.',
  ].join('\n')
}