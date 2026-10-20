/**
 * THE ORIGINAL PHRASE-MATCHING PLANNER.
 *
 * Retained, and still exercised, because deleting the thing M6 replaced would destroy the evidence
 * that it was replaced for. The M6 planner is only meaningfully "world-aware" if this one still
 * demonstrably is not - and the comparison is a test, not a claim.
 *
 * The difference, stated plainly:
 *
 *   this      recognises a phrase, then emits a fixed recipe. Five steps, identical for every folder
 *             on every machine, and the plan itself records NOTHING about the world it was written
 *             for.
 *   M6        refuses to produce a plan without an observation, and records the observation's id,
 *             time, fingerprint and the specific facts used.
 *
 * `DeterministicWorldAwarePlanProvider` in `world-aware.ts` is the replacement. This module is kept
 * for the comparison, and is reachable only when a caller asks for it by name.
 */

import { join } from 'node:path'
import {
  isCapability, type ObjectivePostcondition, type PlanContext, type PlanProposal, type PlanResult, type PlanStep,
} from './plan.ts'
import { expectedFolderSummary } from './expected-content.ts'
import { isInside } from './paths.ts'
import type { PlanProvider } from './provider.ts'

/** A path, as it appears in an objective. */
const PATH_RE = /(?:[A-Za-z]:\\[^\s"']+|\\\\[^\s"']+)/
/** A path, globally. Must be constructed, not written with the /g flag inline - a shared-flagged
 *  regex is stateful under `.test()`, so an inline one alternates between calls. */
const PATH_RE_ALL = new RegExp(PATH_RE.source, 'g')

/**
 * Drive-letter paths with EITHER separator. PATH_RE requires backslashes, so a user typing
 * `C:/tmp/x` was invisible to the folder recipe - a routing bug, not a user error.
 *
 * The `(?<![A-Za-z])` guard is load-bearing, and was added with the browser-page recipe. Without it,
 * `https://example.test/doc` matches as `s://example.test/doc`: the tail of `https:` is a single
 * letter followed by a colon and a slash, which is EXACTLY the shape of `C:/`. Every URL was
 * therefore read as a Windows drive path, and the FILE recipe claimed page requests before the
 * browser recipe could see them. Adding the browser capability is what exposed it.
 */
const FILE_PATH_RE_ALL = /(?<![A-Za-z])[A-Za-z]:[\\/][^\s'\",;]+/g

// NOTE: there is deliberately no `VERSION_CONST_RE` constant here any more. The version-edit recipe
// used to hard-code the text it searched for, which meant it was guessing the contents of a file it
// had never read - and it produced `export '1.1.0'1.0.0'` on a real file. The edit step now takes its
// search text from the INSPECT step's observation (`findFrom`), so there is no literal to keep here
// and therefore nothing that can drift away from what the file actually contains.

/** Words that mean "tell me what is in there". */
const SUMMARY_RE = /\b(summar\w*|inventory|list|contents|report|overview|catalogue|catalog)\b/i
/**
 * Words that mean "tell me the STATE OF THE REPOSITORY", not "tell me what is in a folder".
 *
 * This has to be checked BEFORE SUMMARY_RE, because "report the state of this repository" contains
 * the word "report" and would otherwise be captured as a folder summary - producing a plan about a
 * folder the user never named. That misroute would be silent: the mission would run, write a file,
 * and answer a question nobody asked.
 */
const REPO_STATE_RE = /\b(branch|uncommitted|working tree|repository state|repo state|git status|commit)\b/i
/**
 * "summarise THIS file" - a request about ONE named file, not about a folder.
 *
 * Must be checked before SUMMARY_RE, which matches the word "summar*" on its own: without this
 * ordering "summarise src/index.ts" would be captured as a FOLDER summary and the user would be
 * handed a plan that inventories a folder called src/index.ts.
 */
const FILE_SUMMARY_RE = /\bfile\b/i

/** Raised by a recipe that cannot proceed - most importantly, one with no named input. */
/**
 * The objective postconditions for a folder-summary recipe, as strong as the world allows.
 *
 * Three levels, in descending order of strength:
 *
 *   1. the observation covers the folder completely -> the exact content hash is declared, and a
 *      summary holding the wrong bytes cannot report success;
 *   2. there is an observation but it is incomplete -> the content cannot be predicted, so only
 *      existence and an independent re-read are claimed;
 *   3. there is no observation at all -> same two conditions, and no pretense of more.
 *
 * The narrowing in (2) and (3) is a real loss of coverage and is stated as such rather than papered
 * over: a plan built on a truncated view genuinely cannot say what the finished artefact must
 * contain. Declaring a weaker check is honest; declaring a wrong one would be the failure mode this
 * entire mechanism exists to prevent.
 */
async function folderSummaryPostconditions(
  ctx: PlanContext,
  folder: string,
  outPath: string,
): Promise<readonly ObjectivePostcondition[]> {
  const base: ObjectivePostcondition[] = [
    { kind: 'artifact-exists', path: outPath },
    { kind: 'artifact-read-back', path: outPath },
  ]
  if (!ctx.world) return base
  const expected = await expectedFolderSummary(ctx.world, folder)
  if (!expected.ok) return base
  return [...base, { kind: 'artifact-content-matches', path: outPath, sha256: expected.sha256 }]
}

export class NoTargetNamed extends Error {  constructor(what: string, objective: string) {
    super(`no ${what} was named, so there is nothing to ${what === 'file' ? 'summarise' : 'list'}: ${objective.slice(0, 120)}`)
    this.name = 'NoTargetNamed'
  }
}

interface Intent {
  readonly id: string
  readonly re: RegExp
  /**
   * May return a promise.
   *
   * Required by the folder-summary recipe, which states the artefact's expected CONTENT - and
   * doing that means running the same composer the executor will run, which is async. Widening the
   * return type rather than making every recipe await its own absence keeps the seven recipes that
   * have no need of it untouched.
   */
  readonly build: (objective: string, ctx: PlanContext) => PlanProposal | Promise<PlanProposal>
}

function deriveOutputName(objective: string): string {
  const base = SUMMARY_RE.exec(objective)?.[0]?.toLowerCase() ?? 'summary'
  return `${base}.txt`
}

function folderCandidates(objective: string): string[] {
/** Drive-letter paths with EITHER separator - a user types forward slashes. */
  const found = objective.match(FILE_PATH_RE_ALL)
  FILE_PATH_RE_ALL.lastIndex = 0
  return found ? [...new Set(found.map((p) => p.replace(/[\\/]+$/, '')))] : []
}

/** Raised when the caller's requested output name is not usable. Refused, never substituted. */
export class UnsupportedOutputName extends Error {
  constructor(reason: string, objective: string) {
    super(`${reason}: ${objective.slice(0, 120)}`)
    this.name = 'UnsupportedOutputName'
  }
}

/**
 * The output FILE NAME for the folder recipe.
 *
 * WHEN THE CALLER NAMES THE ARTEFACT, that name is used verbatim - and validated here, at the
 * boundary that emits the plan. This recipe used to have no way to be told, and derived the name
 * from the first SUMMARY_RE word in the objective, so a caller asking for `my-notes.txt` got
 * `contents.txt` written with no warning. That is a confident answer about a file nobody asked
 * for, which is the failure mode this project has refusals for.
 *
 * A name that is not usable is REFUSED, not repaired. There is no fallback here: falling back to
 * the derivation would reintroduce exactly the silent substitution this exists to remove.
 *
 * With NO explicit name the original derivation stands, unchanged, so every existing caller, every
 * existing mission and every existing test keeps precisely the behaviour it had.
 */
function folderOutputName(objective: string, explicit: string | undefined): string {
  if (explicit === undefined) return deriveOutputName(objective)

  const name = explicit.trim()
  if (name.length === 0) throw new UnsupportedOutputName('the requested output file name is empty', objective)
  if (name !== explicit) {
    throw new UnsupportedOutputName(`the requested output name "${explicit}" has surrounding whitespace`, objective)
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new UnsupportedOutputName(`the requested output name "${name}" contains a path separator; give a file name, not a path`, objective)
  }
  if (name === '.' || name === '..') {
    throw new UnsupportedOutputName(`the requested output name "${name}" is not a file name`, objective)
  }
  if (!name.toLowerCase().endsWith('.txt')) {
    throw new UnsupportedOutputName(`the requested output name "${name}" must end in .txt`, objective)
  }
  const base = name.slice(0, -4)
  if (!/^[A-Za-z0-9_-]+$/.test(base)) {
    throw new UnsupportedOutputName(
      `the requested output name "${name}" must be letters, digits, "_" or "-" before the .txt`, objective)
  }
  return name
}

/**
 * The folder-summary recipe. THE SAME FIVE STEPS FOR EVERY FOLDER.
 *
 * Look at what is not here: no count, no extension, no depth, no total size, no check that the
 * folder is readable, and no record of any observation. Every number in the resulting mission would
 * have to be discovered at execution time, which means the plan itself cannot answer "was this the
 * right plan for this machine?".
 */
const FOLDER_SUMMARY: Intent = {
  id: 'folder-summary',
  re: SUMMARY_RE,
  build: async (objective, ctx) => {
    const candidates = folderCandidates(objective)
    const folder = candidates[0] ?? ''
    // A folder summary with no folder named is an AMBIGUOUS request. It used to be planned
    // anyway, on an empty path, and then failed at execution with "no such folder" - fail-closed, but
    // by accident, and after a plan had already been shown to a reviewer. It now refuses up front.
    if (!folder) throw new NoTargetNamed('folder', objective)
    const label = folder
    // The caller's name when one was supplied, the original derivation when one was not. Never a
    // silent substitution in either direction.
    const outName = folderOutputName(objective, ctx.outputFileName)
    const outPath = `${ctx.outputRoot.replace(/[\\/]+$/, '')}\\${outName}`

    // REFUSE A SELF-REFERENTIAL OUTPUT, BEFORE ANYTHING IS PLANNED OR RUN.
    //
    // A summary written INSIDE the folder it describes changes the thing being reported on. Every
    // independent check afterwards - the entry count, the file/folder split, "the source folder still
    // holds what it started with" - is then comparing the folder against a listing taken before the
    // artefact existed, so the mission's own verification is invalidated by its own success.
    //
    // Caught here rather than repaired, because the alternative is silently moving the user's file.
    // `isInside` is a lexical comparison of two absolute paths, so this costs no filesystem call and
    // keeps the planner's prohibition on touching the machine intact. It also refuses the folder
    // itself, not only its children: a summary written to `src` is no more a summary OF `src`.
    if (isInside(label, outPath)) {
      throw new UnsupportedOutputName(
        `the summary would be written to "${outPath}", which is inside the folder being summarised ` +
        `("${label}"); the report would then change the very listing it claims to describe. ` +
        `Choose an output folder outside "${label}".`,
        objective,
      )
    }

    const steps: PlanStep[] = [
      {
        id: 'read-folder',
        capability: 'filesystem.inspect',
        intent: `establish that "${label}" exists and is readable`,
        mode: 'filesystem',
        tool: 'read-folder',
        args: { path: label },
        dependsOn: [],
        rationale: 'a summary of something unreadable is not a summary',
        verification: { kind: 'must-exist', description: `${label} exists and is readable` },
        onFailure: 'abort-mission',
      },
      {
        id: 'inspect-folder',
        capability: 'filesystem.list',
        intent: 'enumerate the entries in the folder',
        mode: 'filesystem',
        tool: 'inspect-folder',
        // `from` is the dataflow link. Without it the tool has no folder to list and reports "no
        // folder listing available from step", which is a step failing for want of an operand rather
        // than for any reason about the world.
        args: { from: 'read-folder' },
        dependsOn: ['read-folder'],
        rationale: 'the listing is derived from the confirmed path, not re-guessed',
        verification: { kind: 'must-exist', description: 'the folder listing is produced' },
        onFailure: 'replan',
      },
      {
        id: 'compose',
        capability: 'filesystem.transform',
        intent: 'generate the summary text from the listing',
        mode: 'filesystem',
        tool: 'compose-summary',
        args: { from: 'inspect-folder', folderLabel: label },
        dependsOn: ['inspect-folder'],
        rationale: 'the summary is derived, not written by the planner',
        verification: { kind: 'must-exist', description: 'summary text is composed' },
        onFailure: 'replan',
      },
      {
        id: 'write-report',
        capability: 'filesystem.write',
        intent: `write the summary to a new file ${outName}`,
        mode: 'filesystem',
        tool: 'write-report',
        // `write-report` takes the composed text from a prior step AND needs the output path, the
        // file name and the output root, because it re-checks containment itself rather than
        // trusting where it was told to write.
        args: { path: outPath, name: outName, outputRoot: ctx.outputRoot, from: 'compose' },
        dependsOn: ['compose'],
        rationale: 'the summary is a new file; nothing existing is overwritten',
        verification: { kind: 'must-exist', description: `${outName} is created` },
        onFailure: 'replan',
      },
      {
        id: 'confirm-report',
        capability: 'filesystem.confirm',
        intent: `read the written file back and confirm it matches what was composed`,
        mode: 'filesystem',
        tool: 'read-report',
        args: { path: outPath },
        dependsOn: ['write-report'],
        rationale: 'a file nobody can read back was not delivered',
        verification: { kind: 'must-read-back', description: `${outName} reads back with the composed content` },
        onFailure: 'abort-mission',
      },
    ]
    for (const s of steps) if (!isCapability(s.capability)) throw new Error(`bad capability on ${s.id}`)

    return {
      objective,
      constraints: ['read-only with respect to the observed folder', 'writes exactly one new file'],
      steps,
      expectedResult: `${outName} exists and describes the contents of ${label}`,
      // The artefact's EXACT CONTENT, stated - when, and only when, the observation can support it.
      //
      // `expectedFolderSummary` runs the same composer the executor will run, over the entry list
      // already observed, so this hash is a prediction rather than a guess. It is declared only if
      // the observation covers the folder completely; otherwise it returns `ok: false` and this falls
      // back to the narrower existence + read-back claim, which is honest rather than broken.
      //
      // The consequence is the point of the exercise. A summary that names 1 of 10 files is the
      // right size and reads back cleanly, so existence + read-back would call it delivered. With
      // the content condition declared, it cannot report success however green its step record is.
      objectivePostconditions: await folderSummaryPostconditions(ctx, label, outPath),
      // The recipe records WHICH WORLD it was offered, and nothing about what was in it.
      //
      // A context that supplied no observation yields an empty basis and is refused by the compiler,
      // which is the honest outcome. When one IS supplied, the identifier and fingerprint are copied
      // so the plan can be compared against the world - but `usedFacts` names no file, no count and
      // no depth, because none were looked at. Two folders with different contents still produce
      // byte-identical steps, and that is the whole difference from the M6 planner.
      basis: {
        observationId: ctx.world?.observationId ?? '',
        observedAt: ctx.world?.observedAt ?? 0,
        root: ctx.world?.scope.root ?? '',
        fingerprint: ctx.world?.fingerprint ?? '',
        usedFacts: ctx.world ? ['the observation was offered; its contents were not read'] : [],
        complete: true,
      },
    }
  },
}


/**
 * THE REPOSITORY-STATE RECIPE.
 *
 * WHY IT EXISTS
 *
 * Until this, the only shape the deterministic planner understood was "summarise a FOLDER". The M20
 * repository mission worked only because its plan was HAND-AUTHORED. That is the difference between
 * a mission that works and a product a person can use: a user must be able to ask in their own words
 * and get a plan, not have one written for them.
 *
 * So this is the objective -> plan link made real for a second, genuinely useful shape.
 *
 * WHAT IT IS NOT
 *
 * It is not a general planner, and it does not pretend the model works. It recognises ONE recipe and
 * refuses everything else. The M20 model comparison measured 0 valid plans from the 0.5B model under
 * both a naive prompt and the project's own capability-primed prompt, so the deterministic path is
 * currently the only one that produces an executable plan - and it is labelled as such, never
 * presented as model output.
 *
 * The three git verbs are all in GIT_READONLY. Note what is NOT used: `git branch`, which the policy
 * classifies in GIT_DESTRUCTIVE. Branch name comes from `rev-parse --abbrev-ref HEAD`.
 */
const REPO_STATE: Intent = {
  id: 'repo-state',
  re: REPO_STATE_RE,
  build: (objective, ctx) => {
    const outPath = `${ctx.outputRoot.replace(/[\\/]+$/, '')}\\repo-report.md`

    const gitStep = (id: string, verb: string, args: string[], intent: string, why: string): PlanStep => ({
      id,
      capability: 'terminal.run',
      intent,
      mode: 'cli',
      tool: 'git-fact',
      args: { verb, args },
      dependsOn: [],
      rationale: why,
      verification: { kind: 'independent-source', description: `${intent}, re-read independently` },
      onFailure: 'abort-mission',
    })

    const steps: PlanStep[] = [
      gitStep('read-branch', 'rev-parse', ['--abbrev-ref', 'HEAD'],
        'read the current branch', 'rev-parse is read-only; `git branch` is classified destructive'),
      gitStep('read-status', 'status', ['--porcelain'],
        'read uncommitted changes', 'porcelain is machine-readable and marks untracked entries with ??'),
      gitStep('read-files', 'ls-files', [],
        'list tracked files', 'ls-files is the only permitted repository-wide inventory, and it reports TRACKED files'),
      {
        id: 'compose',
        capability: 'filesystem.transform',
        intent: 'derive the report text from the observed facts',
        mode: 'filesystem',
        tool: 'compose-repo-report',
        args: {},
        dependsOn: ['read-branch', 'read-status', 'read-files'],
        rationale: 'deriving the counts in one step keeps them comparable and independently checkable',
        verification: { kind: 'must-read-back', description: 'the composed text parses into every required fact' },
        onFailure: 'abort-mission',
      },
      {
        id: 'write',
        capability: 'filesystem.write',
        intent: 'write the report outside the repository',
        mode: 'filesystem',
        tool: 'write-repo-report',
        args: { target: outPath },
        dependsOn: ['compose'],
        rationale: 'writing outside the repo keeps the measurement honest - the mission must not change what it reports',
        verification: { kind: 'must-read-back', description: 'the file on disk re-reads to the same facts' },
        onFailure: 'abort-mission',
      },
      {
        id: 'read-back',
        capability: 'filesystem.read',
        intent: 'read the report back independently',
        mode: 'filesystem',
        tool: 'read-repo-report',
        args: { target: outPath },
        dependsOn: ['write'],
        rationale: 'an independent read is the check that it was really written',
        verification: { kind: 'must-read-back', description: 'the report exists and its facts are internally consistent' },
        onFailure: 'abort-mission',
      },
    ]

    return {
      objective,
      constraints: ['read-only git verbs only', 'no network', 'no dependency changes'],
      steps,
      expectedResult: `a report at ${outPath} naming the branch, the uncommitted change counts ` +
        `(tracked, untracked and total), and the number of git-TRACKED TypeScript files, independently re-read from disk`,
      // The branch name and change counts are read from git at EXECUTION time, so the planner cannot
      // state them and therefore cannot pin the report's content. What it CAN state is that the
      // report exists and survives an independent re-read. The counts themselves are established by
      // `command-verified` evidence from the git steps, which corroborates outside the process.
      objectivePostconditions: [
        { kind: 'artifact-exists', path: outPath },
        { kind: 'artifact-read-back', path: outPath },
      ],
      // Same rule as the folder recipe: copy the observation's identity so the plan can be
      // compared against the world, but claim nothing about what was read. The report's FACTS are
      // discovered at execution time and verified there - the plan does not pretend to know them.
      basis: {
        observationId: ctx.world?.observationId ?? '',
        observedAt: ctx.world?.observedAt ?? 0,
        root: ctx.world?.scope.root ?? '',
        fingerprint: ctx.world?.fingerprint ?? '',
        usedFacts: ctx.world ? ['the observation was offered; git state is read at execution time'] : [],
        complete: true,
      },
    }
  },
}


/**
 * THE FILE-SUMMARY RECIPE.
 *
 * A user names a FILE and asks for it to be summarised. The file must be NAMED and RESOLVABLE. A
 * request that says only "summarise this" is REFUSED, because there is no defensible way to guess
 * which file was meant, and guessing would produce a confident answer about the wrong file - which
 * is the single worst failure mode available to this system.
 *
 * The summary itself is DETERMINISTIC (counts and frequencies over the file's actual bytes) and says
 * so in its own output. It is not a semantic summary and must never be presented as one.
 */
const FILE_SUMMARY: Intent = {
  id: 'file-summary',
  re: FILE_SUMMARY_RE,
  build: (objective, ctx) => {
    // A path is REQUIRED. No candidate means no plan.
    const found = objective.match(FILE_PATH_RE_ALL)
    FILE_PATH_RE_ALL.lastIndex = 0
    const candidates = found ? [...new Set(found.map((p) => p.replace(/[\\/]+$/, '')))] : []
    const file = candidates.find((c) => !c.endsWith('.ts') || true) ?? ''
    if (!file) {
      throw new NoTargetNamed('file', objective)
    }
    const label = file
    const outName = `${file.split(/[\\/]/).pop()!.replace(/[^A-Za-z0-9._-]/g, '_')}.summary.txt`
    const outPath = `${ctx.outputRoot.replace(/[\\/]+$/, '')}\\${outName}`

    const steps: PlanStep[] = [
      {
        id: 'read-input',
        capability: 'filesystem.read',
        intent: `read the contents of "${label}"`,
        mode: 'filesystem',
        tool: 'read-input-file',
        args: { path: label },
        dependsOn: [],
        rationale: 'a summary of a file nobody read is a summary of nothing',
        verification: { kind: 'must-exist', description: `${label} exists and was measured` },
        onFailure: 'abort-mission',
      },
      {
        id: 'summarise-file',
        capability: 'filesystem.transform',
        intent: 'derive a deterministic summary from what the file actually contains',
        mode: 'filesystem',
        tool: 'summarise-file',
        args: { from: 'read-input', label },
        dependsOn: ['read-input'],
        rationale: 'the summary is computed from measured facts, never from the objective text',
        verification: { kind: 'must-read-back', description: 'the summary matches the file as it is now' },
        onFailure: 'abort-mission',
      },
      {
        id: 'write-summary',
        capability: 'filesystem.write',
        intent: 'write the summary outside the source tree',
        mode: 'filesystem',
        tool: 'write-file-summary',
        args: { from: 'summarise-file', target: outPath },
        dependsOn: ['summarise-file'],
        rationale: 'writing outside the input folder keeps the scenario reversible and the input untouched',
        verification: { kind: 'must-read-back', description: 'the written summary re-reads and carries the file\'s current numbers' },
        onFailure: 'abort-mission',
      },
    ]

    return {
      objective,
      constraints: ['read-only on the input file', 'deterministic summary, no model inference', 'writes one new file'],
      steps,
      expectedResult: `a deterministic summary of ${label} at ${outPath}, re-read from disk and ` +
        `checked against the file's actual contents`,
      // The file is read at execution time, so - as in the folder recipe - the contents are not
      // predictable at plan time and the claim is about the artefact, not its text.
      objectivePostconditions: [
        { kind: 'artifact-exists', path: outPath },
        { kind: 'artifact-read-back', path: outPath },
      ],
      basis: {
        observationId: ctx.world?.observationId ?? '',
        observedAt: ctx.world?.observedAt ?? 0,
        root: ctx.world?.scope.root ?? '',
        fingerprint: ctx.world?.fingerprint ?? '',
        usedFacts: ctx.world ? ['the observation was offered; the file is read at execution time'] : [],
        complete: true,
      },
    }
  },
}

/**
 * READ THE PAGE THE BROWSER HAS ALREADY RENDERED, summarise it, and write that summary out.
 *
 * THE SAME THREE-STEP SHAPE AS `FILE_SUMMARY`, and deliberately: read, transform, write. That is not
 * a coincidence to be tidied up - it is the point. The browser mission differs from the file mission
 * in ONE thing, which capability supplies the first step's facts. Everything downstream, including
 * the verification discipline, is the machinery that already exists.
 *
 * WHY THIS IS NOT `browser.navigate`
 *
 * The recipe does NOT navigate. It reads whatever the browser is currently showing. A plan that
 * could navigate would be a plan that could cause the system to go somewhere, and that needs its
 * own governance argument and its own audit. Reading cannot move the machine off the page someone
 * already put in front of it.
 *
 * The fixture URL is supplied by the caller in the OBJECTIVE, so the plan is derived from the request
 * rather than invented here.
 *
 * The deterministic summary states in its own output that no model read the page and that it
 * describes what the page CONTAINS, not what it is FOR. Page text is untrusted data and is carried
 * as data; `browser-tools.ts` is where that is enforced.
 */
const BROWSER_PAGE_SUMMARY: Intent = {
  id: 'browser-page-summary',
  re: /(?:\bread\b.*\bpage\b|\bsummar\w*\b.*\bpage\b|\bpage\b.*\bsummar\w*\b|\bcapture\b.*\bpage\b)/i,
  build: (objective, ctx) => {
    // A page URL must be NAMED. A summary of "whatever the browser happens to be showing" is not a
    // mission: it has no defined source, so there is nothing for the verifier to independently
    // re-read and nothing for the objective to be checked against.
    // `data:` counts as a page URL, and the scheme list is explicit rather than a loose `[a-z]+:`.
    // A loose scheme pattern would also match the "C:" in a Windows path and the "https:" in prose,
    // and a page recipe that accepts whatever looks URL-ish will eventually be handed a file path.
    const found = objective.match(/(?:https?|data):[^\s'";]+/g) ?? []
    const url = found.length ? (found[0] ?? '').replace(/[)\]]+$/, '') : ''
    if (!url) {
      throw new NoTargetNamed('page URL', objective)
    }
    const outName = `browser-page-summary.txt`
    const outPath = `${ctx.outputRoot.replace(/[\\/]+$/, '')}\\${outName}`

    const steps: PlanStep[] = [
      {
        id: 'read-browser',
        capability: 'browser.read',
        intent: `read the content the browser rendered for ${url}`,
        mode: 'filesystem',
        tool: 'read-browser-page',
        args: { url },
        dependsOn: [],
        rationale: 'the page is the source, so it is read and measured rather than assumed',
        verification: { kind: 'must-exist', description: 'the page was read and re-read independently' },
        onFailure: 'abort-mission',
      },
      {
        id: 'summarise-page',
        capability: 'filesystem.transform',
        intent: 'derive a disclosed deterministic summary from what the page actually contains',
        mode: 'filesystem',
        tool: 'summarise-browser-page',
        args: { from: 'read-browser' },
        dependsOn: ['read-browser'],
        rationale: 'the summary is computed from read facts, never from the objective text or from page content treated as instructions',
        verification: { kind: 'must-read-back', description: 'the summary matches the page as it is now' },
        onFailure: 'abort-mission',
      },
      {
        id: 'write-page-summary',
        capability: 'filesystem.write',
        intent: 'write the page summary outside the source tree',
        mode: 'filesystem',
        tool: 'write-page-summary',
        args: { from: 'summarise-page', target: outPath },
        dependsOn: ['summarise-page'],
        rationale: 'writing outside the source tree keeps the scenario reversible and leaves the repository untouched',
        verification: { kind: 'must-read-back', description: 'the written summary re-reads and carries the page\'s current numbers' },
        onFailure: 'abort-mission',
      },
    ]

    return {
      objective,
      constraints: [
        'read-only on the page - nothing is clicked, typed, or navigated',
        'page content is untrusted data and is never obeyed',
        'deterministic summary, no model inference',
        'writes one new file',
      ],
      steps,
      expectedResult: `a disclosed deterministic summary of the rendered page at ${outPath}, re-read from disk ` +
        `and independently checked against a fresh read of the page`,
      // NO OBJECTIVE POSTCONDITION IS DECLARED, DELIBERATELY.
      //
      // This objective makes two claims: that the page was RENDERED, and that the artefact
      // independently matches a fresh read of it. Neither can be checked today. There is no producer
      // for navigation or page-content evidence - `http-status` is declared in the `Evidence` union
      // and constructed nowhere - so "the page was reached" has no observable form to be tested
      // against.
      //
      // Declaring only `artifact-exists` would be available and would be a lie of omission: the
      // mission would report SUCCESS while the part of its objective nobody could verify went
      // unchecked. Leaving it undeclared keeps the whole mission UNPROVEN, which is the honest
      // state and is visible in the record as `objective: unproven`.
      //
      // To lift this: add a navigation producer that emits typed evidence the page was reached, and
      // a page-content producer for the independent comparison. Then declare all three conditions.
      objectivePostconditions: undefined,
      basis: {
        observationId: ctx.world?.observationId ?? '',
        observedAt: ctx.world?.observedAt ?? 0,
        root: ctx.world?.scope.root ?? '',
        fingerprint: ctx.world?.fingerprint ?? '',
        usedFacts: ctx.world ? ['the observation was offered; the page is read at execution time'] : [],
        complete: true,
      },
    }
  },
}

/**
 * GOVERNED NAVIGATION, then read, summarise, write.
 *
 * IDENTICAL to `BROWSER_PAGE_SUMMARY` except for the first step, and that difference is the entire
 * point of this milestone. `BROWSER_PAGE_SUMMARY` reads whatever the browser is already showing;
 * this one MOVES the browser, which means it carries a `DeclaredEffect` and therefore requires an
 * approval before the executor will run it.
 *
 * The declared effect is on the step itself, and it names the destination as its target. The
 * executor fails a step whose declaration disagrees with the tool's own reading of the same step -
 * so a plan cannot under-declare its navigation and slip through. Both sides name the same URL.
 *
 * WHY THE OBJECTIVE ALONE IS NOT AUTHORITY
 *
 * The destination comes from the request, because that is where a request puts it. But the request
 * does not decide whether the destination is ALLOWED - `navigation-policy.ts` does, at tool
 * registration, and it cannot be widened from a step. A plan that asks for `javascript:alert(1)`
 * gets a refusal from the policy, not an approval prompt, because there is no approval that would
 * make executing script in the browser an acceptable thing to do.
 */
const BROWSER_NAVIGATE_SUMMARY: Intent = {
  id: 'browser-navigate-summary',
  re: /\b(?:navigate|go to|open|visit|load|browse)\b[^.\n]{0,24}\bpage\b|\bpage\b[^.\n]{0,24}\b(?:navigate|open|visit|load)\b/i,
  build: (objective, ctx) => {
    // Same explicit scheme list as the read recipe. A loose `[a-z]+:` pattern would match the `C:`
    // in a Windows path, and a navigation recipe that accepts file paths is a recipe that will
    // eventually try to render one.
    //
    // The comma is DELIBERATELY allowed here, unlike in the filesystem-path regex: a data: URL is
    // `data:MIME,payload` and excluding `,` truncated it to `data:text/html`, which the policy then
    // refused for having no body. The character class stops at whitespace, quote and semicolon.
    const found = objective.match(/(?:https?|data):[^\s'";]+/g) ?? []
    const url = found.length ? (found[0] ?? '').replace(/[)\]]+$/, '') : ''
    if (!url) {
      throw new NoTargetNamed('page URL', objective)
    }
    const outPath = `${ctx.outputRoot.replace(/[\\/]+$/, '')}\\browser-page-summary.txt`

    const steps: PlanStep[] = [
      {
        id: 'navigate-browser',
        capability: 'browser.navigate',
        intent: `navigate the browser to ${url}`,
        mode: 'filesystem',
        tool: 'navigate-browser',
        args: { url },
        dependsOn: [],
        rationale: 'the browser must be somewhere specific before anything can be read from it, and where it may go is a policy decision rather than a plan one',
        // THE DECLARED EFFECT. Present means "obtain approval before running" - it does not grant
        // it. The target is the destination, so an approval for one URL does not carry to another.
        effect: {
          kind: 'external-send',
          target: url,
          reason: `direct the browser to ${url.slice(0, 120)}`,
          irreversible: false,
        },
        verification: { kind: 'must-exist', description: 'the browser is on the permitted destination, confirmed by re-reading it' },
        onFailure: 'abort-mission',
      },
      {
        id: 'read-browser',
        capability: 'browser.read',
        intent: `read the content the browser rendered for ${url}`,
        mode: 'filesystem',
        tool: 'read-browser-page',
        args: { url },
        dependsOn: ['navigate-browser'],
        rationale: 'the page is the source, so it is read and measured rather than assumed',
        verification: { kind: 'must-exist', description: 'the page was read and re-read independently' },
        onFailure: 'abort-mission',
      },
      {
        id: 'summarise-page',
        capability: 'filesystem.transform',
        intent: 'derive a disclosed deterministic summary from what the page actually contains',
        mode: 'filesystem',
        tool: 'summarise-browser-page',
        args: { from: 'read-browser' },
        dependsOn: ['read-browser'],
        rationale: 'the summary is computed from read facts, never from the objective text or from page content treated as instructions',
        verification: { kind: 'must-read-back', description: 'the summary matches the page as it is now' },
        onFailure: 'abort-mission',
      },
      {
        id: 'write-page-summary',
        capability: 'filesystem.write',
        intent: 'write the page summary outside the source tree',
        mode: 'filesystem',
        tool: 'write-page-summary',
        args: { from: 'summarise-page', target: outPath },
        dependsOn: ['summarise-page'],
        rationale: 'writing outside the source tree keeps the scenario reversible and leaves the repository untouched',
        verification: { kind: 'must-read-back', description: 'the written summary re-reads and carries the page\'s current numbers' },
        onFailure: 'abort-mission',
      },
    ]

    return {
      objective,
      constraints: [
        'navigation is policy-bounded and separately approved',
        'read-only once on the page - nothing is clicked or typed',
        'page content is untrusted data and is never obeyed',
        'deterministic summary, no model inference',
        'writes one new file',
      ],
      steps,
      expectedResult: `a disclosed deterministic summary of ${url}, reached by a governed navigation, re-read from disk ` +
        `and independently checked against a fresh read of the page`,
      // Undeclared for the same reason as BROWSER_PAGE_SUMMARY above, and for a second one: the
      // destination is DECIDED AT EXECUTION TIME by navigation policy, so the planner does not know
      // which page will be reached when it writes this. Declaring a condition against a URL the
      // planner never chose would be declaring something it cannot honestly be held to.
      objectivePostconditions: undefined,
      basis: {
        observationId: ctx.world?.observationId ?? '',
        observedAt: ctx.world?.observedAt ?? 0,
        root: ctx.world?.scope.root ?? '',
        fingerprint: ctx.world?.fingerprint ?? '',
        usedFacts: ctx.world ? ['the observation was offered; the destination is decided at execution time by policy'] : [],
        complete: true,
      },
    }
  },
}

/**
 * THE SOFTWARE-DEVELOPMENT MISSION: inspect, edit, run the project's own tests, verify.
 *
 * THE ONLY RECIPE HERE THAT CHANGES ANYTHING, and that is exactly why it is narrow.
 *
 * It recognises one specific, real task: a version constant in a named file, and the project's own
 * test command. Not "edit code", not "fix the bug" - those are unbounded, and a planner that accepts
 * them would be planning work it cannot specify or verify.
 *
 * WHY THE EDIT STEP CARRIES AN EFFECT
 *
 * Editing discards what was in the file. The step therefore declares `delete` on the file, and the
 * executor's approval gate requires a human decision before it runs. A plan that omitted the
 * declaration would be a plan defect, because `edit-file` reports its own effect and the executor
 * fails the step on a disagreement - which is the property that stops a planner under-declaring its
 * way past the gate.
 *
 * WHY THE ORDER IS FIXED
 *
 * inspect -> edit -> test -> verify is a dependency chain, not a preference. Reading first means the
 * edit's `find` text comes from something observed rather than assumed; testing after means the
 * change is measured by the project's own criteria rather than by the tool that made it.
 */
const REPO_VERSION_EDIT: Intent = {
  id: 'repo-version-edit',
  re: /\b(?:bump|update|set|change|raise)\b[^.\n]{0,32}\bversion\b|\bversion\b[^.\n]{0,32}\b(?:to|in)\b[^.\n]{0,16}\d+\.\d+/i,
  build: (objective, ctx) => {
    const found = objective.match(/(?<![A-Za-z])[A-Za-z]:[\\/][^\s'\",;]+/g) ?? []
    const candidates = found ? [...new Set(found.map((p) => p.replace(/[\\/]+$/, '')))] : []
    const file = candidates.find((c) => !c.endsWith('.test.js') && !c.endsWith('.test.ts')) ?? ''
    if (!file) throw new NoTargetNamed('source file', objective)

    // The version is taken from the objective, but validated: a version that is not digits and dots
    // is not a version, and passing one through would put arbitrary text into a source file.
    const version = /\b(\d+\.\d+(?:\.\d+)?)\b/.exec(objective)?.[1]
    if (!version) throw new NoTargetNamed('target version (e.g. 1.2.0)', objective)

    const testCmd = candidates.find((c) => /test|check|verify/i.test(c)) ?? ''
    const steps: PlanStep[] = [
      {
        id: 'inspect-source',
        capability: 'filesystem.read',
        intent: `read ${file} so the edit is based on what is actually there`,
        mode: 'filesystem',
        tool: 'inspect-source-file',
        args: { path: file },
        dependsOn: [],
        rationale: 'an edit whose search text was guessed is an edit that may match somewhere unintended',
        verification: { kind: 'must-exist', description: `${file} was read and measured` },
        onFailure: 'abort-mission',
      },
      {
        id: 'edit-source',
        capability: 'filesystem.edit',
        intent: `set the version in ${file} to ${version}`,
        mode: 'filesystem',
        tool: 'edit-file',
        // `find` comes from the INSPECT step, not from here. The recipe does not know the current
        // version - it only knows the target - so writing the search text into the plan would be a
        // guess about a file nobody has read yet. An earlier version did exactly that and
        // produced `export '1.1.0'1.0.0'` on a real file.
        args: { path: file, findFrom: { step: 'inspect-source', key: 'versionLiteral' }, replace: `'${version}'` },
        dependsOn: ['inspect-source'],
        rationale: 'the change is small, literal, and reversible via the backup the tool writes',
        effect: {
          kind: 'delete',
          target: file,
          reason: `replace the contents of ${file}; the previous version string is discarded (a backup is written first)`,
          irreversible: false,
        },
        verification: { kind: 'must-read-back', description: 'the edit re-derives from the backup and matches the file on disk' },
        onFailure: 'abort-mission',
      },
      {
        id: 'run-tests',
        capability: 'terminal.run',
        intent: "run the project's own tests, so the change is judged by the project's criteria",
        mode: 'cli',
        tool: 'run-process',
        // ABSOLUTE. The allowlist matches on absolute paths, so `"node"` is refused with
        // "not on the executable allowlist" - correctly, because a bare name would have to be
        // resolved through PATH, and PATH is exactly the thing an allowlist must not consult.
        args: {
          executable: ctx.world?.capabilities.find((c) => c.name === 'node.exe')?.path ?? 'C:/Program Files/nodejs/node.exe',
          argv: [testCmd || './test.js'],
        },
        dependsOn: ['edit-source'],
        rationale: 'a passing assertion in a file the mission wrote proves nothing about the project',
        verification: { kind: 'must-read-back', description: 'the tests were observed to pass on the edited source' },
        onFailure: 'abort-mission',
      },
    ]

    return {
      objective,
      constraints: [
        'one file, one literal replacement',
        'the workspace root is fixed by the tool, not by the plan',
        'the edit declares an effect and requires approval',
        'the previous content is backed up before the edit',
        'the edit is verified by re-deriving it from the backup',
      ],
      steps,
      expectedResult: `${file} reports version ${version}, its tests pass, and the change is independently re-derived from the backup`,
      // Three claims in `expectedResult`; two of them are checkable here and one is not.
      //
      //   "its tests pass"          -> `command-exited`, and ONLY because the rule requires the
      //                                corroboration clause. A bare exit code would be node grading
      //                                its own homework, which is what `command-verified` was
      //                                invented to prevent.
      //   "the change was made"     -> the edited file exists after an independent look.
      //   "reports version X"       -> NOT DECLARED. The file's text is not observable through any
      //                                evidence kind, so pinning it here would be a claim the system
      //                                cannot be held to. It stays unproven rather than being
      //                                quietly satisfied by the existence check above.
      objectivePostconditions: [
        {
          kind: 'command-exited',
          executable: join(process.env.ProgramFiles ?? 'C:/Program Files', 'nodejs', 'node.exe'),
          exitCode: 0,
        },
        { kind: 'artifact-exists', path: file },
      ],
      basis: {
        observationId: ctx.world?.observationId ?? '',
        observedAt: ctx.world?.observedAt ?? 0,
        root: ctx.world?.scope.root ?? '',
        fingerprint: ctx.world?.fingerprint ?? '',
        usedFacts: ctx.world ? ['the observation was offered; the file is read at execution time'] : [],
        complete: true,
      },
    }
  },
}

const INTENTS: readonly Intent[] = [REPO_STATE, FILE_SUMMARY, BROWSER_NAVIGATE_SUMMARY, BROWSER_PAGE_SUMMARY, REPO_VERSION_EDIT, FOLDER_SUMMARY]

/**
 * THE PHRASE-MATCHING PLANNER. Produces no plan without a `capability`, but produces one with an
 * EMPTY basis - which the compiler refuses.
 *
 * That refusal is deliberate and is the M6 result stated as a test: the old planner's output is not
 * merely lower quality than the new planner's, it is no longer accepted at all, because a plan that
 * cannot name what it was planned against is a plan that cannot be checked.
 */
export class DeterministicPlanProvider implements PlanProvider {
  readonly name = 'deterministic-phrase-matching'

  /**
   * Whether to check the world before emitting the recipe.
   *
   * `true` by default, and the check is narrow on purpose: the recipe's FIRST step exists to
   * establish that the folder is readable, so a folder that is not there means the plan has nothing
   * to do. Without this, the planner produced a plan for a folder that does not exist and the
   * failure surfaced at execution time - which reads as though the machine went wrong rather than
   * the request being unsatisfiable.
   *
   * It is a `lstatSync` and nothing more. It does not look at file counts, extensions or depth, and
   * two folders with entirely different contents still produce byte-identical plans. That gap is
   * the whole difference from `DeterministicWorldAwarePlanProvider`, and the live harness proves it
   * by running both against two real workspaces.
   */
  static checkTargetExists = true

  /**
   * Accepts an observation, but does not USE one.
   *
   * `true`, because the provider genuinely looks at `ctx.world` - it records the fingerprint so its
   * plan can be compared against the world it was written for. It does not reason from the contents:
   * two folders with different files still produce identical steps.
   *
   * The distinction is worth making explicitly, because "it names an observation" and "it plans from
   * the observation" are different claims and only the second one is M6. `test/observation.test.ts`
   * asserts the difference by removing node from an observation and showing this provider's plan does
   * not change while the world-aware one does.
   */
  readonly requiresObservation = false

  capabilities(): readonly string[] {
    return INTENTS.map((i) => `phrase-matched: ${i.id}`)
  }

  async plan(objective: string, ctx: PlanContext): Promise<PlanResult> {
    for (const intent of INTENTS) {
      if (!intent.re.test(objective)) continue
      // "summarise the CONTENTS OF THE FOLDER x" is a folder question wearing a file-summary's
      // clothes. Without this guard the file recipe would swallow it, find no file, and REFUSE an
      // objective the folder recipe handles correctly today.
      if (intent.id === 'file-summary' && /\b(folder|directory|contents)\b/i.test(objective)) continue

      // The ONE thing this planner checks about the world: does the folder it was told to summarise
      // exist? Read directly rather than through an observation, because this planner was written
      // before there was an observer and wiring one in would obscure the comparison M6 is about.
      // The pre-check below demands its target be a DIRECTORY. That is correct for the folder recipe
      // and WRONG for the file recipe, whose target is a file by definition - it was refusing every
      // valid file request with "exists but is not a folder". Existence is still checked; only the
      // directory requirement is scoped to the recipe that needs it.
      // Only the FOLDER recipe's target must be a directory. The file recipe was excluded once already
      // (its target is a file), and the version-edit recipe has to be too - its target is a source
      // FILE, so applying a directory test to it refuses every valid software-development request
      // with "exists but is not a folder". This is an allowlist of the recipes that need the
      // directory requirement, rather than a denylist of the ones that do not, so a NEW recipe
      // defaults to NOT being wrongly constrained.
      const NEEDS_A_DIRECTORY = intent.id === 'folder-summary'
      if (DeterministicPlanProvider.checkTargetExists && NEEDS_A_DIRECTORY) {
        for (const candidate of folderCandidates(objective)) {
          const candidateLower = candidate.replace(/[\\/]+$/, '').toLowerCase()
          const observedEntry = ctx.world?.entries.find(
            (e) => e.relative.toLowerCase() === candidateLower
          )
          if (!observedEntry) {
            return {
              ok: false, code: 'insufficient-info',
              reason: `${candidate} is not in the observed world, so there are no contents to summarise`,
              unsupported: ['folder summary'], missing: [candidate],
            }
          }
          if (observedEntry.kind !== 'directory') {
            return {
              ok: false, code: 'insufficient-info',
              reason: `${candidate} exists but is not a folder, so there are no contents to summarise`,
              unsupported: ['folder summary'], missing: [candidate],
            }
          }
        }
      }

      try {
        return { ok: true, proposal: await intent.build(objective, ctx) }
      } catch (e) {
        // A recipe that cannot proceed REFUSES. It does not fall through to another recipe and it
        // does not guess: "summarise this" with no file named is unanswerable, and answering it
        // about a DIFFERENT file would be a confident wrong answer - the worst thing here.
        if (e instanceof NoTargetNamed) {
          return { ok: false, code: 'insufficient-info', reason: e.message, missing: ['a named target'], unsupported: [] }
        }
        if (e instanceof UnsupportedOutputName) {
          return { ok: false, code: 'insufficient-info', reason: e.message, missing: ['a usable output file name'], unsupported: [] }
        }
        return {
          ok: false, code: 'invalid-proposal',
          reason: `the recipe could not build a plan: ${String((e as Error)?.message ?? e).slice(0, 160)}`,
          missing: [], unsupported: [],
        }
      }
    }
    return {
      ok: false,
      code: 'not-understood',
      reason: 'no recognised intent matched this objective',
      unsupported: INTENTS.map((i) => i.id),
    }
  }
}
