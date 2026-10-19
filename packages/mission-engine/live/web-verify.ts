/**
 * INDEPENDENT VERIFICATION of a persisted research record.
 *
 * =============================================================================
 * WHY A SEPARATE VERIFIER EXISTS
 * =============================================================================
 *
 * The extractor built the record. If the extractor also verified it, the two would share
 * every assumption, and a record that was wrong would be wrong in exactly the way the verifier
 * expected. So verification re-reads the artifact FROM DISK through a fresh parse, re-checks it
 * against the run's own stated target, and never receives the extractor's in-memory object at
 * all. `verifyRun` takes a path and a run id - not an `Extraction`.
 *
 * What it can catch, each of which is a real failure mode rather than a hypothetical:
 *
 *   - the artifact is missing entirely
 *   - it is not JSON, or is JSON of the wrong shape
 *   - it was truncated in transit (marked truncated, with too little content to be usable)
 *   - the recorded URL is not the HTTPS external one the run claims to have visited
 *   - it claims more content elements than it carries
 *   - its digest does not match the bytes on disk - i.e. it was TAMPERED with after writing
 *   - the persisted findings disagree with a fresh scan of the persisted body text
 *
 * The last one is the interesting one: the record's own claim about hostile content is
 * re-derived from the bytes, so a record that suppresses a hostile finding is rejected even
 * though every field is individually well-formed.
 *
 * `computeDigest` is deliberately a plain SHA-256 over the canonical bytes. It is not a
 * signature and not an authenticity claim - it detects corruption and casual editing, and a
 * determined attacker who can rewrite the file can also rewrite the digest. It is recorded as
 * exactly that, and no more.
 */

import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'

import {
  scanForInjection, isChromeClass, classifyFromEvidence, STRUCTURAL_HINTS, MAX_ANCESTORS, MAX_HINTS,
  type ChromeClass, type AncestorEvidence,
} from './web-extract.ts'
import type { Extraction } from './web-extract.ts'

export interface ResearchRecord {
  readonly runId: string
  readonly requestedUrl: string
  readonly finalUrl: string
  readonly status: number
  readonly contentType: string | null
  readonly fetchedAt: number
  readonly title: string
  /**
   * 3 = elements carry a site-chrome classification AND the bounded structural evidence it was
   *     derived from, so the classification can be reproduced.
   * 2 = classification only. The verdict cannot be re-derived, so a brief may not rely on it.
   * absent/1 = legacy, written before classification existed.
   *
   * Deliberately OPTIONAL. Making it mandatory would have retroactively invalidated every
   * artifact already on disk, and the verifier's job is to say what IS true about a file, not to
   * demand that it be recent. An older record still verifies as what it is, and is REPORTED as
   * what it is, rather than hidden or rejected for being old.
   */
  readonly schemaVersion?: 3
  readonly elements: readonly {
    tag: string
    text: string
    href?: string
    /** Absent on legacy (v1) records. */
    chrome?: ChromeClass
    chromeReason?: string
    /** The bounded structural evidence `chrome` was derived from. Absent below v3. */
    evidence?: AncestorEvidence[]
  }[]
  readonly elementCount: number
  readonly hostileContentSeen: boolean
  readonly findingCount: number
  /**
   * The body region the findings were derived from, length-capped. Kept so the record is
   * auditable.
   *
   * This MUST be the same region the extraction scanned. An earlier version kept findings from
   * the whole page but only a 20 KB sample, so the verifier - which re-scans what is stored -
   * disagreed with the record it was checking, and a legitimate page was rejected. The cap is
   * therefore applied BEFORE scanning, once, in the runner, and both sides then agree by
   * construction rather than by luck.
   */
  readonly bodySample: string
  /** True when the body was longer than the cap, so the sample is not the whole page. */
  readonly bodyCapped: boolean
  readonly truncated: boolean
  readonly redirectChain: readonly string[]
  /** SHA-256 over the canonical record. Corruption/tamper detection, not authenticity. */
  readonly digest: string
}

/** The subset of the record the digest covers. `digest` itself is excluded, obviously. */
type Digestable = Omit<ResearchRecord, 'digest'>

export function computeDigest(record: Digestable): string {
  const canonical = JSON.stringify({
    runId: record.runId,
    requestedUrl: record.requestedUrl,
    finalUrl: record.finalUrl,
    status: record.status,
    contentType: record.contentType,
    fetchedAt: record.fetchedAt,
    title: record.title,
    // `undefined` is DROPPED by JSON.stringify, so a legacy record with no schemaVersion
    // canonicalises to exactly the bytes its digest was originally computed over. That is what
    // lets the classification be added without invalidating every artifact already written.
    schemaVersion: record.schemaVersion,
    elements: record.elements,
    elementCount: record.elementCount,
    hostileContentSeen: record.hostileContentSeen,
    findingCount: record.findingCount,
    bodySample: record.bodySample,
    bodyCapped: record.bodyCapped,
    truncated: record.truncated,
    redirectChain: record.redirectChain,
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

export type Verdict =
  | { readonly ok: true; readonly record: ResearchRecord; readonly rechecked: number; readonly chrome: ChromeSummary }
  | { readonly ok: false; readonly reason: string }

/** What the verifier found, so a caller can report it without re-reading the record. */
export interface ChromeSummary {
  /** Record version: 3 when reproducible, 2 when classified only, 1/absent when legacy. */
  readonly schemaVersion: number
  /** True when the classification was REPLAYED from persisted evidence, not merely read. */
  readonly reproducible: boolean
  readonly byClass: Readonly<Record<string, number>>
  /** Elements whose classification could not be determined. Preserved, not dropped. */
  readonly unknown: number
  /** True when the record predates the classification entirely. */
  readonly legacy: boolean
}

/**
 * Would the writer have kept this string? Mirrors `hintsAreStructural` in web-extract.
 *
 * Duplicated on purpose rather than imported: this file is the thing that must be able to reject
 * a record assembled by something OTHER than the writer, and a check that shares code with the
 * code it is checking cannot catch that code being bypassed. The two must agree, and this test
 * pins that they do.
 */
function hintsLookStructural(hints: string): boolean {
  return hints.length > 0 && (
    STRUCTURAL_HINTS.consent.test(hints) ||
    STRUCTURAL_HINTS.footer.test(hints) ||
    STRUCTURAL_HINTS.navigation.test(hints) ||
    STRUCTURAL_HINTS.header.test(hints) ||
    STRUCTURAL_HINTS.content.test(hints)
  )
}

function summariseChrome(r: Partial<ResearchRecord>, elements: Array<{ chrome?: unknown; evidence?: unknown }>): ChromeSummary {
  const byClass: Record<string, number> = {}
  let unknown = 0
  for (const e of elements) {
    const c = typeof e.chrome === 'string' ? e.chrome : 'absent'
    byClass[c] = (byClass[c] ?? 0) + 1
    if (c === 'unknown' || c === 'absent') unknown++
  }
  const legacy = r.schemaVersion !== 3 && r.schemaVersion !== 2
  return { schemaVersion: r.schemaVersion === 3 ? 3 : r.schemaVersion === 2 ? 2 : 1, reproducible: r.schemaVersion === 3, byClass, unknown, legacy }
}

const isLocal = (u: string): boolean => {
  try {
    const h = new URL(u).hostname.toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local') || h === '0.0.0.0'
  } catch { return true }
}

/**
 * Verify a persisted artifact by reading it from disk.
 *
 * `expectedRunId` and `expectedUrl` come from the MISSION, not from the artifact. That is the
 * whole point: a verifier given only the artifact would be checking that it agrees with
 * itself.
 */
export function verifyRun(
  path: string,
  expected: { runId: string; url: string; minElements: number },
): Verdict {
  if (!existsSync(path)) return { ok: false, reason: `no artifact at ${path}` }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    return { ok: false, reason: `artifact is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  const r = parsed as Partial<ResearchRecord>
  if (!r || typeof r !== 'object') return { ok: false, reason: 'artifact is not an object' }

  for (const k of ['runId', 'finalUrl', 'title', 'elements', 'elementCount', 'digest', 'bodySample', 'bodyCapped'] as const) {
    if (r[k] === undefined || r[k] === null) return { ok: false, reason: `artifact is missing "${k}"` }
  }
  if (r.runId !== expected.runId) {
    return { ok: false, reason: `artifact is for run "${r.runId}", not "${expected.runId}"` }
  }
  if (!Array.isArray(r.elements)) return { ok: false, reason: '"elements" is not an array' }

  // The URL must be the one the mission asked for, and it must be genuinely external HTTPS.
  if (r.finalUrl !== expected.url) {
    return { ok: false, reason: `artifact records finalUrl ${r.finalUrl}, mission asked for ${expected.url}` }
  }
  let u: URL
  try { u = new URL(String(r.finalUrl)) } catch { return { ok: false, reason: `finalUrl is not a URL: ${r.finalUrl}` } }
  if (u.protocol !== 'https:') return { ok: false, reason: `finalUrl is ${u.protocol}, not https` }
  if (isLocal(u.toString())) return { ok: false, reason: `finalUrl ${u.toString()} is not an external host` }

  if (String(r.title).trim().length === 0) return { ok: false, reason: 'artifact has no title' }
  const elements = r.elements as Array<{ tag: string; text: string; chrome?: unknown; chromeReason?: unknown }>
  const usable = elements.filter((e) => e && typeof e.text === 'string' && e.text.trim().length > 0)
  if (usable.length < expected.minElements) {
    return { ok: false, reason: `artifact carries ${usable.length} usable element(s), the mission requires ${expected.minElements}` }
  }
  if (r.elementCount !== elements.length) {
    return { ok: false, reason: `elementCount ${r.elementCount} disagrees with the ${elements.length} element(s) actually stored` }
  }

  // ---- site-chrome classification.
  //
  // Three levels, and which one applies is decided by the record's own declared version:
  //
  //   v3  the classification is REPRODUCED. The structural evidence is replayed through the
  //       authoritative classifier and must yield the recorded chrome AND the recorded reason.
  //       A record that disagrees with its own evidence is rejected - that is a record making a
  //       claim its evidence contradicts.
  //   v2  the classification is validated but NOT reproduced, and is reported as unreproducible.
  //       It is not silently accepted as verified, because "the writer said so" is exactly the
  //       assurance this verifier exists not to rely on.
  //   v1  no classification at all. Reported as legacy.
  //
  // A record claiming v3 while leaving an element unclassified or unevidenced is rejected rather
  // than treated as unknown: v3 is a promise that classification happened and was recorded, and
  // an unkept promise is an integrity failure, not an ambiguity.
  const version = r.schemaVersion === 3 ? 3 : r.schemaVersion === 2 ? 2 : 1
  if (version >= 2) {
    for (let i = 0; i < elements.length; i++) {
      const c = (elements[i] as { chrome?: unknown }).chrome
      if (c === undefined) {
        return { ok: false, reason: `record claims schemaVersion ${version} but element ${i} carries no chrome classification` }
      }
      if (!isChromeClass(c)) {
        return { ok: false, reason: `element ${i} carries chrome="${String(c)}", which is not one of the declared labels` }
      }
      const reason = (elements[i] as { chromeReason?: unknown }).chromeReason
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        return { ok: false, reason: `element ${i} is classified "${c}" but records no reason, so the classification cannot be reviewed` }
      }
    }
  }

  if (version === 3) {
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i] as { evidence?: unknown; chrome?: ChromeClass; chromeReason?: string; text: string }
      const ev = el.evidence
      if (ev === undefined) {
        return { ok: false, reason: `record claims schemaVersion 3 but element ${i} carries no structural evidence` }
      }
      if (!Array.isArray(ev)) {
        return { ok: false, reason: `element ${i} has structural evidence that is not an array` }
      }
      if (ev.length > MAX_ANCESTORS) {
        return { ok: false, reason: `element ${i} carries ${ev.length} ancestors, over the ${MAX_ANCESTORS} bound` }
      }
      for (let j = 0; j < ev.length; j++) {
        const a = ev[j] as Partial<AncestorEvidence>
        if (!a || typeof a !== 'object' || Array.isArray(a)) {
          return { ok: false, reason: `element ${i} ancestor ${j} is not an evidence object` }
        }
        if (typeof a.tag !== 'string' || typeof a.role !== 'string' || typeof a.hints !== 'string') {
          return { ok: false, reason: `element ${i} ancestor ${j} is missing tag, role or hints` }
        }
        if (a.tag.length > 32) return { ok: false, reason: `element ${i} ancestor ${j} tag exceeds 32 characters` }
        if (a.role.length > 40) return { ok: false, reason: `element ${i} ancestor ${j} role exceeds 40 characters` }
        if (a.hints.length > MAX_HINTS) return { ok: false, reason: `element ${i} ancestor ${j} hints exceed ${MAX_HINTS} characters` }
        // Only page strings that LOOK structural are permitted in the evidence. Anything else
        // was blanked by the writer because it could not influence a verdict, so its presence
        // means the record was assembled by something other than the writer.
        if (a.hints !== '' && !hintsLookStructural(a.hints)) {
          return {
            ok: false,
            reason: `element ${i} ancestor ${j} carries hints that match no structural pattern; the writer blanks those`,
          }
        }
      }

      // The reproduction itself.
      const replayed = classifyFromEvidence(ev as AncestorEvidence[], el.text)
      if (replayed.chrome !== el.chrome) {
        return {
          ok: false,
          reason: `element ${i} is classified "${el.chrome}" but replaying its own structural evidence yields "${replayed.chrome}"`,
        }
      }
      if (replayed.reason !== el.chromeReason) {
        return {
          ok: false,
          reason: `element ${i} records the reason "${el.chromeReason}" but replay yields "${replayed.reason}"`,
        }
      }
    }
  }

  // Tamper / corruption detection.
  const { digest, ...rest } = r as ResearchRecord
  const recomputed = computeDigest(rest as Digestable)
  if (digest !== recomputed) {
    return { ok: false, reason: `digest mismatch: the artifact says ${String(digest).slice(0, 16)}…, the bytes hash to ${recomputed.slice(0, 16)}…` }
  }

  // Re-derive the hostile-content claim from the persisted bytes. A record that suppresses a
  // finding is rejected even though every field is individually well-formed.
  const rescan = scanForInjection(String(r.bodySample))
  if ((rescan.length > 0) !== (r.hostileContentSeen === true)) {
    return {
      ok: false,
      reason: `the record claims hostileContentSeen=${r.hostileContentSeen} but a fresh scan of the persisted body found ${rescan.length} instruction-like pattern(s)`,
    }
  }
  if (rescan.length !== r.findingCount) {
    return { ok: false, reason: `the record claims ${r.findingCount} finding(s); a fresh scan finds ${rescan.length}` }
  }

  if (r.truncated === true && usable.length < expected.minElements) {
    return { ok: false, reason: 'the artifact is marked truncated and carries too little content to be usable' }
  }

  return { ok: true, record: r as ResearchRecord, rechecked: rescan.length, chrome: summariseChrome(r, elements) }
}

/** A record with no findings, for the success path. Kept next to the type it builds. */
export function buildRecord(fields: Digestable): ResearchRecord {
  return { ...fields, digest: computeDigest(fields) }
}

export type { Extraction }