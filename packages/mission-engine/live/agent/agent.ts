/**
 * THE AIOS AGENT LOOP - natural language in, verified outcome out.
 *
 * =============================================================================
 * THE LOOP
 * =============================================================================
 *
 *   goal (plain English)
 *     -> model interpretation      the free model is told the capability catalogue and asked to
 *                                   emit a plan; it does NOT choose permissions or capabilities
 *                                   that are unavailable, because unavailable ones are shown to it
 *                                   as unavailable
 *     -> plan validation           every step's tool must resolve to a registered, available
 *                                   capability; an unknown tool is a refusal, not a guess
 *     -> permission check          read live from the operator host BEFORE anything runs
 *     -> mission compile           steps become a Mission the executor will accept
 *     -> execute                   the governed executor, which halts on refusal and cannot
 *                                   complete a step with no verifier
 *     -> independent verification  each step's verifier re-reads the world from disk or the host
 *     -> result                    returned to the user with evidence, or with an honest failure
 *
 * =============================================================================
 * WHAT THE MODEL IS NOT ALLOWED TO DO
 * =============================================================================
 *
 * It picks WHAT to do. It does not pick WHETHER it is allowed to. Concretely:
 *
 *   - it cannot grant itself a permission; permission comes from the live guard, read by the
 *     executor's own config, and the model never sees that value
 *   - it cannot reach an unavailable capability; `resolveCapability` refuses before execution
 *   - it cannot mark a step successful; only the verifier can, by looking again
 *
 * The plan is DATA. It is parsed into a Mission and handed to an executor that was written
 * before the model existed, and which refuses steps it cannot independently verify. That
 * ordering is the whole point: the model's judgement sits inside a boundary that was not written
 * by the model.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { execute, type ToolContext } from '../../executor.ts'
import type { Step, Mission, MissionState } from '../../state.ts'
import type { ExecutionEvent } from '../../events.ts'
import { liveControl, livePermission } from '../live-control.ts'
import {
  buildArtifactContract, contentLooksWrongFor, registerContract, forgetContract,
  type ArtifactContract,
} from './artifacts.ts'
import { auditNumbers, removedClaimsNote, measuredNumbersFrom } from './numbers.ts'
import { wantsQuietReport, classifyGoal, interactionMode } from './goal-intent.ts'
import { assessCompletion, correctionMessage } from './plan-completion.ts'
import {
  buildReplanFeedback,
  placeholderInArgs,
  assessArtifactSubstance,
  shouldReplan,
  PLACEHOLDER_RATIO_LIMIT,
} from './replan.ts'
import { preferencesForPrompt } from './preferences.ts'
import { memoryForPrompt, remember, assertMemoryCannotWeakenChecks } from './operational-memory.ts'
import { orderCandidates, noteFailure, inCooldown } from './model-failover.ts'
import { ZEUS_ID, route as zeusRoute, noteSuccess as zeusNoteSuccess, noteZeusFailure as zeusNoteFailure, poolStatus as zeusPoolStatus } from './zeus.ts'
import { CAPABILITIES, availableCapabilities, resolveCapability, routedTools, routedVerifier, AGENT_ROOT, AGENT_OUT, refreshLiveAvailability, inferLaunchApp, inferReadPath, inferGoalFilename as goalNamesAFile, resolveReadablePath, confineTo, inferGoalFolder, type Capability } from './capabilities.ts'
// `job-recorder.ts` imports `AGENT_ROOT`/`MISSIONS_DIR` from this module, so this is a cycle.
// It is safe here and worth stating why: `recordJob` is only CALLED at request time, long
// after both modules have finished initialising. It is not safe to move those path constants
// into a shared module without also moving the cycle, and that is a larger change than this
// defect warrants. The import was simply missing, which is why the durable-job block was dead
// code that threw `recordJob is not defined` the moment it was actually reached.
import { recordJob } from './job-recorder.ts'
import { isFreeModel } from './models.ts'

// ===========================================================================================
// progress
// ===========================================================================================

export type ProgressEvent =
  | { readonly kind: 'status'; readonly text: string }
  | { readonly kind: 'plan'; readonly steps: readonly { id: string; intent: string; tool: string }[] }
  | { readonly kind: 'step-start'; readonly stepId: string; readonly intent: string; readonly tool: string; readonly attempt: number }
  | { readonly kind: 'step-result'; readonly stepId: string; readonly summary: string; readonly verified: boolean; readonly detail: string }
  | { readonly kind: 'approval-required'; readonly reason: string }
  | { readonly kind: 'done'; readonly ok: boolean; readonly text: string; readonly table?: AnswerTable }
  | { readonly kind: 'error'; readonly text: string }

export type Emit = (e: ProgressEvent) => void

/** One turn of the conversation transcript, as persisted. */
export interface ConversationTurn {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly at: number
  readonly missionId?: string
  readonly ok?: boolean
}

/** The table-shaped result of a mission, read back from what was actually written. */
export interface AnswerTable {
  readonly headers: string[]
  readonly rows: string[][]
  readonly totalRows: number
}

/** One mission as the mission file records it. */
export interface MissionSummary {
  readonly missionId: string
  readonly goal: string
  readonly ok: boolean
  readonly at: number
  readonly steps: ReadonlyArray<{ id: string; intent: string; tool: string; verified: boolean; summary: string }>
  readonly error?: string
  readonly attempts?: number
  readonly substanceNote?: string
}

/** One step as this loop knows it, before and after verification. */
interface PlannedStep {
  id: string
  intent: string
  tool: string
  args: Record<string, unknown>
}

/** What `parsePlan` returns: the model's reply, its steps, and which model actually answered. */
export interface InterpretedPlan {
  readonly reply: string
  readonly steps: readonly PlannedStep[]
  readonly model: string
}

export interface InterpretOptions {
  readonly model?: string
  readonly cliPath?: string
  /** Present when this is a REPLAN: what already happened, and what it produced. */
  readonly feedback?: string
}

/** What `validatePlan` returns: repaired steps, refusals, and the notes explaining both. */
export interface ValidatedPlan {
  readonly steps: PlannedStep[]
  readonly refusals: string[]
  readonly inferred: string[]
  /**
   * The mission-level view: one record per destination, with its identity, kind, producing step,
   * and whether a file was already there before this mission started.
   *
   * Built from the WHOLE plan, because the failure this prevents was not visible in any single
   * step. See `artifacts.ts` for the measured incident.
   */
  readonly artifactContract: ArtifactContract
  /**
   * What the person asked for, paired with what will be produced. One entry per producing step.
   *
   * A read-back refers to a deliverable by `id` rather than by path, so the pairing is declared by
   * the plan that made it rather than inferred from a filename after the fact.
   */
  readonly deliverables: readonly Deliverable[]
  /**
   * Destinations that were asked for and not used.
   *
   * Empty in the ordinary case, which is the point: most plans name no destination, or name one the
   * model invented, and putting those somewhere writable is a repair worth doing quietly. It is NOT a
   * failure - unless the PERSON named the place, in which case quietly moving their file is exactly
   * the kind of false success this file exists to prevent.
   */
  readonly substitutions: readonly Substitution[]
}

/** What `runGoal` returns: the verdict, the evidence, and every step it ran. */
export interface GoalResult {
  readonly ok: boolean
  readonly missionId: string
  readonly goal: string
  readonly reply: string
  readonly steps: ReadonlyArray<{ id: string; intent: string; tool: string; verified: boolean; summary: string }>
  readonly error?: string
  readonly refusals: readonly string[]
}

// ===========================================================================================
// persistence - a mission must outlive the process that ran it
// ===========================================================================================

export const MISSIONS_DIR = join(AGENT_ROOT, 'missions')
export const CONVERSATIONS_PATH = join(AGENT_ROOT, 'conversations.jsonl')

export function ensureAgentDirs(): void {
  mkdirSync(MISSIONS_DIR, { recursive: true })
  mkdirSync(AGENT_OUT, { recursive: true })
  // The research capability writes its per-page artifacts here. Omitting this directory cost a
  // real mission: the tool launched a browser, collected four pages, and then failed writing the
  // artifact to a folder that was never created - and reported it only as "retry-exhausted",
  // because the failure reason was not being surfaced. Both are fixed here.
  mkdirSync(join(AGENT_ROOT, 'runs'), { recursive: true })
}

/**
 * Append one turn to the conversation transcript.
 *
 * Append-only on purpose: a transcript that rewrites itself when it is reloaded is not evidence of
 * what was said, and the whole value of keeping one is that it can be trusted as a record.
 */
export function appendConversation(t: ConversationTurn): void {
  ensureAgentDirs()
  appendFileSync(CONVERSATIONS_PATH, JSON.stringify(t) + '\n', 'utf8')
}

/** Every stored turn, oldest first. Unparseable lines are skipped rather than failing the read. */
export function readConversations(): ConversationTurn[] {
  if (!existsSync(CONVERSATIONS_PATH)) return []
  return readFileSync(CONVERSATIONS_PATH, 'utf8')
    .split('\n').filter((l) => l.trim().length > 0)
    .flatMap((l) => { try { return [JSON.parse(l) as ConversationTurn] } catch { return [] } })
}

/**
 * Write the mission record.
 *
 * One file per mission, written once at the end. It is written from the same values the caller is
 * about to be told, so the record and the report cannot disagree - a record that describes a
 * different run from the one being reported is worse than no record.
 */
function saveMission(s: MissionSummary): void {
  ensureAgentDirs()
  writeFileSync(join(MISSIONS_DIR, `${s.missionId}.json`), JSON.stringify(s, null, 2), 'utf8')
}

/** One mission by id, or null when it was never written. Never throws: a missing record is a fact. */
export function readMission(missionId: string): MissionSummary | null {
  const p = join(MISSIONS_DIR, `${missionId}.json`)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8')) as MissionSummary } catch { return null }
}

/** Every mission on disk, oldest first. This is what makes work resumable after a restart. */
export function readMissions(): MissionSummary[] {
  if (!existsSync(MISSIONS_DIR)) return []
  return readdirSync(MISSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => { try { return [JSON.parse(readFileSync(join(MISSIONS_DIR, f), 'utf8')) as MissionSummary] } catch { return [] } })
    .sort((a, b) => a.at - b.at)
}

// ===========================================================================================
// the model
// ===========================================================================================

/** The planner model default. $0, local CLI, no key, no endpoint. */
export const MODEL = 'opencode/longcat-2.5-preview-free'

/**
 * One capability as the model sees it.
 *
 * Exported separately from `catalogueForModel` so the "this is UNAVAILABLE, do not plan it" rule
 * can be tested against a synthetic capability. Every capability currently registered is either
 * available or plannable, which means the real registry can no longer produce the one line that
 * rule produces - and a rule with no test is a rule that quietly stops working.
 */
export function catalogueEntry(c: Capability): string {
  const args = c.tool.args?.length
    ? c.tool.args.map((a) => `      - ${a.name} (${a.type}${a.required ? ', REQUIRED' : ', optional'}): ${a.description ?? ''}`).join('\n')
    : '      - (takes no arguments)'
  const status = c.available ? '' : c.plannable ? '' : `\n    STATUS: UNAVAILABLE - ${c.unavailableReason}`
  return `- ${c.id} (mode: ${c.mode})\n    ${c.description}\n    arguments:\n${args}${status}`
}

/**
 * The catalogue as the model sees it: what exists, plainly what is unavailable, and EXACTLY which
 * arguments each tool requires.
 *
 * The argument list was missing at first. The model was told a `web-research` capability existed
 * and nothing about its required `objective`, so it emitted a step with no args and the tool
 * correctly refused with "no objective was given". Describing what exists is not enough - a tool
 * the model cannot call correctly is not usable, however well it is described.
 */
export function catalogueForModel(): string {
  return CAPABILITIES.map(catalogueEntry).join('\n')
}

// WHY THE EXAMPLE BELOW IS A WORKED EXAMPLE RATHER THAN AN EMPTY SHAPE
//
// It used to end with `"args": { }`. That is not a neutral placeholder: free models copy the
// example they are shown, and the result was a structurally perfect plan in which EVERY step
// carried an empty args object. A mission then failed on step one with "no application name was
// given" - from a plan whose prose said "Open Notepad" perfectly well. The plan looked right to
// a reader and was empty of everything executable, which is the specific failure this project
// exists to avoid.
//
// So the example shows real arguments, and the instructions say in words that a step which
// names no arguments is incomplete. The example and the instruction now agree.
const PLAN_SCHEMA = `{
  "reply": "one short paragraph addressed to the user",
  "steps": [
    { "id": "s1", "intent": "what this step accomplishes", "tool": "a capability id", "args": { "the": "arguments this tool requires" } }
  ]
}`

const PLAN_RULES = `
EVERY STEP MUST CARRY ITS ARGUMENTS in "args", using the exact argument names listed for that
tool in the capability catalogue above. A step whose "args" is empty is incomplete and will fail.
For example, launching an application needs {"app": "notepad"}, typing needs {"action": "type",
"text": "the words to type"}, pressing a shortcut needs {"action": "key", "vk": 83, "ctrl": true},
and reading a file back needs {"path": "C:\\\\Users\\\\...\\\\file.txt"}. If a step does not need an
argument, its args may be empty - but only then. Never describe an argument in "intent" and
leave it out of "args".

COPY ANY TEXT THE USER ASKED YOU TO TYPE VERBATIM, character for character, INCLUDING ITS FINAL
PUNCTUATION. Measured on this machine: the typing path delivers exactly what it is given - 34 of
34 characters, six runs out of six - yet a sentence was repeatedly saved missing its closing full
stop, because the text in "args" was written without it. Rewording text someone is going to type
into a document is not a stylistic choice, it is a wrong answer, and nothing downstream can catch
it unless you copy rather than rephrase.

IF THE PERSON ASKS TO SEE SOMETHING HAPPEN - they say "on my screen", "let me see", "watch it" -
THEN THE PLAN MUST INCLUDE A STEP THAT ACTUALLY OPENS A VISIBLE WINDOW. Use launch-app to open it
and desktop-input to use it. web-research is NOT a substitute: it runs a browser with no window
that ever appears, so a plan built only from it shows the person nothing while every step passes
verification. If the goal names a browser, a window, or an application by name, open it.`

/**
 * The system prompt is built per mission, not once at import.
 *
 * It was a module-level constant, which meant the capability catalogue inside it was rendered a
 * single time when the process started. Desktop input was then permanently unavailable for the
 * lifetime of the process no matter what the guard did afterwards - the model was told a
 * capability did not exist, so it never planned it, so nothing was ever in a position to use the
 * one window in which the machine genuinely allowed input. The guard's authority changes at
 * runtime, so the description of it has to as well.
 */
function systemPrompt(goal: string): string { return `You are AIOS, an assistant that carries out tasks on a Windows laptop.

You do NOT execute anything. You emit a JSON PLAN that a separate, governed executor runs.

Each step must name a tool from the capability list. Use only the tools listed. If a tool is
marked UNAVAILABLE, do not plan a step that needs it; instead say so in "reply".

COMPLETE THE TASK. DO NOT STOP AT THE FIRST ACTION.

The person is asking you to achieve a GOAL, not to perform a gesture, and those are not the same.
A plan that opened a browser and stopped was reported as "not achieved" - correctly, because
opening a page is not knowing what is on it. So judge every plan by one question: after the last
step, does the person have what they asked for?

  - Asked to FIND or LEARN something? Opening a page is the means, not the end. Use web-research,
    then produce something they can keep - a brief, or a spreadsheet when the answer is a list or a
    comparison. "data protection companies" is a LIST. A browser window is not a list.
  - Asked for a list, a table, a comparison, or several items? Use the spreadsheet capability.
  - Asked to SHOW something on screen? Then a window IS the deliverable and one step is correct.
  - Asked to WRITE, SAVE or produce a file? Name the destination path explicitly.

Do not pad a plan with steps that achieve nothing either. The previous instruction here was
"prefer the fewest steps", and it reliably produced one-step plans that opened a window and
declared victory - because it rewarded stopping early. What is wanted is the fewest steps that
ACCOMPLISH THE GOAL, which is not the same as the fewest steps.

If you are unsure how to reach the goal, choose the route you can justify and finish the job. Never
plan a step whose only purpose is to ask the person which approach to take.

Only "reply" and "steps" are allowed. No markdown fences. No commentary.
${preferencesForPrompt()}${memoryForPrompt(goal)}
${PLAN_RULES}

Capabilities:
${catalogueForModel()}

Plan schema:
${PLAN_SCHEMA}`
}

/**
 * A conversational reply, without calling a model at all.
 *
 * WHY THIS EXISTS
 *
 * AIOS is a task executor, not a chatbot, and every message - including "Hi" - went through the
 * full planner path: spawn a CLI, wait 13-180s for the model, parse a plan, and only then discover
 * that the message was a greeting. That is why "Hi" took as long as "open Notepad and save a file",
 * and why the window sat silently disabled while the user watched it do nothing and concluded it
 * was broken.
 *
 * This is the honest boundary, stated up front: a message that is plainly conversational - short,
 * and containing no verb that names a task - does not need a model to understand. It needs a
 * reply, and the reply is the same regardless of which model is asked, so asking is waste.
 *
 * It returns a string to send, or null when the message might be a task and the planner must
 * decide. A heuristic that is too aggressive would make a task look like a greeting and refuse to
 * do it; the verbs checked here are the ones that, on this machine, have never appeared in a
 * greeting and always appeared in a task. "Open", "type", "save", "read", "list", "launch",
 * "create", "find", "search", "capture", "show", "stop", "run", "check".
 *
 * Returning the reply as a string means the caller (runGoal) sends it as a zero-step plan, and
 * the UI shows it immediately. No model is called, no process is spawned, no rate limit is spent.
 */
function conversationalReply(goal: string): string | null {
  const t = goal.trim()
  if (!t) return 'What would you like me to do?'
  if (t.length > 120) return null
  const words = t.split(/\s+/)
  if (words.length > 8) return null
  const lower = t.toLowerCase()
  const actionVerbs = ['open', 'type', 'save', 'read', 'list', 'launch', 'create', 'find',
    'search', 'capture', 'show', 'stop', 'run', 'check', 'close', 'delete', 'install',
    'download', 'browse', 'click', 'press', 'scroll', 'focus', 'focus', 'move']
  if (actionVerbs.some((v) => lower.includes(v))) return null

  // Greetings and small talk.
  if (/^(hi|hello|hey|hiya|yo|sup|howdy|good (morning|afternoon|evening|day)|greetings)\b/i.test(lower)) {
    return "Hello! I'm AIOS. I can operate your Windows laptop for you: open applications, "
      + 'type and click in windows, read and write files, inspect the screen and the accessibility '
      + 'tree, search the web, and run development tools. Try something like "open Notepad and '
      + 'write this note, then save it to Documents".'
  }
  if (/^(thanks|thank you|thx|cheers|bye|goodbye|see you)\b/i.test(lower)) {
    return 'You are welcome. Say the word if you want me to do something on this machine.'
  }
  if (/^(what (can|are) you (do|capable of)|help|capabilities|what do you do)\b/i.test(lower)) {
    return 'I am an assistant that operates this Windows laptop. I can open applications, type and '
      + 'click in windows, read and write files, capture and read the screen (including text drawn '
      + 'as pixels), inspect accessibility trees, search the web, and run development tools. '
      + 'Every action is independently verified against the real machine, and the guard means I '
      + 'never type into a window someone is using. Try: "open Notepad, type hello, and save it".'
  }
  return null
}

/** How many rows of an answer table are pasted into the chat before the rest is left on disk. */
const ANSWER_ROWS = 12

/**
 * The answer, in the chat, rather than a receipt about one.
 *
 * THE DEFECT THIS FIXES
 * ---------------------
 * Asked to "research all data protection solutions and provide details in the chat box here",
 * Zeus answered:
 *
 *     PLAN
 *       s1 Research the market and gather a vendor-by-vendor comparison  [web-research]
 *       s2 Save the researched list as a spreadsheet                   [spreadsheet]
 *       s3 Read the saved spreadsheet back from disk                     [read-file]
 *
 *     ZEUS
 *       Completed 3 step(s); every step and the objective were independently verified.
 *       goal satisfied
 *
 * Every one of those lines is true. None of them is an answer. The person asked for details in the
 * chat and received a description of a file on disk that they had not asked about, in a vocabulary
 * of tool names, wrapped around the single most useless sentence a program can say about a finished
 * job. The work had already been done - the table existed, with real companies in it - and the
 * interface's job is to hand that over.
 *
 * So the closing message now carries the RESULT: a short lead sentence, and the table itself when
 * the result IS a table.
 *
 * WHY THE TABLE IS READ BACK FROM DISK RATHER THAN REUSED FROM THE PLAN
 * ---------------------------------------------------------------------
 * Because the file is what the person will open, and the file is the only version that survived
 * being written. A row that was padded, a URL that was dropped for having no source, a cell the
 * tool quoted because it contained a comma - all of that is in the file and none of it is in the
 * plan. Rendering the plan would show a table that is not the table.
 *
 * BOUNDED, and the bound is stated rather than hidden. A file with ten thousand rows is not pasted
 * into a chat window; the first rows are, the shape is described, and the path is given so the rest
 * is one click away. A truncated answer that says it is truncated is useful; one that silently
 * stops is not.
 */

/** The table-shaped result of this mission, read back from what was actually written. */
export function answerTableFromArtifact(path: string): AnswerTable | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return null

  // A tiny CSV reader rather than a naive split, because the cells this system writes are quoted
  // whenever they contain a comma - which is most of them. Splitting on commas would turn one
  // column into five and show the reader a table nobody produced.
  const split = (line: string): string[] => {
    const out: string[] = []
    let cell = ''
    let quoted = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (quoted) {
        if (c === '"') {
          if (line[i + 1] === '"') { cell += '"'; i++ } else { quoted = false }
        } else cell += c
      } else if (c === '"') quoted = true
      else if (c === ',') { out.push(cell); cell = '' }
      else cell += c
    }
    out.push(cell)
    return out
  }

  const headers = split(lines[0])
  // A one-column file is prose that happens to end in .csv, not a table. Rendering it as one would
  // put a header over a sentence.
  if (headers.length < 2) return null

  const body = lines.slice(1)
  return {
    headers,
    rows: body.slice(0, ANSWER_ROWS).map(split),
    totalRows: body.length,
  }
}

/**
 * Explain why a reply could not be read as a plan.
 *
 * Observed live, repeatedly: a model produces an 11 KB plan - research steps plus a full
 * comparison table inlined as an array of arrays - and it arrives with unbalanced braces, so the
 * parser is inside an object where a steps array should be. Every repair in this file was already
 * applied and none of them can help, because the document's own structure is wrong rather than its
 * quoting.
 *
 * That is not repairable by guessing, and saying so plainly is worth more than another heuristic:
 * the previous message told the person the model had proposed nothing, which is false, and sent
 * them looking at the planner instead of at a document of 11,000 characters carrying a table
 * through a channel that cannot reliably carry it.
 */
function describeUnreadablePlan(raw: string): string {
  const body = String(raw ?? '').trim()
  const bytes = body.length
  const looksLikePlan = /"steps"\s*:/.test(body)
  const inline = (body.match(/\[\s*\[/g) ?? []).length

  if (!looksLikePlan) {
    return `The model answered in prose rather than proposing a plan (${bytes} characters). `
      + 'That is a valid answer, and it is being shown as the reply.'
  }

  // The size and shape are the actionable part: a plan carrying an inline table through a JSON
  // string is the case known to break, and naming it tells whoever reads this what to change.
  const sizeNote = bytes > 6000
    ? ` At ${bytes} characters this reply is large, and a plan of that size with an inline data table `
      + 'is the shape known to arrive malformed - the table travels inside a JSON string, where a '
      + 'single unescaped brace makes the whole document unreadable.'
    : ''
  const inlineNote = inline > 0
    ? ` It carries ${inline} inline array(s) of row data.`
    : ''
  return `The model proposed a plan but it could not be read as JSON, so nothing could be run.`
    + `${sizeNote}${inlineNote} The full reply is kept in the mission record rather than discarded, `
    + 'so the work is not lost - but a plan this shape needs the data carried separately from the plan.'
}

/**
 * Rewrite a status line into the product's own voice, with no model identifiers in it.
 *
 * The interface showed this:
 *
 *     9 free model(s) available; trying opencode/longcat-2.5-preview-free, opencode/beam-free,
 *     opencode/deepseek-v4.1-flash-free, opencode/glm-5.3-flash-free
 *
 * which is the routing table printed at someone who asked a question. Nobody reading it can act on
 * it, and it teaches the reader a vocabulary that is not theirs. What they are owed is one line
 * saying the work is under way, and - if it stalls - which stage it stalled at.
 *
 * HONESTY IS NOT SACRIFICED, ONLY MOVED. Zeus still records the concrete model that answered on the
 * plan itself and in the mission record, and the interface shows the pool shape on demand. What is
 * removed is the dump, not the record. A routing name must never become a disguise, and the way to
 * guarantee that is to keep the evidence reachable rather than to show it unprompted.
 *
 * Model identifiers are matched by shape rather than by an exact list, because the list changes and
 * the interface should not need updating when it does.
 */
function brandStatus(text: string): string {
  const raw = String(text ?? '')
  if (raw.length === 0) return raw

  // Any run of provider/model identifiers is removed wherever it appears, and the surrounding
  // Pool lines are replaced outright rather than rewritten. Stripping the identifier out of
  // "It leads with opencode/beam-free and spreads the rest" left "It leads with a free model and
  // spreads the rest" - a sentence with a hole in it that says nothing and reads like a fault.
  //
  // This runs BEFORE the strip precisely because the strip returns early. With the order the other
  // way round, every pool line kept its original sentence with the hole in it.
  if (/free model\(s\) available|spreads the rest/i.test(raw)) {
    return ZEUS_ID + ' is choosing a free model and spreading the load across its pool.'
  }

  // Any remaining run of provider/model identifiers is removed wherever it appears.
  const MODEL_ID = /opencode\/[A-Za-z0-9._-]+-free\b/g
  if (MODEL_ID.test(raw)) {
    const cleaned = raw
      .replace(MODEL_ID, 'a free model')
      .replace(/\s*,?\s*(and|,)\s*a free model/g, '')
      .replace(/\ba free model,\s*a free model\b/g, 'a free model')
      .replace(/\s{2,}/g, ' ')
      .trim()
    return cleaned.length > 0 ? cleaned : ZEUS_ID + ' is working.'
  }
  return raw
}

/**
 * Ask the free model for a plan.
 *
 * Uses the EXISTING transport (`opencode run` via the local CLI) rather than adding a second
 * client. No key, no endpoint, no cost. If it fails the caller is told WHY - a silent fallback
 * to a hardcoded plan would be exactly the kind of pretended capability this project refuses.
 */
export async function interpret(
  goal: string, emitRaw: Emit, opts?: InterpretOptions,
): Promise<InterpretedPlan> {
  // Every status line leaves through here, so branding is applied once rather than at each of the
  // dozen places a model id could leak from. Doing it at the emit boundary is what makes it total:
  // a new status message added later cannot reintroduce a provider identifier by being forgotten.
  const emit: Emit = (ev) => {
    if (ev.kind === 'status' && typeof ev.text === 'string') {
      emitRaw({ ...ev, text: brandStatus(ev.text) })
      return
    }
    emitRaw(ev)
  }
  // When this is a REPLAN, the goal is the same but the context is not: the model is told what
  // already happened, what the verifier said, and what is still missing. That is the difference
  // between planning once and planning with feedback, and it is the whole point of the loop.
  const effectiveGoal = opts?.feedback
    ? `${goal}\n\n--- WHAT ALREADY HAPPENED ---\n${opts.feedback}\n--- END OF FEEDBACK ---\n\nRevise the plan accordingly: keep what worked, replace or extend what did not, and produce the steps that still need to run. Do not repeat a step that already succeeded.`
    : goal

  const fast = conversationalReply(goal)
  if (fast !== null && !opts?.feedback) {
    emit({ kind: 'status', text: 'Answered directly - no model call needed.' })
    return { reply: fast, steps: [], model: 'none (conversational)' }
  }

  if (opts?.model && !isFreeModel(opts.model)) {
    throw new Error(`${opts.model} is not a free model; AIOS uses free models only`)
  }
  const preferred = opts?.model ?? MODEL

  // Read the guard ONCE, before any model is asked. It is a property of the machine, not of the
  // model, and every attempt renders the same catalogue into its prompt - re-reading it per
  // attempt would report the same status line several times and imply the guard had been
  // re-consulted between models when nothing about it changed.
  emit({ kind: 'status', text: opts?.feedback ? 'Replanning with execution results...' : 'Asking the local model to interpret the goal...' })
  const input = await refreshLiveAvailability()
  emit({
    kind: 'status',
    text: `guard reports input ${input.permitted ? 'PERMITTED' : 'BLOCKED'}: ${input.reason}`,
  })

  // Build the rotation. If the catalogue cannot be read the preferred model is still tried, so a
  // failure to LIST models never prevents an attempt to USE one.
  let candidates: string[] = [preferred]
  try {
    const { freeModels } = await import('./models.ts')
    const ids = (await freeModels({ cliPath: opts?.cliPath })).map((m) => m.id)
    candidates = zeusRoute('plan', ids).candidates
    emit({
      kind: 'status',
      text: ZEUS_ID + ' has ' + ids.length + ' free model(s) to draw on. It leads with '
        + candidates[0] + ' and spreads the rest rather than reusing one until it is throttled'
        + (candidates.length > 1
          ? ' (next: ' + candidates.slice(1, 4).join(', ') + (candidates.length > 4 ? ', and ' + (candidates.length - 4) + ' more' : '') + ')'
          : '') + '. A model that fails is set aside rather than retried immediately, and the one '
        + 'that answers is named in the result.',
    })
    // FALLBACK, NOT A CRUTCH.
    //
    // `freeModels()` said there are no free models, but this machine is known to have eleven:
    // they are listed by `opencode models` as `opencode/*-free`, and `isFreeModel` is what
    // classifies one as free. The most common cause of the read returning nothing is that the
    // CLI writes to a profile directory we did not point it at, or the network is throttled.
    //
    // Refusing to plan because the list could not be obtained is worse than planning against the
    // known-good list, because it kills every mission on a transient failure. So the
    // known-free identifiers are used when the live read fails - and every model tried is still
    // validated by `isFreeModel` inside `planOnce`, which would refuse a model that is not in
    // fact free. The list is the best knowledge we have, reused only when the better one is
    // unreachable, and it is stated as such rather than hidden.
  } catch (e) {
    const knownFree: string[] = [
      'opencode/beam-free',
      'opencode/cat-jam-free',
      'opencode/deepseek-v4.1-flash-free',
      'opencode/glm-5.3-flash-free',
      'opencode/longcat-2.5-preview-free',
      'opencode/mimo-v2.6-flash-free',
      'opencode/muse-spark-1.3-contributor-free',
      'opencode/nemotron-3-ultra-free',
      'opencode/nemotron-3.5-lightning-free',
      'opencode/nemotron-3.5-super-vl-free',
      'opencode/space-bunny-free',
    ]
    candidates = zeusRoute('plan', [preferred, ...knownFree]).candidates
    const cooldownCount = candidates.filter((m) => inCooldown(m)).length
    emit({
      kind: 'status',
      text: `could not read the live model list (${e instanceof Error ? e.message : String(e)}); `
        + `using the known free models instead (${candidates.length}, ${cooldownCount} in cooldown). `
        + `A live list replaces this whenever the CLI answers.`,
    })
  }

  let lastError: unknown
  const tried = new Set<string>()
  for (const model of candidates) {
    if (tried.has(model)) continue
    tried.add(model)
    try {
      const startedAt = Date.now()
      const first = await planOnce(model, effectiveGoal, emit, opts?.cliPath)
      // The latency here is the model's whole round trip, which is the number a waiting person
      // actually experiences - not a proxy. Zeus ranks on it the next time this call comes up.
      zeusNoteSuccess(model, 'plan', Date.now() - startedAt)
      return await completePlanIfNeeded(first, goal, emit, opts?.cliPath, tried, model)
    } catch (e) {
      lastError = e
      const why = e instanceof Error ? e.message : String(e)
      // A refusal or a refusal-shaped reply is NOT a transport failure and switching models will
      // not change it - the model was reached and declined. Rate limits and CLI failures are.
      const retryable = /rate limit|too many requests|\b429\b|exited \d+|could not be run|did not complete within|no completion|terminated/i.test(why)
      noteFailure(model, why)
      zeusNoteFailure(model, 'plan', why)
      emit({
        kind: 'status',
        text: retryable
          ? `${model} could not be used (${why.slice(0, 120)}). Setting it aside for 10 minutes and trying another free model.`
          : `${model} did not return a plan (${why.slice(0, 120)}). This looks like a refusal rather than a transport failure, so trying a different model would only repeat it.`,
      })
      if (!retryable) break
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'no free model could produce a plan'))
}

/**
 * Ask the model ONCE more when its plan merely shows rather than delivers.
 *
 * The system prompt already says "do not stop at the first action", and it is not obeyed
 * reliably - measured, not assumed: with that wording in place the model still returned one
 * step for an information goal and stopped. So the check is in code.
 *
 * Three properties matter more than the feature itself:
 *
 *   1. IT NEVER FABRICATES. The correction is a second question to the model. No step in this
 *      file is synthesised, because a fabricated step would be executed and verified exactly like
 *      a real one and nobody downstream could tell.
 *   2. IT CANNOT MAKE THINGS WORSE. If the second plan is no better, the first is kept and the
 *      reason is said out loud. A mechanism that replaced a working plan with a worse one would
 *      cost the user real work on every information goal.
 *   3. IT IS BOUNDED. One extra call. A loop until the plan looks right is an unbounded cost on
 *      free models that are already rate-limited.
 *
 * Returns the plan that will actually run.
 */
async function completePlanIfNeeded(
  first: InterpretedPlan,
  goal: string,
  emit: Emit,
  cliPath: string | undefined,
  tried: Set<string>,
  answeredBy: string,
): Promise<InterpretedPlan> {
  const verdict = assessCompletion(goal, classifyGoal(goal), first.steps)
  if (!verdict.incomplete) return first

  emit({
    kind: 'status',
    text: `The plan only shows rather than delivers (${first.steps.length} step(s), none of which `
      + 'produces anything). Asking the model once more to finish the job.',
  })

  // Reuse the model that just produced the thin plan. It answered this goal within seconds, so it
  // is the fastest known-good route, and switching would spend a failover budget on a second
  // opinion about the same question. If that model is now unusable, Zeus routes the rest - and
  // routes them for the CORRECTION request type rather than the plan type, because the two are
  // different jobs: this one is short and wants speed, and ranking it on planning latency would
  // optimise it against the wrong measurement.
  const candidates: string[] = [answeredBy]
  try {
    const { freeModels } = await import('./models.ts')
    for (const m of (await freeModels({ cliPath })).map((x) => x.id)) {
      if (!candidates.includes(m)) candidates.push(m)
    }
  } catch { /* the models we already tried are enough */ }

  for (const model of zeusRoute('correct', candidates).candidates.slice(0, 3)) {
    const startedAt = Date.now()
    try {
      const second = await planOnce(model, correctionMessage(goal, verdict), emit, cliPath)
      zeusNoteSuccess(model, 'correct', Date.now() - startedAt)
      const secondVerdict = assessCompletion(goal, classifyGoal(goal), second.steps)
      if (secondVerdict.incomplete && second.steps.length <= first.steps.length) {
        emit({
          kind: 'status',
          text: 'The revised plan still delivers nothing and is no longer than the original, so the '
            + 'original is being kept rather than replaced with something worse.',
        })
        continue
      }
      emit({
        kind: 'status',
        text: `Revised plan now has ${second.steps.length} step(s), `
          + `${secondVerdict.incomplete ? 'still without a deliverable but' : 'including'} something `
          + 'the person can keep.',
      })
      return second
    } catch (e) {
      zeusNoteFailure(model, 'correct', e instanceof Error ? e.message : String(e))
      emit({
        kind: 'status',
        text: `could not get a revised plan from ${model} (${e instanceof Error ? e.message : String(e)}). `
          + 'Keeping the original plan.',
      })
      break
    }
  }
  return first
}

/** One planning attempt with ONE model. Retryable by the caller; owns no policy. */
async function planOnce(
  model: string, goal: string, emit: Emit, cliPath?: string,
): Promise<InterpretedPlan> {
  const { openCodePlannerFetch } = await import('../../../model/opencode-planner.ts')

  // The EXISTING transport, used exactly as the working model planner uses it: it returns a
  // fetch-shaped function that routes a chat-completions request through `opencode run`.
  // Free-ness was checked by the caller before this function was entered, and re-checked here,
  // because this is the layer that actually spawns the model process - a check that existed only
  // in the HTTP route would be a check a future non-HTTP caller could skip, and the thing being
  // enforced is money. It is also re-checked per ATTEMPT now that several models may be tried.
  if (!isFreeModel(model)) throw new Error(`${model} is not a free model; AIOS uses free models only`)

  // `cliPath` is threaded through rather than hardcoded so the reply-handling below can be
  // exercised against a real subprocess emitting a real NDJSON stream. It defaults to
  // `DEFAULT_OPENCODE_CLI`, so every production caller is unchanged - this is the same
  // "overridable, never discovered by search" seam `OpenCodeRunOptions.cliPath` already is.
  // 300s, not 180s, and the reason is measured rather than assumed.
  //
  // Planning latency on the free models available here is extremely uneven: observed runs of the
  // SAME goal took 15s, 19s, 62s, 119s and then exceeded 180s entirely. At 180s the timeout was
  // not a safety limit, it was a coin flip - a mission that would have succeeded died on the draw,
  // and the failure said "planner exceeded timeout", which points at the planner rather than at
  // the fact that the model is slow.
  //
  // The ceiling still exists and is still enforced; it is simply above the observed distribution.
  // It is called out here rather than raised silently because a three-minute worst case is a real
  // cost to whoever is waiting, and it belongs on the list of things to improve rather than in a
  // number nobody remembers changing.
  const PLANNER_TIMEOUT_MS = 300_000

  const { fetchImpl, calls } = openCodePlannerFetch(
    { model, timeoutMs: PLANNER_TIMEOUT_MS, ...(cliPath ? { cliPath } : {}) },
    (e) => emit({ kind: 'status', text: `model call finished in ${e.elapsedMs}ms (exit ${e.exitCode ?? 'n/a'})` }),
  )

  const res = await fetchImpl('https://opencode.local/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: systemPrompt(goal) },
        { role: 'user', content: goal },
      ],
    }),
  })
  // Read the model's ACTUAL reply before anything else touches it.
  //
  // `res.text` is the raw prose the model produced - `openCodePlannerFetch` concatenates the
  // CLI's `text` parts (opencode-planner.ts:256) and then WRAPS them into a chat-completion
  // envelope (opencode-planner.ts:193). So the reply lives at
  // `choices[0].message.content`, and `res.text` is not an envelope.
  //
  // The bug this replaces: `JSON.parse(res.text)` treated the model's answer as if it were
  // that envelope. Any reply that is not itself a JSON document - and "list your capabilities"
  // is answered in prose - threw `Unexpected token ... is not valid JSON`. Because the call
  // was unguarded AND sat BEFORE `parsePlan`, one conversational message killed the mission
  // path, and the tolerant parser built specifically to survive it never ran.
  const body = await res.json() as { choices?: { message?: { content?: string } }[] }
  const raw = String(body?.choices?.[0]?.message?.content ?? '')
  if (!raw.trim()) throw new Error('the model returned no plan text')

  const parsed = parsePlan(raw)
  emit({ kind: 'status', text: `Model proposed ${parsed.steps.length} step(s).` })

  // A reply that will not parse is the single most confusing failure in this system, because the
  // model DID write a plan - a complete, correct one is sitting in the record - and the mission
  // reported that none was proposed.
  //
  // So when the parse yields nothing, say what actually went wrong: how long the reply was, and
  // the parser's own complaint. That converts "the model replied without proposing any executable
  // step" - which points at the model, and is wrong - into a statement about a document that could
  // not be read, with the evidence beside it.
  if (parsed.steps.length === 0) {
    const complaint = describeUnreadablePlan(raw)
    emit({
      kind: 'status',
      text: complaint,
    })
  }

  // === Record the planner handoff as a durable job ===
  // Recorded AFTER the parse and from the SAME `parsed` the executor will run, so the durable
  // record cannot disagree with what was actually attempted.
  //
  // Evidence comes from the adapter's own `calls` log. The previous version wrote
  // `sessionId = ''` and `stderr = ''` as literals and read `res.events.find(...)` - but a
  // `Response` has no `events` property (and `PlannerCallEvidence.events` is a COUNT, not an
  // array), so that lookup could only ever have produced `[]`. The record therefore stated
  // facts that were never observed. Blockers are now derived from what is actually known.
  mkdirSync(MISSIONS_DIR, { recursive: true })
  const call = calls[calls.length - 1]
  const blockers: string[] = parsed.steps.length === 0
    ? ['the model replied without proposing any executable step']
    : []
  recordJob(
    goal,
    call?.sessionId ?? '',
    {
      reply: parsed.reply,
      steps: parsed.steps.map((s) => ({ id: s.id, intent: s.intent, tool: s.tool })),
    },
    {
      exitCode: call?.exitCode ?? (res.status === 200 ? 0 : 1),
      text: raw,
      stderr: call?.stderr ?? '',
    },
    // verified is settled later by the executor/verifier; this records that planning happened.
    true,
    [],
    blockers,
  )
  // ==============================================

  // Report the model that ACTUALLY produced this plan.
  //
  // `parsePlan` hardcoded 'opencode/space-bunny-free', which is a different model from the default
  // and was never the one that ran. Now that a throttled model can be stepped over and another
  // free model used instead, a plan that names the wrong model is not a cosmetic slip: the whole
  // point of announcing a switch is that the user can see which model they are relying on, and a
  // hardcoded name makes every announcement unverifiable.
  return { ...parsed, model }
}

/**
 * Escape quotes that a model emitted INSIDE a JSON string value, and left unescaped.
 *
 * Observed repeatedly on this machine, and it is not a rare shape: a plan to build a spreadsheet
 * naturally contains CSV rows whose cells are quoted, and the model writes
 *
 *     "rows":"Veeam,2006,"Backup, disaster recovery","Enterprise..."
 *
 * The inner quote closes the JSON string early and the whole document becomes unparseable. The
 * mission then reported "the model replied without proposing any executable step" while the log
 * the reader was looking at contained a complete, correct two-step plan.
 *
 * The rule for deciding which quote is the real one is deliberately narrow. Inside a string, a
 * quote is treated as a genuine CLOSING quote only when the next character is one that can
 * legally follow a JSON string: `,` `}` `]` `:` whitespace, or end of input. Anything else means
 * the quote is part of the value, and is escaped. A model that writes a quote inside a value gets
 * it back, correctly, as data.
 *
 * Applied ONLY after a direct parse has already failed, so a well-formed document is never
 * touched. That ordering is the point: this is a repair, not a normalisation, and a repair that
 * ran unconditionally could corrupt a valid plan that happened to contain a brace in a string.
 */
function escapeUnescapedQuotes(s: string): string {
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (!inStr) {
      out += c
      if (c === '"') inStr = true
      continue
    }
    if (esc) { out += c; esc = false; continue }
    if (c === '\\') { out += c; esc = true; continue }
    // A RAW control character inside a JSON string is illegal and is not a quoting question at
    // all - it is always the model meaning "a newline here". A multi-row `rows` argument is the
    // common case, and it fails with "Bad control character in string literal" before the quote
    // question is even reached. So this is repaired first, on its own terms.
    if (c === '\n') { out += '\\n'; continue }
    if (c === '\r') { out += '\\r'; continue }
    if (c === '\t') { out += '\\t'; continue }
    if (c === '"') {
      const next = s[i + 1]
      const closes = next === undefined || next === ',' || next === '}' || next === ']'
        || next === ':' || /\s/.test(next)
      if (closes) { out += c; inStr = false } else { out += '\\"' }
      continue
    }
    out += c
  }
  return out
}

/**
 * Tolerant of a fenced block or leading prose, because real models emit both.
 *
 * A model that answers in prose rather than emitting a plan is NOT an error - people type "hi",
 * or ask a question that needs no tools. That is a conversation, not a failed mission, and
 * reporting it as an error made an ordinary message look like a broken system. So a reply with
 * no usable steps is returned as a reply with zero steps, and the caller decides.
 */
export function parsePlan(raw: string): InterpretedPlan {
  const text = raw.trim()
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(unfenced) as Record<string, unknown>
  } catch {
    // Real models emit malformed JSON. Two forms have been observed on this machine:
    //
    //   1. trailing garbage: `...platform"}}}]}` after a valid document
    //   2. extra braces INSIDE the valid document: `...platform"}}}]` where one `}` is spurious
    //
    // The previous extractor took the span from the first '{' to the LAST '}', which swallowed
    // the garbage and failed on the same character the whole document failed on - so a plan
    // with one stray brace at the end was treated as prose, and a mission that had been
    // correctly planned ran zero steps.
    //
    // The fix is to find the first BALANCED object by counting braces while tracking string
    // state, so an extra brace after the real closing brace is never part of the span. If that
    // alone does not parse, walk the closing brace backwards and take the first valid span.
    const start = unfenced.indexOf('{')
    if (start < 0) {
      return { reply: text.slice(0, 2000), steps: [], model: MODEL }
    }
    let end = -1
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < unfenced.length; i++) {
      const c = unfenced[i]
      if (inStr) {
        if (esc) { esc = false; continue }
        if (c === '\\') { esc = true; continue }
        if (c === '"') inStr = false
        continue
      }
      if (c === '"') { inStr = true; continue }
      if (c === '{') depth++
      if (c === '}') { depth--; if (depth === 0) { end = i; break } }
    }
    let parsed = false
    if (end > start) {
      try { obj = JSON.parse(unfenced.slice(start, end + 1)) as Record<string, unknown>; parsed = true } catch { /* fall through to the walk */ }
    }
    if (!parsed) {
      let cursor = unfenced.lastIndexOf('}')
      while (cursor > start) {
        try {
          obj = JSON.parse(unfenced.slice(start, cursor + 1)) as Record<string, unknown>
          parsed = true
          break
        } catch {
          cursor = unfenced.lastIndexOf('}', cursor - 1)
        }
      }
    }
    if (!parsed) {
      return { reply: text.slice(0, 2000), steps: [], model: MODEL }
    }
  }
  const p = obj
  if (!Array.isArray(p.steps)) {
    // A REFUSAL IS A LEGITIMATE, COMPLETE ANSWER.
    //
    // The user typed a prompt and got this raw on screen:
    //
    //     {"refusal":"The request 'probe' is too ambiguous to form a plan. ..."}
    //
    // The model declined, which is correct behaviour and must not be hidden. But `refusal` was
    // not handled here, so `p.reply` was undefined, the fallback dumped the whole raw document,
    // and the user was shown machine output where an explanation belonged.
    //
    // So the refusal text is extracted and used as the reply. Declining stays visible and stays
    // legible, which is the whole point of allowing a model to decline.
    if (typeof p.refusal === 'string' && p.refusal.trim()) {
      return { reply: p.refusal.trim().slice(0, 2000), steps: [], model: MODEL }
    }
    return { reply: String(p.reply ?? text.slice(0, 2000)).slice(0, 2000), steps: [], model: MODEL }
  }
  const steps = (p.steps as unknown[]).map((s, i) => {
    const step = (s ?? {}) as Record<string, unknown>
    const tool = String(step.tool ?? '').trim()
    if (!tool) throw new Error(`step ${i + 1} names no tool`)
    return {
      id: String(step.id ?? `s${i + 1}`),
      intent: String(step.intent ?? tool),
      tool,
      args: (typeof step.args === 'object' && step.args !== null ? step.args : {}) as Record<string, unknown>,
    }
  })
  return { reply: String(p.reply ?? ''), steps, model: 'opencode/space-bunny-free' }
}

// ===========================================================================================
// plan validation
// ===========================================================================================

/** One destination the person named, and the one that was written instead. */
export interface Substitution {
  /** The path as asked for, verbatim. Never normalised away: it is the person's own words. */
  readonly requested: string
  /** The path actually used, which is inside the output directory. */
  readonly written: string
  /**
   * WHY the substitution happened, in words the reader can act on.
   *
   * Absent this, a mission record showed two paths and no reason, and "the file went somewhere
   * else" is indistinguishable from a bug.
   */
  readonly reason: string
  /**
   * DID THE PERSON AGREE?
   *
   * Always false today, and it is stated rather than defaulted, because that is the honest value:
   * nothing in this system asks a person to approve a destination, so no substitution is ever
   * authorised. The field exists so that "the user agreed to put it here" is a thing the system
   * would have to be able to say truthfully, rather than something it could assume.
   */
  readonly authorized: boolean
}

/**
 * THE DELIVERABLE: what the person asked for, and what was actually produced for it.
 *
 * WHY THIS EXISTS RATHER THAN MORE PATH RECONCILING
 * -------------------------------------------------
 * Reconciliation used to pair a write with a read-back by FILENAME. That is inference dressed as
 * identity, and it fails in both directions:
 *
 *   - It MISSES a real pairing when the two names differ. Observed: a mission wrote
 *     `example.com.csv` and read `Zeus-Browser-Proof.txt`, so the read-back found no partner and
 *     verified a 0-byte file at a path the write had never touched.
 *   - It would MATCH an unrelated pair that happens to share a basename, which is the same false
 *     success in the other direction.
 *
 * So the pairing is now declared rather than inferred. A deliverable is created once, from what
 * the person asked for; the producing step and its read-back are attached to THAT, and a read-back
 * carries the id rather than a guess about which write it meant.
 *
 * The identity is assigned at validation and never re-derived. Nothing downstream may pair two
 * files because their names look alike, because their contents resemble each other, or because one
 * happened to be written most recently - each of those is a coincidence, and a coincidence is not
 * a claim about what the person asked for.
 */
export interface Deliverable {
  /** Stable within the mission. The only thing a read-back refers to. */
  readonly id: string
  /** The filename the PERSON asked for, verbatim. Null when they named none. */
  readonly requestedName: string | null
  /** The destination the person asked for, verbatim. Null when they named none. */
  readonly requestedPath: string | null
  /** Where the file will actually be written. Confined to the agent output directory. */
  readonly resolvedPath: string
  /**
   * The path the PLAN named, before confinement relocated it.
   *
   * Kept because "write X, then read X back" is the ordinary shape of a mission, and after
   * confinement the read-back's own `X` matches nothing that exists. Comparing the two strings for
   * EQUALITY identifies the pair; comparing basenames would not, and would also pair unrelated
   * files that happen to share a name.
   */
  readonly planPath: string
  /** What the producing step declared it would write, when it declared anything. */
  readonly expectedContent: string | null
  /** Whether the producing step explicitly declared an EMPTY deliverable. */
  readonly expectedEmpty: boolean
  /** The step that writes it. */
  readonly producingStepId: string
  /** The step that reads it back, once one is attached. */
  readonly readBackStepId: string | null
  /** Set when the resolved path differs from the requested one. */
  readonly substitution: Substitution | null
}

/** Tools that reach a REAL window. A goal asking to SEE something needs one of these. */
const VISIBLE_TOOLS = /launch-app|desktop-input|screen-diff|list-windows|survey-window|ocr/

/**
 * Tools that OBSERVE what is on the screen.
 *
 * Distinct from VISIBLE_TOOLS on purpose: `launch-app` makes a window appear, and `list-windows`
 * proves one exists, but neither establishes WHAT THE PERSON CAN READ. Only these read the pixels or
 * the accessibility tree of a real window, and they are the only things that can support a claim
 * about what a visible page says.
 */
const OBSERVING_TOOLS = /ocr|survey-window|screen-diff/

/** Tools that fetch a page without showing it to anyone. */
const HEADLESS_RESEARCH_TOOLS = /web-research/

/**
 * The thing the person asked about, quoted back so the refusal names it rather than gesturing.
 *
 * "the page says", "the screen shows" - the goal's own words. A refusal that says "you asked what
 * it says" without saying what is unhelpful in the same way a step id without a path is.
 */
const REPORTING_VERB_FROM_GOAL = (goal: string): string => {
  const m = /\b(says?|reads?|shows?|displays?|states?|contains?|lists?)\b/i.exec(String(goal ?? ''))
  return m ? `the page ${m[1].toLowerCase()}` : 'the page looked like'
}

/**
 * Check every step against the registry BEFORE anything runs, and supply the defaults the model
 * reliably omits.
 *
 * The model is not trusted to have read the catalogue. An unknown or unavailable tool is
 * refused here, so the failure is a clear message rather than an executor error three steps in.
 *
 * The `objective` default is not a shortcut around the model: the user's own goal IS the
 * objective, and a step that omitted it was going to fail for a reason the user could do
 * nothing about. Filling it from the goal is what the user meant.
 */
export function validatePlan(plan: InterpretedPlan, goal = '', missionId = ''): ValidatedPlan {
  const steps: PlannedStep[] = []
  const refusals: string[] = []
  const inferred: string[] = []
  /**
   * Destinations that were asked for and not used.
   *
   * Empty in the ordinary case, which is the point: most plans name no destination, or name one the
   * model invented, and putting those somewhere writable is a repair worth doing quietly. It is NOT a
   * failure - unless the PERSON named the place, in which case quietly moving their file is exactly
   * the kind of false success this file exists to prevent.
   */
  const substitutions: Substitution[] = []
  for (const s of plan.steps) {
    const r = resolveCapability(s.tool)
    if ('unavailable' in r) { refusals.push(`step "${s.id}" (${s.intent}): ${r.unavailable}`); continue }
    const args: Record<string, unknown> = { ...s.args }
    // Required operands that are obviously derivable from the request are filled from it.
    // Anything else stays missing, so the tool still refuses rather than guessing.
    if (typeof args.objective !== 'string' || args.objective.trim().length === 0) {
      if (goal.trim().length > 0) args.objective = goal.trim()
    }

    // Same principle, narrower case: a launch step that named the application in its own prose
    // but not in its args gets the name recovered, and the recovery is ANNOUNCED rather than
    // silent. A step that said "Open Notepad" and omitted `{"app":"notepad"}` is not ambiguous
    // - the plan already answered the question, in the wrong field. See inferLaunchApp for why
    // this can only ever return something the host would have accepted anyway.
    //
    // Announced on purpose: a reader comparing the printed plan against what ran can see which
    // arguments the model supplied and which were filled in. An inference that is not reported
    // is indistinguishable from the model having done it, and this project does not make that
    // distinction disappear.
    if (r.tool.name === 'launch-app'
      && (typeof args.app !== 'string' || args.app.trim().length === 0)) {
      const named = inferLaunchApp(s.intent) ?? inferLaunchApp(goal)
      if (named) {
        args.app = named
        inferred.push(`step "${s.id}": "app" was not in the plan, so "${named}" was recovered from the step's own wording`)
      }
    }

    // A path the model gave that fails the folder rule is not a different opinion - it is a
    // paraphrase that happens to be unsafe, and it must not be run. Recovering from the goal is
    // the same mechanism used for a missing app: the goal is what the user said, and what they
    // said is the authoritative path.
    if (r.tool.name === 'launch-app' && typeof args.path === 'string' && args.path.trim().length > 0) {
      const check = resolveReadablePath(args.path)
      if ('refused' in check) {
        const recovered = inferReadPath(goal) ?? inferReadPath(s.intent)
        if (recovered) {
          args.path = recovered
          inferred.push(`step "${s.id}": the path the plan gave (${args.path}) is not in a readable folder, so "${recovered}" was recovered from the goal`)
        }
      }
    }
    // Same idea for the mission's closing read. A path named in the goal is a path the person
    // chose; recovering it puts it through the SAME allowlist an explicit argument would face,
    // so this widens nothing. See inferReadPath.
    if (r.tool.name === 'read-file'
      && (typeof args.path !== 'string' || args.path.trim().length === 0)) {
      const named = inferReadPath(goal) ?? inferReadPath(s.intent)
      if (named) {
        args.path = named
        inferred.push(`step "${s.id}": "path" was not in the plan, so "${named}" was recovered from the goal, and checked against the same readable-folder rules an explicit path would face`)
      }
    }

    // ...and the PROUCING tools, which is where this actually bit.
    //
    // Observed: the goal "data protection companies" produced a three-step plan - research, build a
    // spreadsheet, read it back - and the middle step failed because the model wrote
    // `C:\Users\Samer\AppData\Local\opencode\output\data-protection-companies.csv`. That path comes
    // from the model's own habits, not from anything in this repository, and it is outside every
    // folder a mission may write to.
    //
    // The refusal was CORRECT and must stay. But the goal never named a path, so there was nothing
    // to recover from it and the whole mission died on a detail the person had no opinion about.
    // A correct plan failing for a reason the user could not have known about is not governance,
    // it is a defect.
    //
    // So: a path the goal named is preferred; otherwise the model's own filename is KEPT but
    // relocated into the output directory, which is where writes belong. Only the directory is
    // supplied. The model still chose the name, so nothing is invented, and the confinement is
    // the same rule an explicitly-given path would have faced.
    // A `rows` argument that arrived as an ARRAY must be allowed through validation. The required-
    // argument check calls String(v) on every operand, so an array of arrays reads as a non-empty
    // string and passes - but only because that is incidental. It is stated here so the array
    // form is a supported input rather than something that happens to work.
    if (r.tool.name === 'write-file' || r.tool.name === 'spreadsheet') {
      const given = String(args.path ?? '').trim()
      const fromGoal = inferReadPath(goal) ?? inferReadPath(s.intent)
      // A destination the goal named is honoured only when it is INSIDE the output directory.
      //
      // "save it to my documents as quarterly-summary.txt" yields
      // `C:\Users\Samer\Documents\quarterly-summary.txt`, and `write-file` refuses that path:
      // AIOS's own writers are confined to the agent output directory, so using the goal's path
      // verbatim handed the step a destination that guaranteed its own failure - recovered from
      // the person, and announced as a fix.
      //
      // What is taken from the goal is therefore the FILENAME, which is the part models get wrong
      // (they invent folders and temp paths) and the part the person actually cares about. The
      // folder stays the output directory, which is unchanged and is not widened by a sentence.
      const goalPathUsable = fromGoal !== null && fromGoal.startsWith(AGENT_OUT)
      // DID THE PERSON NAME A PLACE. Not "did the plan name a place" - the plan always names one,
      // because a model that invents `...\Temp\aios-planner-x\notes.txt` is naming a place too.
      //
      // The distinction that matters is who chose it. A destination the person wrote down - whether
      // as a full path or as the prose "in my Documents folder" - is part of the goal, and a file
      // anywhere else does not satisfy it. A destination the MODEL invented is being corrected, not
      // contradicted: nobody asked for it, so recording it as a substitution would be noise that
      // trains people to ignore the message.
      //
      // `inferReadPath` only finds a path written out in full, and `inferGoalFilename` only finds
      // a name with an extension, so between them they miss the most ordinary phrasing there is:
      // "create the report in my Documents folder" contains neither. `inferGoalFolder` reads the
      // folder out of the PROSE, which is what makes that case a substitution rather than a quiet
      // repair - and it reads the folder from the sentence, never from a filename, because
      // "AIOS-Desktop-Mission-Report.txt" contains the word "Desktop" and a goal that says nothing
      // about the Desktop must not be read as asking for it.
      const personNamedFolder = inferGoalFolder(goal) ?? inferGoalFolder(s.intent)

      // THE PATH THE PLAN NAMED, recorded before ANY branch can change it.
      //
      // Recorded here rather than in each branch below, because that is where the bug lived: the
      // record was added to two of the three branches, so a write whose path was simply unwritable
      // - `C:\Windows\System32\evil.csv` - was relocated without `planRequestedPath` being set, the
      // read-back could not be paired to it, and two pre-existing tests failed. Every branch that
      // can move the path must leave this behind, and the only reliable way to guarantee that is to
      // take it before the first of them.
      //
      // It is what lets the deliverable pairing recognise "write X, then read X back" by EXACT
      // EQUALITY once confinement has moved the write. Two files that merely share a basename are
      // not paired, and that case is refused.
      if (given.length > 0) args.planRequestedPath = given

      // THE PLAN'S OWN FILENAME IS KEPT WHEN ANOTHER STEP USES IT.
      //
      // Observed on mission 2a1995ef (goal: open NAKIVO visibly, scan it, save a CSV to
      // `...\out\nakivo-scan.csv`). Attempt 2 produced four steps - open Explorer, write the
      // scanner, run the scanner, read the CSV back. The goal names ONE destination, and the
      // branch below applied it to EVERY producing step, so the step that was meant to write
      // `scan_nakivo.py` had its path replaced with `nakivo-scan.csv`. The next step then ran
      // `python ...\out\scan_nakivo.py`, a file that no longer existed, and the mission failed on
      // a detail no person had an opinion about.
      //
      // The residue was worse than the failure: `nakivo-scan.csv` was left holding PYTHON SOURCE
      // where an inventory belonged. The verdict gate correctly refused to report that as success,
      // and refusing is the right behaviour - but the file on disk was still wrong, and a refused
      // verdict is not a repair.
      //
      // The destination the person named is the DELIVERABLE. A plan that writes a script and then
      // runs it has an intermediate file, and that file has its own name for a reason. When
      // ANOTHER STEP IN THIS PLAN refers to that name, the name is load-bearing: replacing it
      // breaks a plan that was otherwise entirely correct.
      //
      // This only ever prevents the goal's destination from being imposed. The branches below
      // that keep the model's own FILENAME and merely relocate it into the output directory are
      // untouched, so confinement is unaffected.
      const ownName = given.length > 0 ? (given.split(/[\\/]/).pop() ?? '') : ''
      const usedByAnotherStep = ownName.length > 0 && steps.some((other) =>
        other.id !== s.id && JSON.stringify(other.args ?? {}).includes(ownName))

      if (goalPathUsable && usedByAnotherStep) {
        inferred.push(`step "${s.id}": kept the plan's own "${ownName}" because another step in this `
          + 'plan refers to it. The destination named in the goal is the deliverable, and imposing it '
          + 'on an intermediate file would leave the plan pointing at a file that was never written.')
      } else if (goalPathUsable) {
        args.path = fromGoal
        inferred.push(`step "${s.id}": output goes to "${fromGoal}", taken from the goal`)
      } else if (fromGoal !== null || personNamedFolder !== null || goalNamesAFile(goal) || goalNamesAFile(s.intent)) {
        // The filename comes from whoever named one: the goal if it named a file, else the PLAN's own
        // path - which is the model having chosen a name, and discarding it would be inventing one.
        // "Documents" in prose says WHERE, not what to call the file.
        //
        // This previously fell back to `${s.id}.txt`, which silently renamed the deliverable to
        // "s3.txt". Two consequences, both observed: the person asked for a report and the file
        // was called something else, and the read-back - which reconciles on FILENAME - no longer
        // matched the write, so it kept pointing at the refused destination and verified a 0-byte
        // stub. One naming decision broke the reconciliation that the rest of the chain depends on.
        const fromGoal = goalNamesAFile(goal) ?? goalNamesAFile(s.intent)
        const fromPlan = given ? (given.split(/[\\/]/).pop() ?? '') : ''
        const base = fromGoal ?? fromPlan
        const fallback = fromGoal ?? fromPlan ?? `${s.id || 'output'}.csv`
        args.path = confineTo(AGENT_OUT, base || fallback, fallback)
        // THE PERSON NAMED THE PLACE. "In my Documents folder" is part of the goal, so a file
        // anywhere else does not satisfy it. Zeus's own writers cannot write there, so the work
        // still happens - and the fact that it happened somewhere else is recorded rather than
        // repaired quietly, because the whole point is that a goal naming a destination is not
        // met by a file in a different folder.
        //
        // A model-invented path (a temp folder, an opencode output dir) with no folder named in
        // the prose reaches the same line but is NOT recorded: nobody asked for it, so announcing
        // a failure would be noise. The note still says where the file went.
        const namedItself = given.length > 0 && personNamedFolder !== null
        // THE PATH THE PLAN ITSELF NAMED, BEFORE CONFINEMENT MOVED IT.
        //
        // Kept because a read-back in the same plan will name the SAME string - "write X, then read
        // X back" is the ordinary shape - and once confinement has relocated the write, that string
        // no longer matches anything on disk. Recording it is what lets the deliverable pairing
        // recognise the read-back as referring to the write it was written next to, by exact
        // equality rather than by basename.
        //
        // This is identity, not resemblance: the two strings are identical. Two files sharing a
        // basename are still not the same file, and that case is refused.
        if (given.length > 0) args.planRequestedPath = given
      if (namedItself) {
          substitutions.push({
            requested: given,
            written: args.path,
            reason: 'the destination is outside the agent output directory, which is the only place '
              + 'AIOS\'s own writers may write. The file was produced in the output directory instead.',
            // Nothing in this system asks a person to approve a destination, so no substitution can
            // honestly claim to be authorised. Stated rather than defaulted so the field cannot be
            // assumed true by a reader who is looking for it to be true.
            authorized: false,
          })
          args.requestedPath = given
          // The name the person asked for, separately from the path. The deliverable carries both,
          // so a reader can see that `Zeus-Browser-Proof.txt` was requested even after the file is
          // written under a different name.
          const requestedLeaf = given.split(/[\\/]/).pop()
          if (requestedLeaf && requestedLeaf.length > 0) args.requestedName = requestedLeaf
          inferred.push(
            `step "${s.id}": you asked for "${given}" but AIOS writes only inside its own output `
            + `directory, so the file was written to ${args.path} instead. Both paths are recorded, `
            + 'and the mission will not be reported as satisfied.',
          )
        } else {
          // THE SAME RECORD FOR THE QUIET BRANCH, where the plan's own path was outside the
          // writable area and was relocated without a substitution being raised.
          //
          // This was missed at first, and it broke two pre-existing tests that assert something
          // important: a plan that writes to a temp path and reads that same temp path back must
          // have its read-back follow the write into the output folder. Without the plan's original
          // string the pair could not be recognised, the read-back was refused, and the mission
          // lost its own verification step. Nobody asked for that path, so it is NOT a
          // substitution - but it is still the path the plan named, and a read-back naming it is
          // still referring to that write.
          if (given.length > 0) args.planRequestedPath = given
          inferred.push(
            `step "${s.id}": the goal named "${base || fallback}" but AIOS writes only inside its `
            + `output directory, so the file was written to ${args.path}. The name is the goal's own; `
            + 'only the folder is ours.',
          )
        }
      } else {
        // confineTo, not `join(AGENT_OUT, base.replace(...))`. The inline version left `..` intact,
        // and joining a directory with `..` yields its PARENT - a real escape from the only folder
        // a mission may write to. The helper checks the result instead of trusting the input.
        const base = given ? given.split(/[\\/]/).pop() ?? 'output' : `${s.id || 'output'}.csv`
        args.path = confineTo(AGENT_OUT, base, 'output.csv')
        inferred.push(
          given
            ? `step "${s.id}": the destination the plan gave (${given}) is outside every folder a `
              + `mission may write to, so the file was written to ${args.path} instead. The name is `
              + "the plan's own; only the folder was supplied."
            : `step "${s.id}": no destination was named, so the output goes to ${args.path}`,
        )
      }
    }

    const required = (r.tool.args ?? []).filter((a) => a.required)
    const missing = required.filter((a) => {
      const v = args[a.name]
      return v === undefined || v === null || String(v).trim().length === 0
    })
    if (missing.length > 0) {
      refusals.push(`step "${s.id}" (${s.intent}): ${r.tool.name} requires ${missing.map((m) => m.name).join(', ')}, which the plan did not provide`)
      continue
    }
    steps.push({ ...s, args })
  }

  // ---- RECONCILE THE CLOSING READ WITH WHAT WAS ACTUALLY WRITTEN.
  //
  // Observed: a three-step plan - research, write a spreadsheet, read it back - wrote a correct
  // 984-byte CSV, and then failed the read-back because the model had named a DIFFERENT path for
  // the same file. It wrote to `...\AppData\Local\Temp\aios-planner-1Hym1b\companies.csv`, which
  // was outside every folder a mission may write to, so the write was relocated to the output
  // directory - and the read-back kept the model's original temp path. Two steps, one file, one
  // of them looking in the wrong place.
  //
  // The read-back exists to prove the write happened. Reading a path nobody wrote is not a
  // weaker check, it is a check of nothing - and its refusal then reads as "the file could not be
  // written", which is the opposite of what happened.
  //
  // So a read whose FILENAME matches a producing step's resolved path is pointed at that path.
  //
  // THE FILENAME MATCH IS GONE, and its removal is the point of this section. It was the mechanism
  // by which a read-back guessed which write it was verifying, and it fails in both directions:
  //
  //   - It MISSES real pairings. The failing mission wrote `example.com.csv` and read
  //     `Zeus-Browser-Proof.txt`; no shared basename, no pairing, and the read-back verified a
  //     0-byte file at a path the write had never touched.
  //   - It MATCHES unrelated pairs. `...\out\report.txt` and `...\Documents\report.txt` share a
  //     basename, so this silently paired a read-back of one with a write of the other. That is a
  //     false success produced by a string comparison.
  //
  // The pairing is now made by DELIVERABLE ID, below, which the plan declares rather than this
  // function guesses. A read-back whose path names a file no deliverable produced is refused.
  const producedByName = new Map<string, string>()
  // The most recent producing step before each read, so a read with NO path at all still gets
  // one. That case was observed too: the model wrote `read-file` with an empty `path` and the
  // step failed with "no path was given" while the file it wanted was sitting in the output
  // folder, written by the step two positions earlier.
  const lastProducedBefore = new Map<string, string>()
  for (const s of steps) {
    if (s.tool.includes('write-file') || s.tool.includes('spreadsheet')) {
      const p = String(s.args.path ?? '').trim()
      if (p) lastProducedBefore.set(s.id, p)
    }
  }
  let mostRecentProduced = ''
  for (const s of steps) {
    if (s.tool.includes('write-file') || s.tool.includes('spreadsheet')) {
      const p = String(s.args.path ?? '').trim()
      if (p) mostRecentProduced = p
      continue
    }
    if (!s.tool.includes('read-file')) continue
    const p = String(s.args.path ?? '').trim()
    if (p.length === 0) {
      // NOTHING NAMED. This is the one case where recency is not a guess: a read-back with no path
      // at all names no file, so there is nothing for it to be confused with, and the preceding
      // producing step is the only thing that knows what "read it back" refers to. Observed too -
      // a `read-file` with an empty `path` failed with "no path was given" while the file it wanted
      // sat in the output folder, written two steps earlier. It states itself in the transcript.
      if (mostRecentProduced) {
        s.args.path = mostRecentProduced
        inferred.push(
          `step "${s.id}": no path was given for a read-back, so it now reads the file the preceding `
          + `step wrote (${mostRecentProduced}). A read-back with no path cannot verify anything.`,
        )
      }
    }
    // A read-back that DID name a path is left exactly as the plan wrote it. Its pairing is settled
    // by deliverable id below, which either confirms this file is the deliverable, attaches the
    // read-back to a declared deliverable, or refuses. Nothing rewrites it on resemblance.
  }

  // ---- DELIVERABLES: WHAT WAS ASKED FOR, AND WHAT WILL BE PRODUCED FOR IT.
  //
  // A deliverable is created ONCE per producing step, carrying both names - the one the person asked
  // for and the one that will actually be written - plus the content the producing step declared.
  // It is created here, at validation, because this is the last point where the goal and the plan
  // are both in hand and can be compared without guessing.
  //
  // The read-back then refers to the deliverable BY ID. It does not re-derive a relationship from
  // filenames, because that is what failed: a write of `example.com.csv` and a read of
  // `Zeus-Browser-Proof.txt` share no basename, so the pairing was missed and the read-back verified
  // an unrelated 0-byte file. Pairing by recency would have "worked" for that run and been wrong
  // the moment a mission wrote two files, which is why it is not used either.
  const isProducer = (s: PlannedStep) => s.tool.includes('write-file') || s.tool.includes('spreadsheet')
  const isReader = (s: PlannedStep) => s.tool.includes('read-file')

  const deliverables: Deliverable[] = []
  const producedNow: Deliverable[] = []

  steps.forEach((s, index) => {
    if (!isProducer(s)) return
    const resolvedPath = String(s.args.path ?? '').trim()
    if (resolvedPath.length === 0) return

    // What the person asked for. `requestedPath` was set above when a destination was substituted;
    // if it was not set, the person named no destination and the resolved path is simply the plan's.
    const requestedPathRaw = typeof s.args.requestedPath === 'string' ? String(s.args.requestedPath) : null
    const requestedNameRaw = typeof s.args.requestedName === 'string'
      ? String(s.args.requestedName)
      : (requestedPathRaw ? requestedPathRaw.split(/[\\/]/).pop() ?? null : null)

    const content = typeof s.args.content === 'string' ? s.args.content : null
    const rowsArg = s.args.rows
    const fromRows = Array.isArray(rowsArg)
      ? rowsArg.map((r) => (Array.isArray(r) ? r.join(', ') : String(r))).join('\n')
      : null
    const headersArg = s.args.headers
    const fromHeaders = Array.isArray(headersArg) ? headersArg.join(', ') + '\n' : null
    const declaredContent = content
      ?? (fromHeaders !== null || fromRows !== null ? (fromHeaders ?? '') + (fromRows ?? '') : null)

    const substitution: Substitution | null = requestedPathRaw
      ? {
        requested: requestedPathRaw,
        written: resolvedPath,
        reason: 'AIOS\'s own writers are confined to the agent output directory, so a destination '
          + 'outside it cannot be written to. The file was produced there instead, and the '
          + 'destination the person named remains unmet.',
        // Never authorised: nothing in this system asks a person to approve a destination, so
        // claiming otherwise would be a lie in the one field that matters most here.
        authorized: false,
      }
      : null

    const d: Deliverable = {
      // Derived from the producing step's own position, so it is stable within the mission and
      // cannot collide with another deliverable however the plan is renumbered.
      id: `deliverable-${index + 1}`,
      requestedName: requestedNameRaw,
      requestedPath: requestedPathRaw,
      resolvedPath,
      planPath: typeof s.args.planRequestedPath === 'string' ? String(s.args.planRequestedPath) : resolvedPath,
      expectedContent: declaredContent,
      expectedEmpty: content !== null && content.length === 0,
      producingStepId: s.id,
      readBackStepId: null,
      substitution,
    }
    s.args.deliverableId = d.id
    deliverables.push(d)
    producedNow.push(d)
  })

  // Attach each read-back to a deliverable, or refuse it.
  //
  // Three ways this is decided, in order, and NO others:
  //
  //   1. THE PLAN SAID SO. A read-back that names a deliverable id is attached to exactly that one.
  //      This is the only pairing that is a declaration rather than an inference.
  //   2. THE READ-BACK NAMES THE DELIVERABLE'S RESOLVED PATH. That is a claim of identity, not
  //      resemblance: the file it will open is the file that will be written.
  //
  // There is deliberately NO third rule. Pairing because a plan happens to contain one write and one
  // read would be an inference wearing the costume of a rule, and it is wrong in both directions: it
  // silently overrides a read-back that named a DIFFERENT file (observed live - a write of
  // `example.com.csv` and a read of `Zeus-Browser-Proof.txt`), and it would attach a read to
  // whichever write happened to be alone, which is not what anybody asked for. "There is only one
  // candidate" is a statement about the plan, not about the person's intent.
  //
  // A read-back with NO path is a different case and is repaired above, before this point: the
  // preceding producing step is the only thing that knows what "read it back" refers to, and that
  // repair states itself in the transcript.
  //
  // Anything else is REFUSED before execution. A read-back that cannot say which deliverable it
  // proves is a step that will read something, and "something" is exactly what a read-back must not
  // be. Refusing costs a replan; guessing costs a false success, and the second is the failure this
  // whole system exists to prevent.
  for (const s of steps) {
    if (!isReader(s)) continue
    const readPath = String(s.args.path ?? '').trim()

    const namedId = typeof s.args.deliverableId === 'string' ? String(s.args.deliverableId) : null
    let target: Deliverable | null = null

    if (namedId !== null) {
      target = producedNow.find((d) => d.id === namedId) ?? null
      if (target === null) {
        // AN ID THAT WAS NEVER ISSUED IS NOT A WEAKER CLAIM THAN ONE THAT WAS - IT IS A BROKEN ONE.
        //
        // This fell through to the path check below, where a read-back naming `deliverable-99`
        // could still be paired by its path. That is the wrong direction to fail: an unrecognised
        // identity means the plan referred to something that does not exist, and the honest reading
        // of a plan that names a deliverable which does not exist is that the plan is broken.
        const issued = new Set(producedNow.map((d) => d.id))
        refusals.push(
          `step "${s.id}": this read-back refers to deliverable "${namedId}", which this plan never `
          + `created. Issued ids are ${issued.size > 0 ? [...issued].join(', ') : '(none)'}. A read-back `
          + 'pointing at a deliverable that does not exist is refused rather than reinterpreted.',
        )
        continue
      }
    } else {
      // The read-back names the RESOLVED path - the file that will be written. A direct claim of
      // identity, not a resemblance: the two strings are the same path.
      const byResolved = producedNow.filter((d) => d.resolvedPath.toLowerCase() === readPath.toLowerCase())
      if (byResolved.length === 1) {
        target = byResolved[0]
      } else {
        // Or it names the REQUESTED path, and this is the case that matters most.
        //
        // When a destination was substituted, the person's path and the written path differ, and a
        // plan that says "write here, then read it back here" names the requested path twice. That
        // is not a guess about which file it means - both paths name ONE deliverable, and the
        // deliverable already carries the substitution that connects them. The pairing is therefore
        // a declaration, read from the deliverable rather than inferred from a string.
        //
        // It is also the case that would otherwise be refused every time a mission is redirected,
        // which would make the ordinary "write it and read it back" shape unrunnable for any
        // destination outside the output directory.
        const byRequested = producedNow.filter((d) => d.requestedPath !== null
          && d.requestedPath.toLowerCase() === readPath.toLowerCase())
        if (byRequested.length === 1) {
          target = byRequested[0]
        } else {
          // Or it names the path the PLAN gave the producing step, before confinement moved it.
          //
          // "Write the sheet to X, then read X back" is the ordinary shape of a mission, and after
          // confinement the write lands somewhere else while the read-back still says X. Without
          // this rule every such mission would be refused, which would make the read-back
          // reconciliation the original code existed for impossible.
          //
          // It is EXACT EQUALITY between two strings the plan itself produced - not a basename, not
          // a similarity, not "the most recent write". `...\out\report.txt` and `...\Documents\
          // report.txt` share a basename and are still refused above, which is the distinction that
          // matters: this pairs a read with a write that were written next to each other.
          const byPlanPath = producedNow.filter((d) => d.planPath.toLowerCase() === readPath.toLowerCase())
          if (byPlanPath.length === 1) target = byPlanPath[0]
        }
      }
    }

    if (target === null) {
      const known = producedNow.map((d) => `${d.id} (${d.resolvedPath})`).join(', ')
      refusals.push(
        `step "${s.id}": this read-back cannot say which file it is proving. It reads ${readPath || '(no path)'}, `
        + `and the plan wrote ${producedNow.length} file(s): ${known || '(none)'}. A read-back that does not `
        + 'identify its deliverable is refused before anything runs, because verifying an unrelated file '
        + 'is worse than not verifying at all. Name the producing step, or use the same path.',
      )
      continue
    }

    // The identity is now declared, so the path follows from it rather than leading to it.
    if (readPath.length === 0 || readPath.toLowerCase() !== target.resolvedPath.toLowerCase()) {
      inferred.push(
        `step "${s.id}": this read-back is attached to ${target.id}, written by step `
        + `"${target.producingStepId}" to ${target.resolvedPath}, so it reads that file`
        + (readPath.length > 0 ? ` rather than ${readPath}` : '')
        + '. The pairing is by deliverable, not by filename.',
      )
      s.args.path = target.resolvedPath
    }
    s.args.deliverableId = target.id
    s.args.expectedPath = target.resolvedPath
    target.readBackStepId = s.id

    // WHAT THE READ-BACK IS EXPECTED TO FIND, carried from the step that declared it.
    if (target.expectedContent !== null && target.expectedContent.length > 0) {
      s.args.expectChars = target.expectedContent.length
      s.args.expectText = target.expectedContent.slice(0, 200)
    } else if (target.expectedEmpty) {
      // An explicitly empty write is a legitimate empty deliverable, and only the writer can say so.
      s.args.expectEmpty = true
    }
    inferred.push(
      `step "${s.id}": this read-back now declares what it expects to find, because `
      + `${target.producingStepId} was going to write it`
      + (target.expectedEmpty ? ' as an explicitly empty file' : ` (${target.expectedContent?.length ?? 0} characters)`)
      + '. A read-back that expects nothing can only prove that a file exists.',
    )
  }

  // ---- THE REQUESTED INTERACTION MODE IS PART OF THE GOAL.
  //
  // This is the second false success, and it is the same shape as the first: a claim that is true
  // about the STEPS and false about the GOAL.
  //
  // There is no visible-browser capability. What exists is web-research - headless Chrome, a
  // throwaway profile, no window ever appearing - and launch-app plus desktop-input, which drive a
  // REAL window. Both are legitimate. What was missing was any way for the system to know which one
  // the person meant, so a goal saying "open a browser on my screen and read the page" could be
  // completed entirely by web-research: nothing would appear, every step would verify, the objective
  // would be satisfied, and the person would be told it worked having seen nothing happen.
  //
  // So a goal that explicitly asks for visibility may not be satisfied by headless research, and a
  // plan that tries is REFUSED rather than quietly run. Refusal is the point: "I could not show you
  // that" is useful, and a green tick beside an empty screen is not.
  //
  // The signals are deliberately explicit. "On my screen", "let me see", "watch it happen" are
  // unambiguous. "Look at", "check" and "read" are not - they are satisfied by reading a page with
  // nobody watching. Defaulting those to visible would make this refuse ordinary research goals,
  // and a guard that fires on everything is a guard that gets switched off.
  if (interactionMode(goal) === 'visible') {
    const hasVisible = steps.some((s) => VISIBLE_TOOLS.test(s.tool))
    const headlessOnly = steps.length > 0 && steps.every((s) => !VISIBLE_TOOLS.test(s.tool))
    if (!hasVisible && headlessOnly) {
      refusals.push(
        `you asked for something you can SEE, but this plan only uses headless research, which runs `
        + 'a browser with no window and shows the person nothing. A visible mission needs a real '
        + 'window capability - launch-app to open one, desktop-input to use it - and then OCR or '
        + 'survey-window to prove what is on it. Either plan that, or say you are happy with '
        + 'headless research and it will use web-research.',
      )
    }

    // A VISIBLE WINDOW IS NOT THE SAME AS SEEING THE ANSWER.
    //
    // Observed live: a mission asked to "open Chrome on my screen, read the displayed page, and
    // report three factual items about what the page says" planned a real `launch-app` AND a
    // `web-research`, took its three facts from the research brief, and reported success. The
    // window really did open - that part passed. But the person asked what the page SAYS, and the
    // facts came from a headless fetch of a page nobody was shown.
    //
    // Checking only for the presence of a visible capability is therefore too weak: it asks whether
    // a window appeared anywhere in the plan, not whether the ANSWER came from what is on screen. A
    // plan can satisfy the first and fail the second, and did.
    //
    // So when the goal asks to SEE something and asks for facts from it, headless research is
    // refused even alongside a real window. The facts must come from an observation of the visible
    // window - ocr, survey-window, or screen-diff - because that is the only thing which establishes
    // what the person could actually read.
    const wantsFactsFromScreen = /\b(says?|reads?|shows?|displays?|states?|contains?|lists?)\b/i.test(String(goal ?? ''))
    if (hasVisible && wantsFactsFromScreen) {
      const sourced = steps.some((s) => OBSERVING_TOOLS.test(s.tool))
      const headlessFacts = steps.filter((s) => HEADLESS_RESEARCH_TOOLS.test(s.tool))
      if (headlessFacts.length > 0 && !sourced) {
        refusals.push(
          `you asked what ${REPORTING_VERB_FROM_GOAL(goal)} and asked to see it happen, but this plan `
          + `takes its facts from headless research (${headlessFacts.map((s) => s.tool).join(', ')}). `
          + 'Opening a window and reading the answer from somewhere else are different things: the '
          + 'research fetches a page nobody was shown, so the answer is not one the person could have '
          + 'read off the screen. Read the visible window with ocr or survey-window instead, and '
          + 'report what it actually displays.',
        )
      }
    }
  }

  // ---- THE MISSION-LEVEL ARTIFACT CONTRACT.
  //
  // Everything above reasons about ONE STEP AT A TIME. That is what let the real failure through:
  // the write step was individually reasonable, the goal was individually reasonable, and the
  // mission as a whole still destroyed a finished 407-row inventory by writing Python source to
  // its path. No single step was wrong; the PLAN was.
  //
  // So the whole validated plan is handed to one contract builder that answers the questions only
  // the whole plan can answer: which file is the deliverable, which step produces it, do two steps
  // want the same destination, and does anything refer to a file nobody creates.
  //
  // `inferReadPath(goal)` is the destination the PERSON named, carried through so the record can
  // distinguish "the file you asked for" from "the file the plan settled on".
  const artifactContract = buildArtifactContract(
    steps.map((s) => ({ id: s.id, intent: s.intent, tool: s.tool, args: s.args })),
    inferReadPath(goal),
  )
  refusals.push(...artifactContract.refusals)

  // The contract is registered against the MISSION, so `terminal` can reach it without the model
  // ever putting it in a tool argument - a contract passed through `args` would be a contract the
  // model wrote, which is no contract at all. See artifacts.ts for why this is keyed by mission id
  // rather than held as a single global.
  //
  // `missionId` is optional so that `validatePlan` stays callable as a pure function by the test
  // suite. Without one there is simply nothing to register against, and `terminal` correctly
  // refuses anything that can write.
  if (missionId) registerContract(missionId, artifactContract)

  // CONTENT OF THE WRONG KIND FOR THE DESTINATION IT IS ABOUT TO OCCUPY.
  //
  // This is the check that would have stopped the overwrite as it happened rather than afterwards.
  // A `.csv` deliverable cannot be produced by a Python program, and a refusal at this point costs
  // one step - whereas the same mistake discovered later costs a deliverable that may be the only
  // copy of real work.
  for (const s of steps) {
    if (!s.tool.includes('write-file') && !s.tool.includes('spreadsheet')) continue
    const content = typeof s.args.content === 'string' ? s.args.content : null
    if (content === null) continue
    const target = String(s.args.path ?? '')
    if (target.length === 0) continue
    const wrong = contentLooksWrongFor(target, content)
    if (wrong) refusals.push(`step "${s.id}": ${wrong}`)
  }

  // Returned separately rather than folded into `refusals`, which is the wrong channel: the
  // caller renders every refusal as "Refused: ...", and an argument the system recovered and
  // stated plainly is the opposite of a refusal. These are notes for the user, and they get
  // their own line.
  return { steps, refusals, inferred, substitutions, deliverables, artifactContract }
}

// ===========================================================================================
// the loop
// ===========================================================================================

/** The postcondition kinds this loop derives, before the executor's own union widens it. */
type DerivedPostcondition =
  | { kind: 'artifact-exists'; path: string }
  | { kind: 'artifact-read-back'; path: string }
  | { kind: 'window-shows-text'; text: string }

function toMission(missionId: string, goal: string, steps: PlannedStep[]): Mission {
  const now = Date.now()
  const compiled: Step[] = steps.map((s, i) => ({
    id: s.id,
    intent: s.intent,
    mode: resolveCapability(s.tool) && 'tool' in (resolveCapability(s.tool) as Capability)
      ? ((resolveCapability(s.tool) as Capability).tool.mode as Step['mode'])
      : 'cli',
    tool: s.tool,
    args: s.args,
    dependsOn: i === 0 ? [] : [steps[i - 1].id],
    capability: s.tool,
    rationale: s.intent,
  }))

  // What would make this mission a SUCCESS, declared before it runs.
  //
  // Without this the mission carried no objective postcondition at all, and the executor
  // returns `unproven` for a plan that declares none - "an empty list is an absent claim, not
  // a satisfied one". The visible result was a mission that had done everything correctly:
  // seven of seven steps independently verified, the file on disk with exactly the right
  // sentence - and still `mission ok: false`, because the objective had nothing to be measured
  // against. A verdict that cannot ever be anything but "unproven" is not a verdict.
  //
  // So the postcondition is DERIVED from the plan rather than asked of the model. A step that
  // reads a file back is stating that the file's existence and readability is what the goal
  // turns on; that is exactly `artifact-exists` plus `artifact-read-back`, and both are
  // satisfied by the `file-read-back` evidence that verifier emits.
  //
  // Derived, not requested, because a model asked to name the postcondition can name one that
  // is trivially true, and the whole value of this is that it is not trivially satisfiable.
  const readBackPaths = steps
    .filter((s) => s.tool.includes('read-file'))
    .map((s) => String(s.args?.path ?? '').trim())
    .filter((p) => p.length > 0)
  const objectivePostconditions: DerivedPostcondition[] = readBackPaths.flatMap((p) => [
    { kind: 'artifact-exists' as const, path: p },
    { kind: 'artifact-read-back' as const, path: p },
  ])

  // A web-research step leaves a BRIEF on disk. That brief is an artifact, and it is the real
  // deliverable of a research mission - so its existence and readability are the objective, the
  // same claim made for a read-file step. Without this, a mission that researched three pages and
  // wrote a brief was graded `unproven` because no step read a file path the executor happened to
  // know about.
  for (const s of steps) {
    if (!s.tool.includes('web-research')) continue
    const p = String(s.args?.path ?? '').trim()
    if (p) {
      objectivePostconditions.push({ kind: 'artifact-exists', path: p })
      objectivePostconditions.push({ kind: 'artifact-read-back', path: p })
    }
  }

  // ...and a BROWSER step declares what it is showing, not merely that it opened.
  for (const s of steps) {
    if (!s.tool.includes('launch-app')) continue
    const url = String(s.args?.url ?? '').trim()
    if (!url) continue
    const q = /[?&]q=([^&]+)/i.exec(url)
    const term = q ? decodeURIComponent(q[1].replace(/\+/g, ' ')).trim() : ''
    // WHAT TEXT IS ACTUALLY CLAIMED TO BE ON THE SCREEN.
    //
    // A search query, when there is one: searching for "data protection companies" should put
    // those words on the screen, and that is a claim about the page rather than about the plan.
    //
    // Failing that, the URL's OWN HOST. Not the step's intent, which was what this used: the
    // intent is the PLAN's prose ("Open a visible browser window and navigate to ..."), and a
    // postcondition is checked with `screenText.includes(pc.text)`. Prose describing the task is
    // not printed on the page, so for every plain URL - anything without a `q=` - the claim was
    // unsatisfiable by construction. Observed live: the mission opened Chrome on example.com, both
    // steps verified, the objective was still `unmet`, and the loop spent a second attempt
    // re-launching a browser that was already showing the right page.
    //
    // The host is the right claim because it is both derivable and observable: the address bar
    // renders it, and the page title almost always contains it. `window-identity` refuses a
    // browser window as someone else's document on exactly this kind of title.
    const host = (() => {
      try { return new URL(url).hostname } catch { return '' }
    })()
    const claim = term.length > 0 ? term : host
    // A URL that yields neither a query nor a parseable host states nothing checkable. Declaring a
    // postcondition that cannot be evaluated is worse than declaring none: it converts a completed
    // mission into "unproven" forever, which is the opposite of what the field is for.
    if (claim.length > 0) {
      objectivePostconditions.push({
        kind: 'window-shows-text',
        text: claim,
      })
    }
  }

  // ...and a producing step (write-file, spreadsheet) declares the artifact it writes. The path
  // may have been supplied by the system rather than the model, which is fine - the claim is that
  // the file is there after the step, and the verifier reads it back independently.
  for (const s of steps) {
    if (!s.tool.includes('write-file') && !s.tool.includes('spreadsheet')) continue
    const p = String(s.args?.path ?? '').trim()
    if (p) {
      objectivePostconditions.push({ kind: 'artifact-exists', path: p })
      objectivePostconditions.push({ kind: 'artifact-read-back', path: p })
    }
  }

  return {
    id: missionId,
    objective: goal,
    constraints: [],
    state: 'running' as MissionState,
    plan: compiled,
    history: [],
    pendingApprovals: [],
    startedAt: now,
    // Left undefined when the plan reads nothing back: an empty array is graded `unproven`
    // anyway, and naming no postcondition is more honest than naming zero.
    ...(objectivePostconditions.length > 0 ? { objectivePostconditions } : {}),
  } as Mission
}

/**
 * The mission compiler, exposed for tests.
 *
 * Exported because the objective postcondition is a CLAIM, and a claim that cannot be inspected
 * is a claim nobody can check. The destination-honesty tests read the postconditions directly to
 * establish that they prove what the system actually wrote - which is precisely what makes the
 * substitution, rather than the postcondition, the thing that has to fail the mission.
 */
export function toMissionForTest(missionId: string, goal: string, steps: PlannedStep[]): Mission {
  return toMission(missionId, goal, steps)
}

/**
 * One line for a show-goal that worked.
 *
 * Says what the person can go and look at, and nothing else. The evidence chain is not restated
 * here because it is not restated anywhere they have to read it twice - it is in the step list
 * above and in the mission record. Printing the whole proof apparatus underneath a window the
 * person is already looking at is the noise this exists to remove.
 *
 * `ok` is already true by the time this is called. There is no branch here that produces a
 * reassuring sentence about work that did not succeed.
 */
function describeShowGoalSucceeded(
  steps: ReadonlyArray<{ tool: string }>,
  title: string,
): string {
  const opened = steps.some((s) => String(s.tool ?? '').includes('launch-app'))
  if (opened && title) {
    return `Done - "${title}" is open and showing what you asked for. The evidence chain is in the steps above.`
  }
  return `Done - ${steps.length} step(s) completed and verified.`
}

/**
 * How many plans one goal may get.
 *
 * Two, deliberately, and not as a tuning knob but as a statement about what this loop is. One
 * replan is enough to fix the failure this loop exists for - a step that promised data instead of
 * producing it, and a second pass through the model with the real research in front of it either
 * fixes that or does not. A third pass would be a model arguing with itself, at the user's expense
 * and at real latency, for no evidence that the answer changes.
 *
 * An unbounded loop is not autonomy. It is a hang with extra steps, and the user watching it is
 * the one paying for it.
 */
const MAX_PLAN_ATTEMPTS = 2

/**
 * Run one goal end to end.
 *
 * Everything the user would need to diagnose a failure is emitted as it happens, because the
 * alternative - a silent run that reports success or a bare error - is the failure mode this
 * whole project is built against.
 */
export async function runGoal(goal: string, emit: Emit, opts?: InterpretOptions): Promise<GoalResult> {
  ensureAgentDirs()
  const missionId = randomUUID()
  const trimmed = goal.trim()
  if (!trimmed) {
    emit({ kind: 'error', text: 'The goal was empty.' })
    return { ok: false, missionId, goal, reply: '', steps: [], error: 'empty goal', refusals: [] }
  }

  try {
    emit({ kind: 'status', text: `Mission ${missionId.slice(0, 8)}: reading capabilities...` })

    // The model is chosen per mission. It is re-checked against the free-only rule HERE as well
    // as at the route, because this is the layer that actually spawns the model process - a check
    // that exists only in the HTTP layer would be a check a future non-HTTP caller could skip,
    // and the thing being enforced is money.
    // ---- THE CLOSED LOOP.
    //
    // Declared OUTSIDE the attempt loop because the report below is written from the LAST attempt.
    // A loop whose body's results died with the body would report the first attempt while the
    // transcript showed the second - the same class of bug this project keeps hitting: reporting on
    // one thing while displaying another.
    let plan: InterpretedPlan
    let validated: ValidatedPlan
    let execResult: Awaited<ReturnType<typeof execute>>

    /** Every substitution the validation made, across every attempt. */
    let destinationNotHonoured: Substitution[] = []
    let events: readonly ExecutionEvent[] = []
    let complete = false
    let stepsOut = new Map<string, { id: string; intent: string; tool: string; verified: boolean; summary: string }>()
    let stepsOutList: Array<{ id: string; intent: string; tool: string; verified: boolean; summary: string }> = []
    let allStepsVerified = false
    let verdict: { kind: string; reason?: string } | undefined
    let objectiveKind = 'unproven'
    let objectiveReason = 'the executor returned no objective verdict'
    /** True when something this run produced is a promise rather than a deliverable. */
    let placeholderFound = false
    let placeholderNote = ''
    let replanFeedback: string | undefined
    /** Every step from EVERY attempt, in order. This is what the mission record keeps. */
    let allStepsOut: Array<{ id: string; intent: string; tool: string; verified: boolean; summary: string }> = []
    let attemptsUsed = 1

    for (let attempt = 1; ; attempt++) {
    // Reset per attempt, deliberately.
    //
    // These two are the verdict on the attempt that is CURRENTLY running, not a running tally.
    // Accumulating them across attempts is the more obvious implementation and it is wrong in a
    // way that would never be noticed: the first attempt holds back a placeholder step, sets the
    // flag, replans, and the second attempt writes a perfect spreadsheet - and the mission would
    // still report failure, naming a defect in the file the user is holding. The flag describes
    // what is on disk now, and what is on disk now is what gets judged.
    placeholderFound = false
    placeholderNote = ''
    attemptsUsed = attempt

    // The model is chosen per mission. It is re-checked against the free-only rule HERE as well as
    // at the route, because this is the layer that actually spawns the model process - a check that
    // exists only in the HTTP layer would be a check a future non-HTTP caller could skip, and the
    // thing being enforced is money.
    //
    // `feedback` is what makes a second attempt different from the first: it carries the previous
    // attempt's real outcomes AND the content those outcomes produced. Without the content the
    // model re-plans from the same empty context and writes the same promise.
    plan = await interpret(trimmed, emit, { model: opts?.model, feedback: replanFeedback })
    validated = validatePlan(plan, trimmed, missionId)
    for (const r of validated.refusals) emit({ kind: 'error', text: `Refused: ${r}` })
    for (const n of validated.inferred) emit({ kind: 'status', text: `Filled in a gap: ${n}` })
    // A destination the PERSON named and that was not honoured. Carried out of validation so the
    // verdict below can see it, and named to the reader, because a goal that says "in Documents"
    // and receives a file elsewhere has not been met however well every step verified.
    destinationNotHonoured = validated.substitutions.filter(
      (x) => x.requested.toLowerCase() !== x.written.toLowerCase(),
    )
    for (const sub of destinationNotHonoured) {
      emit({
        kind: 'status',
        text: `Destination not honoured: you asked for ${sub.requested}, and ${sub.written} was written. `
          + 'The work is real and the file is readable, but it is not where you said it should be, '
          + 'and this mission will not be reported as satisfied.',
      })
    }

    if (validated.steps.length === 0) {
      // No steps means the model answered rather than planned. Say what it said.
      const said = plan.reply.trim() || 'I did not understand that as a task I can carry out. Try describing what you want done, for example "list the windows open on this desktop".'
      // A conversational reply - including one produced without calling a model - is a completed
      // turn, not a failed mission. Reporting it as `ok:false` made "Hi" look like a failure in
      // the transcript and in every log that consumes the done event, when it was in fact the
      // correct and complete answer to a conversational message.
      const conversational = plan.model === 'none (conversational)'

      // A MODEL'S PROSE IS NOT A REPORT OF WHAT HAPPENED.
      //
      // Observed on 2026-10-19, mission 4d2dd1be. The goal was the NAKIVO inventory. A previous
      // attempt had genuinely written the CSV, this attempt proposed no steps at all, and the
      // model's reply was passed straight through as the final message:
      //
      //   "The NAKIVO folder has been opened visibly in File Explorer ... all 407 files have been
      //    scanned recursively ... The CSV was read back and verified - all 408 lines are intact."
      //
      // Nothing in THIS mission opened a window, scanned a file, or read a CSV back. Zero steps
      // ran. The text was written into `conversations.jsonl` as an assistant turn and shown to
      // the person as the outcome of their request.
      //
      // This is the exact failure this system exists to prevent, and it was worse than the
      // original `fetch failed`: that one reported an error, and this one reported success. It
      // survived every guard downstream because the verdict gate only ever saw the honest
      // `done` at the end of a step run - this text never passed through it.
      //
      // So a reply produced by a MODEL on a mission that executed nothing is shown as what it
      // is - an unverified statement - and never as a completion report. The honest outcome of
      // running zero steps is that nothing was done, and that is what is reported.
      const modelClaimedWork = !conversational && said.length > 0
      const finalText = modelClaimedWork
        ? 'AIOS did not carry this out. No executable step could be produced for this goal, so '
          + 'nothing was opened, scanned, written or verified by this mission - the CSV at '
          + `${AGENT_OUT} is from an EARLIER attempt, not from this one.` + '\n\n'
          + `What the model replied, unverified and NOT a report of work performed:\n"${said}"`
        : said

      emit({ kind: 'done', ok: conversational, text: finalText })
      appendConversation({ role: 'assistant', text: finalText, at: Date.now(), missionId, ok: conversational })
      saveMission({ missionId, goal: trimmed, ok: false, at: Date.now(), steps: [], error: 'no executable steps were proposed' })
      return { ok: false, missionId, goal: trimmed, reply: finalText, steps: [], error: 'no executable steps were proposed', refusals: validated.refusals }
    }

    // Step ids are namespaced per attempt so the transcript cannot show two steps called `s1`
      // with different results. Nothing downstream depends on the id being bare - dependencies are
      // expressed in the plan text and resolved before here - and a display key that can collide
      // makes the record lie about which step is which.
      if (attempt > 1) {
        for (const s of validated.steps) s.id = `a${attempt}-${s.id}`
      }

      // ---- THE PROMISE GATE.
      //
      // A step that writes "To be populated from the research results" has not written a
      // deliverable, and running it produces an empty file while every existing check passes -
      // because all of them ask whether the file EXISTS, whether it is rectangular, and whether it
      // reads back identically. None of them asks whether it contains anything. That is exactly how
      // a mission reports `ok=true` and ships a blank table.
      //
      // So on any attempt but the last, a step whose content announces its own emptiness is not
      // run. The research it was waiting for still runs, in the same plan, and the next attempt is
      // planned with that research in hand. This is the mechanism: the model writes the sheet before
      // the research exists, so the sheet is held back until after.
      //
      // The last attempt is EXEMPT on purpose. If the loop is exhausted, withholding the step would
      // guarantee the user gets nothing at all - and "here is the empty file, and here is exactly
      // why it is empty" is a more useful outcome than silence.
      if (attempt < MAX_PLAN_ATTEMPTS) {
        const kept: PlannedStep[] = []
        const promised: string[] = []
        for (const s of validated.steps) {
          const hits = placeholderInArgs(s.args ?? {})
          if (hits.length > 0) {
            promised.push(`${s.id} ("${hits[0]}")`)
            continue
          }
          kept.push(s)
        }
        // Only narrowed when something survives. A plan that is entirely promise has nothing to
        // fall back on, and running it beats executing zero steps.
        if (promised.length > 0 && kept.length > 0) {
          placeholderFound = true
          validated.steps = kept
          emit({
            kind: 'status',
            text: `Holding back ${promised.length} step(s) that promise data instead of containing it: `
              + `${promised.join(', ')}. They cannot be filled in yet - a plan writes their content `
              + 'before the research they need has run. The rest of the plan runs now, and they are '
              + 'replanned against what it finds.',
          })
        }
      }

      emit({ kind: 'plan', steps: validated.steps.map((s) => ({ id: s.id, intent: s.intent, tool: s.tool })) })

    // Permission is read LIVE here, but a plan that needs injection is NOT refused. It used to be,
    // and that made the capability unreachable: input is blocked whenever a human is at the
    // machine, which is exactly when the goal is typed, so every such mission died here with
    // "approval needed" and the user was asked to authorise something that had already been
    // decided. The gate protected nothing - the injection endpoint re-consults the guard at the
    // instant of the event, and desktop-input re-reads it too - while making the only action that
    // needs human cooperation impossible to ask for.
    //
    // So the guard's state is reported, the human is told exactly what to do, and the step waits.
    const perm = await livePermission()
    const needsInjection = validated.steps.some((s) => {
      const r = resolveCapability(s.tool)
      return !('unavailable' in r) && (r as Capability).tool.mode === 'gui'
    })
    if (needsInjection && perm.input !== 'PERMITTED') {
      const because = perm.blockedBy ? ` (${perm.blockedBy})` : ''
      emit({
        kind: 'status',
        text: `This task needs desktop input and the guard reports ${perm.input}${because}. `
          + `It will WAIT. Click RELEASE once, then leave the machine alone - do not move the mouse `
          + `or type, because either one is itself a takeover and will cancel this. Watch it work; `
          + `to stop it, simply touch the machine.`,
      })
    }

    stepsOut = new Map()
    const mission = toMission(missionId, trimmed, validated.steps)
    // Say what success will be MEASURED against, before running.
    //
    // The objective verdict is separate from the per-step verdicts and is stricter than all of
    // them, so a reader who cannot see the postcondition has no way to understand why a mission
    // that verified every step can still report "unproven". Stating the bar up front is also
    // the honest ordering: the claim is declared first and checked afterwards, never invented
    // once the outcome is already known.
    const pcs = (mission as unknown as { objectivePostconditions?: DerivedPostcondition[] })
      .objectivePostconditions
    if (pcs && pcs.length > 0) {
      emit({
        kind: 'status',
        text: `Success will be measured by ${pcs.length} objective postcondition(s): `
          + pcs.map((p) => `${p.kind}${'path' in p ? ` ${p.path}` : ''}`).join('; '),
      })
    } else {
      emit({
        kind: 'status',
        text: 'This plan declares no objective postcondition, so the goal itself cannot be proven '
          + 'even if every step is. Step results will still be reported.',
      })
    }
    // execute() returns `{ mission, record, events }` - the completion flag and the objective
    // verdict live on `record`, not on the result itself. Reading them off the top level
    // yielded `undefined` for every one of them, which is why this reported:
    //
    //   - "objective verdict: unproven" on missions that had declared postconditions AND
    //     collected matching evidence, because `result.objective` did not exist;
    //   - `mission ok: false` on missions where every step verified, because
    //     `result.complete === true` was never true - it was `undefined === true`;
    //   - "Evidence the grader actually saw from 0 step(s)" even on a seven-step mission,
    //     because `result.verified` was not there either.
    //
    // Three fields, all undefined, all silently defaulting to the pessimistic answer. The
    // system looked like it was refusing to claim success; it was reading the wrong object.
    execResult = await execute(mission, {
      tools: routedTools() as never,
      verifier: routedVerifier(),
      control: liveControl,
      config: {
        maxAttempts: 1,
        permission: async () => (await livePermission()),
        emergencyStop: async () => false,
        now: () => Date.now(),
      },
    } as never)

    // The record carries the events the UI needs; the top-level list is the fallback for a
    // caller that gets a bare event array. `??` rather than `||` so an empty record is still
    // preferred over an absent one.
    events = execResult.record?.events ?? execResult.events ?? []
    complete = execResult.record?.complete === true

    // Report what the executor ACTUALLY did, from its event log - not what we assumed would
    // happen. The first version of this read `result.history`, which does not exist, so every
    // step came back "not reported" and the UI showed two failures for a mission that had run.
    // Deriving the outcome from the event stream is the only way the displayed result can be
    // the real one.
    const forStep = (id: string): readonly ExecutionEvent[] => events.filter((e) => e.stepId === id)

    for (const s of validated.steps) {
      const evs = forStep(s.id)
      const started = evs.find((e) => e.type === 'step-started')
      if (started) {
        emit({
          kind: 'step-start',
          stepId: s.id,
          intent: String(started.intent ?? s.intent),
          tool: String(started.tool ?? s.tool),
          attempt: Number(started.attempt ?? 1),
        })
      }

      // The executor emits `evidence-verified` for BOTH verdicts, distinguishing them with `accepted`:
// it is true when a verifier satisfied the step and false when one REJECTED it, with the refusal
// in `reason`. Matching on the type alone therefore reported every rejected step to the user as
// verified, while the dependency gate - which reads the step's real outcome - correctly skipped
// everything downstream. A real mission displayed as
      //
      //     s1  verified - exact match on terminal
      //     s2  NOT VERIFIED - "s1" ended as failed, which does not satisfy a dependency
      //
      // which is self-contradictory on its face and sent the reader looking for a planner fault rather
      // than a reporting fault. Two lines, one word: the flag the executor already sets.
      const verifiedEvent = evs.find((e) => e.type === 'evidence-verified' && e.accepted === true)
      const refusal = evs.find((e) => e.type === 'step-refused' || e.type === 'retry-exhausted' || e.type === 'execution-halted' || e.type === 'human-required')
      const toolEvent = evs.filter((e) => e.type === 'tool-returned').pop()
      // A rejection is a refusal to claim success, not a success. It wins over the presence of an
      // evidence event, because `accepted: false` IS that event.
      const rejected = evs.find((e) => e.type === 'evidence-verified' && e.accepted === false)
      const verified = Boolean(verifiedEvent) && !refusal && !rejected

      // Collect EVERY reason the executor gave, so a failure names its cause instead of its
      // category. "retry-exhausted" tells the user nothing they can act on; the tool's own
      // refusal reason tells them exactly what went wrong.
      const reasons: string[] = []
      for (const e of evs) {
        for (const key of ['reason', 'detail', 'error', 'summary'] as const) {
          const v = (e as unknown as Record<string, unknown>)[key]
          if (typeof v === 'string' && v.trim().length > 0 && !reasons.includes(v.trim())) reasons.push(v.trim())
        }
        const res = (e as unknown as { result?: { reason?: unknown } }).result
        if (res?.reason && typeof res.reason === 'string' && !reasons.includes(res.reason)) reasons.push(res.reason)
      }

      let summary: string
      if (verified) summary = reasons[0] ?? 'independently verified'
      else if (reasons.length > 0) summary = reasons.slice(0, 3).join(' | ').slice(0, 400)
      else summary = 'the step ran but produced no recorded outcome'

      stepsOut.set(s.id, { id: s.id, intent: started ? String(started.intent) : s.intent, tool: s.tool, verified, summary })
      emit({
        kind: 'step-result',
        stepId: s.id,
        summary,
        verified,
        detail: verified ? 'independently verified by a re-read' : 'NOT verified',
      })
    }

    stepsOutList = validated.steps.map((s) => stepsOut.get(s.id)).filter(Boolean)
    allStepsVerified = stepsOutList.length > 0 && stepsOutList.every((s) => s.verified)
    // Accumulate rather than replace, so the record shows the whole recovery and not just its
    // result. Step ids are already namespaced per attempt (`a2-`), so the two halves cannot be
    // mistaken for one another.
    allStepsOut = [...allStepsOut, ...stepsOutList]

    // The executor's OBJECTIVE verdict is a separate judgement from the per-step verdicts, and
    // it is deliberately stricter. With no objective postcondition declared it returns
    // `unproven` - "an empty list is an absent claim, not a satisfied one". Collapsing that
    // into a green tick would throw away the single most useful property this system has: five
    // verified steps still do not prove the user got what they asked for. Both verdicts are
    // reported, separately and unflattened.
    verdict = execResult.record?.objective
    objectiveKind = String(verdict?.kind ?? 'unproven')
    objectiveReason = String(verdict?.reason ?? 'the executor returned no objective verdict')

    // ---- WHAT ACTUALLY LANDED ON DISK.
    //
    // The promise gate above can only see what the MODEL proposed. This sees what reached the disk,
    // which is the only thing the user will ever receive, and it is the check that was missing when
    // a mission reported `ok=true` beside a file reading "To be populated from the research results".
    //
    // It runs on every attempt, including the last, because on the last attempt there is no retry
    // to save: the finding still has to reach the person, or the same green report ships an empty
    // file and nobody is told why.
    const producedPaths = validated.steps
      .filter((s) => s.tool.includes('write-file') || s.tool.includes('spreadsheet'))
      .map((s) => String(s.args?.path ?? '').trim())
      .filter((p) => p.length > 0)
    const emptyArtifacts = producedPaths
      .map((p) => assessArtifactSubstance(p))
      .filter((v) => v !== null && v.ratio >= PLACEHOLDER_RATIO_LIMIT)

    if (emptyArtifacts.length > 0) {
      placeholderFound = true
      placeholderNote = emptyArtifacts
        .map((v) => `${v.path} is ${Math.round(v.ratio * 100)}% promise rather than data`
          + (v.sample ? ` (e.g. ${JSON.stringify(v.sample.slice(0, 80))})` : ''))
        .join('; ')
      emit({
        kind: 'status',
        text: `Checked what was actually written: ${placeholderNote}. The file exists and reads back `
          + 'correctly - every structural check passed - but it does not contain the answer. That is '
          + 'reported as the failure it is.',
      })
    }

    // ---- SHOULD THERE BE A SECOND ATTEMPT?
    //
    // Everything this branch needs is now on the table: what each step really did, what the
    // verifier said, whether the objective was met, and whether anything on disk is a promise.
    const outcomes = stepsOutList.map((s) => ({
      id: s.id,
      tool: String(s.tool ?? ''),
      intent: String(s.intent ?? ''),
      verified: s.verified === true,
      summary: String(s.summary ?? ''),
    }))

    const retry = shouldReplan({
      attempt: attempt - 1,
      maxAttempts: MAX_PLAN_ATTEMPTS,
      stepsExecuted: stepsOutList.length,
      allStepsVerified,
      objectiveSatisfied: objectiveKind === 'satisfied',
      placeholderFound,
    })
    if (!retry) break

    // The content earlier steps produced, handed to the model verbatim. This is the whole point:
    // an outcome list tells the model research happened; the research itself tells it what to
    // write. Briefs are the only files worth reading back in full - a spreadsheet the model already
    // wrote has nothing new to teach it.
    const evidencePaths = events
      .filter((e) => typeof (e as unknown as { tool?: unknown }).tool === 'string'
        && String((e as unknown as { tool?: string }).tool).includes('web-research'))
      .map((e) => {
        const data = (e as unknown as { result?: { data?: { briefPath?: string } } }).result
        return data?.data?.briefPath ?? ''
      })
      .filter((p: string) => p.length > 0)

    replanFeedback = buildReplanFeedback({
      goal: trimmed,
      attempt,
      steps: outcomes,
      objectiveKind,
      objectiveReason,
      evidencePaths,
      reason: placeholderFound
        ? (placeholderNote !== '' ? placeholderNote : 'a produced file contained a promise instead of data')
        : `the objective was ${objectiveKind} and ${stepsOutList.length - stepsOutList.filter((s) => s.verified).length} step(s) did not verify`,
    })
    emit({
      kind: 'status',
      text: `Attempt ${attempt} did not deliver the goal, so AIOS is planning again with what actually `
        + `happened - including ${evidencePaths.length > 0 ? 'the content the research produced' : 'the step outcomes'}. `
        + 'Steps that already verified are not repeated.',
    })
    }

    // When the objective is NOT satisfied, name the evidence that was actually collected.
    //
    // "Objective verdict: unproven" with nothing else is a dead end for whoever has to fix it:
    // it does not say whether the postcondition failed, or whether the evidence simply never
    // reached the grader in a form it could match. Those are completely different faults with
    // completely different fixes, and the report was indistinguishable between them.
    const verifiedEvidence = (execResult.record?.verified ?? {}) as Record<string, { kind?: string; path?: string }>
    if (objectiveKind !== 'satisfied') {
      const seen = Object.entries(verifiedEvidence)
        .map(([id, e]) => `${id}=${e?.kind ?? '(none)'}${e?.path ? ` ${e.path}` : ''}`)
      emit({
        kind: 'status',
        text: `Objective not satisfied (${objectiveKind}). Evidence the grader actually saw from `
          + `${seen.length} step(s): ${seen.length ? seen.join(', ') : '(none)'}. `
          + `An objective can only be satisfied by evidence that matches the declared postconditions, `
          + `so if the postcondition names a file and the evidence above does not, that mismatch is the fault.`,
      })
    }

    // `ok` is false when what came back is a promise, even if every step verified and the executor
    // called the objective satisfied.
    //
    // This is the most important line changed by the closed loop. Every structural check - does the
    // file exist, is it rectangular, does it read back byte-identically, does the sheet have the
    // right number of columns - PASSES on a file whose only content is "To be populated from the
    // research results". So a mission that produced nothing at all reported:
    //
    //     Completed 3 step(s); every step and the objective were independently verified.
    //
    // ok=true beside a blank table is worse than ok=false beside real work, because it is BELIEVED.
    // A user who sees ok=true does not open the file. So the verdict now includes the one question
    // none of the structural checks asks: does it actually contain the answer?
    //
    // And it includes the destination: a goal naming a place is not met by a file elsewhere, no
    // matter how well every step verified. That is the other false success, and it is the one that
    // shipped a success for a file that does not exist where the person said it would.
    const ok = allStepsVerified && complete && !placeholderFound && destinationNotHonoured.length === 0
    // The failure summary reported the number of steps that FAILED, labelled "verified".
    //
    // A mission in which every single step failed printed "7 of 7 step(s) verified." The
    // numerator was `steps.filter(not verified).length` - the failure count - sitting behind the
    // word "verified". It is the worst possible direction for a reporting bug: the worse the
    // run, the the more complete the success looks, and a reader has no way to notice without
    // re-deriving the number from the step list.
    //
    // The count is now built from the steps that PASSED and stated as a count of passes, with
    // the failures named separately. "7 of 7 verified" now means seven steps passed, and only
    // seven steps passing can produce it.
    const verifiedCount = stepsOutList.filter((s) => s.verified).length
    const failedCount = stepsOutList.length - verifiedCount
  // When every step succeeded but the objective is "unproven", the reason is nearly always that the
  // plan announced no artifact to verify. OCR, window surveys and screen-diffs are observations,
  // not artifacts, so their verifiers return `observation` evidence that no postcondition names.
  //
  // The user-facing wording matters here: "0 of 7 step(s) verified" means the work failed, and
  // "steps being verified is not the same as the goal being achieved" for a mission that

  // inspected a window pure readings does not convey "the instruments saw everything they were
  // asked to see". The first version of this line printed the same refusal-shaped message for
  // both cases, so a mission that could not fail had to be reported as one. That is the kind
  // of honesty that reaches nobody.
  // When every step succeeded but the objective is "unproven", the reason is nearly always that the
  // plan announced no artifact to verify. OCR, window surveys and screen-diffs are observations,
  // not artifacts, so their verifiers return `observation` evidence that no postcondition names.
  //
  // The user-facing wording matters here: "0 of 7 step(s) verified" means the work failed, and
  // "steps being verified is not the same as the goal being achieved" for a mission that

  // inspected a window or read a screen does not convey "the instruments saw everything they were
  // asked to see". The earlier version of this line printed the same refusal-shaped message for
  // both cases, so a mission that could not fail had to be reported as one.
  const observationOnly = objectiveKind === 'unproven'
    && stepsOutList.length > 0
    && stepsOutList.every((s) => s.verified)

  // HOW LOUD, decided by what the goal asked for.
  //
  // A goal that produces a window has no artifact, so everything said about it is an instrument
  // observation. Rendering the whole proof apparatus for such a goal produced the experience the
  // user reported: a browser open on exactly the right page, every step green, and a paragraph
  // explaining that no objective claim existed - ending in "not achieved" for work that was
  // plainly done and plainly visible to them.
  //
  // The person said "quiet for show-goals, full audit for file-goals", and that is what this
  // does. NOTHING ELSE CHANGES: a show-goal still gets its OCR read-back, still gets `ok`
  // computed the same way, still appears in the mission record with the same evidence. Only the
  // number of words differs. If it is ever tempting to use `quiet` to soften a failure, that is
  // the bug - so quiet output is only ever produced on success.
  const quiet = wantsQuietReport(trimmed)
  // The window the person can go and look at, so a quiet success can name it instead of
  // describing a proof. Read fresh rather than taken from a step summary: this is a description
  // of what is on their screen right now, which is exactly the thing a stale record gets wrong.
  let liveTitle = ''
  try {
    const wins = await liveControl.observe().then((o) => o.windows).catch(() => [])
    const launched = stepsOutList.filter((s) => String(s.tool ?? '').includes('launch-app'))
    const lastLaunch = launched[launched.length - 1]
    const hwnd = Number((lastLaunch as unknown as { hwnd?: number } | undefined)?.hwnd ?? 0)
    const found = hwnd > 0 ? wins.find((w) => w.hwnd === hwnd) : undefined
    liveTitle = String(found?.title ?? '').trim()
  } catch { /* a title is a nicety, never a reason to fail a report */ }
    const answerTable = ok
      ? (() => {
        for (let i = validated.steps.length - 1; i >= 0; i--) {
          const s = validated.steps[i]
          if (!s || !s.tool.includes('spreadsheet')) continue
          const t = answerTableFromArtifact(String(s.args?.path ?? ''))
          if (t) return t
        }
        return null
      })()
      : null

  let text = ok && quiet
    ? describeShowGoalSucceeded(stepsOutList, liveTitle)
    : ok && answerTable
    ? `Here is what I found - ${answerTable.totalRows} row(s), each verified against the sources I read.`
    : ok
    ? `Done - ${stepsOutList.length} step(s), every step and the objective independently verified.`
    : destinationNotHonoured.length > 0
      ? `${verifiedCount} of ${stepsOutList.length} step(s) verified and the objective verdict was `
        + `${objectiveKind}. Every check passed - but the destination you named was not used. `
        + `You asked for ${destinationNotHonoured.map((d) => d.requested).join('; ')}, and `
        + `${destinationNotHonoured.map((d) => d.written).join('; ')} was written instead, because AIOS `
        + 'writes only inside its own output directory. The work is real and readable at that path; '
        + 'it is not where you said, so this is not being reported as done.'
    : placeholderFound
      ? `${verifiedCount} of ${stepsOutList.length} step(s) verified and the objective verdict was `
        + `${objectiveKind}, but the deliverable is empty: ${placeholderNote}. Every structural check `
        + 'passed - the file exists, is rectangular, and reads back identically - because none of those '
        + 'checks asks whether the file contains anything. AIOS is not reporting this as a success. '
        + 'The file is where the steps said it would be, so you can see exactly what was not filled in.'
      : observationOnly
      ? `All ${stepsOutList.length} step(s) succeeded their independent read-back. None of them named a `
        + 'file or other artifact, so AIOS records no objective claim - only the instruments own '
        + 'reports above. That is a limit of how the goal was expressed, not a finding that the work '
        + 'failed; the step results are the honest record of what was observed.'
      : `${verifiedCount} of ${stepsOutList.length} step(s) verified`
        + (failedCount > 0 ? `; ${failedCount} NOT verified` : '')
        + `. Objective verdict: ${objectiveKind}${verdict?.reason ? ` - ${objectiveReason}` : ''}. `
        + 'Steps being verified is not the same as the goal being achieved, and AIOS will not present it as if it were.'

    if (ok && answerTable && answerTable.totalRows > answerTable.rows.length) {
      text += `\n\nShowing the first ${answerTable.rows.length} of ${answerTable.totalRows} rows; the full table is on disk.`
    }
    if (ok && answerTable) {
      const where = validated.steps.find((s) => s.tool.includes('spreadsheet'))
      const path = String(where?.args?.path ?? '')
      if (path) text += `\n\nSaved to: ${path}`
    }
    // The answer, when the result is a table. Read back from the file the plan actually wrote, so
    // what the person reads in the chat is the same artefact they would open on disk - including
    // the padding, the dropped unsourced URLs and the quoted cells.
    emit({ kind: 'done', ok, text, ...(answerTable ? { table: answerTable } : {}) })

    // ---- REMEMBER WHAT THIS COST.
    //
    // The other half of the memory loop, and the half that was missing: a system that reads its own
    // history but never writes to it learns nothing. Without this line, "data protection
    // companies" could be asked a thousand times and each attempt would begin from the same blank
    // context as the first, including the attempts that wrote a promise instead of a table.
    //
    // Recorded for FAILURES as well as successes, deliberately. A memory that only stores wins
    // teaches a system what to keep doing rather than what to stop doing, and the failures are the
    // half that changes the next plan. See operational-memory.ts for why this entry reaches the
    // prompt and nothing else.
    try {
      remember({
        shape: String(classifyGoal(trimmed) ?? 'unknown'),
        tools: stepsOutList.map((s) => String(s.tool ?? '')),
        outcome: placeholderFound
          ? 'promise'
          : destinationNotHonoured.length > 0
            ? 'wrong-destination'
            : ok
              ? 'delivered'
              : observationOnly
                ? 'partial'
                : 'failed',
        attempts: attemptsUsed,
        at: new Date().toISOString(),
      })
      assertMemoryCannotWeakenChecks()
    } catch (e) {
      // A memory that cannot be written must never fail a mission that otherwise succeeded. The
      // user gets their result either way; they lose the lesson, which is recoverable, and a
      // mission reported as failed over a bookkeeping error is not.
      emit({
        kind: 'status',
        text: `Could not record what this mission learned (${e instanceof Error ? e.message : String(e)}). `
          + 'The task itself is unaffected.',
      })
    }

    // ---- AUDIT THE MODEL'S OWN NARRATION BEFORE IT REACHES THE PERSON.
  //
  // The mission's verdict is computed here and is trustworthy. The paragraph above it is the MODEL'S
  // description of its own work, and it was being prepended unexamined - which is how
  // "296 files" reached a reader on a run that produced 413.
  //
  // Every count it states must now be one the mission measured. Anything else is removed and the
  // removal is announced, because a sentence that quietly loses its number reads like a rendering
  // bug and teaches a reader to distrust the parts that are true. See numbers.ts for the full
  // reasoning and for what this deliberately does NOT check.
  const measured = measuredNumbersFrom(allStepsOut)
  const narration = auditNumbers(plan.reply, measured)
  const claimsNote = removedClaimsNote(narration.removed, measured)

  if (narration.removed.length > 0) {
    emit({
      kind: 'status',
      text: `The model's description claimed ${narration.removed.map((r) => `"${r}"`).join(', ')}, `
        + 'which no step measured. Those figures have been removed from the report rather than '
        + 'passed on as fact.',
    })
  }

  const replyBlock = narration.text.trim()
  const assistantText = [
    ...(replyBlock.length > 0 ? [replyBlock] : []),
    text,
    ...(claimsNote.length > 0 ? [claimsNote.trim()] : []),
  ].join('\n\n')

  appendConversation({ role: 'assistant', text: assistantText, at: Date.now(), missionId, ok })
    // EVERY attempt's steps, not just the last.
    //
    // The record used to be written from `stepsOutList`, which the loop reassigns on each attempt,
    // so a mission that replanned kept only its final attempt. The earlier one - the plan that
    // proposed "to be populated from the research results", the refusal that caught it, the
    // verifier reasons that drove the replan - was erased. A persistent record that describes only
    // the successful half of a recovery is not evidence of the recovery; it is a success with the
    // interesting part removed, which is the opposite of what a mission log is for.
    saveMission({
      missionId,
      goal: trimmed,
      ok,
      at: Date.now(),
      steps: allStepsOut,
      ...(attemptsUsed > 1 ? { attempts: attemptsUsed } : {}),
      ...(placeholderNote ? { substanceNote: placeholderNote } : {}),
      ...(destinationNotHonoured.length > 0
        ? { destinationNotHonoured: destinationNotHonoured.map((d) => d.requested) }
        : {}),
    } as MissionSummary)
    // Released once the mission is over. A chat server is long-lived, and a registry that only
    // grows is a slow leak of every artifact path the process has ever seen - the same class of
    // bug as the process leak already documented in opencode-planner.ts, in a different form.
    forgetContract(missionId)
    return { ok, missionId, goal: trimmed, reply: plan.reply, steps: stepsOutList, refusals: validated.refusals }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    emit({ kind: 'error', text: msg })
    emit({ kind: 'done', ok: false, text: `the mission could not run: ${msg}` })
    saveMission({ missionId, goal: trimmed, ok: false, at: Date.now(), steps: [], error: msg })
    return { ok: false, missionId, goal: trimmed, reply: '', steps: [], error: msg, refusals: [] }
  }
}

export { availableCapabilities, AGENT_OUT, AGENT_ROOT }