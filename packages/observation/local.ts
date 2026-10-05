/**
 * THE READ-ONLY OBSERVER.
 *
 * It reports facts. It does not act, and the type system is arranged so that "acts" is not a
 * mistake available to make.
 *
 * WHY READ-ONLY IS STRUCTURAL AND NOT A RULE
 *
 * This module imports `node:fs` and nothing else that can have an effect. It opens directories,
 * stats files, resolves paths and reads the terminal policy's allowlist - a fixed table - to decide
 * which executables exist. It cannot spawn, cannot write, cannot reach a ControlSurface, cannot
 * grant a permission and cannot record an approval, because it has no import through which to do
 * any of them. `test/observation.test.ts` asserts that by inspecting the import graph, and control D
 * in the live harness attempts a write through the provider to show the attempt has nowhere to go.
 *
 * The one thing it does that looks like power is following a junction, and even that is bounded: it
 * records where a path RESOLVED to, so a symlink pointing outside the root is visible as a fact
 * rather than silently walked.
 *
 * WHAT IT DELIBERATELY DOES NOT OBSERVE
 *
 * Processes, windows, the registry, network state, environment variables, the clipboard, keystrokes,
 * other users' files. Some of these are safely readable and some are not, and the ones that are not
 * are exactly the ones that would turn an observer into surveillance. The list is short on purpose:
 * a world state that grows to describe everything stops being evidence of anything.
 */

import { readdirSync, statSync, realpathSync, lstatSync } from 'node:fs'
import { join, resolve, extname, relative, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
// Two data tables with no behaviour. See the note in `capabilities()` for why this is a static
// import rather than a lazy `require`.
import { buildAllowlist, REFUSED_PROGRAMS } from './allowlist-view.ts'
import type {
  WorldState, WorldEntry, EntryKind, ObservedCapability, ObservationError, ObservationScope,
} from './world.ts'

/**
 * THE PROVIDER INTERFACE.
 *
 * One method. A planner receives what this returns and has no other way to learn anything about the
 * machine, which is what makes "the planner is world-aware" a checkable property rather than a
 * claim: give it a provider and it knows that much, no more.
 */
export interface ObservationProvider {
  readonly name: string
  /** What this provider can report, for a planner deciding whether to ask. */
  observes(): readonly string[]
  /**
   * Reports the state of `scope`. Read-only by contract, and the local implementation is read-only
   * by construction.
   */
  observe(scope: ObservationScope): WorldState
}

/** How many entries to walk before stopping and saying so. */
const DEFAULT_ENTRY_CAP = 2000

function kindOf(lstat: ReturnType<typeof lstatSync>): EntryKind {
  if (lstat.isSymbolicLink()) return 'symlink'
  if (lstat.isDirectory()) return 'directory'
  if (lstat.isFile()) return 'file'
  return 'other'
}

/**
 * THE LOCAL PROVIDER. Filesystem and the executable allowlist, nothing else.
 *
 * The allowlist is consulted as DATA - it is a table in the policy module, and asking "is this path
 * permitted" is a comparison, not an act. Note what is deliberately NOT done: no attempt is made to
 * run a discovered executable to find out whether it works. An observer that executes what it
 * observes is no longer an observer.
 */
export class LocalObservationProvider implements ObservationProvider {
  readonly name = 'local-filesystem'

  observes(): readonly string[] {
    return [
      'files and folders under a root, with depth, kind, size and extension',
      'whether a specific path exists, and what it is',
      'which allowlisted executables are installed, and whether the policy permits them',
      'per-subtree file counts, so a plan can size itself against reality',
    ]
  }

  observe(scope: ObservationScope): WorldState {
    const observedAt = Date.now()
    const errors: ObservationError[] = []
    const entries: WorldEntry[] = []
    let truncated = false

    const root = resolve(scope.root)
    const extFilter = scope.extensions?.length
      ? new Set(scope.extensions.map((e) => e.toLowerCase().replace(/^\./, '')))
      : undefined

    // The root itself, so a plan can tell "empty folder" from "folder that does not exist".
    try {
      const st = lstatSync(root)
      const real = safeReal(root)
      entries.push({
        path: real,
        relative: '.',
        kind: kindOf(st),
        depth: 0,
        ...(st.isFile() ? { sizeBytes: st.size, modifiedAt: st.mtimeMs } : {}),
      })
    } catch (e) {
      errors.push({ path: root, reason: `the root could not be read: ${(e as Error).message}` })
    }

    const walk = (dir: string, depth: number) => {
      if (depth > scope.maxDepth) return
      if (entries.length >= DEFAULT_ENTRY_CAP) { truncated = true; return }
      let children: string[]
      try {
        children = readdirSync(dir)
      } catch (e) {
        errors.push({ path: dir, reason: `could not be listed: ${(e as Error).message}` })
        return
      }
      for (const name of children.sort()) {
        if (entries.length >= DEFAULT_ENTRY_CAP) { truncated = true; return }
        const full = join(dir, name)
        let lst: ReturnType<typeof lstatSync>
        try {
          lst = lstatSync(full)
        } catch (e) {
          errors.push({ path: full, reason: `could not be examined: ${(e as Error).message}` })
          continue
        }
        const kind = kindOf(lst)
        const real = safeReal(full)
        const rel = relative(root, full).replace(/\\/g, '/')
        const ext = extname(name).replace(/^\./, '').toLowerCase()

        if (kind === 'file' && extFilter && !extFilter.has(ext)) continue

        entries.push({
          path: real,
          relative: rel,
          kind,
          depth,
          ...(kind === 'file' ? { sizeBytes: lst.size, modifiedAt: lst.mtimeMs, extension: ext || undefined } : {}),
        })

        if (kind === 'directory') walk(full, depth + 1)
        // A symlink is RECORDED and not followed. Following it would let a link inside the
        // workspace walk the observer out of it, and the fact that a link exists is itself worth
        // planning around.
      }
    }

    try {
      if (lstatSync(root).isDirectory()) walk(root, 1)
    } catch (e) {
      errors.push({ path: root, reason: `could not be walked: ${(e as Error).message}` })
    }

    entries.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0))

    return {
      observationId: randomUUID(),
      observedAt,
      scope: { ...scope, root },
      entries,
      fingerprint: fingerprintOf(entries),
      capabilities: this.capabilities(),
      truncated,
      errors,
    }
  }

  /**
   * Which allowlisted programs are actually installed.
   *
   * `existsSync` on the absolute path only - never a PATH lookup, because a lookup would answer a
   * different question ("what would run if I typed this") than the one being asked ("is this
   * specific file present").
   */
  private capabilities(): ObservedCapability[] {
    // A static import, not `require`.
    //
    // The first version used a lazy `require` to keep the dependency "obviously harmless". Two
    // problems: `require` does not exist in this ESM module at all, so the observer threw on EVERY
    // call and took 36 tests with it; and a dynamic import is a worse thing to find in a module whose
    // entire claim is that it has no capability to act. The allowlist view is two data tables with no
    // behaviour, so importing it costs nothing and says exactly what it is.
    const sysRoot = process.env.SystemRoot ?? 'C:\\WINDOWS'
    const progFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
    const allowed = new Set(buildAllowlist(sysRoot, progFiles).map((p) => p.abs.toLowerCase()))

    return [
      join(progFiles, 'nodejs', 'node.exe'),
      join(progFiles, 'Git', 'cmd', 'git.exe'),
      join(sysRoot, 'System32', 'cmd.exe'),
    ].map((p) => {
      let exists = false
      try { exists = statSync(p).isFile() } catch { exists = false }
      const name = (p.split(/[\\/]/).pop() ?? p).toLowerCase()
      const refusal = REFUSED_PROGRAMS[name]
      return {
        path: p,
        name,
        exists,
        permitted: exists && allowed.has(p.toLowerCase()) && !refusal,
        ...(refusal ? { refusal } : exists && !allowed.has(p.toLowerCase()) ? { refusal: 'not on the executable allowlist' } : {}),
      } satisfies ObservedCapability
    })
  }
}

function safeReal(p: string): string {
  try { return realpathSync.native(p) } catch { return p }
}

/**
 * The fingerprint: every entry's path, kind and size, in a stable order.
 *
 * A digest of LISTING METADATA. It detects additions, removals, renames and resizes, and it does NOT
 * detect a same-length in-place edit - the limit is documented on `WorldState.fingerprint`, was found
 * by a test that asserted the stronger claim and failed, and is left visible rather than papered over.
 */
export function fingerprintOf(entries: readonly WorldEntry[]): string {
  const h = createHash('sha256')
  for (const e of entries) {
    h.update(`${e.relative}|${e.kind}|${e.sizeBytes ?? 0}\n`)
  }
  return h.digest('hex').slice(0, 16)
}

/** A provider that reports nothing, for controls and for callers with no observer. */
export class NoObservationProvider implements ObservationProvider {
  readonly name = 'none'
  observes(): readonly string[] { return [] }
  observe(scope: ObservationScope): WorldState {
    return {
      observationId: 'none', observedAt: Date.now(), scope, entries: [],
      fingerprint: fingerprintOf([]), capabilities: [], truncated: false,
      errors: [{ path: scope.root, reason: 'no observation provider is configured' }],
    }
  }
}
