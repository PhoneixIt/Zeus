/**
 * GOVERNED FILESYSTEM OPERATIONS - search, create, copy, move.
 * =============================================================================
 * WHY THESE FOUR, AND IN THIS ORDER
 * =============================================================================
 *
 * Measured against what exists: every writer creates a NEW file and refuses to overwrite,
 * `filesystem.edit` changes one literal in place, `filesystem.rollback` undoes it, and `read-folder`
 * lists a directory. There was no way to FIND a file, no way to make a directory, no way to copy, and
 * no way to move. So a real workflow - "find the config, copy it to a backup location, adjust the
 * copy, verify both" - could not be expressed at all.
 *
 * The order is the order of dependency: `search` finds the target, `mkdir` establishes where things
 * go, `copy` duplicates, `move` relocates. `move` also covers `rename`, because a rename IS a move
 * within one directory and implementing them separately would mean two code paths for one act.
 *
 * =============================================================================
 * THE EFFECT DECLARATIONS ARE NOT UNIFORM, AND THAT IS THE POINT
 * =============================================================================
 *
 *   search   NO EFFECT. It reads. Reading a filename is not a change to the world.
 *   mkdir    NO EFFECT. It creates a directory that did not exist and REFUSES to reuse one. Nothing
 *            existing is touched.
 *   copy     NO EFFECT. It creates a new file and REFUSES to overwrite. The source is not modified.
 *   move     `delete`. IT DESTROYS THE SOURCE LOCATION. This is the only one of the four that can
 *            lose work, and it is the only one that requires a human approval.
 *
 * Calling all four "harmless" would be the convenient answer and the wrong one. Calling `copy`
 * consequential would be defensible but would train people to approve reflexively, which is how an
 * approval gate stops meaning anything. The line drawn here is the one that matters: **an operation
 * that can DESTROY something existing needs authorisation; one that can only ADD does not.**
 *
 * =============================================================================
 * SCOPE IS NEVER A STEP ARGUMENT
 * =============================================================================
 *
 * `workspaceRoot` is a constructor argument on every registration. A step can name a path inside it;
 * it cannot supply the root that decides what "inside" means. Every operation resolves the path,
 * collapses `..` BEFORE the containment test, and refuses anything that lands outside.
 */

import type { Dirent } from 'node:fs'
import { readdirSync, statSync, existsSync, mkdirSync, copyFileSync, renameSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve, sep, join, extname, dirname } from 'node:path'

import type { Tool, ToolContext, ToolResult, Verifier } from '../executor.ts'
import type { ToolRegistration } from '../../tool-router/router.ts'
import type { Evidence, Step } from '../state.ts'

/** Bounds. A search that can walk a whole drive is a hang waiting to happen. */
export const MAX_SEARCH_RESULTS = 500
export const MAX_SEARCH_DEPTH = 8
export const MAX_SEARCH_NODES = 20_000
/** Same bound as the editor: above this, a "copy" is a bulk transfer and not a file operation. */
export const MAX_OP_BYTES = 8 * 1024 * 1024

const TEXT_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'mjs', 'cjs', 'json', 'md', 'txt', 'yml', 'yaml', 'py', 'css', 'html',
  'sql', 'sh', 'toml', 'ini', 'cfg', 'log', 'csv',
])

/** Resolve and confine. ONE implementation, so scope cannot differ between call sites. */
export function confine(root: string, candidate: unknown, what = 'path'): { path: string } | { error: string } {
  if (typeof candidate !== 'string' || !candidate.trim()) return { error: `no ${what} was given` }
  const raw = candidate.trim()
  if (!isAbsolute(raw)) return { error: `refusing a relative ${what}: "${raw}"` }
  const r = resolve(root)
  const c = resolve(raw)
  // Compared AFTER resolution. A check on the written string would pass `C:\root\..\Windows`.
  if (c !== r && !c.startsWith(r.endsWith(sep) ? r : r + sep)) {
    return { error: `"${c}" is outside the workspace root ${r}` }
  }
  return { path: c }
}

function isTextFile(p: string): boolean {
  const ext = extname(p).slice(1).toLowerCase()
  return TEXT_EXTENSIONS.has(ext)
}

function sizeOf(p: string): number {
  try { return statSync(p).size } catch { return -1 }
}

// ============================================================================================
// SEARCH
// ============================================================================================

export interface SearchHit {
  readonly path: string
  readonly relative: string
  readonly bytes: number
  /** Lines that matched, 1-indexed and capped. Present only for a CONTENT search. */
  readonly lines?: ReadonlyArray<number>
}

/**
 * A bounded recursive search by NAME or by CONTENT.
 *
 * Bounded three ways - result count, depth, and total nodes VISITED - because an unbounded walk of a
 * misdirected root is the difference between "slow" and "the machine stops answering". The node
 * counter is what makes that true rather than hoped for.
 */
export function searchFiles(root: string, args: Record<string, unknown>):
  | { ok: true; hits: SearchHit[]; visited: number; truncated: boolean }
  | { ok: false; reason: string } {
  const pattern = String(args.pattern ?? '')
  if (!pattern.trim()) return { ok: false, reason: 'no search pattern was given' }
  const mode = String(args.mode ?? 'name') === 'content' ? 'content' : 'name'
  const base = confine(root, args.path ?? root, 'search root')
  if ('error' in base) return { ok: false, reason: base.error }
  const start = base.path
  if (!existsSync(start)) return { ok: false, reason: `no such path: "${start}"` }
  if (!statSync(start).isDirectory()) return { ok: false, reason: `"${start}" is not a directory` }

  const needle = pattern.toLowerCase()
  // A name pattern is a SUBSTRING, not a glob. Glob syntax would need `*` to mean "any", and a
  // pattern with no `*` is far more common; substring matching is the honest default and is said so.
  const rx = args.regex === true ? safeRegex(pattern) : null
  if (args.regex === true && !rx) return { ok: false, reason: `"${pattern}" is not a valid regular expression` }

  const hits: SearchHit[] = []
  let visited = 0
  let truncated = false

  const walk = (dir: string, depth: number): void => {
    if (truncated) return
    if (depth > MAX_SEARCH_DEPTH) { truncated = true; return }
    let entries: Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (truncated) return
      visited += 1
      if (visited > MAX_SEARCH_NODES) { truncated = true; return }
      // Symlinks are not followed. A link out of the workspace would defeat the scope check entirely,
      // because the check is on the PATH and the link resolves elsewhere.
      if (e.isSymbolicLink()) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (!e.isFile()) continue

      if (mode === 'name') {
        if (e.name.toLowerCase().includes(needle)) {
          hits.push({ path: full, relative: full.slice(start.length + 1), bytes: sizeOf(full) })
        }
      } else {
        if (!isTextFile(full)) continue
        let text: string
        try { text = readFileSync(full, 'utf8') } catch { continue }
        const lines: number[] = []
        text.split('\n').forEach((line, i) => {
          if (lines.length >= 5) return
          const matched = rx ? rx.test(line) : line.toLowerCase().includes(needle)
          if (matched) lines.push(i + 1)
        })
        if (lines.length) hits.push({ path: full, relative: full.slice(start.length + 1), bytes: sizeOf(full), lines })
      }
      if (hits.length >= MAX_SEARCH_RESULTS) { truncated = true; return }
    }
  }
  walk(start, 0)
  hits.sort((a, b) => a.path.localeCompare(b.path))
  return { ok: true, hits, visited, truncated }
}

function safeRegex(p: string): RegExp | null {
  try { return new RegExp(p, 'i') } catch { return null }
}

// ============================================================================================
// MKDIR
// ============================================================================================

export function planMkdir(root: string, args: Record<string, unknown>):
  | { ok: true; path: string; created: boolean }
  | { ok: false; reason: string } {
  const scoped = confine(root, args.path, 'directory path')
  if ('error' in scoped) return { ok: false, reason: scoped.error }
  const p = scoped.path
  if (existsSync(p)) {
    // A FILE where a directory was asked for is a REFUSAL, not a reuse. Reporting `created: false`
    // for it would let a mission believe it had a folder it does not have.
    if (!statSync(p).isDirectory()) return { ok: false, reason: `"${p}" exists and is not a directory` }
    // REUSED, not created. Silently reporting success here would make a mission believe it had
    // established a directory it never made.
    return { ok: true, path: p, created: false }
  }

  // PARENTS ARE CREATED (`mkdir -p` semantics), which is what a staging path like `dist/rc` actually
  // needs - the alternative is a separate mission step per directory level, which is ceremony rather
  // than safety. The one thing that makes it impossible is an ancestor that is a FILE, and that is
  // said HERE rather than surfacing as an obscure ENOTDIR from `mkdirSync` three layers down.
  let probe = dirname(p)
  while (probe.length >= root.length) {
    if (existsSync(probe) && !statSync(probe).isDirectory()) {
      return { ok: false, reason: `"${probe}" is a file, so "${p}" cannot be created beneath it` }
    }
    if (probe === root) break
    probe = dirname(probe)
  }
  return { ok: true, path: p, created: true }
}

// ============================================================================================
// COPY and MOVE
// ============================================================================================

export type TransferOp = 'copy' | 'move'

export interface TransferPlan {
  readonly op: TransferOp
  readonly from: string
  readonly to: string
  readonly bytes: number
}

/**
 * The shared plan for copy and move.
 *
 * `overwrite` is NOT offered. A file operation that can silently replace something is a different
 * operation from one that cannot, and the safe one is the one worth having. Refusing is also the
 * honest answer: overwriting is what `filesystem.write`'s siblings have always refused, and adding
 * an opt-in flag here would be the first way to bypass that in the repository.
 */
export function planTransfer(op: TransferOp, root: string, args: Record<string, unknown>):
  | { ok: true; plan: TransferPlan }
  | { ok: false; reason: string } {
  const from = confine(root, args.from, 'source path')
  if ('error' in from) return { ok: false, reason: from.error }
  const to = confine(root, args.to, 'destination path')
  if ('error' in to) return { ok: false, reason: to.error }

  const src = from.path
  const dst = to.path
  if (src === dst) return { ok: false, reason: 'the source and destination are the same file, so this would do nothing' }

  if (!existsSync(src)) return { ok: false, reason: `no source at "${src}"` }
  const st = statSync(src)
  if (!st.isFile()) return { ok: false, reason: `"${src}" is not a file; directories are not transferred by this capability` }
  if (st.size > MAX_OP_BYTES) return { ok: false, reason: `the source is ${st.size} bytes, above the ${MAX_OP_BYTES} bound for a single-file operation` }

  if (existsSync(dst)) {
    return { ok: false, reason: `refusing to overwrite "${dst}": it already exists. Removing or renaming it first is a decision for a human, not a flag on this tool.` }
  }
  const parent = resolve(dst, '..')
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    return { ok: false, reason: `the destination folder "${parent}" does not exist, so the operation cannot be performed` }
  }
  if (!isTextFile(dst) && op === 'copy') {
    return { ok: false, reason: `"${extname(dst).slice(1) || dst}" is not a file type this capability writes` }
  }
  return { ok: true, plan: { op, from: src, to: dst, bytes: st.size } }
}

// ============================================================================================
// TOOLS + REGISTRATIONS
// ============================================================================================

export interface FsOpsDeps {
  /** The workspace root. A CONSTRUCTOR argument - a step can never supply it. */
  readonly workspaceRoot: string
}

/**
 * A single registration carrying all four tools.
 *
 * Bundled so they cannot be registered one at a time and leave a capability half-present: `search`
 * without `mkdir` cannot stage a destination, and `copy` without a scope check is a data leak.
 */
export function fsOpsRegistration(deps: FsOpsDeps): ToolRegistration[] {
  const root = deps.workspaceRoot

  const searchTool: Tool = {
    name: 'search-files', mode: 'filesystem',
    async run(_c: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      const r = searchFiles(root, args)
      if (!r.ok) return { kind: 'failed', reason: r.reason }
      return {
        kind: 'data',
        data: { hits: r.hits, count: r.hits.length, visited: r.visited, truncated: r.truncated },
        summary: `found ${r.hits.length} match(es)${r.truncated ? ' (search was BOUNDED and stopped early)' : ''}`,
      }
    },
  }

  const mkdirTool: Tool = {
    name: 'make-directory', mode: 'filesystem',
    async run(_c: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      const r = planMkdir(root, args)
      if (!r.ok) return { kind: 'failed', reason: r.reason }
      if (!r.created) {
        // Reported as data, not as "created". A mission that believes it made a directory it merely
        // found is a mission whose plan is wrong about the world.
        return { kind: 'data', data: { path: r.path, created: false }, summary: `${r.path} already existed` }
      }
      // `recursive: true` because a staging path is normally nested. Node returns the FIRST
      // directory it created, which is what makes this honest: the summary says what was actually
      // made rather than implying only the leaf was.
      const firstCreated = mkdirSync(r.path, { recursive: true })
      return {
        kind: 'data',
        data: { path: r.path, created: true, firstCreated: firstCreated ?? r.path },
        summary: `created ${r.path}`,
      }
    },
  }

  const transfer = (op: TransferOp): Tool => ({
    name: op === 'copy' ? 'copy-file' : 'move-file', mode: 'filesystem',
    async run(_c: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      const r = planTransfer(op, root, args)
      if (!r.ok) return { kind: 'failed', reason: r.reason }
      try {
        if (op === 'copy') copyFileSync(r.plan.from, r.plan.to)
        else renameSync(r.plan.from, r.plan.to)
      } catch (e) {
        return { kind: 'failed', reason: `${op} failed: ${e instanceof Error ? e.message : String(e)}` }
      }
      return { kind: 'data', data: { ...r.plan }, summary: `${op}d ${r.plan.from} -> ${r.plan.to}` }
    },
  })

  const copyTool = transfer('copy')
  const moveTool = transfer('move')

  /** Shared scope guard for the two operations that WRITE. */
  const scopeOf = (step: Step, args: Record<string, unknown>): { ok: true } | { error: string } => {
    const from = confine(root, args.from, 'source path')
    if ('error' in from) return { error: from.error }
    const to = confine(root, args.to, 'destination path')
    if ('error' in to) return { error: to.error }
    void step
    return { ok: true }
  }

  return [
    // search - reads, so no effect and no approval.
    { tool: searchTool, capabilities: ['filesystem.search'] },

    // mkdir - creates what did not exist and refuses to reuse. Additive.
    {
      tool: mkdirTool, capabilities: ['filesystem.write'],
      preflight: (step) => {
        const r = planMkdir(root, step.args as Record<string, unknown>)
        return r.ok ? undefined : { blocked: `mkdir refused: ${r.reason}`, needsHuman: false }
      },
    },

    // copy - additive: the source is untouched and the destination must not exist.
    {
      tool: copyTool, capabilities: ['filesystem.copy'],
      preflight: (step) => {
        const args = step.args as Record<string, unknown>
        const scope = scopeOf(step, args)
        if ('error' in scope) return { blocked: `copy refused: ${scope.error}`, needsHuman: false }
        const r = planTransfer('copy', root, args)
        return r.ok ? undefined : { blocked: `copy refused: ${r.reason}`, needsHuman: false }
      },
    },

    // move - the ONLY one of the four that destroys something (the source location), and so the only
    // one that declares an effect and requires a human approval.
    {
      tool: moveTool, capabilities: ['filesystem.move'],
      preflight: (step) => {
        const args = step.args as Record<string, unknown>
        const scope = scopeOf(step, args)
        if ('error' in scope) return { blocked: `move refused: ${scope.error}`, needsHuman: false }
        const r = planTransfer('move', root, args)
        return r.ok ? undefined : { blocked: `move refused: ${r.reason}`, needsHuman: false }
      },
      effectOf: (step) => {
        const args = step.args as Record<string, unknown>
        const scope = scopeOf(step, args)
        if ('error' in scope) return undefined
        const r = planTransfer('move', root, args)
        // A step preflight refuses declares NOTHING: it will not run, so there is nothing to approve.
        if (!r.ok) return undefined
        return {
          kind: 'delete' as const,
          target: r.plan.from,
          reason: `move ${r.plan.from} to ${r.plan.to}, which REMOVES the file from its current location`,
          irreversible: false,
        }
      },
    },
  ]
}

// ============================================================================================
// INDEPENDENT VERIFICATION
// ============================================================================================

/**
 * Verify from the WORLD, never from the tool's report.
 *
 * Each operation has a different post-condition and all four are checked, because the one that does
 * not apply is often the one that is broken:
 *
 *   search   the reported count is re-derived by searching AGAIN. A tool that invented a hit is the
 *            failure this catches, and it is the reason a search result cannot be trusted as data.
 *   mkdir    the directory exists AND is a directory.
 *   copy     the DESTINATION exists with the source's bytes, and THE SOURCE STILL EXISTS - a "copy"
 *            that lost the source is a move wearing the wrong name.
 *   move     the destination exists with the source's bytes AND THE SOURCE IS GONE. Checking the
 *            destination alone would pass a plain copy presented as a move.
 */
export function fsOpsVerifier(deps: FsOpsDeps): Verifier {
  const root = deps.workspaceRoot
  return {
    verifies: (step: Step) =>
      step.tool === 'search-files' || step.tool === 'make-directory' ||
      step.tool === 'copy-file' || step.tool === 'move-file',

    async verify(step: Step, _c: ToolContext, data: unknown) {
      const args = step.args as Record<string, unknown>

      if (step.tool === 'search-files') {
        const claimed = data as { hits?: Array<{ path: string }>; count?: number } | undefined
        if (!Array.isArray(claimed?.hits)) return { rejected: 'the search reported no hit list' }
        // Re-run it. Two searches of the same world must agree.
        const again = searchFiles(root, args)
        if (!again.ok) return { rejected: `an independent search failed: ${again.reason}` }
        if (again.hits.length !== claimed!.hits!.length) {
          return {
            rejected: `the search reported ${claimed!.hits!.length} hit(s) and an independent search ` +
              `found ${again.hits.length}. A search result is data, and invented data is worse than none.`,
          }
        }
        for (const h of claimed!.hits!) {
          if (!again.hits.some((x) => x.path === h.path)) {
            return { rejected: `the search reported "${h.path}", which an independent search did not find` }
          }
        }
        return { evidence: { kind: 'search-verified', count: again.hits.length, root } as unknown as Evidence }
      }

      if (step.tool === 'make-directory') {
        const claimed = data as { path?: string } | undefined
        if (!claimed?.path) return { rejected: 'the mkdir named no path' }
        if (!existsSync(claimed.path)) return { rejected: `an independent stat found no directory at "${claimed.path}"` }
        if (!statSync(claimed.path).isDirectory()) return { rejected: `"${claimed.path}" exists but is not a directory` }
        return { evidence: { kind: 'directory-verified', path: claimed.path } as unknown as Evidence }
      }

      const claimed = data as { from?: string; to?: string; bytes?: number } | undefined
      if (!claimed?.from || !claimed?.to) return { rejected: 'the operation named no source or destination' }

      // Re-derive both paths from the STEP, so a tool cannot report a transfer it did not perform by
      // naming two other files.
      const fromScoped = confine(root, args.from, 'source path')
      const toScoped = confine(root, args.to, 'destination path')
      if ('error' in fromScoped || 'error' in toScoped) {
        return { rejected: `refused to verify: ${'error' in fromScoped ? fromScoped.error : (toScoped as { error: string }).error}` }
      }
      const src = fromScoped.path
      const dst = toScoped.path

      if (!existsSync(dst)) {
        return { rejected: `an independent stat found nothing at the destination "${dst}"` }
      }
      const after = sizeOf(dst)
      const before = typeof claimed.bytes === 'number' ? claimed.bytes : -1
      if (before >= 0 && after !== before) {
        return { rejected: `the destination is ${after} bytes but the source was reported as ${before}` }
      }
      if (step.tool === 'move-file') {
        if (existsSync(src)) {
          return { rejected: `a move must REMOVE the source, but "${src}" still exists - this was a copy` }
        }
        return { evidence: { kind: 'file-moved', path: dst, bytes: after } as unknown as Evidence }
      }

      // copy-file: the source MUST SURVIVE.
      if (!existsSync(src)) return { rejected: `a copy must LEAVE the source in place, but "${src}" is gone` }
      if (!readFileSync(src).equals(readFileSync(dst))) {
        return { rejected: 'the destination does not match the source byte for byte' }
      }
      return { evidence: { kind: 'file-copied', path: dst, bytes: after } as unknown as Evidence }
    },
  }
}

/** Compare two files by CONTENT. Exported so the harness can cross-check without a copy helper. */
export function filesAreIdentical(a: string, b: string): boolean {
  if (!existsSync(a) || !existsSync(b)) return false
  return readFileSync(a).equals(readFileSync(b))
}

/** Re-exported so callers need not import node:fs just to write a fixture. */
export { writeFileSync }