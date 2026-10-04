/**
 * THE DETERMINISTIC PLANNER.
 *
 * Turns a natural-language objective into a `PlanProposal`. It executes nothing.
 *
 * NOT A WORKFLOW ENGINE
 *
 * The distinction that matters, stated bluntly because this is where the requirement is easiest
 * to violate by accident: this file does not contain a folder-summarising workflow. It contains
 * a RECOGNISER that inspects an objective, extracts validated operands from it, and emits the
 * generic plan structure for the intent it recognised.
 *
 * The test for that is not stylistic. If a future `AiPlanProvider` can only work by being
 * special-cased alongside this one, the abstraction has leaked. Concretely:
 *
 *   - this file emits `PlanStep[]`, the same type a model will emit
 *   - it holds no reference to any tool, the executor, `ControlSurface`, or `fs`
 *   - its only contact with the filesystem is `paths.ts`, for VALIDATION, and it reads no
 *     file contents
 *   - the step sequence lives in data (`INTENTS`), not in control flow, so adding an intent is
 *     adding a record rather than adding a branch
 *
 * It parses ENGLISH far more crudely than a model would, and that is fine and stated: the point
 * of this milestone is the PIPELINE, not the parsing. An objective it cannot parse produces a
 * recorded refusal, never a guess.
 */

import type { PlanContext, PlanProposal, PlanResult, PlanStep } from './plan.ts'
import type { PlanProvider } from './provider.ts'
import { checkNewOutputFile, checkReadableFolder, expandPath } from './paths.ts'

/**
 * A path-shaped token: a drive path, a UNC path, or a quoted folder name.
 *
 * NO `g` FLAG, DELIBERATELY.
 *
 * A `/g`-flagged regex used with `.test()` is stateful: `lastIndex` survives between calls, so
 * the second `.test()` on a new string starts mid-string and can return false for a string the
 * first call matched. This bit in practice - the intent matcher tested `SUMMARY_RE` and then
 * `PATH_RE`, both global, so whether an objective was recognised depended on how many times the
 * planner had been called before it. The unit test caught it as an intermittent refusal of a
 * perfectly valid objective.
 *
 * The global form is created separately, only for `matchAll`, which needs it and clones the
 * regex rather than mutating the original.
 */
const PATH_RE = /(?:[A-Za-z]:\\[^\s"']+|\\\\[^\s"']+)/

/** Global clone, for extracting every occurrence. Never used with `.test()`. */
const PATH_RE_ALL = new RegExp(PATH_RE.source, 'g')

/** Words that mean "write a new file", used only to confirm the objective asks for a summary. */
const SUMMARY_RE = /\b(summar\w*|inventory|list|contents|report|overview|catalogue|catalog)\b/i

/**
 * One recognised intent, as DATA.
 *
 * The step sequence is a list, not a chain of `if`s. That is the whole defence against this file
 * growing into a workflow engine: a new intent is a new record, and the compiler below treats
 * every record identically.
 */
interface Intent {
  readonly id: string
  readonly describe: string[]
  /** True when this intent applies to the objective. */
  readonly matches: (objective: string) => boolean
  /** Builds the steps. Pure: reads nothing from disk beyond what `paths.ts` validated. */
  build(input: {
    objective: string
    folder: string
    folderLabel: string
    outputPath: string
    outputName: string
    ctx: PlanContext
  }): PlanStep[]
}

/**
 * The folder-summarise intent: the first genuinely user-driven scenario.
 *
 * Note what the plan does NOT contain: no `gui`, no `browser`, no `api`. It uses only `cli` and
 * `filesystem`, the modes that are actually proven, and needs no injected input - so it can be
 * run and verified today without arming the operator.
 */
const FOLDER_SUMMARY: Intent = {
  id: 'folder-summary',
  describe: [
    'inspect a folder you name and write a summary of its contents to a new file',
    'e.g. "summarise the files in C:\\work\\reports"',
  ],
  matches: (o) => SUMMARY_RE.test(o) && PATH_RE.test(o),

  build: ({ folder, folderLabel, outputName, outputPath, ctx }) => {
    const FOLDER = 'read-folder'
    const LIST = 'inspect-folder'
    const COMPOSE = 'compose-summary'
    const WRITE = 'write-report'
    const CONFIRM = 'confirm-report'

    return [
      {
        id: FOLDER,
        intent: `establish that "${folderLabel}" exists and is readable`,
        mode: 'filesystem',
        tool: 'read-folder',
        args: { path: folder },
        dependsOn: [],
        rationale: 'every later step reads this folder, so its existence is a precondition rather than an assumption',
        verification: { kind: 'independent-source', description: 're-stat the folder and re-list it by a different call than the tool used' },
        onFailure: 'abort-mission',
      },
      {
        id: LIST,
        intent: 'list the entries in the folder',
        mode: 'filesystem',
        tool: 'inspect-folder',
        // The listing is passed forward by the executor as the previous step's output, so this
        // step does not re-read the folder. That keeps the summary traceable to ONE listing
        // rather than two that could differ.
        args: { from: FOLDER },
        dependsOn: [FOLDER],
        rationale: 'the summary is generated from a listing, so the listing must be a recorded artefact',
        verification: { kind: 'independent-source', description: 're-list the folder independently and compare the entry names' },
        onFailure: 'abort-mission',
      },
      {
        id: COMPOSE,
        intent: 'generate the summary text from the listing',
        mode: 'filesystem',
        tool: 'compose-summary',
        args: { from: LIST, folderLabel },
        dependsOn: [LIST],
        rationale: 'separating generation from writing means the text is inspectable before anything touches the disk',
        verification: { kind: 'must-contain', description: 'the generated text names the folder and states how many entries it saw' },
        onFailure: 'abort-mission',
      },
      {
        id: WRITE,
        intent: `write the summary to a new file ${outputName}`,
        mode: 'filesystem',
        tool: 'write-report',
        // `outputRoot` is carried so the tool can enforce containment itself rather than
        // inferring a boundary from the path it was handed. `folderLabel` lets the independent
        // verifier confirm the file on disk is a summary of THIS folder and not a leftover.
        args: { from: COMPOSE, path: outputPath, name: outputName, outputRoot: ctx.outputRoot, folderLabel },
        dependsOn: [COMPOSE],
        rationale: 'the only step that writes; creating a new file is the whole reason the scenario is reversible',
        verification: { kind: 'must-exist', description: 'the file exists, is a regular non-empty file, and lies inside the output root' },
        onFailure: 'abort-mission',
      },
      {
        id: CONFIRM,
        intent: 'read the written file back and confirm it matches what was composed',
        // Deliberately depends on the WRITE, not merely on COMPOSE. A read-back before the
        // write would confirm the generator, not the disk.
        mode: 'filesystem',
        tool: 'read-report',
        args: { from: WRITE, path: outputPath },
        dependsOn: [WRITE],
        rationale: 'a write that was never read back has not been shown to have landed',
        verification: { kind: 'must-read-back', description: 're-read the file a second time and compare its content to the composed text' },
        onFailure: 'abort-mission',
      },
    ]
  },
}

const INTENTS: readonly Intent[] = [FOLDER_SUMMARY]

/** Derives an output file name from the objective's wording. Never a path. */
function deriveOutputName(objective: string): string {
  const kind = /\b(inventor\w*|catalogue|catalog)\b/i.test(objective) ? 'inventory'
    : /\breport\b/i.test(objective) ? 'report'
      : /\boverview\b/i.test(objective) ? 'overview'
        : 'summary'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${kind}-${stamp}.md`
}

/** Pulls candidate folder tokens out of the objective, most specific first. */
function folderCandidates(objective: string): string[] {
  const quoted = [...objective.matchAll(/"([^"]+)"/g)].map((m) => m[1])
  const paths = [...objective.matchAll(PATH_RE_ALL)].map((m) => m[0])
  // Quoted first: a human who quotes a folder meant it, and an unquoted path in the same
  // sentence is usually the output location rather than the subject.
  return [...new Set([...quoted, ...paths])]
}

export class DeterministicPlanProvider implements PlanProvider {
  readonly name = 'deterministic-v1'

  capabilities(): readonly string[] {
    return INTENTS.flatMap((i) => i.describe)
  }

  async plan(objective: string, ctx: PlanContext): Promise<PlanResult> {
    const o = (objective ?? '').trim()
    if (!o) {
      return { ok: false, reason: 'the objective was empty', unsupported: [] }
    }

    const applicable = INTENTS.filter((i) => i.matches(o))
    if (applicable.length === 0) {
      return {
        ok: false,
        reason:
          'this planner does not recognise that objective. It handles: ' +
          INTENTS.flatMap((i) => i.describe).join('; '),
        unsupported: [o],
      }
    }
    if (applicable.length > 1) {
      // Ambiguity is refused rather than resolved. Picking one and hoping is how a planner
      // starts doing things nobody asked for.
      return {
        ok: false,
        reason: `the objective matches ${applicable.length} known intents (${applicable.map((i) => i.id).join(', ')}); refusing to guess which was meant`,
        unsupported: applicable.map((i) => i.id),
      }
    }

    // ---- operands, validated. The objective may select what to READ; it may not choose
    //      where to WRITE. The output root comes from the caller.
    const candidates = folderCandidates(o)
    const folderCheck = candidates.length === 0
      ? { ok: false as const, reason: 'the objective names no folder, so there is nothing to inspect' }
      : checkReadableFolder(expandPath(candidates[0]))
    if (!folderCheck.ok) {
      // Try the next candidate before giving up: an objective may mention an output path first.
      const alt = candidates.slice(1).map((c) => checkReadableFolder(expandPath(c))).find((c) => c.ok)
      if (!alt) {
        return {
          ok: false,
          reason: `${folderCheck.reason}. Named: ${candidates.join(', ') || '(nothing)'}`,
          unsupported: candidates,
        }
      }
    }
    const folderRaw = candidates.find((c) => checkReadableFolder(expandPath(c)).ok)
    const folder = expandPath(folderRaw!)
    const folderLabel = folderRaw!

    const outputName = deriveOutputName(o)
    const outCheck = checkNewOutputFile(ctx.outputRoot, outputName)
    if (!outCheck.ok) {
      return { ok: false, reason: outCheck.reason, unsupported: [outputName] }
    }
    const outputPath = `${ctx.outputRoot.replace(/[\\/]+$/, '')}\\${outputName}`

    const intent = applicable[0]
    const proposal: PlanProposal = {
      objective: o,
      constraints: [
        'read only the folder named in the objective',
        `write only inside ${ctx.outputRoot}`,
        'create new files; never overwrite, modify or delete anything',
        'no input injection of any kind',
      ],
      steps: intent.build({ objective: o, folder, folderLabel, outputPath, outputName, ctx }),
      expectedResult: `a new file ${outputName} containing a summary of the ${folderLabel} folder, read back and confirmed`,
    }

    return { ok: true, proposal }
  }
}