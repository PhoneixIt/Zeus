/**
 * OPERAND SAFETY.
 *
 * A folder named by a user is an OPERAND, not an instruction. It selects what to look at. It
 * never says where to write, and it never widens what may be touched.
 *
 * The distinction matters because the failure mode is mundane and severe: an objective reading
 * "summarise C:\Users\Samer and put the summary in System32" is not a request with an unusual
 * path in it, it is two instructions wearing one sentence. So paths arriving from an objective
 * are checked, and the output destination is decided by the CALLER, not parsed from the text.
 *
 * EVERY CHECK REFUSES BY DEFAULT
 *
 * Each validator returns a reason, not a boolean, because "it failed" is useless to a user and
 * "it failed because that is a file, not a folder" is actionable. And each refuses unless it can
 * affirmatively establish the property - absence of evidence is never read as permission.
 */

import { statSync, existsSync, readdirSync } from 'node:fs'
import { isAbsolute, resolve, sep, join, relative } from 'node:path'

export type Refusal = { readonly ok: false; readonly reason: string }
export type Allowed = { readonly ok: true }
export type Check = Allowed | Refusal

const refuse = (reason: string): Refusal => ({ ok: false, reason })

/**
 * A folder the plan may READ.
 *
 * Must exist, must be a directory, and must be readable. Nothing here restricts WHICH folder -
 * the user is entitled to ask about any folder on their machine - because reading a directory
 * the user named is not a safety question. It is a legibility question, and the checks below
 * exist to turn "that folder is not usable" into a clear message instead of a confusing
 * downstream failure.
 */
export function checkReadableFolder(raw: string): Check {
  if (!raw || raw.trim().length === 0) return refuse('no folder was named in the objective')
  const p = resolve(raw.trim())
  if (!existsSync(p)) return refuse(`the folder "${raw}" does not exist`)
  let st
  try {
    st = statSync(p)
  } catch (e) {
    return refuse(`the folder "${raw}" could not be inspected: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!st.isDirectory()) return refuse(`"${raw}" is a file, not a folder`)
  try {
    readdirSync(p)
  } catch (e) {
    return refuse(`the folder "${raw}" cannot be read: ${e instanceof Error ? e.message : String(e)}`)
  }
  return { ok: true }
}

/**
 * True when `candidate` is inside `root`.
 *
 * Compared on RESOLVED absolute paths with an explicit separator, because the naive
 * `startsWith(root)` test is wrong in a way that matters: `C:\Users\Samer\DocumentsEvil` starts
 * with `C:\Users\Samer\Documents` and is a different directory. Appending the separator is what
 * makes the prefix test mean containment.
 */
export function isInside(root: string, candidate: string): boolean {
  const r = resolve(root)
  const c = resolve(candidate)
  if (c === r) return true
  return c.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * A file the plan may CREATE, inside the caller's output root, that does not already exist.
 *
 * Three properties, all required:
 *   1. inside the output root, after resolution
 *   2. a plain file name - no traversal, no absolute path smuggled through `..`
 *   3. not already present, so the operation cannot overwrite anything
 *
 * Refusing to overwrite is what makes the whole scenario reversible: there is no code path here
 * that can damage an existing file, because there is no code path here that can open one for
 * writing.
 */
export function checkNewOutputFile(outputRoot: string, fileName: string): Check {
  if (!fileName || fileName.trim().length === 0) return refuse('no output file name was given')
  const name = fileName.trim()

  // 2. a bare file name. Anything with a separator or a drive is a path, not a name.
  if (name.includes('/') || name.includes('\\')) {
    return refuse(`the output name "${name}" contains a path separator; give a file name, not a path`)
  }
  if (isAbsolute(name)) return refuse(`the output name "${name}" is an absolute path; give a file name`)

  const target = join(resolve(outputRoot), name)

  // 1. containment, re-checked after joining rather than trusted from the argument.
  if (!isInside(outputRoot, target)) {
    return refuse(`the output file "${target}" would fall outside the permitted output folder ${resolve(outputRoot)}`)
  }

  // 3. must not exist.
  if (existsSync(target)) {
    return refuse(`"${name}" already exists in ${resolve(outputRoot)}; this operation creates new files only and will not overwrite`)
  }
  return { ok: true }
}

/** Expands `~` and environment variables the way a user typing a path expects. */
export function expandPath(raw: string): string {
  let p = raw.trim()
  if (p.startsWith('~')) p = join(process.env.USERPROFILE ?? process.env.HOME ?? '', p.slice(1))
  p = p.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k) => process.env[k] ?? m)
  return resolve(p)
}

/** True when `child` escapes `parent`. Used by tests and by the containment report. */
export function escapes(child: string, parent: string): boolean {
  return !isInside(parent, child) && resolve(child) !== resolve(parent)
}

/** A short, human-readable statement of what a folder contains, for the plan report. */
export function describeFolder(path: string): string {
  try {
    const names = readdirSync(path)
    return `${names.length} entr${names.length === 1 ? 'y' : 'ies'}`
  } catch {
    return 'unreadable'
  }
}

/** Exported so a caller can state the boundary in a plan report rather than implying one. */
export function relativeTo(root: string, p: string): string {
  const r = relative(resolve(root), resolve(p))
  return r === '' ? '.' : r
}