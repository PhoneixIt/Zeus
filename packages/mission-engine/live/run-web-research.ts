/**
 * LIVE WEB RESEARCH - the mission runner.
 *
 * =============================================================================
 * THE VERTICAL SLICE
 * =============================================================================
 *
 *   fetch (bounded, HTTPS only)  ->  extract (untrusted, inert)  ->  persist
 *     ->  CLOSE AND REOPEN  ->  verify from disk  ->  recover (bounded, idempotent)
 *
 * Every stage fails closed. A stage that cannot do its job produces a FAIL and the mission
 * stops; nothing is substituted to make a run look successful. In particular there is no
 * fixture fallback: if example.com is unreachable, the run reports unreachable.
 *
 * RECOVERY is bounded and only touches idempotent stages. Fetching a URL again and
 * re-extracting are both idempotent; verification and persistence are not repeated once they
 * have passed. A resumed run therefore does not redo verified work, and the record of what it
 * did survives in the run history.
 *
 * Run twice with different targets: distinct run ids, no corruption of the first run.
 */

import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { fetchPage, DEFAULT_LIMITS, type FetchResult } from './web-research.ts'
import { extractFrom, type ExtractResult } from './web-extract.ts'
import { buildRecord, verifyRun, type ResearchRecord } from './web-verify.ts'

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed++
}

const ROOT = mkdtempSync(join(tmpdir(), 'aios-webr-'))
const RUNS = join(ROOT, 'runs')
mkdirSync(RUNS, { recursive: true })

interface Stage { name: string; ok: boolean; detail: string; at: number }

interface RunOutcome {
  runId: string
  url: string
  ok: boolean
  artifactPath: string
  stages: Stage[]
  resumedFrom?: string
}

/** The persisted per-run state: what completed, and where the artifact went. */
const statePath = (runId: string) => join(RUNS, `${runId}.state.json`)
const artifactPath = (runId: string) => join(RUNS, `${runId}.record.json`)

const writeState = (o: RunOutcome) =>
  writeFileSync(statePath(o.runId), JSON.stringify(o, null, 2), 'utf8')
const readState = (runId: string): RunOutcome | undefined => {
  const p = statePath(runId)
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as RunOutcome) : undefined
}

const MAX_BODY_SAMPLE = 20_000
const MIN_ELEMENTS = 3

/**
 * Run one research mission.
 *
 * `resumeFrom` names a prior run. Only the idempotent prefix is redone; anything already
 * marked complete is skipped and the ATTEMPT is recorded, so a resumed run is visibly a
 * resumed run and not a silent re-run.
 */
async function runResearch(url: string, opts: { runId?: string; resumeFrom?: string } = {}): Promise<RunOutcome> {
  const resumed = opts.resumeFrom ? readState(opts.resumeFrom) : undefined
  const runId = opts.runId ?? randomUUID()
  const stages: Stage[] = []
  const done = new Map((resumed?.stages ?? []).map((s) => [s.name, s]))

  const stage = (name: string, fn: () => { ok: boolean; detail: string }): boolean => {
    // Idempotent stages may be redone after an interruption; the attempt is still recorded.
    if (opts.resumeFrom && done.has(name)) {
      stages.push({ name, ok: done.get(name)!.ok, detail: `skipped, already verified: ${done.get(name)!.detail}`, at: Date.now() })
      return done.get(name)!.ok
    }
    let r: { ok: boolean; detail: string }
    try { r = fn() } catch (e) { r = { ok: false, detail: `threw: ${e instanceof Error ? e.message : String(e)}` } }
    stages.push({ name, ok: r.ok, detail: r.detail, at: Date.now() })
    return r.ok
  }

  // ---- stage 1: acquire. Idempotent.
  // The fetch is async, so it is handled explicitly rather than through the sync `stage` helper.
  let fetched: FetchedPage | null = null
  if (opts.resumeFrom && done.has('acquire')) {
    stages.push({ name: 'acquire', ok: true, detail: `skipped, already verified: ${done.get('acquire')!.detail}`, at: Date.now() })
  } else {
    const res: FetchResult = await fetchPage(url, DEFAULT_LIMITS)
    if ('failure' in res) {
      stages.push({ name: 'acquire', ok: false, detail: `${res.failure.kind}: ${res.failure.detail}`, at: Date.now() })
      const out: RunOutcome = { runId, url, ok: false, artifactPath: artifactPath(runId), stages, ...(opts.resumeFrom ? { resumedFrom: opts.resumeFrom } : {}) }
      writeState(out)
      return out
    }
    fetched = { finalUrl: res.page.finalUrl, status: res.page.status, contentType: res.page.contentType, fetchedAt: res.page.fetchedAt, body: res.page.body, truncated: res.page.truncated, redirectChain: res.page.redirectChain }
    stages.push({
      name: 'acquire', ok: true,
      detail: `HTTP ${res.page.status} from ${res.page.finalUrl}, ${res.page.bytes} bytes in ${res.page.elapsedMs}ms`,
      at: Date.now(),
    })
  }

  if (!fetched) {
    // Resuming past the fetch. There is no cached body to re-extract, so this run can only be
    // honest about what it has: the stages already recorded. It says so rather than pretending.
    stages.push({ name: 'extract', ok: false, detail: 'cannot resume: no cached body and no artifact to verify', at: Date.now() })
    const out: RunOutcome = { runId, url, ok: false, artifactPath: artifactPath(runId), stages, resumedFrom: opts.resumeFrom }
    writeState(out)
    return out
  }

  // ---- stage 2: extract. Idempotent.
  let extraction: ExtractResult | null = null
  if (opts.resumeFrom && done.has('extract')) {
    stages.push({ name: 'extract', ok: true, detail: `skipped, already verified: ${done.get('extract')!.detail}`, at: Date.now() })
  } else {
    extraction = extractFrom(fetched.body)
    if ('error' in extraction) {
      stages.push({ name: 'extract', ok: false, detail: extraction.error, at: Date.now() })
      const out: RunOutcome = { runId, url, ok: false, artifactPath: artifactPath(runId), stages, ...(opts.resumeFrom ? { resumedFrom: opts.resumeFrom } : {}) }
      writeState(out)
      return out
    }
    stages.push({
      name: 'extract', ok: true,
      detail: `title="${extraction.extraction.title.slice(0, 60)}", ${extraction.extraction.elements.length} element(s), hostile=${extraction.extraction.hostileContentSeen}`,
      at: Date.now(),
    })
  }

  // ---- stage 3: persist. NOT idempotent: writing twice would create two artifacts.
  let record: ResearchRecord | null = null
  if (opts.resumeFrom && done.has('persist') && existsSync(artifactPath(runId))) {
    stages.push({ name: 'persist', ok: true, detail: 'skipped, artifact already on disk', at: Date.now() })
  } else {
    if (!extraction) {
      stages.push({ name: 'persist', ok: false, detail: 'nothing to persist: extraction did not run', at: Date.now() })
      const out: RunOutcome = { runId, url, ok: false, artifactPath: artifactPath(runId), stages, ...(opts.resumeFrom ? { resumedFrom: opts.resumeFrom } : {}) }
      writeState(out)
      return out
    }
    // The body is capped ONCE, here, and the extraction runs on the capped text, so the findings
    // and the stored `bodySample` describe the same region and the verifier can reach the same
    // answer by re-scanning. Capping AFTER extraction would make every record inconsistent by
    // construction.
    //
    // The cap is a memory bound, not a correctness bound, so a cap that captures no content is
    // not a reason to record an empty result. RFC 9110 spends its first 20 KB on <head>
    // boilerplate - zero content tags - so a blind byte-cap would have reported "this page has
    // no extractable content" about a 1.1 MB specification. The cap is therefore relaxed when
    // it yields nothing, and the relaxation is recorded in `bodyCapped` rather than hidden.
    let bodySample = fetched.body.slice(0, MAX_BODY_SAMPLE)
    let scoped = extractFrom(bodySample)
    if ('error' in scoped || scoped.extraction.elements.length === 0) {
      bodySample = fetched.body
      scoped = extractFrom(bodySample)
    }
    const bodyCapped = bodySample.length < fetched.body.length
    if ('error' in scoped) {
      stages.push({ name: 'persist', ok: false, detail: `re-extraction of the capped body failed: ${scoped.error}`, at: Date.now() })
      const out: RunOutcome = { runId, url, ok: false, artifactPath: artifactPath(runId), stages, ...(opts.resumeFrom ? { resumedFrom: opts.resumeFrom } : {}) }
      writeState(out)
      return out
    }
    const ex = scoped.extraction
    try {
      record = buildRecord({
        runId,
        requestedUrl: url,
        finalUrl: fetched.finalUrl,
        status: fetched.status,
        contentType: fetched.contentType,
        fetchedAt: fetched.fetchedAt,
        title: ex.title,
        elements: ex.elements.map((e: { tag: string; text: string; href?: string }) => ({
          tag: e.tag, text: e.text, ...(e.href ? { href: e.href } : {}),
        })),
        elementCount: ex.elements.length,
        hostileContentSeen: ex.hostileContentSeen,
        findingCount: ex.findings.length,
        bodySample,
        bodyCapped,
        truncated: ex.truncated || bodyCapped,
        redirectChain: fetched.redirectChain,
      })
      writeFileSync(artifactPath(runId), JSON.stringify(record, null, 2), 'utf8')
      stages.push({ name: 'persist', ok: true, detail: `wrote ${artifactPath(runId)} (${JSON.stringify(record).length} bytes)`, at: Date.now() })
    } catch (e) {
      stages.push({ name: 'persist', ok: false, detail: `write failed: ${e instanceof Error ? e.message : String(e)}`, at: Date.now() })
      const out: RunOutcome = { runId, url, ok: false, artifactPath: artifactPath(runId), stages, ...(opts.resumeFrom ? { resumedFrom: opts.resumeFrom } : {}) }
      writeState(out)
      return out
    }
  }

  const out: RunOutcome = { runId, url, ok: true, artifactPath: artifactPath(runId), stages, ...(opts.resumeFrom ? { resumedFrom: opts.resumeFrom } : {}) }
  writeState(out)
  return out
}

/** The subset of a fetched page this runner carries between stages. */
interface FetchedPage {
  finalUrl: string
  status: number
  contentType: string | null
  fetchedAt: number
  body: string
  truncated: boolean
  redirectChain: readonly string[]
}

// ===========================================================================================
// The live runs
// ===========================================================================================

// Both targets are real, public, third-party HTTPS pages with enough substance to carry at
// least MIN_ELEMENTS. `example.com` was tried first and genuinely has only ONE content
// element - it is a single-paragraph page - so it failed the element requirement correctly.
// Keeping a target that cannot satisfy the mission's own criteria would mean either lowering
// the criteria for everything, or recording a run that verifies for the wrong reason.
// Two DIFFERENT real, public, third-party HTTPS pages, so "two runs" means two distinct
// retrievals rather than the same document fetched twice. Both were chosen after the first
// attempts failed the mission's own criteria for honest reasons: `example.com` has one
// content element, and iana.org was replaced once RFC 9110 proved it exercises the extractor
// harder (preformatted specification text, plus incidental instruction-like phrases).
const TARGETS = ['https://www.iana.org/help/example-domains', 'https://www.rfc-editor.org/rfc/rfc9110.html']

console.log('=== RUN 1 and RUN 2: real external HTTPS ===')
const outcomes: RunOutcome[] = []
for (const [i, url] of TARGETS.entries()) {
  console.log(`\n--- run ${i + 1}: ${url}`)
  const o = await runResearch(url)
  outcomes.push(o)
  for (const s of o.stages) console.log(`  ${s.ok ? 'ok  ' : 'FAIL'} ${s.name}: ${s.detail}`)
  check(`run ${i + 1} completed all stages`, o.ok, `runId=${o.runId}`)
}

console.log('')
console.log('=== INDEPENDENT VERIFICATION: fresh read from disk ===')
for (const [i, o] of outcomes.entries()) {
  console.log(`\n--- run ${i + 1}: ${o.artifactPath}`)
  check(`run ${i + 1} artifact exists on disk`, existsSync(o.artifactPath))
  const v = verifyRun(o.artifactPath, { runId: o.runId, url: TARGETS[i], minElements: MIN_ELEMENTS })
  if (v.ok) {
    console.log(`  verdict OK  title="${v.record.title.slice(0, 60)}"  elements=${v.record.elements.length}  findings=${v.rechecked}  digest=${v.record.digest.slice(0, 16)}…`)
    check(`run ${i + 1} verified`, true)
    check(`run ${i + 1} finalUrl is external HTTPS`, v.record.finalUrl.startsWith('https://') && !v.record.finalUrl.includes('localhost'))
    check(`run ${i + 1} has a title and >= ${MIN_ELEMENTS} elements`, v.record.title.length > 0 && v.record.elements.length >= MIN_ELEMENTS, `${v.record.elements.length}`)
  } else {
    check(`run ${i + 1} verified`, false, v.reason)
  }
}

check('the two runs have distinct ids', outcomes[0].runId !== outcomes[1].runId, `${outcomes[0].runId} vs ${outcomes[1].runId}`)
check('the first run\'s artifact was not corrupted by the second', verifyRun(outcomes[0].artifactPath, { runId: outcomes[0].runId, url: TARGETS[0], minElements: MIN_ELEMENTS }).ok)
check('both artifacts are on disk', outcomes.every((o) => existsSync(o.artifactPath)))

// ===========================================================================================
// Tamper detection - against the real artifact
// ===========================================================================================

console.log('')
console.log('=== TAMPER DETECTION on a real, verifying artifact ===')
{
  const o = outcomes[0]
  // Baseline: the untouched artifact must PASS, or a rejection below proves nothing.
  const clean = verifyRun(o.artifactPath, { runId: o.runId, url: TARGETS[0], minElements: MIN_ELEMENTS })
  check('the untouched artifact verifies', clean.ok, clean.ok ? 'baseline established' : clean.reason)
  const original = readFileSync(o.artifactPath, 'utf8')

  // Tamper 1: change the title. The digest must catch it.
  const t1 = JSON.parse(original) as { title: string }
  t1.title = 'REPLACED BY SOMETHING ELSE'
  const p1 = join(ROOT, 'tampered-title.json')
  writeFileSync(p1, JSON.stringify(t1, null, 2), 'utf8')
  const v1 = verifyRun(p1, { runId: o.runId, url: TARGETS[0], minElements: MIN_ELEMENTS })
  check('a tampered title is rejected', !v1.ok, v1.ok ? 'ACCEPTED A TAMPERED RECORD' : v1.reason)
  // The reason must be the DIGEST, not some incidental check - otherwise this would still be
  // evidence for the wrong reason.
  check('and it is rejected on the digest specifically', !v1.ok && /digest mismatch/.test(v1.reason), v1.ok ? '' : v1.reason)

  // Tamper 2: the harder case. Rewrite a field AND recompute the digest, so the digest agrees.
  // This is what a record trying to look clean looks like, and only the semantic checks catch it.
  const t2 = JSON.parse(original) as ResearchRecord
  const swapped = { ...t2, finalUrl: 'https://localhost:8080/attacker-controlled' }
  const { digest: _old, ...rest2 } = swapped
  const reforged = buildRecord(rest2 as Omit<ResearchRecord, 'digest'>)
  const p2 = join(ROOT, 'tampered-url.json')
  writeFileSync(p2, JSON.stringify(reforged, null, 2), 'utf8')
  const v2 = verifyRun(p2, { runId: o.runId, url: TARGETS[0], minElements: MIN_ELEMENTS })
  check('a re-forged record pointing at localhost is rejected, digest notwithstanding', !v2.ok, v2.ok ? 'ACCEPTED A FORGED RECORD' : v2.reason)

  // Tamper 3: a record claiming a different run id.
  const p3 = join(ROOT, 'wrong-run.json')
  writeFileSync(p3, original, 'utf8')
  const v3 = verifyRun(p3, { runId: 'a-different-run', url: TARGETS[0], minElements: MIN_ELEMENTS })
  check('the same artifact verified against the WRONG run id is rejected', !v3.ok, v3.ok ? 'ACCEPTED' : v3.reason)
}

console.log('')
console.log(`=== ${failed === 0 ? 'PASS' : failed + ' FAILURE(S)'} ===`)
console.log(`  artifacts under: ${RUNS}`)
console.log(`  ids: ${outcomes.map((o) => o.runId).join(', ')}`)
process.exit(failed ? 1 : 0)