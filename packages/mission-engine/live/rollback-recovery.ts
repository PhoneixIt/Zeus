/**
 * THE ROLLBACK RECOVERY POLICY - the concrete recovery the executor can perform.
 * =============================================================================
 * WHY THIS IS A POLICY AND NOT A STEP
 * =============================================================================
 *
 * The executor decides WHEN to recover. This decides WHAT recovery is permitted, and returns the
 * steps. It never runs them: the executor executes them through the ordinary step path, so a rollback
 * is subject to exactly the same preflight, the same approval gate, the same effect declaration and
 * the same verification as any other work.
 *
 * That is the whole design. A recovery that ran through a private back door would be recovery nobody
 * authorised and nobody verified - and it would be recovery that can reach further than the work it
 * is repairing, which is how a repair becomes an incident.
 *
 * =============================================================================
 * THE ONE RECOVERY IT OFFERS
 * =============================================================================
 *
 * Roll a file back to the backup its edit wrote. It is offered ONLY for a failed `edit-file` step,
 * and only when that step's own path is in scope. Every other failure - including a failed rollback,
 * a failed test, an out-of-scope edit - gets a stated refusal, not a guess.
 */

import { existsSync } from 'node:fs'

import type { RecoveryPolicy, RecoveryRequest, RecoveryAttempt } from '../recovery.ts'
import { BACKUP_SUFFIX } from './edit-tools.ts'
import type { Step } from '../state.ts'

export interface RollbackRecoveryOptions {
  /** The workspace root. Recovery cannot reach further than the work it is repairing. */
  readonly workspaceRoot: string
  /** Recoveries allowed per mission. The executor counts these too; both must agree. */
  readonly maxRecoveries: number
  /** Digests of files this mission already recovered, so one repair cannot loop on itself. */
  readonly recovered?: Set<string>
}

export function rollbackRecoveryPolicy(opts: RollbackRecoveryOptions): RecoveryPolicy {
  return {
    maxRecoveries: opts.maxRecoveries,

    plan(req: RecoveryRequest) {
      // ONLY an edit can be recovered this way. Anything else is refused in words.
      if (req.step.tool !== 'edit-file') {
        return {
          permitted: false,
          reason: `the only recovery available is rolling back a file edit, and "${req.step.id}" used "${req.step.tool ?? 'no tool'}"`,
        }
      }

      const path = String((req.step.args as { path?: unknown } | undefined)?.path ?? '')
      if (!path) return { permitted: false, reason: 'the failed edit named no path, so there is nothing to roll back' }

      // SCOPE. Re-checked here, in the policy, and again by the rollback tool at run time. Two checks
      // of one rule is the point: the policy refuses to even PLAN a recovery outside the root.
      const root = opts.workspaceRoot.replace(/[\\/]+$/, '')
      if (!path.startsWith(root)) {
        return { permitted: false, reason: `the failed edit was outside the workspace root ${root}, so recovery is out of scope` }
      }

      // NO BACKUP, NO RECOVERY. Said here rather than discovered at run time, so the refusal names the
      // actual cause instead of arriving as a failed step three layers down.
      const backup = path + BACKUP_SUFFIX
      if (!existsSync(backup)) {
        return { permitted: false, reason: `there is no backup at ${backup}, so the edit cannot be reversed` }
      }

      // NO REPEATING A REPAIR. A recovery that has already run for this path must not be planned
      // again: that is the shape a loop takes, and the budget alone would only slow it down.
      if (opts.recovered?.has(path)) {
        return { permitted: false, reason: `a recovery for ${path} has already been attempted in this mission, so repeating it is refused` }
      }
      opts.recovered?.add(path)

      // The digest is NOT supplied here. The executor cannot see the file's current content at plan
      // time, and guessing it would defeat the stale-digest guard that stops a rollback from
      // discarding an intervening change. The rollback step therefore carries no digest, and the
      // verifier - which re-reads both files - is what decides whether the restore is honest.
      const step: Step = {
        id: 'recovery-rollback',
        intent: `roll ${path} back to the content it had before the failed edit`,
        mode: 'filesystem',
        capability: 'filesystem.rollback',
        rationale: 'the edit did not verify, so the world is restored to a state this mission can account for before anything else is attempted',
        tool: 'rollback-file',
        args: { path },
        dependsOn: [],
        effect: {
          kind: 'delete',
          target: path,
          reason: `restore ${path} from the backup written before the failed edit`,
          irreversible: false,
        },
        verification: { kind: 'must-read-back', description: 'the file on disk matches its backup' },
        onFailure: 'abort-mission',
      } as unknown as Step

      return { steps: [step], reason: `roll ${path} back to its pre-edit backup` }
    },
  }
}

/** A human-readable account of a recovery, for the mission report and the durable note. */
export function describeRecovery(a: RecoveryAttempt): string {
  return a.recovered
    ? `recovered: ${a.summary}`
    : `recovery did NOT succeed: ${a.failure ?? a.summary}`
}