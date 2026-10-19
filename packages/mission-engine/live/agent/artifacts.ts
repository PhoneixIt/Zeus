/**
 * MISSION-LEVEL ARTIFACT INTEGRITY.
 *
 * Why this module exists, in one measured incident.
 *
 * On 2026-10-19 a NAKIVO mission produced a correct 407-row inventory at
 * `~/.aios/agent/out/nakivo-scan.csv`. I verified it independently: row count matched a fresh
 * enumeration, the byte total matched exactly (941,397,427), and spot-checks agreed. A LATER
 * mission then resolved to the same filename and overwrote it with PYTHON SOURCE. The good
 * inventory was destroyed by a mission that went on to report failure.
 *
 * Nothing detected it, and every layer that looked like it might have was actively lying:
 *
 *   - `write-file` had no existence check at all. `writeFileSync(p, content, 'utf8')` truncates.
 *   - `writeFileVerifier` compared `statSync(p).size` to the SIZE THE TOOL JUST RECORDED, so an
 *     overwrite verified as a correct write of exactly the wrong number of bytes.
 *   - `readFileVerifier` compared the tool's claimed text against a fresh read - both the NEW
 *     content.
 *   - `objectiveVerdict` matches evidence by PATH STRING, so a read-back of the clobbered file
 *     satisfied `artifact-exists` for the original goal.
 *
 * So this is not a missing check in one tool. It is a missing MENTAL MODEL: nothing in the system
 * ever said "this file is the deliverable, these steps produce it, and nobody else may write it".
 *
 * WHAT THIS MODULE IS. Artifact-integrity and destination-authorization enforcement inside the
 * existing execution architecture. It is NOT a security sandbox: it does not confine the user, it
 * does not defend against a hostile operator, and it makes no claim about untrusted code. It stops
 * a correct system from destroying a correct result.
 *
 * WHAT IT DOES, in three parts:
 *
 *   1. `buildArtifactContract` - decide, for the WHOLE mission and not one step at a time, which
 *      file is the deliverable, which step produces it, and what kind of content belongs there.
 *
 *   2. `auditArtifactReferences` - refuse a plan that talks about a file no producing step
 *      declares and that does not already exist. This is the check that catches "write a Python
 *      script, run it, write the CSV" when the write step had no declared destination: the plan
 *      becomes internally inconsistent, and an inconsistent plan is refused rather than repaired
 *      by guessing which artifact a step meant.
 *
 *   3. `refuseContentMismatch` - refuse content of the wrong KIND for a destination. A `.csv`
 *      deliverable cannot be produced by a Python program. This is the check that would have
 *      stopped the overwrite at the moment it was written, not afterwards.
 *
 * The governing rule throughout: SILENCE IS NOT AUTHORIZATION. A path that nobody chose is not a
 * destination; a file that already exists is not writable; a step that cannot say which artifact it
 * produces does not get to pick one.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'

/** Bytes at a path, or null when it cannot be read. Never throws into a tool result. */
export function safeStatSize(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

/** The authorized root for every artifact this process produces. */
export const ARTIFACT_ROOT = 'C:\\Users\\Samer\\.aios\\agent\\out'

/**
 * What kind of thing a file is, judged by its EXTENSION.
 *
 * The extension is the only signal available before the bytes exist, and it is a strong one:
 * `.csv` means delimited rows, `.json` means a parseable object. It is NOT a content validator -
 * `contentLooksLike` below is a cheap shape check that catches gross mismatches, not a parser.
 */
export type ArtifactKind = 'csv' | 'json' | 'text' | 'binary-or-other'

export function artifactKindFor(path: string): ArtifactKind {
  const ext = extname(path).toLowerCase()
  if (ext === '.csv') return 'csv'
  if (ext === '.json') return 'json'
  if (ext === '.txt' || ext === '.md' || ext === '.log') return 'text'
  return 'binary-or-other'
}

/**
 * Who may replace a file that already exists.
 *
 * `never` is the default and the ONLY value anything in this codebase may set today. `authorized`
 * exists because the distinction has to be representable - "this would overwrite" and "you asked me
 * to overwrite this" are different answers - but no code path sets it, because nothing in this
 * system asks a person to approve a destination. Adding the field now means that when approval is
 * ever built, the gate already refuses by default instead of permitting by default.
 */
export type OverwriteAuthority = 'never' | 'authorized'

export interface ArtifactRecord {
  /** Stable within a mission. The identity a read-back pairs to - never a basename. */
  readonly id: string
  /** The destination the PERSON named, when they named one. Null when nobody named a destination. */
  readonly requestedPath: string | null
  /** The authorized absolute path bytes may be written to. */
  readonly resolvedPath: string
  /** The kind of content this destination may receive. */
  readonly kind: ArtifactKind
  /** The step that produces it, or null when no step declares one. */
  readonly producingStepId: string | null
  /** The step that reads it back, if the plan has one. */
  readonly readBackStepId: string | null
  /** Whether an existing file here may be replaced. Always 'never' today. */
  readonly overwrite: OverwriteAuthority
  /** True when a file already exists at `resolvedPath` as the plan was validated. */
  readonly existedBefore: boolean
  /** Bytes of that pre-existing file, so a failure can prove it did not change them. */
  readonly preExistingSha256: string | null
  readonly preExistingBytes: number | null
  /** Filled in once the artifact is written and verified. */
  readonly finalSha256: string | null
}

export interface ArtifactPlanStep {
  readonly id: string
  readonly intent: string
  readonly tool: string
  readonly args: Record<string, unknown>
}

export interface ArtifactContract {
  readonly artifacts: readonly ArtifactRecord[]
  /** Reasons the plan is refused before anything runs. Empty means it may proceed. */
  readonly refusals: readonly string[]
}

export function sha256File(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Does this CONTENT look like something other than what the destination claims to be?
 *
 * A shape heuristic, and stated as one. It cannot prove a CSV is well-formed - that is the
 * read-back's job, and `spreadsheet` parses what it writes for exactly this reason. What it
 * catches is the failure that actually happened: a destination named `.csv` receiving a Python
 * program. That is unambiguous in either direction and cheap to detect.
 *
 * Returning true means REFUSE. The burden of proof sits with the write, because the cost of the
 * mistake is asymmetric: a refused write costs one step, and a wrong write destroys a deliverable
 * that may be the only copy of real work.
 */
export function contentLooksWrongFor(path: string, content: string): string | null {
  const kind = artifactKindFor(path)
  if (kind === 'binary-or-other') return null

  const head = content.slice(0, 4000)
  const trimmed = head.trimStart()

  // A Python program, at a destination that is supposed to hold DATA.
  //
  // The extension is honoured rather than second-guessed. `safeFileName` replaces an unrecognised
  // extension with the fallback's, so a model that writes `scan.py` at a path that already ended
  // `.csv` had its extension rewritten out from under it - and refusing on the rewritten name
  // would blame the model for something this codebase did.
  //
  // `.txt` is treated as a neutral container, not as data. A person asking for "notes.txt" may
  // legitimately mean a scratch file, and refusing Python at a `.txt` path would block the exact
  // shape of work the loop does constantly: write a helper script, run it, produce the real
  // artifact. The refusals below are all about DATA destinations - `.csv`, `.json` - where a
  // program is unambiguously the wrong thing.
  const ext = extname(path).toLowerCase()
  const isScriptDestination =
    ext === '.py' || ext === '.ps1' || ext === '.sh' || ext === '.bat' || ext === '.txt'

  const pythonish =
    /^#!.*\bpython\b/.test(trimmed) ||
    /^(import\s+\w|from\s+\w+\s+import\s)/m.test(head) ||
    /^\s*def\s+\w+\s*\(.*\)\s*:/m.test(head) ||
    /^(if __name__|print\()/m.test(head)
  // A SOURCE destination may receive source. Judging a .py file by whether it parses as Python
  // would be backwards - it is the one place source is the correct content.
  if (pythonish && !isScriptDestination) {
    return `"${basename(path)}" is a ${kind === 'csv' ? 'CSV' : kind.toUpperCase()} destination, but the `
      + 'content being written to it is a Python program. That is not a repair of the content - it '
      + 'would replace a finished artifact with source code. Name the script .py, or write the '
      + 'artifact itself to this path.'
  }

  // JavaScript / TypeScript.
  const jsish =
    /^(const|let|var|function|class|import|export)\s/m.test(head) ||
    /=>\s*\{/.test(head) ||
    /^\s*(const|let)\s+\w+\s*=\s*(require|await)/m.test(head)
  const isJsDestination =
    ext === '.js' || ext === '.ts' || ext === '.mjs' || ext === '.cjs' || ext === '.txt'
  if (jsish && kind !== 'json' && !isJsDestination) {
    return `"${basename(path)}" is a ${kind.toUpperCase()} destination, but the content being written `
      + 'to it is JavaScript. Writing a script over a data deliverable destroys the deliverable; '
      + 'give the script its own .js path.'
  }

  // JSON destinations must actually parse as JSON. Not a shape guess: `JSON.parse` either throws
  // or it does not, and a file called `.json` that cannot be parsed is broken by definition rather
  // than by judgement. The failure this prevents is a reader downstream - a tool, a report, a
  // person - meeting a file that claims to be JSON and is not.
  if (kind === 'json') {
    try {
      JSON.parse(content)
    } catch (e) {
      return `"${basename(path)}" is a .json deliverable, and this content is not valid JSON `
        + `(${e instanceof Error ? e.message.split('\n')[0] : 'parse failed'}). `
        + 'Writing it would leave a file whose extension promises something it does not contain.'
    }
  }

  // A CSV destination whose lines are all assignments or statements is not a CSV.
  //
  // The discriminator is a comma OUTSIDE quotes, because that is what actually separates fields.
  // A line containing `"x.csv"` has quotes but no delimiter - it is an assignment, not a row - and
  // counting the quotes as data is what made the first version of this check pass the very case it
  // was written for. A single real row is enough to let the file through; this fires only when
  // NOTHING in the content is row-shaped.
  if (kind === 'csv') {
    const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
    if (lines.length === 0) return null

    const hasUnquotedComma = (line: string): boolean => {
      let inQuotes = false
      for (const ch of line) {
        if (ch === '"') inQuotes = !inQuotes
        else if (ch === ',' && !inQuotes) return true
      }
      return false
    }

    // Only for a destination that is supposed to CONTAIN DATA. A single-column CSV is legal, and
    // so is a file with one value per line; refusing on "no commas" alone would reject those. The
    // check is therefore paired with the source signals above: content that is not row-shaped AND
    // looks like code is not a thin CSV, it is the wrong kind of thing entirely.
    const looksLikeCode =
      pythonish || jsish
      || /^[A-Za-z_][\w.]*\s*=\s*\S/m.test(content)
      || /^(from|import|def|class|return|print|if|for|while)\b/m.test(content)
    if (!lines.some(hasUnquotedComma) && looksLikeCode) {
      return `"${basename(path)}" is a CSV deliverable, and this content has no comma-delimited `
        + 'rows in it at all - it is assignments and statements. Writing it here would replace a '
        + 'finished inventory with code.'
    }
  }

  return null
}

/** Does this line contain a comma that is not inside a quoted field? */
export function hasUnquotedDelimiter(line: string): boolean {
  let inQuotes = false
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === ',' && !inQuotes) return true
  }
  return false
}

/**
 * FILES A PLAN MENTIONS BUT NOBODY PRODUCES.
 *
 * Observed on mission 2a1995ef: the write step declared no destination, the goal named a CSV, so
 * validation put the CSV path on the write step - and the script the plan had told a LATER step to
 * run (`python ...\out\scan_nakivo.py`) was now something no step would ever create. The mission
 * failed, and the CSV held source code.
 *
 * The per-step guard added for that (`deliverable-not-intermediates`) only fires when the write step
 * HAS a declared filename to protect. Here it had none, so the guard was structurally unable to
 * help. This is the mission-level check that closes that hole: it looks at every file the plan
 * refers to, across all steps and all tools, and asks whether some step produces it.
 *
 * Scoped deliberately and narrowly. Only files INSIDE the artifact root are considered, because
 * that is the only place a mission is writing; a reference to `C:\Users\Samer\Desktop\NAKIVO` is
 * data being read and is none of this module's business. And a file that ALREADY EXISTS is never
 * a dangling reference - reading an existing file is legitimate.
 */
export function auditArtifactReferences(
  steps: readonly ArtifactPlanStep[],
  produced: ReadonlyMap<string, string>,
  root: string = ARTIFACT_ROOT,
): string[] {
  const refusals: string[] = []
  const rootNorm = resolve(root).toLowerCase()

  for (const s of steps) {
    // Every string the step carries, joined - a terminal command and a path argument are both
    // just places a filename can appear, and the point is to notice the MENTION.
    const blob = [s.intent, JSON.stringify(s.args ?? {})].join('\n')

    // Filenames with a path-ish shape. Requiring an extension keeps this from matching prose.
    const mentions = blob.match(/[\w.-]+\.(?:py|js|ts|csv|json|txt|md|log|ps1|sh)\b/gi) ?? []
    for (const raw of mentions) {
      const name = raw.toLowerCase()

      // Produced by a step of this mission - that is exactly what makes a reference resolvable.
      if (produced.has(name)) continue

      // Already on disk: reading an existing file is not a dangling reference.
      const direct = resolve(root, raw)
      if (existsSync(direct)) continue
      if (existsSync(resolve(rootNorm, raw))) continue

      // Did any step of this mission declare it as a destination?
      const declaredBy = steps.find(
        (o) => typeof o.args?.path === 'string'
          && basename(String(o.args.path)).toLowerCase() === name)
      if (declaredBy) continue

      // Referenced only from OUTSIDE the artifact root? Not this module's concern.
      if (!direct.toLowerCase().startsWith(rootNorm + '\\')) continue

      refusals.push(
        `step "${s.id}" refers to "${raw}", but no step in this plan creates it and it does not `
        + 'exist. A plan that runs or reads a file it never produces is internally inconsistent, '
        + 'and guessing which artifact was meant is how a deliverable ends up holding the wrong '
        + `content. Declare "${raw}" as the destination of a producing step, or remove the reference.`,
      )
    }
  }

  return refusals
}

/**
 * Build the contract for a whole mission: one record per destination, plus the refusals that must
 * be settled before anything is written.
 *
 * `steps` is the VALIDATED plan - paths already confined to the artifact root, so what is compared
 * here is what would actually be written.
 */
export function buildArtifactContract(
  steps: readonly ArtifactPlanStep[],
  requestedDeliverablePath: string | null,
  root: string = ARTIFACT_ROOT,
): ArtifactContract {
  const producers = steps.filter(
    (s) => s.tool.includes('write-file') || s.tool.includes('spreadsheet'))
  const readers = steps.filter((s) => s.tool.includes('read-file'))

  const artifacts: ArtifactRecord[] = []
  const refusals: string[] = []
  const produced = new Map<string, string>()

  producers.forEach((s, i) => {
    const raw = typeof s.args.path === 'string' ? String(s.args.path).trim() : ''
    if (raw.length === 0) return

    const resolved = resolve(raw)
    const name = basename(resolved).toLowerCase()
    produced.set(name, s.id)

    const exists = existsSync(resolved)
    const readBack = readers.find(
      (r) => typeof r.args?.path === 'string'
        && basename(String(r.args.path)).toLowerCase() === name)

    artifacts.push({
      id: `artifact-${i + 1}`,
      requestedPath: requestedDeliverablePath
        && basename(resolve(requestedDeliverablePath)).toLowerCase() === name
        ? requestedDeliverablePath
        : null,
      resolvedPath: resolved,
      kind: artifactKindFor(resolved),
      producingStepId: s.id,
      readBackStepId: readBack?.id ?? null,
      // Never. Nothing in this system asks a person to approve a destination, so every
      // replacement is unauthorized and the gate below refuses it.
      overwrite: 'never',
      existedBefore: exists,
      preExistingSha256: exists ? sha256File(resolved) : null,
      preExistingBytes: exists ? safeSize(resolved) : null,
      finalSha256: null,
    })
  })

  // Two steps writing the same destination is not a plan, it is a race the mission intends to
  // lose. It is also the shape that let attempt 2 clobber attempt 1.
  const byPath = new Map<string, string[]>()
  for (const a of artifacts) {
    const k = a.resolvedPath.toLowerCase()
    byPath.set(k, [...(byPath.get(k) ?? []), a.producingStepId ?? '?'])
  }
  for (const [path, ids] of byPath) {
    if (ids.length > 1) {
      refusals.push(
        `steps ${ids.join(' and ')} both write "${path}". Two steps producing one artifact means the `
        + 'later one silently destroys the earlier one, and neither can be verified independently. '
        + 'Give each step its own destination.',
      )
    }
  }

  refusals.push(...auditArtifactReferences(steps, produced, root))

  return { artifacts, refusals }
}

function safeSize(path: string): number | null {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

/**
 * May this write proceed against this destination?
 *
 * The single gate every producing tool passes through. It answers two questions and nothing else:
 * is the destination the artifact the plan declared, and does it already hold bytes somebody
 * depends on.
 *
 * Returns a refusal STRING to refuse, or null to allow. Returning a reason rather than throwing
 * keeps the failure in the tool's own result, where the executor records it as a step outcome and
 * the mission can honestly report partial completion - instead of surfacing as an unhandled error
 * that looks like a crash.
 */
export function authorizeWrite(opts: {
  readonly path: string
  readonly stepId: string
  readonly contract: ArtifactContract
}): string | null {
  const target = resolve(opts.path)
  const known = opts.contract.artifacts.find(
    (a) => a.resolvedPath.toLowerCase() === target.toLowerCase())

  if (!known) {
    return `refusing to write "${opts.path}": it is not an artifact this plan declared. A write must `
      + 'be associated with a deliverable the mission identified up front, so that what was '
      + 'requested, what was written, and what was verified cannot drift apart.'
  }

  if (known.existedBefore && known.overwrite !== 'authorized') {
    const detail = known.preExistingSha256
      ? `it holds ${known.preExistingBytes ?? '?'} byte(s) (sha256 ${known.preExistingSha256.slice(0, 16)}...)`
      : `it holds ${known.preExistingBytes ?? '?'} byte(s)`
    return `refusing to overwrite "${known.resolvedPath}": ${detail}. A file that already exists is `
      + 'not this mission\'s to replace, and a mission that fails partway through would destroy work '
      + 'that is already good. Write to a new filename, or remove the existing file yourself.'
  }

  return null
}