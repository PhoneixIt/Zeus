/**
 * WORLD STATE. What is KNOWN, and what is merely assumed.
 *
 * The contract exists to answer one question honestly: *when the planner decides to do something,
 * what did it actually look at?* Without that, "the planner is world-aware" is a claim with nothing
 * behind it, and a plan that happens to suit the machine it was written on is indistinguishable
 * from a plan that suited reality.
 *
 * KNOWN VERSUS ASSUMED
 *
 * An `entries` array is a set of FACTS, each one obtained by a real filesystem call that can be
 * re-performed. Anything not in it is not a fact - it is unknown, and unknown is a state the
 * planner is required to handle rather than fill in. That is why there is no `files?: string[]` with
 * a default: an absent fact and an empty fact are different, and a planner that cannot tell them
 * apart will eventually write a summary of a folder it never listed.
 *
 * WHAT THIS IS NOT
 *
 * It is not a model of the computer. It carries no process table, no window list, no registry, no
 * network state, and no inference of any kind. "World state" here means exactly "what the safe
 * read-only capabilities could establish, with a record of how and when". Calling it situational
 * awareness would be a much larger claim than the code supports, and the gap between those two
 * words is the gap this project keeps having to defend.
 *
 * FRESHNESS
 *
 * Every state carries when it was taken, what it describes, and a fingerprint. The fingerprint is
 * what makes staleness CHECKABLE rather than a matter of opinion: re-observe and compare, and either
 * the world is the same or the plan was built on something that is no longer there. A timestamp
 * alone cannot answer that, because a world can change within the same millisecond.
 *
 * The rule this encodes: a plan may be built on an observation, but it must SAY which one. A plan
 * that cannot name its basis is a plan that cannot be held to anything.
 */

/** A file kind, resolved rather than guessed from the name. */
export type EntryKind = 'file' | 'directory' | 'symlink' | 'other'

/** One observed thing. Every field came from a syscall. */
export interface WorldEntry {
  /** Absolute, resolved through realpath, so a junction cannot present a path that is not there. */
  readonly path: string
  /** Path relative to the observed root, using forward slashes. */
  readonly relative: string
  readonly kind: EntryKind
  /** Depth below the root. 0 is the root itself. */
  readonly depth: number
  /** Lowercase extension without the dot, for files. */
  readonly extension?: string
  readonly sizeBytes?: number
  readonly modifiedAt?: number
}

/**
 * An executable the observer found, and whether it is one the terminal policy would permit.
 *
 * `permitted` is the OBSERVER's reading of the policy table, recorded at observation time. It is a
 * fact about the machine plus the table, not a grant: nothing here authorises running anything. It
 * exists so a plan can distinguish "node is installed" from "node may be launched", which are
 * different questions and are frequently confused.
 */
export interface ObservedCapability {
  /** Absolute path. Never a bare name: a name cannot be resolved without choosing. */
  readonly path: string
  readonly name: string
  readonly exists: boolean
  /** Whether the terminal allowlist contains this exact path. */
  readonly permitted: boolean
  /** Why it is not permitted, when it is not. Empty when it is. */
  readonly refusal?: string
}

/** A read that failed. Recorded rather than swallowed. */
export interface ObservationError {
  readonly path: string
  readonly reason: string
}

/** What an observation covers. A plan built on it can only speak about this. */
export interface ObservationScope {
  /** The absolute root that was observed. */
  readonly root: string
  /** How deep the walk went. */
  readonly maxDepth: number
  /** Files with these extensions only, when the caller narrowed it. */
  readonly extensions?: readonly string[]
}

/**
 * A structured, timestamped, fingerprinted view of part of the machine.
 *
 * Immutable and serialisable. It contains no handles, no closures and no references back to
 * anything that could act, so it can be logged, compared, cached and handed to a planner without
 * granting it any capability it did not already have.
 */
export interface WorldState {
  /** Identity of this observation. Recorded in every plan built from it. */
  readonly observationId: string
  readonly observedAt: number
  readonly scope: ObservationScope

  /**
   * Everything the walk found, sorted by `relative` so two observations of the same world compare
   * cleanly. Sorting is not cosmetic: freshness is decided by comparing fingerprints, and an
   * unstable order would report a changed world every time it was asked.
   */
  readonly entries: readonly WorldEntry[]

  /**
   * A digest of the observation's LISTING METADATA: every entry's relative path, kind and size.
   *
   * WHAT IT DETECTS, AND WHAT IT CANNOT, measured rather than assumed:
   *
   *   detects       a file or folder added · one removed · a rename · a RESIZE
   *   does NOT      detect an in-place edit that leaves the length unchanged
   *
   * The second row is a real limit. Everything here comes from `lstat`, so two files with the same
   * name and the same length are indistinguishable to this digest. An earlier version of this comment
   * claimed a changed file "has a different fingerprint", a test asserted that, and the test FAILED -
   * the claim was wrong, not the digest. Fixing the prose is the honest repair; changing the digest
   * to hash every file would trade a real cost for a guarantee nothing currently asks for.
   */
  readonly fingerprint: string

  /** Executables found, with whether the policy permits them. */
  readonly capabilities: readonly ObservedCapability[]

  /**
   * Whether the walk stopped early. A truncated observation is a PARTIAL view, and a plan that
   * treats it as complete is how a summary ends up confidently describing 20 of 400 files.
   */
  readonly truncated: boolean

  /** Reads that failed. Non-empty means the view has holes. */
  readonly errors: readonly ObservationError[]
}

// ============================================================ reading a world state

/** Files under a root, at any depth. Folders are not included in this count. */
export function filesIn(w: WorldState): readonly WorldEntry[] {
  return w.entries.filter((e) => e.kind === 'file')
}

/** Folders strictly below the root, at any depth. */
export function directoriesIn(w: WorldState): readonly WorldEntry[] {
  return w.entries.filter((e) => e.kind === 'directory')
}

/** How deep the observed tree actually goes, so a plan can size its own walk. */
export function deepestLevel(w: WorldState): number {
  return w.entries.reduce((max, e) => Math.max(max, e.depth), 0)
}

/** Distinct extensions present, lowercase, sorted. Empty when there are no files. */
export function extensionsIn(w: WorldState): readonly string[] {
  return [...new Set(filesIn(w).map((e) => e.extension).filter((x): x is string => Boolean(x)))].sort()
}

/** Whether a path is covered by this observation. The check a planner must make before asserting. */
export function observes(w: WorldState, path: string): boolean {
  const root = w.scope.root.replace(/[\\/]+$/, '')
  const p = path.replace(/[\\/]+$/, '')
  return p === root || p.startsWith(root + '\\') || p.startsWith(root + '/')
}

/** Finds an entry by its relative path. Undefined means it was NOT observed - never "empty". */
export function find(w: WorldState, relative: string): WorldEntry | undefined {
  const want = relative.replace(/[\\/]+/g, '/')
  return w.entries.find((e) => e.relative === want)
}

/**
 * Whether an observation can be trusted as current.
 *
 * Two independent conditions, and both are necessary:
 *
 *   AGE       the observation was taken recently enough
 *   UNCHANGED re-observing produces the same fingerprint
 *
 * Age alone is not enough - a world can change in a millisecond. A fingerprint alone is not enough
 * either, because it requires a fresh read to be meaningful, and a caller holding an old snapshot
 * with no observer cannot produce one.
 *
 * `refetched` is the result of re-observing. When it is undefined the answer is "cannot tell", and
 * that is reported as its own state rather than optimistically treated as fresh.
 */
export type Freshness =
  | { readonly fresh: true }
  | { readonly fresh: false; readonly reason: 'too-old'; readonly ageMs: number; readonly maxAgeMs: number }
  | { readonly fresh: false; readonly reason: 'world-changed'; readonly was: string; readonly now: string }
  | { readonly fresh: false; readonly reason: 'cannot-verify'; readonly why: string }

export function checkFreshness(
  w: WorldState,
  opts: { now: number; maxAgeMs: number; refetched?: WorldState },
): Freshness {
  const ageMs = opts.now - w.observedAt
  if (ageMs > opts.maxAgeMs) {
    return { fresh: false, reason: 'too-old', ageMs, maxAgeMs: opts.maxAgeMs }
  }
  if (!opts.refetched) {
    return { fresh: false, reason: 'cannot-verify', why: 'no re-observation was supplied, so the fingerprint cannot be compared' }
  }
  if (opts.refetched.fingerprint !== w.fingerprint) {
    return { fresh: false, reason: 'world-changed', was: w.fingerprint, now: opts.refetched.fingerprint }
  }
  return { fresh: true }
}
