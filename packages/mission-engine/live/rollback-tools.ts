/**
 * ROLLBACK - the first capability that can UNDO a change it previously made.
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 *
 * `filesystem.edit` writes a `.aios-backup` before it changes anything, and documents that as making
 * the change reversible. That was, until this file existed, **a promise nothing could keep**: there
 * was no capability that read the backup and restored it. A backup nobody can use is not
 * reversibility, it is litter.
 *
 * Recovery needs one more thing the edit capability deliberately does not have. The edit TOOL
 * re-checks its own backup immediately after writing it and refuses if the backup does not read back
 * identically - which is a very short window, and it cannot cover a backup that has since been
 * deleted, truncated, or overwritten by something else. `rollbackEdit` is the check that matters at
 * the moment it is needed: is the backup still there, and is it still the content we are claiming it
 * was?
 *
 * =============================================================================
 * WHY ROLLBACK IS ITS OWN CAPABILITY AND NOT A FLAG ON EDIT
 * =============================================================================
 *
 * Restoring a file overwrites whatever is there now - including, potentially, a change made by
 * someone else in the meantime. That is a different consequence from "replace a string I told you
 * about", and folding it into `filesystem.edit` would mean the edit capability could destroy work it
 * had never seen. It declares its own effect, so it requires its own approval, and the approval names
 * the FILE - so an approval to roll one file back does not roll another back.
 *
 * =============================================================================
 * WHAT ROLLBACK REFUSES
 * =============================================================================
 *
 *   - no backup                       there is nothing to restore, and inventing one is not recovery
 *   - backup unreadable / empty       a truncated backup is worse than none: it would "succeed" and
 *                                     leave a file that was never the original
 *   - a CURRENT HASH that does not match   unless the caller says what it expects to be replacing,
 *                                     this would clobber an intervening change without saying so
 *   - a path outside the workspace    same scope rule as every other write, same constructor-
 *                                     supplied root, never a step-supplied one
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'

import type { Tool, ToolContext, ToolResult, Verifier } from '../executor.ts'
import type { ToolRegistration } from '../../tool-router/router.ts'
import type { Evidence, Step } from '../state.ts'
import { BACKUP_SUFFIX, MAX_EDIT_BYTES, resolveInside } from './edit-tools.ts'

export interface RollbackDeps {
  /** The workspace root. A constructor argument, for the same reason as everywhere else. */
  readonly workspaceRoot: string
}

/** A small, stable digest. Not cryptographic - it detects an intervening change, not an attacker. */
function digest(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

export function rollbackPlan(root: string, args: Record<string, unknown>):
  | { ok: true; path: string; backup: string; current: string; restored: string; currentDigest: string }
  | { ok: false; reason: string } {
  const raw = String(args.path ?? '')
  if (!raw) return { ok: false, reason: 'no path given' }
  const scoped = resolveInside(root, raw)
  if ('error' in scoped) return { ok: false, reason: scoped.error }
  const abs = scoped.path
  const backup = abs + BACKUP_SUFFIX

  if (!existsSync(abs)) return { ok: false, reason: `no file at "${abs}" to roll back` }
  if (!existsSync(backup)) {
    return {
      ok: false,
      reason: `no backup at "${backup}", so there is nothing to restore. Rolling back to nothing is not recovery.`,
    }
  }

  let restored: string
  let current: string
  try {
    restored = readFileSync(backup, 'utf8')
  } catch (e) {
    return { ok: false, reason: `the backup could not be read: ${e instanceof Error ? e.message : String(e)}` }
  }
  try {
    current = readFileSync(abs, 'utf8')
  } catch (e) {
    return { ok: false, reason: `the file could not be read: ${e instanceof Error ? e.message : String(e)}` }
  }

  // An EMPTY backup is the specific case worth naming. A truncated backup restores successfully and
  // leaves an empty file, which reads as "rolled back" and is in fact data loss.
  if (restored.length === 0) {
    return { ok: false, reason: `the backup at "${backup}" is EMPTY; restoring it would destroy the file rather than recover it` }
  }
  if (restored.length > MAX_EDIT_BYTES) {
    return { ok: false, reason: `the backup is ${restored.length} characters, above the ${MAX_EDIT_BYTES} bound` }
  }

  const currentDigest = digest(current)

  // The guard that makes rollback safe in a shared workspace: an intervening change is not silently
  // discarded. The caller must state what it believes is there now.
  const expected = args.expectCurrentDigest
  if (expected !== undefined) {
    if (typeof expected !== 'string') {
      return { ok: false, reason: '`expectCurrentDigest` must be a string when supplied' }
    }
    if (expected !== currentDigest) {
      return {
        ok: false,
        reason: `the file has changed since the rollback was planned (digest ${currentDigest}, expected ${expected}). ` +
          `Rolling back now would discard a change this mission did not make.`,
      }
    }
  }

  if (current === restored) {
    return { ok: false, reason: 'the file already matches its backup, so there is nothing to roll back' }
  }

  return { ok: true, path: abs, backup, current, restored, currentDigest }
}

export function rollbackRegistration(deps: RollbackDeps): ToolRegistration {
  const tool: Tool = {
    name: 'rollback-file',
    mode: 'filesystem',
    async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      const plan = rollbackPlan(deps.workspaceRoot, args)
      if (!plan.ok) return { kind: 'failed', reason: plan.reason }
      // NOTE: the backup is NOT overwritten by a rollback. It stays as the original, so a second
      // rollback is still possible and the history is not destroyed by undoing.
      writeFileSync(plan.path, plan.restored, 'utf8')
      return {
        kind: 'data',
        data: {
          path: plan.path,
          backup: plan.backup,
          currentDigest: plan.currentDigest,
          restoredDigest: digest(plan.restored),
        },
        summary: `rolled ${plan.path} back to its backup`,
      }
    },
  }

  return {
    tool,
    capabilities: ['filesystem.rollback'],
    effectOf: (step: Step) => {
      // The SAME gate discipline as `edit`: a step that preflight refuses declares NO effect,
      // because there is nothing to authorise - it will not run. Offering a human the chance to
      // approve a rollback with no backup would be asking them to decide about something that
      // cannot happen.
      const args = step.args as Record<string, unknown>
      const plan = rollbackPlan(deps.workspaceRoot, args)
      if (!plan.ok) return undefined
      return {
        kind: 'delete' as const,
        target: plan.path,
        reason: `overwrite ${plan.path} with the content it had before the last edit`,
        irreversible: false,
      }
    },
    preflight: (step: Step) => {
      const plan = rollbackPlan(deps.workspaceRoot, step.args as Record<string, unknown>)
      if (plan.ok) return undefined
      return { blocked: `rollback refused: ${plan.reason}`, needsHuman: false }
    },
  }
}

/**
 * INDEPENDENT VERIFICATION of a rollback.
 *
 * It reads the target from disk and the backup from disk, and requires they are byte-identical. That
 * is the whole property: a rollback is "the file is what it was", and anything weaker is a claim.
 *
 * It does NOT read the tool's reported digests as proof - it recomputes nothing it can simply compare
 * two files, because two files is the evidence.
 */
export function rollbackVerifier(deps: RollbackDeps): Verifier {
  return {
    verifies: (step: Step) => step.tool === 'rollback-file',
    async verify(step: Step, _ctx: ToolContext, toolData: unknown) {
      const args = step.args as Record<string, unknown>
      const claimed = toolData as { path?: string; backup?: string } | undefined
      const scoped = resolveInside(deps.workspaceRoot, String(args.path ?? ''))
      if ('error' in scoped) return { rejected: `refused to verify: ${scoped.error}` }
      const abs = scoped.path
      const backup = abs + BACKUP_SUFFIX

      if (!claimed?.path) return { rejected: 'the rollback named no path' }
      if (!existsSync(abs)) return { rejected: `an independent stat found no file at "${abs}"` }
      if (!existsSync(backup)) return { rejected: `the backup "${backup}" is gone, so this cannot be a rollback` }

      const onDisk = readFileSync(abs, 'utf8')
      const original = readFileSync(backup, 'utf8')
      if (original.length === 0) {
        return { rejected: 'the backup is empty, so the file on disk is not a restored original' }
      }
      if (onDisk !== original) {
        return {
          rejected: `the file does not match its backup after the rollback ` +
            `(file ${onDisk.length} chars, backup ${original.length} chars)`,
        }
      }
      return {
        evidence: { kind: 'file-rolled-back', path: abs, bytes: Buffer.byteLength(onDisk) } as unknown as Evidence,
      }
    },
  }
}

export { digest as rollbackDigest }
void statSync