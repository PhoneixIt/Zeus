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

import { lstatSync } from 'node:fs'
import {
  isCapability, type PlanContext, type PlanProposal, type PlanResult, type PlanStep,
} from './plan.ts'
import type { PlanProvider } from './provider.ts'

/** A path, as it appears in an objective. */
const PATH_RE = /(?:[A-Za-z]:\\[^\s"']+|\\\\[^\s"']+)/
/** A path, globally. Must be constructed, not written with the /g flag inline - a shared-flagged
 *  regex is stateful under `.test()`, so an inline one alternates between calls. */
const PATH_RE_ALL = new RegExp(PATH_RE.source, 'g')
/** Words that mean "tell me what is in there". */
const SUMMARY_RE = /\b(summar\w*|inventory|list|contents|report|overview|catalogue|catalog)\b/i

interface Intent {
  readonly id: string
  readonly re: RegExp
  readonly build: (objective: string, ctx: PlanContext) => PlanProposal
}

function deriveOutputName(objective: string): string {
  const base = SUMMARY_RE.exec(objective)?.[0]?.toLowerCase() ?? 'summary'
  return `${base}.txt`
}

function folderCandidates(objective: string): string[] {
  const found = objective.match(PATH_RE_ALL)
  PATH_RE_ALL.lastIndex = 0
  return found ? [...new Set(found.map((p) => p.replace(/[\\/]+$/, '')))] : []
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
  build: (objective, ctx) => {
    const candidates = folderCandidates(objective)
    const folder = candidates[0] ?? ''
    const label = folder || 'the folder'
    const outName = deriveOutputName(objective)
    const outPath = `${ctx.outputRoot.replace(/[\\/]+$/, '')}\\${outName}`

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

const INTENTS: readonly Intent[] = [FOLDER_SUMMARY]

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

      // The ONE thing this planner checks about the world: does the folder it was told to summarise
      // exist? Read directly rather than through an observation, because this planner was written
      // before there was an observer and wiring one in would obscure the comparison M6 is about.
      if (DeterministicPlanProvider.checkTargetExists) {
        for (const candidate of folderCandidates(objective)) {
          try {
            if (!lstatSync(candidate).isDirectory()) {
              return {
                ok: false, code: 'insufficient-info',
                reason: `${candidate} exists but is not a folder, so there are no contents to summarise`,
                unsupported: ['folder summary'], missing: [candidate],
              }
            }
          } catch {
            return {
              ok: false, code: 'insufficient-info',
              reason: `${candidate} is not there, so there is nothing to summarise. The planner checked before emitting a plan, rather than producing one that would fail at execution.`,
              unsupported: ['folder summary'], missing: [candidate],
            }
          }
        }
      }

      return { ok: true, proposal: intent.build(objective, ctx) }
    }
    return {
      ok: false,
      code: 'not-understood',
      reason: 'no recognised intent matched this objective',
      unsupported: INTENTS.map((i) => i.id),
    }
  }
}
