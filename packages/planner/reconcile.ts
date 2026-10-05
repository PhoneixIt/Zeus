/**
 * OBJECTIVE RECONCILIATION.
 *
 * When the world diverges from the plan, something has to decide what the user actually meant
 * *now*. This module does that, and it is deliberately the smallest thing that can.
 *
 * WHY NOT JUST LET THE PLANNER FIGURE IT OUT
 *
 * Because the planner parses an objective. Hand it an objective naming a folder that no longer
 * exists and the only correct answer is "I cannot plan this" - which is right, and useless. The
 * objective is a record of what the user wanted when they asked, and the world has since moved.
 * Somebody has to bridge that gap, and making it explicit is better than having it happen
 * invisibly inside a planner.
 *
 * THE RULE, AND WHY IT IS SO NARROW
 *
 * A path in the objective is replaced ONLY when it has ceased to exist AND exactly one existing
 * directory carries the same leaf name. That is a rename, detected mechanically.
 *
 * Both halves are load-bearing:
 *
 *   - "has ceased to exist" stops the reconciler touching anything that still works
 *   - "exactly one match" stops it choosing between candidates. Two directories named `reports`
 *     is genuinely ambiguous, and picking one would be a guess about which the user meant.
 *
 * If neither condition holds the reconciler REFUSES, and the mission fails with a reason. A
 * recovery that silently reads a different directory than the one asked for is worse than no
 * recovery: the user gets a confident summary of the wrong thing.
 *
 * EVERY SUBSTITUTION IS RECORDED
 *
 * `substitutions` is part of the result, not a log line. The caller is expected to put it in the
 * mission history and the user-facing report, because "the folder you named moved and I followed
 * it" is something a person needs to be able to see.
 */

import { existsSync, statSync, readdirSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

/** One path in the objective that was replaced, and why. */
export interface Substitution {
  readonly from: string
  readonly to: string
  readonly why: string
}

export type ReconcileResult =
  | {
      readonly ok: true
      /** The amended objective. Identical to the original when nothing was substituted. */
      readonly objective: string
      readonly substitutions: readonly Substitution[]
    }
  | { readonly ok: false; readonly reason: string }

/** What the reconciler is allowed to see. A listing, never the filesystem itself. */
export interface FreshObservation {
  /** Directories that exist right now, absolute. */
  readonly existingDirectories: readonly string[]
  /** When the observation was taken, so a stale one is recognisable. */
  readonly at: number
}

/** Reads the current shape of a directory tree into a `FreshObservation`. */
export function observeDirectories(root: string, depth = 1): FreshObservation {
  const found: string[] = []
  const walk = (dir: string, left: number): void => {
    if (!existsSync(dir)) return
    found.push(resolve(dir))
    if (left <= 0) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const n of names) {
      const p = resolve(dir, n)
      try {
        if (statSync(p).isDirectory()) walk(p, left - 1)
      } catch { /* unreadable entry; not a candidate */ }
    }
  }
  walk(root, depth)
  return { existingDirectories: found, at: Date.now() }
}

/** Path-shaped tokens in an objective. Non-global; see the note in deterministic.ts. */
const PATH_TOKEN = /(?:[A-Za-z]:\\[^\s"']+|\\\\[^\s"']+)/g
const QUOTED = /"([^"]+)"/g

/** Every path-like token, with its exact surrounding text so substitution is textual and safe. */
function tokens(objective: string): string[] {
  const quoted = [...objective.matchAll(QUOTED)].map((m) => m[1])
  const bare = [...objective.matchAll(PATH_TOKEN)].map((m) => m[0])
  return [...new Set([...quoted, ...bare])]
}

export class ObjectiveReconciler {
  readonly name = 'objective-reconciler-v1'

  /**
   * Amends `objective` to match what was actually observed.
   *
   * Refuses rather than guessing. The three refusals are all real situations: nothing moved, the
   * target still exists (so no reconciliation is needed), or the target moved somewhere
   * ambiguous.
   */
  reconcile(objective: string, observed: FreshObservation): ReconcileResult {
    if (!observed.existingDirectories.length) {
      return { ok: false, reason: 'the fresh observation contains no directories, so nothing can be reconciled against it' }
    }

    const subs: Substitution[] = []
    let amended = objective

    for (const token of tokens(objective)) {
      if (existsSync(token)) continue // still there; leave it alone

      const leaf = basename(token)
      const matches = observed.existingDirectories.filter((d) => basename(d) === leaf)

      if (matches.length === 0) {
        return {
          ok: false,
          reason:
            `"${token}" no longer exists and nothing with the same name was found among ` +
            `${observed.existingDirectories.length} observed director(ies). Refusing to guess a replacement.`,
        }
      }
      if (matches.length > 1) {
        return {
          ok: false,
          reason:
            `"${token}" no longer exists and ${matches.length} directories are named "${leaf}" ` +
            `(${matches.join(', ')}). That is ambiguous, and choosing one would be a guess about ` +
            `what the user meant. Refusing.`,
        }
      }

      const to = matches[0]
      subs.push({
        from: token,
        to,
        why:
          `"${token}" no longer exists; exactly one directory named "${leaf}" was observed ` +
          `at ${to}, and ${dirname(token)} is where it was expected`,
      })

      // Textual replacement, both bare and quoted forms, so the amended objective still parses.
      amended = amended.split(`"${token}"`).join(`"${to}"`)
      amended = amended.split(token).join(to)
    }

    return { ok: true, objective: amended, substitutions: subs }
  }
}
