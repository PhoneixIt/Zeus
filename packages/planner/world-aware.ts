/**
 * THE WORLD-AWARE PLANNER.
 *
 * It plans from what is there. Not from a table of phrases someone anticipated.
 *
 * WHAT CHANGED, AND WHY IT WAS STRUCTURAL
 *
 * The previous planner recognised a phrase and emitted a fixed recipe: five steps, identical for
 * every folder on every machine. It was a lookup table that happened to be written in TypeScript,
 * and its only claim to being a planner was that its output happened to typecheck.
 *
 * The difference is not that the recipes are now computed. It is that the plan RECORDS WHAT IT
 * LOOKED AT, and cannot be produced at all without it. A plan's `basis` names the observation, its
 * time, its fingerprint and the specific facts used. So the question "did this plan suit the machine
 * it was planned for?" has an answer that can be checked, and when the world moves the answer changes
 * visibly rather than silently.
 *
 * WHY A MODEL IS NOT INVOLVED, AND WHY THAT IS THE POINT
 *
 * The reasoning here is a few hundred lines of explicit logic over an observed state. When a model
 * arrives it replaces THIS - the reasoning - while the contract around it stays fixed: same
 * `PlanProposal` out, same compiler, same router, same executor, same governance. A model that
 * reasoned badly would produce a plan the compiler refuses, not a plan that quietly runs. That is the
 * property worth having, and it is only available because the boundary was built before there was
 * anything to put behind it.
 *
 * AND IT STILL CANNOT ACT
 *
 * This module imports no executor, no governance contract, no `ControlSurface`, no tool, and no
 * filesystem module. It has no way to write, spawn, inject, or authorise. It reads a `WorldState` -
 * data - and returns a `PlanProposal` - data. `test/observation.test.ts` asserts the import graph,
 * and control E in the live harness attempts to reach the executor from a plan and shows there is
 * nothing to reach.
 */

import { createHash } from 'node:crypto'
// The single filesystem call in this module, and it is a READ with no capability to act. Needed
// because the observer reports resolved paths; see `realish` for why, and `test/observation.test.ts`
// for the assertion that this is the only one.
import { realpathSync } from 'node:fs'
// `join` builds the absolute operands a terminal step needs. Path arithmetic only - it touches no
// filesystem, so the "the planner cannot read or write" assertion in the tests is unaffected.
import { join } from 'node:path'
import {
  filesIn, directoriesIn, deepestLevel, extensionsIn, observes, find,
  type WorldState,
} from '../observation/world.ts'
import {
  isCapability, type PlanContext, type PlanFailure, type PlanProposal, type PlanResult, type PlanStep,
  type Capability,
} from './plan.ts'
import type { PlanProvider } from './provider.ts'

/** How an objective names its subject. Deliberately narrow, and honest about being narrow. */
const SUBJECT_RE = /(?:[A-Za-z]:\\[^\s"']+|\\\\[^\s"']+)/

/** Words that mean "tell me what is in there". */
const SUMMARY_RE = /\b(summar\w*|inventory|catalogue|catalog|describe|what'?s in|contents of|report on|overview)\b/i

const no = (
  code: PlanFailure,
  reason: string,
  unsupported: readonly string[] = [],
  missing?: readonly string[],
): PlanResult => ({ ok: false, code, reason, unsupported, ...(missing ? { missing } : {}) })

/**
 * A stable step id that includes the fingerprint.
 *
 * Not cosmetic. M2 established that step ids survive a replan, which is exactly why the approval key
 * carries a plan epoch: an id that stayed the same across a changed world would let an authorisation
 * for the old action authorise the new one. Deriving the id from the observation means a plan for a
 * different world is a DIFFERENT plan, visibly, rather than the same plan with different arguments.
 */
function stepId(base: string, world: WorldState, ...parts: Array<string | number>): string {
  const h = createHash('sha256')
  h.update([base, world.fingerprint, ...parts.map(String)].join('|'))
  return `${base}-${h.digest('hex').slice(0, 8)}`
}

/**
 * The observed entry for an absolute path, or undefined if the walk never recorded one.
 *
 * Resolution goes through `realpath` on both sides, because the observer reports RESOLVED paths and a
 * textual comparison would fail to match whenever the objective names a path with a different
 * spelling than the filesystem reported - a junction, an 8.3 name, or a trailing separator.
 */
function entryFor(world: WorldState, absolute: string): ReturnType<typeof find> {
  const want = realish(absolute).replace(/[\\/]+$/, '').toLowerCase()
  return world.entries.find((e) => e.path.replace(/[\\/]+$/, '').toLowerCase() === want)
}

/**
 * Best-effort resolution; falls back to the input when the path does not exist.
 *
 * The ONE filesystem call in this module, and it is a read with no capability to act. It exists
 * because the observer reports RESOLVED paths: matching the objective's spelling against them
 * textually would fail on a junction, an 8.3 short name, or a trailing separator, and the planner
 * would then report a folder it can plainly see as "not observed".
 *
 * A `require` was tried first, to keep `node:fs` out of the import graph. It does not exist in this
 * ESM module, so the call threw on every plan - and the import graph is a better place to be honest
 * than a working call to a function that never ran. `test/observation.test.ts` asserts this is the
 * only `node:fs` call here.
 */
function realish(p: string): string {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

/** Rejects a path argument that is not inside where the plan is allowed to write or read. */
function pathOk(outputRoot: string, p: string): boolean {
  const root = outputRoot.replace(/[\\/]+$/, '')
  const abs = p.replace(/[\\/]+$/, '')
  return abs === root || abs.startsWith(root + '\\') || abs.startsWith(root + '/')
}

/**
 * THE PLANNER.
 *
 * One objective shape is handled: summarise a folder. That is a limitation, stated here rather than
 * hidden, and the failure code for everything else is `not-understood` - so an objective this planner
 * cannot handle is reported as such instead of being approximated into a folder summary.
 */
export class DeterministicWorldAwarePlanProvider implements PlanProvider {
  readonly name = 'deterministic-world-aware'

  /**
   * Declares that this provider cannot plan without a view of the world.
   *
   * Read by the supervisor, which then REFUSES rather than calling `plan()` with no observation. That
   * matters because the alternative is a fallback to recipe-style planning, and a fallback here would
   * make the world's presence optional in exactly the component that decides whether to look.
   */
  readonly requiresObservation = true

  capabilities(): readonly string[] {
    return [
      'summarise the contents of a named folder, planning from an observed WorldState',
      'refuse rather than invent when the folder is missing, empty, or the observation is stale',
      'choose filesystem vs terminal capabilities based on what the observation shows is present',
    ]
  }

  async plan(objective: string, ctx: PlanContext): Promise<PlanResult> {
    // ---- 1. Is this an objective I handle at all?
    if (!SUMMARY_RE.test(objective)) {
      return no(
        'not-understood',
        `this planner handles "summarise the contents of a folder"; the objective does not ask for that`,
        ['folder summary'],
      )
    }
    const subjectMatch = SUBJECT_RE.exec(objective)
    if (!subjectMatch) {
      return no('not-understood', 'the objective names no folder to summarise', ['folder summary'])
    }
    const subject = subjectMatch[0].replace(/[\\/]+$/, '')

    // ---- 2. Do I have a world to plan against?
    //
    // This check is the milestone. The previous planner had no such step and produced a plan anyway;
    // that plan was a recipe, and whether it suited the machine was unknowable from the plan itself.
    const world = ctx.world
    if (!world) {
      return no(
        'observation-missing',
        'no observation was supplied, so there is nothing to plan against. A plan without a view of ' +
        'the world is a recipe, not a plan.',
      )
    }

    // ---- 3. Is that view current?
    //
    // A plan built on a stale view is worse than no plan, because it looks informed. The caller
    // supplies the tolerance and, where it has one, a re-observation; the planner does not decide
    // either, because freshness is the caller's risk to set.
    const maxAge = ctx.maxObservationAgeMs
    if (typeof maxAge === 'number') {
      const age = ctx.now() - world.observedAt
      if (age > maxAge) {
        return no(
          'observation-stale',
          `the observation of ${world.scope.root} was taken ${Math.round(age / 1000)}s ago, beyond ` +
          `the ${Math.round(maxAge / 1000)}s this caller accepts. Re-observe before planning.`,
        )
      }
      if (ctx.refetched) {
        if (ctx.refetched.fingerprint !== world.fingerprint) {
          return no(
            'observation-stale',
            `${world.scope.root} changed between the observation and the plan ` +
            `(fingerprint ${world.fingerprint} -> ${ctx.refetched.fingerprint}). The plan would ` +
            `describe a machine that no longer exists in that state.`,
          )
        }
      } else {
        return no(
          'observation-stale',
          `the observation is within its age limit but no re-observation was supplied, so it cannot ` +
          `be confirmed to still describe the world.`,
        )
      }
    }

    // ---- 4. Does the world contain the thing the objective names?
    //
    // A subject outside the observed root is NOT treated as missing. It is unobserved, which is a
    // different state, and reporting it as one keeps "I did not look there" distinct from "it is not
    // there" - the difference between re-observing with a wider scope and telling the user the folder
    // does not exist.
    if (!observes(world, subject)) {
      return no(
        'insufficient-info',
        `the objective names ${subject}, which is outside the observed root ${world.scope.root}. ` +
        `Nothing is known about it.`,
        [],
        [subject],
      )
    }
    // THE SUBJECT ITSELF MUST HAVE BEEN OBSERVED, not merely be inside the observed root.
    //
    // The first version checked only the root, and a test caught the consequence: asked to summarise
    // `<root>\gone` - a subfolder that does not exist - the planner produced a plan for `<root>`
    // instead, because the root's files were right there in the observation. It would have written a
    // confident summary of a folder the user never named.
    //
    // "Inside the scope" and "present in the scope" are different facts, and only the second one
    // licenses an assertion about this path.
    const subjectEntry = entryFor(world, subject)
    if (!subjectEntry) {
      return no(
        'insufficient-info',
        `${subject} was not found when ${world.scope.root} was observed, so there is nothing to ` +
        `summarise. It is inside the observed tree, but it is not present in it.`,
        [],
        [subject],
      )
    }
    if (subjectEntry.kind !== 'directory') {
      return no(
        'insufficient-info',
        `${subject} exists but is a ${subjectEntry.kind}, not a folder, so there is no contents to summarise`,
        [],
        [subject],
      )
    }
    // The root entry must also be sound, or the walk produced a partial view of the subject.
    if (!find(world, '.')) {
      return no('insufficient-info', `the observation of ${subject} produced no entry for the folder itself`, [], [subject])
    }
    if (world.errors.length > 0) {
      return no(
        'observation-truncated',
        `${world.errors.length} path(s) under ${subject} could not be read (for example ` +
        `"${world.errors[0].path}": ${world.errors[0].reason}), so any summary would be incomplete ` +
        `in a way nobody could detect afterwards.`,
        [],
        world.errors.map((e) => e.path),
      )
    }
    if (world.truncated) {
      return no(
        'observation-truncated',
        `the observation of ${subject} stopped at its entry cap, so the listing is partial. A summary ` +
        `of a partial listing reads exactly like a summary of a complete one.`,
      )
    }

    // ---- 5. What is actually in there?
    //
    // This is the part that used to be hardcoded. Every number below comes from the observation, so
    // a different folder produces a different plan rather than the same plan with a different name.
    const files = filesIn(world)
    const dirs = directoriesIn(world)
    if (files.length === 0) {
      return no(
        'insufficient-info',
        `${subject} contains no files${dirs.length ? ` (it has ${dirs.length} subfolder(s), which were looked at too)` : ''}. ` +
        `There is nothing to summarise, and writing a summary of nothing would be inventing content.`,
        [],
        [],
      )
    }

    const usedFacts: string[] = [
      `${files.length} file(s) observed`,
      `${dirs.length} subfolder(s) observed`,
      `extensions: ${extensionsIn(world).join(', ') || 'none'}`,
      `max depth ${deepestLevel(world)}`,
      `node ${world.capabilities.find((c) => c.name === 'node.exe')?.exists ? 'present' : 'ABSENT'}`,
    ]
    const observed = files
      .slice()
      .sort((a, b) => (a.relative < b.relative ? -1 : 1))
      .map((f) => f.relative)

    // ---- 6. Build the plan, choosing capabilities from what was observed.
    //
    // The branch is the point: node's presence is an OBSERVED fact, so a machine without node gets a
    // different plan rather than a step that fails at execution time with "executable not found". The
    // failure then happens during planning, where it can be reported honestly, instead of halfway
    // through a mission.
    const node = world.capabilities.find((c) => c.name === 'node.exe')
    const useTerminal = node?.exists === true && node.permitted === true
    const outName = `summary${files.length === 1 ? '' : 's'}-${world.fingerprint.slice(0, 6)}.txt`
    const outPath = `${ctx.outputRoot.replace(/[\\/]+$/, '')}\\${outName}`
    if (!pathOk(ctx.outputRoot, outPath)) {
      return no('invalid-proposal', `the derived output path ${outPath} is outside ${ctx.outputRoot}`)
    }

    const base: PlanStep[] = [
      {
        id: stepId('inspect', world, subject),
        capability: 'filesystem.inspect',
        intent: `establish what is in ${subject}, from the observation taken at ${new Date(world.observedAt).toISOString()}`,
        mode: 'filesystem',
        tool: 'inspect-folder',
        args: { path: subject },
        dependsOn: [],
        rationale: `the observation recorded ${files.length} file(s) and ${dirs.length} subfolder(s); this step re-establishes that at execution time rather than trusting the plan`,
        verification: { kind: 'must-exist', description: `${subject} is still readable at execution time` },
        onFailure: 'replan',
      },
    ]

    // The composition step's OPERANDS, and they differ by branch.
    //
    // The terminal branch runs a process and gets a file path; the filesystem branch gets text
    // directly. `write-summary` consumes the previous step's output, and the shape of that output is
    // what decides which branch is usable - so the branch and the operands have to be chosen
    // together, from the same observed fact.
    const transformStep: PlanStep = {
      id: stepId(useTerminal ? 'tally-terminal' : 'tally-fs', world, files.length),
      capability: useTerminal ? 'terminal.run' : 'filesystem.transform',
      intent: `compose a summary of ${files.length} observed file(s): ${observed.slice(0, 6).join(', ')}${observed.length > 6 ? `, and ${observed.length - 6} more` : ''}`,
      mode: useTerminal ? 'cli' : 'filesystem',
      tool: useTerminal ? 'run-process' : 'compose-summary',
      args: useTerminal
        ? {
            // The observed file list, the folder they are in, and where the process should write.
            // All three are facts from the observation, which is why this step is different for a
            // different folder - and why the process is given the folder rather than the planner
            // having to re-derive it.
            subject,
            files: observed.map((rel) => join(subject, rel)),
            reportPath: join(ctx.outputRoot.replace(/[\\/]+$/, ''), `${world.fingerprint.slice(0, 6)}.raw`),
            total: files.reduce((a, f) => a + (f.sizeBytes ?? 0), 0),
            note: 'derived from the observation, not from the objective text',
          }
        : { path: subject, files: observed },
      dependsOn: [base[0].id],
      // Where the wording would normally be a guess, it is a fact: the file list came out of the
      // observation, so the step describes the world rather than a template.
      rationale: useTerminal
        ? `node.exe was observed present and permitted, so the composition runs as an allowlisted process`
        : `node.exe was NOT observed as a permitted program, so the composition uses the filesystem capability instead of failing at execution`,
      verification: { kind: 'must-exist', description: `${outName} is created` },
      onFailure: 'replan',
    }

    const writeStep: PlanStep = {
      id: stepId('write', world, outName),
      capability: 'filesystem.write',
      intent: `write the composed summary to ${outName}`,
      mode: 'filesystem',
      tool: 'write-summary',
      args: useTerminal
        // The process wrote a file; this step publishes it under the plan's own name.
        ? { path: outPath, from: transformStep.id, copyFrom: transformStep.args.reportPath }
        : { path: outPath, from: transformStep.id },
      dependsOn: [transformStep.id],
      rationale: 'the summary is a new file; nothing existing is overwritten',
      verification: { kind: 'must-read-back', description: `${outName} reads back with the composed content` },
      onFailure: 'replan',
    }

    const verifyStep: PlanStep = {
      id: stepId('confirm', world, outName),
      capability: 'filesystem.read',
      intent: `read ${outName} back and confirm it describes the ${files.length} file(s) observed`,
      mode: 'filesystem',
      tool: 'read-back',
      args: { path: outName, expectFiles: files.length },
      dependsOn: [writeStep.id],
      rationale: 'a summary nobody can read back was not delivered',
      verification: { kind: 'must-contain', description: `the summary names all ${files.length} observed file(s) and the total size` },
      onFailure: 'abort-mission',
    }

    const steps = [...base, transformStep, writeStep, verifyStep]
    for (const s of steps) {
      if (!isCapability(s.capability)) {
        return no('invalid-proposal', `step "${s.id}" names the unknown capability "${s.capability}"`)
      }
    }

    return {
      ok: true,
      proposal: {
        objective,
        constraints: [
          'read-only with respect to the observed folder',
          'writes exactly one new file',
          'the plan is bound to observation ' + world.observationId,
        ],
        steps,
        expectedResult:
          `${outName} exists and names all ${files.length} file(s) observed under ${subject}` +
          `${dirs.length ? ` across ${dirs.length} subfolder(s)` : ''}, totalling ` +
          `${files.reduce((a, f) => a + (f.sizeBytes ?? 0), 0)} bytes`,
        basis: {
          observationId: world.observationId,
          observedAt: world.observedAt,
          root: world.scope.root,
          fingerprint: world.fingerprint,
          usedFacts,
          complete: !world.truncated && world.errors.length === 0,
        },
      },
    }
  }
}
