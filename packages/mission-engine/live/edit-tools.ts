/**
 * GOVERNED FILE EDITING - the first capability that CHANGES something that already exists.
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 *
 * Every writer in this repository creates a NEW file and refuses to overwrite: `write-probe-file`,
 * `write-report`, `write-file-summary`, `write-page-summary`. That is correct for them - they are
 * report writers, and refusing to clobber keeps every scenario reversible.
 *
 * But it means AIOS cannot currently modify a file that exists. A software-development mission is
 * observe -> change -> execute -> verify, and the middle step was impossible. This supplies it, and
 * only it.
 *
 * =============================================================================
 * WHAT MAKES AN EDIT SAFE HERE
 * =============================================================================
 *
 * FOUR properties, each of which is a refusal rather than a convenience:
 *
 *   1. SCOPE. The target must be absolute and inside a workspace root given to the TOOL, not to the
 *      step. A path is resolved and checked BEFORE anything is opened, so `..` segments and absolute
 *      escapes are rejected on the resolved string rather than trusted on the written one.
 *
 *   2. EXACT MATCH, NOT REGEX. The edit names the literal text to find. A regex is a program; a
 *      literal is a string. `find` must occur exactly `occurrences` times - no more, no fewer - so
 *      an edit that would match somewhere unintended FAILS instead of silently changing three places.
 *
 *   3. REVERSIBILITY. The previous content is written to a sidecar backup BEFORE the edit, and the
 *      edit is refused outright if the backup cannot be written. A change that cannot be undone is
 *      not a change this capability will make.
 *
 *   4. AUTHORISATION. The registration declares an effect, so the executor's approval gate engages.
 *      Editing a file DISCARDS the content that was there, so it is declared as `delete` with
 *      `irreversible: false` - honest, because the backup exists. A plan cannot declare it away.
 */

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs'
import { isAbsolute, resolve, sep, dirname } from 'node:path'

import type { Tool, ToolContext, ToolResult, Verifier } from '../executor.ts'
import type { ToolRegistration } from '../../tool-router/router.ts'
import type { Evidence, Step } from '../state.ts'

/** Refuse anything that is not plainly a text file, on the same grounds as the file summariser. */
const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'mjs', 'cjs', 'json', 'md', 'txt', 'yml', 'yaml',
  'py', 'css', 'html', 'sql', 'sh', 'toml', 'ini', 'cfg',
])

/** The sidecar suffix. Not an extension anyone has, so it cannot collide with a real file. */
export const BACKUP_SUFFIX = '.aios-backup'

/** Above this, an edit is refused: a whole-file replacement is a write, not an edit. */
export const MAX_EDIT_BYTES = 1024 * 1024

export interface EditFacts {
  readonly path: string
  readonly backup: string
  readonly find: string
  readonly replace: string
  readonly occurrences: number
  readonly bytesBefore: number
  readonly bytesAfter: number
  /** The content as it was, re-derivable from the backup. Never taken from the tool on trust. */
  readonly before: string
}

/** Resolve and confine. The single place path scope is decided, so it cannot differ per call site. */
export function resolveInside(root: string, candidate: string): { path: string } | { error: string } {
  if (!isAbsolute(candidate)) return { error: `refusing a relative path: "${candidate}"` }
  const r = resolve(root)
  const c = resolve(candidate)
  // Compared on RESOLVED strings. A check on the written path would pass `C:\root\..\other`.
  if (c !== r && !c.startsWith(r.endsWith(sep) ? r : r + sep)) {
    return { error: `"${c}" is outside the workspace root ${r}` }
  }
  return { path: c }
}

export interface EditDeps {
  /**
   * The workspace root. A CONSTRUCTOR argument, like the navigation policy.
   *
   * If the root came from a step's arguments, a plan could name any root it liked and the scope
   * check would be theatre. It cannot be widened from a step.
   */
  readonly workspaceRoot: string
}

/** Read the current content and decide whether the edit is well-formed, without writing anything. */
export function planEdit(root: string, args: Record<string, unknown>):
  | { ok: true; path: string; backup: string; find: string; replace: string; occurrences: number; before: string; after: string }
  | { ok: false; reason: string } {
  const raw = String(args.path ?? '')
  const find = String(args.find ?? '')
  const replace = String(args.replace ?? '')

  if (!raw) return { ok: false, reason: 'no path given' }
  if (!find) return { ok: false, reason: 'no `find` text given - an edit must say what it is replacing' }
  if (find === replace) return { ok: false, reason: 'the `find` and `replace` text are identical, so this would change nothing' }

  const scoped = resolveInside(root, raw)
  if ('error' in scoped) return { ok: false, reason: scoped.error }
  const abs = scoped.path

  const ext = abs.includes('.') ? (abs.split('.').pop() ?? '').toLowerCase() : ''
  if (!TEXT_EXTENSIONS.has(ext)) {
    return { ok: false, reason: `"${ext || abs}" is not a text type this editor will modify` }
  }
  if (!existsSync(abs)) return { ok: false, reason: `no file at "${abs}" - this capability EDITS an existing file and does not create one` }
  const st = statSync(abs)
  if (st.isDirectory()) return { ok: false, reason: `"${abs}" is a directory, not a file` }
  if (st.size > MAX_EDIT_BYTES) {
    return { ok: false, reason: `refusing to edit a ${st.size}-byte file: above ${MAX_EDIT_BYTES} this is a rewrite, not an edit` }
  }

  const before = readFileSync(abs, 'utf8')

  // Counted on the WHOLE file, not per line, so a multi-line `find` is matched as one unit.
  const occurrences = before.split(find).length - 1
  if (occurrences === 0) {
    return { ok: false, reason: `the text to replace does not appear in ${abs}; nothing was changed` }
  }

  // An edit that matches in several places is almost always a mistake, and silently changing all of
  // them is how a one-line fix becomes a three-line surprise. The caller may assert the count.
  const claimed = args.occurrences === undefined ? 1 : Number(args.occurrences)
  if (!Number.isInteger(claimed) || claimed < 1) {
    return { ok: false, reason: `\`occurrences\` must be a positive integer, got ${JSON.stringify(args.occurrences)}` }
  }
  if (occurrences !== claimed) {
    return {
      ok: false,
      reason: `the text to replace appears ${occurrences} time(s) in ${abs}, but the step asserted ${claimed}. ` +
        `Nothing was changed - say which count you meant.`,
    }
  }

  return {
    ok: true,
    path: abs,
    backup: abs + BACKUP_SUFFIX,
    find,
    replace,
    occurrences,
    before,
    after: before.split(find).join(replace),
  }
}

/**
 * The registration: the tool plus its effect declaration.
 *
 * Returned as one object so the tool cannot be registered without the gate - the same reasoning as
 * `navigationRegistration`, and for the same reason.
 */

/**
 * The PATH-level checks only: in scope, a text file, exists, small enough.
 *
 * SEPARATE FROM `planEdit` because preflight and effectOf answer a different question. They are
 * asked "may this action happen at all?" - and they receive the PLAN step, which has no `prior`, so
 * a search text carried from an earlier step is not resolvable at that moment. Requiring it made
 * preflight block every such step as though it were out of scope, which is a refusal for the wrong
 * reason: an edit whose search text has not arrived yet is INCOMPLETE, not FORBIDDEN, and those are
 * different verdicts that must not share a message.
 *
 * So completeness is checked by the tool at run time, where `ctx.prior` exists, and scope is checked
 * here, where it can be checked honestly.
 */
export function planScope(root: string, args: Record<string, unknown>):
  | { ok: true; path: string; backup: string }
  | { ok: false; reason: string } {
  const raw = String(args.path ?? '')
  if (!raw) return { ok: false, reason: 'no path given' }
  const scoped = resolveInside(root, raw)
  if ('error' in scoped) return { ok: false, reason: scoped.error }
  const abs = scoped.path
  const ext = abs.includes('.') ? (abs.split('.').pop() ?? '').toLowerCase() : ''
  if (!TEXT_EXTENSIONS.has(ext)) return { ok: false, reason: `"${ext || abs}" is not a text type this editor will modify` }
  if (!existsSync(abs)) return { ok: false, reason: `no file at "${abs}" - this capability EDITS an existing file and does not create one` }
  const st = statSync(abs)
  if (st.isDirectory()) return { ok: false, reason: `"${abs}" is a directory, not a file` }
  if (st.size > MAX_EDIT_BYTES) return { ok: false, reason: `refusing to edit a ${st.size}-byte file: above ${MAX_EDIT_BYTES} this is a rewrite, not an edit` }
  return { ok: true, path: abs, backup: abs + BACKUP_SUFFIX }
}

export function editFileRegistration(deps: EditDeps): ToolRegistration {
  const tool: Tool = {
    name: 'edit-file',
    mode: 'filesystem',
    async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      // `find` may be taken from a PRIOR STEP rather than written into the plan.
      //
      // WHY: an edit must replace something that was OBSERVED. A plan that hard-codes the text to
      // search for is asserting the file's current contents, which it cannot know - the first
      // version of this recipe searched for `const VERSION = '` and produced
      // `export '1.1.0'1.0.0'` on a file it had never read. Reading the value in the inspect step
      // and carrying it forward is what makes the search text an observation rather than a guess,
      // and it is the only way the recipe can edit a value it does not know in advance.
      const resolved = { ...args }
      const from = args.findFrom as { step?: string; key?: string } | undefined
      if (from?.step && from?.key) {
        const prior = ctx.prior?.[from.step]?.output as Record<string, unknown> | undefined
        const value = prior?.[from.key]
        if (typeof value !== 'string' || !value) {
          return {
            kind: 'failed',
            reason: `step "${from.step}" did not provide a non-empty "${from.key}" to search for, so there is nothing to replace`,
          }
        }
        resolved.find = value
      }
      const plan = planEdit(deps.workspaceRoot, resolved)
      if (!plan.ok) return { kind: 'failed', reason: plan.reason }

      // The backup is written FIRST and its failure aborts the edit. If the previous content cannot
      // be preserved, the change is not made - there is no path where the file is modified and the
      // original is gone.
      try {
        mkdirSync(dirname(plan.backup), { recursive: true })
        writeFileSync(plan.backup, plan.before, 'utf8')
      } catch (e) {
        return {
          kind: 'failed',
          reason: `the backup could not be written, so the edit was NOT attempted: ${e instanceof Error ? e.message : String(e)}`,
        }
      }
      // Verify the backup by reading it back, not by trusting the write. A silently truncated
      // backup is worse than none, because the mission would report a reversible change.
      try {
        if (readFileSync(plan.backup, 'utf8') !== plan.before) {
          return { kind: 'failed', reason: 'the backup did not read back identically, so the edit was NOT attempted' }
        }
      } catch (e) {
        return { kind: 'failed', reason: `the backup could not be read back: ${e instanceof Error ? e.message : String(e)}` }
      }

      writeFileSync(plan.path, plan.after, 'utf8')
      const facts: EditFacts = {
        path: plan.path,
        backup: plan.backup,
        find: plan.find,
        replace: plan.replace,
        occurrences: plan.occurrences,
        bytesBefore: Buffer.byteLength(plan.before),
        bytesAfter: Buffer.byteLength(plan.after),
        before: plan.before,
      }
      return {
        kind: 'data',
        data: { ...facts, path: plan.path },
        summary: `edited ${plan.path} (${plan.occurrences} replacement${plan.occurrences === 1 ? '' : 's'}, backed up)`,
      }
    },
  }

  return {
    tool,
    capabilities: ['filesystem.edit'],
    effectOf: (step: Step) => {
      const plan = planScope(deps.workspaceRoot, step.args as Record<string, unknown>)
      // A step that preflight blocks declares NO effect: there is nothing to authorise, because it
      // will not run. Putting an approval request in front of a human for a refused edit is asking
      // them to decide about something that never happened.
      if (!plan.ok) return undefined
      return {
        kind: 'delete' as const,
        target: plan.path,
        reason: `replace the contents of ${plan.path}, discarding what is there now (a backup is written first)`,
        irreversible: false,
      }
    },
    preflight: (step: Step) => {
      const plan = planScope(deps.workspaceRoot, step.args as Record<string, unknown>)
      if (plan.ok) return undefined
      // needsHuman FALSE. A refused edit is not consequential-and-awaiting-signature; it is an action
      // the tool will not take. The distinction matters: reporting it as awaitable would imply a
      // person could authorise writing outside the workspace.
      return { blocked: `edit refused: ${plan.reason}`, needsHuman: false }
    },
  }
}

/**
 * INDEPENDENT VERIFICATION.
 *
 * It does NOT trust the tool's report. It re-reads the target from disk and the backup from disk,
 * and it RE-DERIVES what the file should contain by applying the same literal replacement to the
 * backup's content. Three things are checked, and each catches a different lie:
 *
 *   - the target now contains the replacement and no longer contains the searched text
 *   - the backup exists and equals the content the edit claims to have replaced
 *   - re-deriving from the backup reproduces the target byte for byte
 *
 * The third is the strong one. A tool that reported success without writing, wrote the wrong text, or
 * corrupted the file in passing all fail it, and none of them can be caught by reading the tool's
 * own `data` field.
 */
export function editFileVerifier(deps: EditDeps): Verifier {
  return {
    verifies: (step: Step) => step.tool === 'edit-file',
    async verify(step: Step, ctx: ToolContext, toolData: unknown) {
      const args = step.args as Record<string, unknown>
      const claimed = toolData as Partial<EditFacts> | undefined

      // Re-derive the plan from the CURRENT state of the world, not from what the tool said.
      const scoped = resolveInside(deps.workspaceRoot, String(args.path ?? ''))
      if ('error' in scoped) return { rejected: `refused to verify: ${scoped.error}` }
      const abs = scoped.path
      const replace = String(args.replace ?? '')

      // The search text may have come from an earlier step, and the verifier MUST resolve it from
      // the same source the tool did - otherwise `find` is empty here, `text.includes('')` is always
      // true, and every edit is rejected for "still containing the text it was supposed to
      // replace". The executor passes the run context to `verify`, so `ctx.prior` is available.
      const from = args.findFrom as { step?: string; key?: string } | undefined
      let find = String(args.find ?? '')
      if (!find && from?.step && from?.key) {
        const value = (ctx.prior?.[from.step]?.output as Record<string, unknown> | undefined)?.[from.key]
        if (typeof value !== 'string' || !value) {
          return { rejected: `the search text came from step "${from.step}" but is not available, so this edit cannot be verified` }
        }
        find = value
      }
      if (!find) return { rejected: 'no search text to verify against, so "still contains the original" cannot be checked' }

      if (!claimed?.path) return { rejected: 'the edit named no path' }
      if (!claimed.backup) return { rejected: 'the edit named no backup, so it cannot be shown to be reversible' }

      if (!existsSync(claimed.backup)) {
        return { rejected: `the backup "${claimed.backup}" does not exist, so this change cannot be undone` }
      }
      let original: string
      try {
        original = readFileSync(claimed.backup, 'utf8')
      } catch (e) {
        return { rejected: `the backup could not be read: ${e instanceof Error ? e.message : String(e)}` }
      }

      let current: string
      try {
        current = readFileSync(abs, 'utf8')
      } catch (e) {
        return { rejected: `the edited file could not be read: ${e instanceof Error ? e.message : String(e)}` }
      }

      // 1. The search text must be GONE, and the replacement present.
      if (current.includes(find)) {
        return { rejected: `the file still contains the text the edit was supposed to replace` }
      }
      if (replace.length > 0 && !current.includes(replace)) {
        return { rejected: `the file does not contain the replacement text it was supposed to gain` }
      }

      // 2. The backup must be what the tool claimed it replaced. Compared against the tool's own
      //    report so a tool that quietly discarded more than it said is caught.
      if (typeof claimed.before === 'string' && claimed.before !== original) {
        return { rejected: 'the backup does not match the previous content the edit reported replacing' }
      }

      // 3. THE STRONG ONE. Re-derive independently from the backup and compare byte for byte.
      const derived = original.split(find).join(replace)
      if (derived !== current) {
        return {
          rejected: `the file on disk is not what the backup implies it should be ` +
            `(re-derived ${derived.length} chars, on disk ${current.length} chars). ` +
            `Something other than the declared edit changed this file.`,
        }
      }

      return {
        evidence: {
          kind: 'file-edited',
          path: abs,
          bytes: Buffer.byteLength(current),
          occurrences: claimed.occurrences ?? 1,
        } as unknown as Evidence,
      }
    },
  }
}