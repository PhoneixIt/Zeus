/**
 * WHAT THE COMPOSER WILL WRITE, PREDICTED FROM THE OBSERVATION.
 *
 * The gap this closes: a planner can state "this artefact must contain exactly this text" only if
 * it can predict that text BEFORE the mission runs. For the folder-summary recipe that is possible,
 * because the composer is a pure function of the folder label and the entry list - and the planner
 * already holds the entry list, from the observation it was built on.
 *
 * WHAT IS AND IS NOT REIMPLEMENTED HERE
 *
 * Nothing. This module:
 *
 *   - READS the entry list out of the observation (already gathered by the observer, which is the
 *     only component permitted to touch the filesystem - `provider.ts` forbids a planner from doing
 *     so, and that prohibition is structural rather than advisory);
 *   - TRANSPORTS each observed entry into the composer's shape, carrying `kind`, `sizeBytes` and
 *     `extension` as facts the observer already computed from syscalls;
 *   - CALLS `StructuredSummarizer` - the same class the tool instantiates - and hashes its output
 *     with the same SHA-256 the read-back verifier uses.
 *
 * The formatting, the grouping, the ordering, the extension rule and the directory-detection rule
 * each live in exactly one place: the composer and the observer. A second copy of any of them would
 * drift, and the symptom of drift would be a hash that never matches - a mission that did the right
 * thing and was reported as having failed its objective, which is worse than not checking at all.
 *
 * WHEN IT DECLINES
 *
 * If the observation does not cover the folder, or does not cover it completely, this returns
 * `ok: false` rather than a guess. A planner that declared a content postcondition it could not
 * compute would produce a permanently red objective, and a permanently red objective teaches a
 * reader to ignore the objective line - which is the failure this whole contract exists to prevent.
 */

import { createHash } from 'node:crypto'
import { StructuredSummarizer, type FolderEntry } from './summarizer.ts'
import type { WorldEntry, WorldState } from '../observation/world.ts'

/** Matches `normalizeFolderLabel`'s canonical form: trimmed, no trailing separators. */
function canonicalPath(p: string): string {
  return p.trim().replace(/[\\/]+$/, '')
}

/**
 * The immediate children of `subject`, as the composer will receive them.
 *
 * `readdirSync` returns DIRECT children only, so this filters to depth `subjectDepth + 1` under the
 * subject's own path rather than "everything below", which would wrongly pull in grandchildren and
 * make the prediction depend on tree depth.
 *
 * Matched on the PARENT PATH rather than on a `relative` prefix. An earlier version did the latter
 * and silently returned ZERO entries whenever the subject WAS the observation root - which is how
 * `run-folder-summary` plans, since it observes the source folder itself. The root's `relative` is
 * spelled differently from a child-bearing prefix (`.` rather than a leading path), so no child's
 * `relative` matched it, the prediction described an empty folder, and every such mission failed
 * its own objective.
 *
 * That is the second time this helper's failure mode has been "predict confidently about nothing".
 * It is why `ok: false` exists, and why the decline cases are tested - but a silent empty prediction
 * is worse than a decline, so the parent-path form is used because it has no spelling-dependent
 * branch to get wrong.
 */
function immediateChildren(world: WorldState, subjectPath: string, subjectDepth: number): WorldEntry[] {
  const parent = subjectPath.replace(/[\\/]+$/, '').toLowerCase()
  return world.entries.filter((e) =>
    e.depth === subjectDepth + 1
    && dirnameOf(e.path).replace(/[\\/]+$/, '').toLowerCase() === parent)
}

/** Normalised for case- and separator-insensitive comparison, as Windows paths require. */
function normPath(p: string): string {
  return p.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
}

/** The parent directory of an absolute path, for either separator. */
function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : p
}

/**
 * One observed entry -> the composer's shape.
 *
 * `listingOf` in `folder-tools.ts` calls `statSync` and treats "not a directory" as a file, so a
 * symlink or an unstatable entry becomes a file there. This maps the same way, from the OBSERVED
 * kind rather than a fresh syscall, which is the same fact taken at a different time.
 */
function toComposerEntry(e: WorldEntry): FolderEntry {
  const isDir = e.kind === 'directory'
  return {
    name: e.relative.slice(e.relative.lastIndexOf('/') + 1),
    kind: isDir ? 'directory' : 'file',
    bytes: isDir ? undefined : e.sizeBytes,
    extension: isDir ? '' : (e.extension ?? ''),
  }
}

/**
 * The observed entry for an ABSOLUTE path.
 *
 * Matched on `path`, not `relative`, because the caller has an absolute path in hand and
 * `find()` matches the relative one. Case-insensitive and separator-tolerant, as Windows paths are:
 * a junction or an 8.3 short name would not match textually, and this then returns `undefined` -
 * which makes the caller declare fewer postconditions. That is the safe direction: a missed match
 * narrows the claim, and the wrong match would be a content hash for the wrong folder.
 *
 * Deliberately no `realpathSync`. The observation already recorded resolved paths, and a filesystem
 * call from here would put one back into the planner, which `provider.ts` forbids structurally.
 */
function observedEntryFor(world: WorldState, absolute: string): WorldEntry | undefined {
  const want = normPath(absolute)
  return world.entries.find((e) => normPath(e.path) === want)
}

export type ExpectedSummary =
  | { readonly ok: true; readonly text: string; readonly sha256: string; readonly entryCount: number }
  | { readonly ok: false; readonly reason: string }

/**
 * The exact bytes `compose-summary` will produce for `subject`, given what was observed.
 *
 * Returns `ok: false` rather than a partial answer whenever the observation cannot support the
 * claim. Every `ok: false` is a legitimate "this planner cannot state the objective in checkable
 * terms for this world", and the caller's correct response is to declare fewer postconditions -
 * not to guess.
 */
export async function expectedFolderSummary(
  world: WorldState,
  subject: string,
): Promise<ExpectedSummary> {
  const want = canonicalPath(subject)

  const entry = observedEntryFor(world, want)
  if (!entry) {
    return { ok: false, reason: `${want} was not present in observation ${world.observationId}` }
  }
  if (entry.kind !== 'directory') {
    return { ok: false, reason: `${want} was observed as ${entry.kind}, not a directory` }
  }
  if (world.truncated || world.errors.length > 0) {
    // A truncated observation describes "what was seen", not "what is there". Declaring a content
    // hash from it would claim a completeness the observation does not have.
    return {
      ok: false,
      reason: `observation ${world.observationId} is incomplete (${world.truncated ? 'truncated' : `${world.errors.length} error(s)`}), so its listing cannot stand for the folder`,
    }
  }

  const children = immediateChildren(world, entry.path, entry.depth)
  const entries = children.map(toComposerEntry)

  // FAIL CLOSED ON AN IMPLAUSIBLE EMPTY PREDICTION.
  //
  // "This folder is empty" and "my child-matching is broken" are indistinguishable from the inside
  // this function, and only one of them is true. That is not hypothetical: an earlier version of
  // `immediateChildren` selected by `relative` prefix, which matches nothing when the subject IS
  // the observation root, and this helper returned `ok: true` with a confident hash of an EMPTY
  // summary. Every mission planned that way failed its own objective while writing a perfectly good
  // report - a false negative caused by the helper, not by the mission.
  //
  // The guard is deliberately narrow. It fires only when all three hold:
  //   - the subject is the observation ROOT (so `relative` is spelled as the root spells it);
  //   - the observation claims it descended far enough to have seen children (`maxDepth >= 1`);
  //   - and zero children matched.
  //
  // A genuinely empty folder still predicts empty, because either it is not the root, or the
  // observation never claimed to descend. No filesystem call is made: all three facts are already on
  // `WorldState`.
  const isObservationRoot = normPath(entry.path) === normPath(world.scope.root)
  if (entries.length === 0 && isObservationRoot && world.scope.maxDepth >= 1) {
    return {
      ok: false,
      reason:
        `observation ${world.observationId} claims depth ${world.scope.maxDepth} and its root is ` +
        `${entry.path}, yet no child of that root was matched - an empty prediction here is ` +
        `indistinguishable from a broken one, so no content claim is made`,
    }
  }

  // The composer itself canonicalises order, so this output depends on the SET of entries and not
  // on the order the observation happened to record them in. That is the property that makes the
  // prediction equal to what the tool will produce after its own `readdirSync`.
  const text = (await new StructuredSummarizer().generate({ folderLabel: want, entries })).text

  return {
    ok: true,
    text,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    entryCount: entries.length,
  }
}
