/**
 * WHERE DOES THE PERSON EXPECT TO SEE THIS HAPPEN?
 * ============================================================================
 *
 * HEADLESS RESEARCH IS NOT A VISIBLE BROWSER, AND PASSING ONE OFF AS THE OTHER IS A LIE.
 * ------------------------------------------------------------------------
 * The capability registry has no visible-browser entry, and pretending otherwise would hide the
 * most important fact about the system. What exists is:
 *
 *   - web-research    mode=browser   headless Chrome, a throwaway profile, NO window ever appears
 *   - launch-app      mode=gui       opens a REAL window, including a browser at a URL
 *   - desktop-input   mode=gui       real keyboard and mouse into a named window
 *
 * A mission asked to "open a browser, navigate to a page and read it" can be completed ENTIRELY by
 * web-research. Nothing appears on screen. Every step verifies, the objective is satisfied, and the
 * person is told it worked - having seen nothing happen. That is the complaint this exists to fix.
 *
 * Both tools are legitimate. What was missing is any way for the SYSTEM to know which was wanted,
 * so it was free to answer with either. This gives the planner and the validator that knowledge,
 * and the duty to refuse when it cannot be honoured.
 *
 * THE SIGNALS ARE DELIBERATELY EXPLICIT
 * -------------------------------------
 * "On my screen", "let me see", "watch it happen" are unambiguous. "Look at", "check" and "read" are
 * not - they are satisfied by reading a page with nobody watching. Defaulting those to visible would
 * make the system refuse ordinary research goals, and a guard that fires on everything is a guard
 * that gets switched off.
 *
 * So the default is "any will do", and only an explicit request for visibility raises the bar.
 */

export type InteractionMode = 'visible' | 'any'

export function interactionMode(goal: string): InteractionMode {
  const lower = String(goal ?? '').toLowerCase()
  if (/\b(on my screen|on screen|visible|visibly|let me see|show me|watch it|watch what|watch how)\b/i.test(lower)) {
    return 'visible'
  }
  // "Open the browser to ..." is a request for a window. Kept narrow on purpose: "open the file and
  // tell me what it says" wants the content, and read-file serves that without a window being
  // anyone's expectation.
  if (/\bopen\b/i.test(lower) && /\b(browser|chrome|edge|window|tab|notepad|app|site|google|bing|duckduckgo|firefox)\b/i.test(lower)) {
    return 'visible'
  }
  // "Show me", "display", "list what is on ..." - a request to SEE the machine's own state.
  //
  // This was missing, and it was missing for the same reason the whole rule is narrow: nobody
  // writes "let me see" when they mean it. They write "list the windows open on this desktop" or
  // "show me the taskbar", and both are asking to look at the real screen. With no signal for
  // them, `interactionMode` said `any`, a plan could answer with web-research, and the person who
  // asked to see their desktop was told it was done while a headless Chrome collected pages
  // somewhere they never saw.
  //
  // The machine nouns are what carry it, and they must be the SUBJECT rather than merely present.
  // The first version of this rule matched them anywhere in the sentence, and "show me the
  // spreadsheet" matched because "show" appeared and "spreadsheet" could be read as a thing in a
  // folder of files - which is not why anybody says it. A person saying "show me" is looking at
  // the SCREEN; a person saying "show me the spreadsheet" wants a file, and read-file serves that
  // without a window being anyone's expectation.
  const seesTheMachine =
    // verb, then the machine, with only filler allowed in between
    /\b(show|shows|display|list|see|inspect|survey)\s+(me\s+)?((the|my|this)\s+)?(desktop|screen|taskbar|windows?)\b/i.test(lower)
    // "the windows on this desktop", "desktop icons"
    || /\b(desktop|screen|taskbar)\s+(windows?|icons?|shortcuts?|buttons?)\b/i.test(lower)
    || /\bwindows?\s+(open|on)\s+(this|my|the)\s+(desktop|screen|pc|machine)\b/i.test(lower)
  if (seesTheMachine) {
    return 'visible'
  }
  return 'any'
}

/**
 * WHAT KIND OF GOAL IS THIS, AND HOW LOUDLY SHOULD THE RESULT BE REPORTED?
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 *
 * The user said: "quiet for show-goals, full audit for file-goals." That is not a formatting
 * preference bolted onto the end of a message. It follows from something the reporting could not
 * previously express.
 *
 * A goal that produces a FILE has an artifact. You can hash it, read it back, compare it, and say
 * something definite. A goal that produces a WINDOW has no artifact. Everything said about it is
 * an observation of an instrument - "a window exists", "OCR saw these characters" - and those
 * observations cannot be dressed up as proofs without the report becoming a lie.
 *
 * Printing the full audit machinery for both is what produced the experience the user reported:
 * a browser opened on exactly the right page, every step green, and then a paragraph explaining
 * that no objective claim existed, ending in "not achieved". Technically defensible, and useless
 * to a person who can see the results page on their own screen.
 *
 * So the distinction is made explicit here and used for one thing: how much the result says.
 *
 * ============================================================================================
 * WHAT THIS DOES NOT DO
 * ============================================================================================
 *
 * It does not decide what to DO. That is the planner's job, and it is settled by the goal, not by
 * how much noise the answer makes. Nothing here may cause a weaker check to be chosen, or a
 * stronger one to be skipped - a `show` goal still gets its OCR read-back. Only the wording
 * changes. That restriction is the whole safety property of this file.
 */

import { readPreferences } from './preferences.ts'

export type GoalIntent =
  /** The deliverable is something on the screen: a window, a page, an app. */
  | 'show'
  | 'show'
  /** The deliverable is a file: a note, a report, a spreadsheet, a saved document. */
  | 'produce'
  /** The deliverable is understanding: a fact, a comparison, a list of things. */
  | 'information'
  /** The deliverable is a change to some application's state. */
  | 'act'
  /** Not a task. Handled before the planner is ever consulted. */
  | 'conversational'

/**
 * Classify a goal by what it asks for, from the wording alone.
 *
 * Ordering is deliberate. A goal that mentions a destination path is a `produce` goal even if it
 * also says "open", because "open Notepad and save it to C:\..." is not a show-goal - the file is
 * the point and the window is the means. Conversely a goal with no path and no research verb but
 * an "open" is a `show` goal.
 *
 * `information` sits above `show` on purpose, and this is the ordering that matters most: "find
 * me data protection companies" contains no open/show verb at all, but if it did - "open google
 * and search for data protection companies" - it is still fundamentally a request to KNOW
 * something, and treating it as a show-goal is how a one-step plan that stops at the browser got
 * graded as a complete unit of work.
 */
const GREETING = /^(hi|hey|hello|yo|sup|howdy|thanks|thank you|thx|cheers|bye|goodbye|see you|good (morning|afternoon|evening|day))\b/i

export function classifyGoal(goal: string): GoalIntent {
  const t = goal.trim()
  if (!t) return 'conversational'
  const lower = t.toLowerCase()

  // Greetings first. Without this they fall through to the bare-noun-phrase rule below and are
  // read as a request for information about the word "hi" - which is technically a noun phrase
  // and practically nonsense. They are intercepted earlier in the pipeline anyway, but a
  // classifier that calls a greeting a research request is wrong at any depth, and the next
  // caller may not have that earlier intercept.
  if (GREETING.test(lower)) return 'conversational'

  // A destination path is the strongest signal there is: the person named a file.
  const namesAPath = /\.[a-z0-9]{1,6}\b/i.test(t) && /[\\/]|:/.test(t)

  // Asking to KNOW something. Checked before "show", because the two are routinely conflated
  // and only one of them is what the person meant.
  const wantsToKnow =
    /\b(find|research|look up|search for|search the web|what (is|are|was|were)|who (is|are)|how (do|does|can|to)|which|compare|comparison|vs\.?|versus|list (of|all|the)|tell me about|explain|summar[yi]se|analyse|analyze|pros and cons|best|top \d+)\b/i.test(lower)

  const wantsToShow =
    /\b(open|show|display|browse|bring up|launch|start)\b/i.test(lower)
    && !/\bsave\b|\bwrite\b|\bexport\b|\bcreate a file\b/i.test(lower)

  const wantsToAct =
    /\b(click|press|type|scroll|focus|close|delete|install|download|move|resize)\b/i.test(lower)

  // Producing a file. Checked BEFORE the bare-noun-phrase fallback below, because "save a report
  // to Documents" is five ordinary words and would otherwise be read as a topic to research.
  // The first version of this missed it for exactly that reason.
  const wantsToProduce =
    /\b(save|write|export|generate|record|produce|create a (file|document|report|note|spreadsheet|csv))\b/i.test(lower)
    || /\bto (my |the )?(documents|desktop|downloads)\b/i.test(lower)

  if (namesAPath) return 'produce'
  if (wantsToKnow) return 'information'
  if (wantsToShow) return 'show'
  if (wantsToAct) return 'act'
  if (wantsToProduce) return 'produce'

  // A bare noun phrase with no verb ("data protection companies") is a request for information.
  // People type topics, not imperatives, and reading that as an information request is far more
  // useful than reporting it as a goal with no intent at all.
  const words = lower.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
  if (words.length > 0 && words.length <= 6 && !wantsToAct) return 'information'

  return 'act'
}

/**
 * Should this goal's result be reported in full, or in one line?
 *
 * The rule the user gave: quiet for show-goals, full audit for file-goals. Everything that is not
 * a show-goal gets the full treatment, including `information` - because an information goal is
 * the one most likely to have produced a brief or a spreadsheet, and the reader wants to know
 * which and where.
 */
export function wantsQuietReport(goal: string): boolean {
  // The stored preference decides WHETHER there is a split at all. When the person asks for
  // 'full', every goal is reported in full regardless of what it is - which is the point of
  // storing the setting rather than hardcoding the rule.
  //
  // readPreferences never throws: an absent or corrupt file returns the defaults, so this call
  // cannot be the reason a mission fails to classify.
  try {
    if (readPreferences().reportStyle === 'full') return false
  } catch { /* no preferences file, or it cannot be read: use the split below */ }
  return classifyGoal(goal) === 'show'
}
