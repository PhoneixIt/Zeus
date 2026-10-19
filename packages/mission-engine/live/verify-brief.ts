/**
 * INDEPENDENT VERIFICATION of a persisted company brief.
 *
 * =============================================================================
 * WHAT MAKES THIS A VERIFIER AND NOT A SECOND OPINION
 * =============================================================================
 *
 * The mission wrote the brief. If the mission also checked the brief, a wrong brief would be
 * wrong in exactly the way its own author expected. So this file:
 *
 *   - reads the brief FROM DISK, through a fresh JSON parse
 *   - opens each source artifact FROM DISK and re-verifies it with `verifyRun`, which re-derives
 *     the digest and rescans the stored body for instruction-like content
 *   - takes the expected correlation id from the CALLER (the mission), never from the brief
 *   - checks that every quoted-fact claim can be FOUND, at the stated index, in the stated
 *     source's stored elements
 *   - recomputes the brief digest
 *
 * It never receives the in-memory `CompanyBrief`. A verifier handed the writer's object is
 * checking that the object agrees with itself.
 *
 * =============================================================================
 * WHAT IT DELIBERATELY DOES NOT CLAIM
 * =============================================================================
 *
 * It does NOT decide whether the company actually sells what its website says it sells. That
 * is a question about the world, and no amount of file re-reading answers it. Claims that are
 * `rule-derived` are accepted as STRUCTURALLY sound and reported as
 * `not-automatically-verifiable`; the verifier checks that the brief LABELLED them that way
 * rather than passing them off as fact. A brief that upgraded a rule-derived claim to a proven
 * fact FAILS here, and that is deliberate.
 */

import { existsSync, readFileSync } from 'node:fs'

import { verifyRun } from './web-verify.ts'
import { isChromeClass, type ChromeClass } from './web-extract.ts'
import { digestBrief, type CompanyBrief, type BriefClaim } from './company-brief.ts'

export type BriefVerdict =
  | {
    readonly ok: true
    readonly brief: CompanyBrief
    readonly checks: readonly string[]
    readonly sourcesVerified: number
    readonly claimsTraced: number
    readonly unverifiedClaims: number
  }
  | { readonly ok: false; readonly reason: string; readonly checks: readonly string[] }

/** The labels that mean "site furniture". Mirrors the mission's own definition. */
const CHROME_LABELS: ReadonlySet<ChromeClass> = new Set<ChromeClass>([
  'navigation', 'header', 'footer', 'consent-banner',
])

const isLocal = (u: string): boolean => {
  try {
    const h = new URL(u).hostname.toLowerCase()
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local') || h === '0.0.0.0'
  } catch { return true }
}

/**
 * Verify a persisted brief.
 *
 * `expected.correlationId` MUST come from the mission, not from the file under test. That is
 * the entire difference between checking a brief and agreeing with it.
 */
export function verifyBrief(
  path: string,
  expected: { correlationId: string; minSources?: number },
): BriefVerdict {
  const checks: string[] = []
  const minSources = expected.minSources ?? 1

  if (!existsSync(path)) return { ok: false, reason: `no brief at ${path}`, checks }
  checks.push('brief file exists')

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    return { ok: false, reason: `brief is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, checks }
  }
  checks.push('brief is valid JSON')
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'brief is not an object', checks }

  const b = parsed as Partial<CompanyBrief>

  // ---- shape
  for (const k of ['correlationId', 'objective', 'startingUrl', 'terminalState', 'sources', 'claims', 'unresolved', 'digest', 'mode'] as const) {
    if (b[k] === undefined || b[k] === null) return { ok: false, reason: `brief is missing "${k}"`, checks }
  }
  checks.push('brief carries every required field')

  if (b.correlationId !== expected.correlationId) {
    return { ok: false, reason: `brief is for correlation "${b.correlationId}", mission expected "${expected.correlationId}"`, checks }
  }
  checks.push(`correlation id matches the mission (${String(expected.correlationId).slice(0, 8)}…)`)

  // ---- terminal state must be one of the three declared values, and must not overclaim
  const term = String(b.terminalState)
  if (!['complete', 'partial', 'failed'].includes(term)) {
    return { ok: false, reason: `terminalState "${term}" is not one of complete/partial/failed`, checks }
  }
  checks.push(`terminal state is "${term}"`)

  if (b.mode !== 'deterministic-extraction') {
    return { ok: false, reason: `brief records mode "${String(b.mode)}"; this verifier only vouches for deterministic-extraction`, checks }
  }
  if ((b as { modelUsed?: unknown }).modelUsed !== null) {
    return { ok: false, reason: 'brief records a model; a model-written claim cannot be verified from stored bytes alone', checks }
  }
  checks.push('mode is deterministic-extraction and modelUsed is null')

  if (!Array.isArray(b.sources)) return { ok: false, reason: '"sources" is not an array', checks }
  if (!Array.isArray(b.claims)) return { ok: false, reason: '"claims" is not an array', checks }

  const sources = b.sources as CompanyBrief['sources']
  const claims = b.claims as BriefClaim[]

  // ---- a failed mission must not also claim sources, and a complete one must have some
  if (term === 'complete' && sources.length < minSources) {
    return { ok: false, reason: `brief claims terminalState "complete" but carries ${sources.length} source(s); the mission required at least ${minSources}`, checks }
  }
  if (term === 'complete' && b.warnings && b.warnings.length > 0) {
    return { ok: false, reason: `brief claims "complete" while recording ${b.warnings.length} warning(s); a complete mission records none`, checks }
  }
  if (term === 'failed' && sources.length > 0 && term === 'failed' && String(b.terminalReason ?? '').length === 0) {
    return { ok: false, reason: 'brief is marked failed but gives no reason', checks }
  }
  checks.push('terminal state is consistent with what the brief carries')

  // ---- every cited source must have a real, independently verified artifact
  const elementsBySource = new Map<string, string[]>()
  const elementChrome = new Map<string, Array<ChromeClass | undefined>>()
  for (const s of sources) {
    if (!s || typeof s.id !== 'string' || typeof s.url !== 'string' || typeof s.artifactPath !== 'string') {
      return { ok: false, reason: 'a source record is malformed', checks }
    }
    let u: URL
    try { u = new URL(s.url) } catch { return { ok: false, reason: `source ${s.id} url is not a URL: ${s.url}`, checks } }
    if (u.protocol !== 'https:') return { ok: false, reason: `source ${s.id} url is ${u.protocol}, not https`, checks }
    if (isLocal(u.toString())) return { ok: false, reason: `source ${s.id} url is not an external host`, checks }
    if (String(s.title ?? '').trim().length === 0) {
      return { ok: false, reason: `source ${s.id} has no title`, checks }
    }

    // runId on the artifact is `${correlationId}.${sourceId}` - the binding between the brief's
    // source list and the bytes on disk. A source that names a real file belonging to a
    // DIFFERENT run is exactly the substitution this check exists to catch.
    const v = verifyRun(s.artifactPath, { runId: `${expected.correlationId}.${s.id}`, url: s.url, minElements: 1 })
    if (!v.ok) {
      return { ok: false, reason: `source ${s.id} (${s.url}) failed independent verification: ${v.reason}`, checks }
    }
    if (s.digest !== v.record.digest) {
      return {
        ok: false,
        reason: `source ${s.id} brief digest ${String(s.digest).slice(0, 16)}… does not match the artifact's ${v.record.digest.slice(0, 16)}…`,
        checks,
      }
    }
    // The classification must be present and structurally valid for the report's filtering to
    // mean anything. `verifyRun` already enforces this on v2 records; here the brief must not
    // have been built against a record that never had one.
    if (v.record.schemaVersion !== 3) {
      return {
        ok: false,
        reason: v.record.schemaVersion === 2
          ? `source ${s.id} is classified but carries no structural evidence (schemaVersion 2), so the report's chrome filtering cannot be reproduced`
          : `source ${s.id} is a legacy (v1) artifact with no site-chrome classification; a brief cannot claim chrome-aware reporting from it`,
        checks,
      }
    }
    for (let i = 0; i < v.record.elements.length; i++) {
      if (!isChromeClass(v.record.elements[i].chrome)) {
        return { ok: false, reason: `source ${s.id} element ${i} has no valid chrome classification`, checks }
      }
    }
    elementChrome.set(s.id, v.record.elements.map((e) => e.chrome))
    elementsBySource.set(s.id, v.record.elements.map((e) => e.text))
  }
  if (sources.length > 0) checks.push(`all ${sources.length} source artifact(s) independently verified from disk, digests agree`)

  // ---- claims must be traceable to stored evidence, or honestly labelled as not
  let traced = 0
  let unverified = 0
  for (const c of claims) {
    if (!c || typeof c.text !== 'string' || typeof c.kind !== 'string') {
      return { ok: false, reason: 'a claim is malformed', checks }
    }
    if (c.kind === 'quoted-fact') {
      if (c.sourceId === null || c.elementIndex === null || c.quote === null) {
        return { ok: false, reason: `claim ${c.id} is a quoted-fact but does not name its source, index and quote`, checks }
      }
      const stored = elementsBySource.get(c.sourceId)
      if (stored === undefined) {
        return { ok: false, reason: `claim ${c.id} cites source ${c.sourceId}, which is not in the brief`, checks }
      }
      if (c.elementIndex < 0 || c.elementIndex >= stored.length) {
        return { ok: false, reason: `claim ${c.id} points at element ${c.elementIndex} of ${c.sourceId}, which stores ${stored.length}`, checks }
      }
      if (stored[c.elementIndex] !== c.quote) {
        return {
          ok: false,
          reason: `claim ${c.id} quotes text that is NOT at index ${c.elementIndex} of source ${c.sourceId}: "${c.quote.slice(0, 40)}…" vs stored "${String(stored[c.elementIndex]).slice(0, 40)}…"`,
          checks,
        }
      }
      if (c.factualStatus !== 'traceable-to-stored-source') {
        return { ok: false, reason: `claim ${c.id} quotes a stored source but is labelled ${c.factualStatus}`, checks }
      }
      // The brief's COPY of the classification is re-derived from the artifact. Without this, a
      // brief could relabel a navigation item as main content and the report would show chrome
      // as evidence while every individual field still looked well-formed.
      const storedClass = elementChrome.get(c.sourceId)?.[c.elementIndex]
      const claimedClass = (c as { chromeClass?: unknown }).chromeClass
      const claimedIsChrome = (c as { isSiteChrome?: unknown }).isSiteChrome
      if (claimedClass !== storedClass) {
        return {
          ok: false,
          reason: `claim ${c.id} records chromeClass "${String(claimedClass)}", but source ${c.sourceId} element ${c.elementIndex} is classified "${String(storedClass)}"`,
          checks,
        }
      }
      const shouldBeChrome = storedClass !== undefined &&
        (CHROME_LABELS.has(storedClass))
      if (claimedIsChrome !== shouldBeChrome) {
        return {
          ok: false,
          reason: `claim ${c.id} records isSiteChrome=${String(claimedIsChrome)}, but its class "${String(storedClass)}" implies ${String(shouldBeChrome)}`,
          checks,
        }
      }
      // Excluded content must remain RECOVERABLE. A brief that filtered chrome out of the
      // report must still carry every claim in its claims array, so the excluded text is still
      // reachable - "reduced" must never mean "deleted".
      if (claimedIsChrome === true && c.text.trim().length === 0) {
        return { ok: false, reason: `claim ${c.id} is marked site chrome but carries no text, so the excluded content is not recoverable`, checks }
      }
      traced++
    } else if (c.kind === 'rule-derived') {
      // The rule is what makes it reviewable. Without a named rule it is an assertion.
      if (c.rule === null || c.rule.length === 0) {
        return { ok: false, reason: `rule-derived claim ${c.id} names no rule`, checks }
      }
      if (c.factualStatus !== 'not-automatically-verifiable') {
        return {
          ok: false,
          reason: `rule-derived claim ${c.id} is labelled "${c.factualStatus}"; a derived conclusion must not be presented as proven`,
          checks,
        }
      }
      unverified++
    } else {
      return { ok: false, reason: `claim ${c.id} has unknown kind "${c.kind}"`, checks }
    }
  }
  checks.push(`${traced} quoted claim(s) traced to stored evidence; ${unverified} rule-derived claim(s) correctly marked not-automatically-verifiable`)

  // ---- a brief with no evidence at all cannot be called complete
  if (term !== 'failed' && traced === 0) {
    return { ok: false, reason: 'the brief carries no traceable quoted evidence', checks }
  }
  checks.push('the brief carries at least one traceable quote')

  // ---- unresolved questions must be honest: absence of evidence has to be reported
  if (!Array.isArray(b.unresolved)) return { ok: false, reason: '"unresolved" is not an array', checks }
  const sectionsWithEvidence = new Set(claims.filter((c) => c.kind === 'quoted-fact').map((c) => c.section))
  if (term !== 'failed' && !sectionsWithEvidence.has('customers') && !b.unresolved.some((q) => /customer/i.test(String(q)))) {
    return { ok: false, reason: 'no customer evidence was collected and the brief does not say so', checks }
  }
  if (term !== 'failed' && !sectionsWithEvidence.has('products') && !b.unresolved.some((q) => /product|service/i.test(String(q)))) {
    return { ok: false, reason: 'no product/service evidence was collected and the brief does not say so', checks }
  }
  checks.push(`unresolved questions reported honestly (${b.unresolved.length})`)

  // ---- tamper detection over the brief itself
  const recomputed = digestBrief(
    b.correlationId, String(b.objective), String(b.startingUrl), sources, claims, b.unresolved as string[],
  )
  if (b.digest !== recomputed) {
    return {
      ok: false,
      reason: `brief digest mismatch: the file says ${String(b.digest).slice(0, 16)}…, its content hashes to ${recomputed.slice(0, 16)}…`,
      checks,
    }
  }
  checks.push('brief digest matches its content (no post-write tampering)')

  return { ok: true, brief: b as CompanyBrief, checks, sourcesVerified: sources.length, claimsTraced: traced, unverifiedClaims: unverified }
}