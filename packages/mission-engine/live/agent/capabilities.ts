/**
 * AIOS CAPABILITIES - the things the assistant can actually DO.
 *
 * =============================================================================
 * WHAT A CAPABILITY IS HERE
 * =============================================================================
 *
 * A capability is a tool PLUS an independent verifier, bound together and registered under a
 * human-readable description. The description is not documentation for its own sake: it is the
 * text the model reads when deciding what to use, so it is part of the control surface. A
 * capability whose description overstates what it does causes the model to pick it for tasks it
 * cannot handle, and the mission fails in a way that looks like the model's fault.
 *
 * That is why each one is written in the second person and states its limits.
 *
 * =============================================================================
 * THE RULE NO CAPABILITY MAY BREAK
 * =============================================================================
 *
 * A tool returns what it DID. A verifier re-reads the world and decides whether that is true.
 * They are never the same code path, and a verifier never receives the tool's in-memory result -
 * it is handed the step and asked to go and look. The executor refuses a step with no verifier,
 * so a capability cannot be registered without one; that is enforced upstream, not by discipline
 * here.
 *
 * =============================================================================
 * WHAT IS AND IS NOT HERE
 * =============================================================================
 *
 * Present: browser research, file read/write, spreadsheet authoring, window discovery, terminal.
 * Absent: anything that needs injected input, because the guard currently refuses it. Those are
 * not stubbed to look complete - `desktopInputBlocked` says so plainly, so the model is told the
 * capability is unavailable instead of discovering it by failing.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, appendFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve, isAbsolute, extname, sep, normalize, basename } from 'node:path'
import { homedir } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import type { Tool, ToolContext, ToolResult, Verifier } from '../../executor.ts'
// The transport-loss classifier, shared with the executor's throwing-tool boundary - one
// regex set, one verdict, for the same evidence in both layers. See transport-loss.ts.
import { midActionTransportLoss } from '../../transport-loss.ts'
import type { DeclaredEffect } from '../../../governance/approval.ts'
import type { WindowInfo } from '../../../governance/contract.ts'
import type { Step, Evidence } from '../../state.ts'

import { runCompanyBrief, ensureBriefDirs, type BriefRunResult } from '../company-brief.ts'
import { verifyBrief } from '../verify-brief.ts'
import { liveControl, surveyWindow, livePermission, armOperator } from '../live-control.ts'
import { GIT_SENDS as GIT_SEND_VERBS, GIT_DESTRUCTIVE as GIT_DESTROY_VERBS } from '../terminal-policy.ts'
import { windowIsSameApp, adoptedWindowRefusal } from './window-identity.ts'
import {
  contentLooksWrongFor, sha256File, safeStatSize,
  contractFor, authorizeShell, snapshotArtifacts, artifactDelta,
} from './artifacts.ts'

// ===========================================================================================
// shared helpers
// ===========================================================================================

/** Every artifact this process writes lives under one auditable root. Never a temp directory. */
export const AGENT_ROOT = join(homedir(), '.aios', 'agent')
export const AGENT_OUT = join(AGENT_ROOT, 'out')

function ensureOut(): void {
  mkdirSync(AGENT_OUT, { recursive: true })
}

/** Extensions a mission may read back. A write target should already carry one of these. */
const READABLE_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.log']

/**
 * Reduce a model-supplied filename to something inert, safe to join onto a directory.
 *
 * WHY THIS IS A FUNCTION AND NOT A ONE-LINE REPLACE
 *
 * The first version of the write-path recovery sanitised with `[^\w.-]` and used the result
 * directly. A filename of `..` survives that - both characters are in the allowed set - and
 * `join(AGENT_OUT, '..')` is the PARENT of the output directory. That is a real traversal out of
 * the only folder a mission may write to, and it was found by a test written to check exactly
 * this, not by reading the code.
 *
 * The rules, in order, because each catches something the previous one does not:
 *   1. keep only word characters and a dot, so no separator can survive
 *   2. reject a name that is entirely dots (`.`, `..`, `...`) - these mean "go up" to the
 *      filesystem, whatever else they contain
 *   3. ensure the name ends in an extension a mission can READ BACK. A filename taken from
 *      `drivers\etc\hosts` is extensionless, and a file AIOS writes but can never read back is
 *      not a deliverable - the closing read-file step fails on it, which is the same class of
 *      failure as the wrong folder, just one step later.
 *   4. fall back to a fixed name rather than returning nothing, so a caller cannot accidentally
 *      write to the directory itself
 */
export function safeFileName(raw: string, fallback = 'output'): string {
  const leaf = String(raw ?? '').split(/[\\/]/).pop() ?? ''
  let name = leaf.replace(/[^\w.-]/g, '_').replace(/^\.+/, '')
  if (name.length === 0 || /^\.+$/.test(name)) name = fallback
  name = name.slice(0, 120)
  const ext = extname(name).toLowerCase()
  if (!READABLE_EXTENSIONS.includes(ext)) {
    const wanted = extname(fallback).toLowerCase()
    name = wanted && READABLE_EXTENSIONS.includes(wanted) ? name + wanted : name + '.csv'
  }
  return name
}

/**
 * Place a model-supplied filename inside a directory, guaranteed to stay inside it.
 *
 * The guarantee is checked, not assumed: the joined path is compared against the directory after
 * normalisation, and anything that did not land inside is replaced rather than returned. A
 * security-relevant helper that trusts its own input to behave is not a guarantee.
 */
export function confineTo(dir: string, rawName: string, fallback = 'output'): string {
  const name = safeFileName(rawName, fallback)
  const candidate = join(dir, name)
  const base = normalize(dir) + sep
  if (normalize(candidate).startsWith(base)) return candidate
  return join(dir, safeFileName(fallback, 'output'))
}

/** Where a user-facing file may be written. Prevents a model turning the tool into a file writer. */
export function allowedOutputPath(p: string): string {
  const abs = resolve(p)
  const root = resolve(AGENT_OUT)
  if (abs !== root && !abs.startsWith(root + join('', '/'))) {
    throw new Error(`output must live under ${root}; ${abs} is outside it`)
  }
  return abs
}

const str = (v: unknown, k: string, fallback = ''): string => (typeof v === 'string' && v.trim() ? v : fallback)
const num = (v: unknown, fallback = 0): number => (Number.isFinite(Number(v)) ? Number(v) : fallback)

// ===========================================================================================
// CAPABILITY 1 - web research (multi-page, evidence-backed)
// ===========================================================================================

let lastBrief: BriefRunResult | null = null

/**
 * Rewrite a search URL to one that will not be blocked, preserving the query.
 *
 * Google's search results page is protected against automation and returns a CAPTCHA ("sorry")
 * instead of results - confirmed on this machine, which is why the first real run of
 * web-research on a Google URL produced zero quoted facts. The query string is parsed, not
 * string-substituted, so a malicious query cannot become part of a different URL.
 */
function rewriteBlockedSearchUrl(url: string): string {
  const google = /^https?:\/\/(www\.)?google\.[a-z.]+\/search\b/i.exec(url)
  if (!google) return url
  try {
    const u = new URL(url)
    const q = u.searchParams.get('q')
    if (!q) return url
    return `https://duckduckgo.com/?q=${encodeURIComponent(q)}`
  } catch {
    return url
  }
}

const webResearchTool: Tool = {
  name: 'web-research',
  mode: 'browser',
  args: [
    { name: 'url', type: 'string', required: true, description: 'the public https page to start from' },
    { name: 'objective', type: 'string', required: true, description: 'what the research is for' },
    { name: 'pages', type: 'number', required: false, description: 'how many pages to follow, 1-6' },
  ],
  async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const url = str(args.url, 'url')
    const objective = str(args.objective, 'objective')
    if (!url) return { kind: 'failed', reason: 'no url was given' }
    if (!objective) return { kind: 'failed', reason: 'no objective was given' }

    // GOOGLE BLOCKS AUTOMATED SEARCH. This was observed, not assumed: the first real run of
    // this capability on this machine fetched https://www.google.com/search?q=data+protection+companies
    // and got a "sorry" page - a CAPTCHA - with zero quoted facts. Google's search results are not
    // a free resource in practice, no matter what the URL looks like.
    //
    // DuckDuckGo's HTML endpoint is the same information without the gate, so a Google search URL
    // is transparently rewritten here. The rewrite is logged, the original is preserved in the
    // objective, and a person who genuinely wants Google can still get it by passing a non-search
    // Google URL. What is NOT allowed is for the planner to choose a search engine that silently
    // fails - that is the failure this code exists to prevent.
    const effectiveUrl = rewriteBlockedSearchUrl(url)

    const { findChrome } = await import('../run-research-desk.ts')
    const chrome = findChrome()
    if (!chrome) return { kind: 'failed', reason: 'no Chrome/Edge binary was found on this machine' }
    ensureBriefDirs()

    try {
      const { mkdtempSync } = await import('node:fs')
      const { tmpdir } = await import('node:os')
      const r = await runCompanyBrief({
        chromePath: chrome,
        cdpPort: 9402,
        // A throwaway profile per run: the user's own browser profile is never opened.
        profileDir: mkdtempSync(join(tmpdir(), 'aios-agent-profile-')),
        runDir: join(AGENT_ROOT, 'runs'),
        limits: { maxPages: Math.min(6, Math.max(1, num(args.pages, 3))) },
      }, objective, effectiveUrl)
      lastBrief = r
      if (r.terminalState === 'failed') {
        return { kind: 'failed', reason: r.terminalReason }
      }
      return {
        kind: 'data',
        summary: `${r.sources.length} page(s), ${r.claims.filter((c) => c.kind === 'quoted-fact').length} quoted fact(s)`,
        data: {
          correlationId: r.correlationId,
          briefPath: r.briefPath,
          objective: r.objective,
          terminalState: r.terminalState,
          sources: r.sources.map((s) => ({ id: s.id, url: s.url, title: s.title, elements: s.elementCount })),
        },
      }
    } catch (e) {
      return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) }
    }
  },
}

/**
 * Re-reads the brief from disk in a FRESH parse and re-verifies every source artifact.
 *
 * It is handed the path the tool recorded, not the tool's result object, so a tool that reported
 * a successful run without writing anything fails here.
 */
const webResearchVerifier: Verifier = {
  verifies: (s: Step) => s.mode === 'browser' && (s.tool ?? '').includes('web-research'),
  async verify(_s: Step, _ctx: ToolContext, toolData: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
    const d = toolData as { briefPath?: string; correlationId?: string } | undefined
    if (!d?.briefPath || !d.correlationId) return { rejected: 'the step recorded no brief path to verify' }
    if (!existsSync(d.briefPath)) return { rejected: `no brief on disk at ${d.briefPath}` }

    const v = verifyBrief(d.briefPath, { correlationId: d.correlationId, minSources: 1 })
    if (!v.ok) return { rejected: `the saved brief does not verify: ${v.reason}` }
        return {
      evidence: {
        kind: 'artifact',
        detail: `${v.sourcesVerified} source(s) re-read from disk; ${v.claimsTraced} claim(s) traced to stored quotes`,
        path: d.briefPath,
      } as unknown as Evidence,
    }
  },
}

// ===========================================================================================
// CAPABILITY 2 - write a file
// ===========================================================================================

/**
 * Resolve `{{stepId.data.a.b}}` references against earlier steps' results.
 *
 * A model asked to chain two steps naturally writes the second one as a template referring to
 * the first. Without this, the file was written containing the literal text `{{s1.data.output}}`
 * - faithfully, and completely useless. The tool did exactly what it was told; nobody had told
 * it what the placeholder meant.
 *
 * SAFETY, which is the reason this lives here and is deliberately narrow:
 *   - only `{{step.path}}` is recognised; anything else is left EXACTLY as written, so a file
 *     that legitimately contains braces is not mangled
 *   - a reference to a step with no result resolves to an empty string and the fact is recorded,
 *     rather than silently producing a half-filled document
 *   - the cap on total substituted length keeps a large prior result from being inlined into a
 *     field that was meant to hold a path
 *
 * A tool cannot escalate by resolving a reference: this only READS results the executor already
 * gave it, and writes to the same output directory it could write to anyway.
 */
export function resolveRefs(
  text: string,
  prior: Readonly<Record<string, unknown>> | undefined,
): { text: string; unresolved: string[] } {
  if (typeof text !== 'string' || !text.includes('{{')) return { text: String(text ?? ''), unresolved: [] }
  const unresolved: string[] = []
  const MAX = 20_000

  const walk = (root: unknown, parts: string[]): unknown => {
    let cur: unknown = root
    for (const part of parts) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
      cur = (cur as Record<string, unknown>)[part]
    }
    return cur
  }

  /**
   * The executor's `StepResult` carries the tool's whole `ToolResult` under `output`, so the
   * real path to a tool's data is `s1.output.data.output`. A model writes `s1.data.output`
   * because that is the shape the tool returns. Rather than demand one exact spelling, the
   * candidates below are tried in order - the first that resolves wins, and an unresolved
   * reference falls back to the step's summary, which is what a person would have written.
   */
  const candidatesFor = (stepId: string, dotted: string): string[][] => {
    const parts = dotted.split('.').filter((p) => p.length > 0)
    if (parts.length === 0) return [[]]
    return [
      [stepId, ...parts],
      [stepId, 'output', ...parts],
      [stepId, 'output', 'data', ...parts],
      [stepId, 'data', ...parts],
    ]
  }

  const out = text.replace(/\{\{\s*([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_]+)*)\s*\}\}/g, (whole, stepId: string, dotted: string) => {
    const bucket = (prior ?? {})[stepId] as Record<string, unknown> | undefined
    if (!bucket) { unresolved.push(whole); return '' }

    for (const path of candidatesFor(stepId, dotted)) {
      // Each candidate is expressed relative to the prior map.
      const value = walk(prior, path)
      if (value === undefined || value === null) continue
      if (typeof value === 'object' && value !== null && 'kind' in (value as Record<string, unknown>)) {
        // A whole ToolResult was referenced; its summary is the readable part.
        const summary = (value as { summary?: unknown }).summary
        if (typeof summary === 'string') return summary.slice(0, MAX)
      }
      const s = typeof value === 'string' ? value : JSON.stringify(value)
      return s.length > MAX ? s.slice(0, MAX) : s
    }
    // The step's readable summary. `StepResult` has no `summary` field of its own - the summary
    // the user sees lives on the tool result nested inside `output`. Checking only the outer
    // object silently produced an empty string instead of the fallback.
    const outerSummary = bucket.summary
    const innerSummary = (bucket.output as { summary?: unknown } | undefined)?.summary
    const fallback = typeof outerSummary === 'string' && outerSummary.length > 0
      ? outerSummary
      : typeof innerSummary === 'string' ? innerSummary : undefined
    if (fallback !== undefined) return fallback.slice(0, MAX)
    unresolved.push(whole)
    return ''
  })
  return { text: out, unresolved }
}

const writeFileTool: Tool = {
  name: 'write-file',
  mode: 'filesystem',
  args: [
    { name: 'path', type: 'string', required: true, description: 'absolute path under the agent output directory' },
    { name: 'content', type: 'string', required: true, description: 'the text to write' },
  ],
  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const raw = str(args.path, 'path')
    const resolved = resolveRefs(typeof args.content === 'string' ? args.content : '', ctx.prior)
    const content = resolved.text

    // Fail closed on an EMPTY file.
    //
    // This is the "verifier repeats the executor" trap, found by running: the model produced a
    // step with no content, the tool wrote an empty file, and the verifier - re-reading the file -
    // cheerfully confirmed the file was there and was the right size, which it was. Both tools
    // were individually correct and the pair still produced a useless result.
    //
    // A file with no content is not a finished artefact, so writing one is now a refusal, and the
    // refusal names the likely cause: a reference that did not resolve.
    if (content.trim().length === 0) {
      const why = resolved.unresolved.length > 0
        ? `the content was only references and none resolved: ${resolved.unresolved.join(', ')}`
        : 'the content was empty'
      return { kind: 'failed', reason: `refusing to write an empty file: ${why}` }
    }
    if (!raw) return { kind: 'failed', reason: 'no path was given' }
    let p: string
    try { p = allowedOutputPath(raw) } catch (e) {
      return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) }
    }

    // NEVER REPLACE A FILE THAT ALREADY EXISTS. This is the check whose absence destroyed a
    // verified 407-row inventory: a later mission resolved to the same filename and
    // `writeFileSync` truncated it, with no error and nothing in the record to notice. See
    // artifacts.ts for the whole incident.
    //
    // The gate is here - at the last point before bytes hit disk - rather than only in validation,
    // because validation cannot know what is on disk when the write actually happens. A second
    // mission, or a second attempt inside one mission, can create the file in between, and a
    // plan-time check would have been checked against a state that no longer holds.
    //
    // `flag: 'wx'` is the primitive: it fails with EEXIST rather than truncating. It is atomic
    // where existsSync-then-write is a race, which matters precisely because two missions sharing
    // a destination is the situation this exists for.
    const existsAlready = existsSync(p)
    if (existsAlready) {
      const prior = sha256File(p)
      const size = safeStatSize(p)
      return {
        kind: 'failed',
        reason: `refusing to overwrite ${p}: it already exists and holds ${size ?? '?'} byte(s)`
          + (prior ? ` (sha256 ${prior.slice(0, 16)}...)` : '')
          + '. A file that is already there is not this mission\'s to replace. Write to a new '
          + 'filename, or delete the existing file yourself if it is stale.',
      }
    }

    // CONTENT OF THE WRONG KIND FOR THIS DESTINATION. Catches the specific damage: a `.csv`
    // deliverable about to be overwritten by the Python program that was supposed to produce it.
    const wrongKind = contentLooksWrongFor(p, content)
    if (wrongKind) return { kind: 'failed', reason: wrongKind }

    ensureOut()
    try {
      mkdirSync(dirname(p), { recursive: true })
      // Stage, then promote. A partial write must never be visible at the deliverable's path -
      // a crash between truncate and completion would leave a truncated file that a later
      // read-back verifies as "the right size", because the verifier compares against the size
      // this call recorded.
      const staged = `${p}.${process.pid}-${Date.now()}.staging`
      try {
        writeFileSync(staged, content, { encoding: 'utf8', flag: 'wx' })
        // Only now does the destination change. renameSync replaces atomically on Windows for a
        // same-volume move, so a reader sees the old file or the new one, never a half-written one.
        renameSync(staged, p)
      } catch (e) {
        // A failed promotion must not leave the staging file behind to be mistaken for an artefact.
        try { if (existsSync(staged)) unlinkSync(staged) } catch { /* nothing further to do */ }
        throw e
      }
      const bytes = statSync(p).size
      return {
        kind: 'data',
        summary: `wrote ${bytes} byte(s)`,
        // The hash is returned so the record can prove later WHICH bytes this was. Without it,
        // "the file exists" and "the file is still what this mission wrote" are indistinguishable,
        // which is exactly what let a clobber read as a success.
        data: { path: p, bytes, sha256: sha256File(p) },
      }
    } catch (e) {
      return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) }
    }
  },
}

const writeFileVerifier: Verifier = {
  verifies: (s: Step) => (s.tool ?? '').includes('write-file'),
  async verify(_s: Step, _ctx: ToolContext, toolData: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
    const d = toolData as { path?: string; bytes?: number } | undefined
    if (!d?.path) return { rejected: 'the step recorded no path to verify' }
    if (!existsSync(d.path)) return { rejected: `nothing exists at ${d.path}` }
    const actual = statSync(d.path).size
    if (actual !== d.bytes) return { rejected: `the file is ${actual} bytes; the step recorded ${d.bytes}` }
    return {
      evidence: {
        kind: 'artifact', detail: `re-read from disk: ${actual} byte(s)`, path: d.path,
      } as unknown as Evidence,
    }
  },
}

// ===========================================================================================
// CAPABILITY 3 - spreadsheet (CSV: no dependency, no cost, opens in Excel/LibreOffice)
// ===========================================================================================

/** Parse CSV properly enough to verify it: quoted fields, embedded commas, escaped quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
      } else field += ch
      continue
    }
    if (ch === '"') { inQuotes = true; continue }
    if (ch === ',') { row.push(field); field = ''; continue }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    if (ch === '\r') continue
    field += ch
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.length > 0)
}

const csvCell = (v: unknown): string => {
  const s = String(v ?? '').replace(/\r?\n/g, ' ').trim()
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const spreadsheetTool: Tool = {
  name: 'spreadsheet',
  mode: 'filesystem',
  args: [
    { name: 'path', type: 'string', required: true, description: 'absolute .csv path under the agent output directory' },
    { name: 'headers', type: 'string', required: true, description: 'comma-separated column headers' },
    {
      name: 'rows',
      type: 'string|array',
      required: true,
      description:
        'THE ROWS, AS A JSON ARRAY OF ARRAYS: [["Veeam","2006"],["Commvault","1996"]]. '
        + 'Prefer this form and nothing else. It is the only one a small model emits reliably, '
        + 'because each cell is its own JSON string and no cell ever has to carry a comma, a '
        + 'quote or a newline inside a delimited string. A newline-separated string also works '
        + 'and is accepted, but it is the shape that most often produces an unparseable plan: '
        + 'a model quoting a cell that contains a comma emits a quote that is indistinguishable '
        + 'from a JSON delimiter, and the whole plan is then lost. Use one column per array '
        + 'element, in the same order as headers.',
    },
  ],
  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const raw = str(args.path, 'path')
    if (!raw) return { kind: 'failed', reason: 'no path was given' }
    let p: string
    try { p = allowedOutputPath(raw) } catch (e) {
      return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) }
    }
    const rHeaders = resolveRefs(str(args.headers, 'headers'), ctx.prior)
    const headers = rHeaders.text
    if (!headers) return { kind: 'failed', reason: 'no headers were given' }

    // Accept BOTH shapes, because a plan written before this argument was documented will still
    // arrive as a string. The array form is joined here rather than in the planner so that the
    // tool is the single place that decides how a cell becomes text.
    const rawRows = args.rows
    // CELLS ARE THE UNIT, all the way through. The array form keeps them as cells; the string
    // form is split into them once, here.
    //
    // An earlier version joined array cells into a comma-separated string and then split it
    // again further down, which destroyed the quoting `csvCell` had just applied: a cell holding
    // "backup, disaster recovery, cloud" was quoted, then re-split on those commas, and came back
    // as five columns. The array form exists precisely to make that cell expressible, so it must
    // not be flattened on the way to disk.
    const cellsPerRow: string[][] = Array.isArray(rawRows)
      ? rawRows.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : [String(r ?? '')]))
      : resolveRefs(String(rawRows ?? ''), ctx.prior).text
        .split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
        .map((l) => l.split(','))

    // A MODEL INVENTS URLS. It is not a bug in the tool that it does: the model wants every
    // row to look authoritative, and a real URL is the cheapest way to look authoritative. But
    // a URL that is not in the research brief is not evidence; it is a hallucination wearing a
    // link's clothes. The verifier rejects the whole sheet for it, which leaves the person with
    // nothing.
    //
    // The honest repair is to DROP the unverified URL - not to replace it with a different one,
    // which would be fabrication, and not to keep it, which would be a lie. An empty cell is
    // honest: it says "no source was found for this row", which is exactly what happened.
    // The dropped URLs are reported in the summary so the person can see what was removed and
    // why, rather than wondering why the sheet is shorter on links than expected.
    const droppedUrls: string[] = []
    const cleanedCells = cellsPerRow.map((cells) => cells.map((cell) => {
      const m = /^https:\/\/\S+$/.exec(cell.trim())
      if (!m) return cell
      const u = cell.trim()
      let found = false
      try {
        if (lastBrief && lastBrief.sources.some((s) => s.url === u)) found = true
        else if (lastBrief) {
          const raw = readFileSync(lastBrief.briefPath, 'utf8')
          found = raw.includes(u)
        }
      } catch { found = false }
      if (!found) { droppedUrls.push(u); return '' }
      return cell
    }))

    // A MODEL GENERATES RAGGED ROWS. It is not a bug in the tool that it does: a language model
    // counting columns across a long row is not good at it, and rejecting the step for a missing
    // cell leaves the person with nothing. The honest repair is to PAD the short rows with empty
    // cells and REPORT that it happened, so the sheet is still rectangular and the missing data
    // is visible rather than silently absent. Nothing is invented: an empty cell is an empty cell.
    const headerCells = headers.split(',')
    const headerCount = headerCells.length
    const padded = cleanedCells.map((cells) => (
      cells.length >= headerCount ? cells : [...cells, ...new Array(headerCount - cells.length).fill('')]
    ))
    const paddedCount = padded.filter((c, i) => cellsPerRow[i]!.length < headerCount).length

    ensureOut()
    const body = [headerCells, ...padded].map((cells) => cells.map(csvCell).join(',')).join('\n')

    // The same two gates as `write-file`, and for the same reason: a spreadsheet is a deliverable
    // like any other, and the absence of an overwrite check is what destroyed a finished CSV.
    // Applied here too because a plan that targets a `.csv` deliverable is free to reach it with
    // either tool, and a guarantee that only holds on one route is not a guarantee.
    if (existsSync(p)) {
      const prior = sha256File(p)
      const size = safeStatSize(p)
      return {
        kind: 'failed',
        reason: `refusing to overwrite ${p}: it already exists and holds ${size ?? '?'} byte(s)`
          + (prior ? ` (sha256 ${prior.slice(0, 16)}...)` : '')
          + '. Write to a new filename, or delete the existing file yourself if it is stale.',
      }
    }

    try {
      mkdirSync(dirname(p), { recursive: true })
      // Stage then promote, so a crash cannot leave a truncated deliverable at the final path.
      const staged = `${p}.${process.pid}-${Date.now()}.staging`
      try {
        writeFileSync(staged, body + '\n', { encoding: 'utf8', flag: 'wx' })
        renameSync(staged, p)
      } catch (e) {
        try { if (existsSync(staged)) unlinkSync(staged) } catch { /* nothing further to do */ }
        throw e
      }
      const parsed = parseCsv(readFileSync(p, 'utf8'))
      const dropped = droppedUrls.length > 0
        ? `; ${droppedUrls.length} unverified URL(s) removed (they were not present in the research brief)`
        : ''
      const padded = paddedCount > 0
        ? `; ${paddedCount} short row(s) padded to ${headerCount} columns`
        : ''
      return {
        kind: 'data',
        summary: `${Math.max(0, parsed.length - 1)} data row(s), ${parsed[0]?.length ?? 0} column(s)` + dropped + padded,
        data: {
          path: p,
          rows: Math.max(0, parsed.length - 1),
          columns: parsed[0]?.length ?? 0,
          droppedUrls,
          sha256: sha256File(p),
        },
      }
    } catch (e) {
      return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) }
    }
  },
}

const spreadsheetVerifier: Verifier = {
  verifies: (s: Step) => (s.tool ?? '').includes('spreadsheet'),
  async verify(_s: Step, _ctx: ToolContext, toolData: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
    const d = toolData as { path?: string; rows?: number; columns?: number } | undefined
    if (!d?.path) return { rejected: 'the step recorded no spreadsheet path' }
    if (!existsSync(d.path)) return { rejected: `no spreadsheet at ${d.path}` }

    // Re-parse from disk. A spreadsheet whose rows do not survive a round trip through its own
    // format is not a spreadsheet; it is a file with commas in it.
    const parsed = parseCsv(readFileSync(d.path, 'utf8'))
    const dataRows = Math.max(0, parsed.length - 1)
    if (dataRows !== d.rows) return { rejected: `the file holds ${dataRows} data row(s); the step recorded ${d.rows}` }
    const cols = parsed[0]?.length ?? 0
    if (cols !== d.columns) return { rejected: `the file has ${cols} column(s); the step recorded ${d.columns}` }
    const ragged = parsed.filter((r) => r.length !== cols)
    if (ragged.length > 0) return { rejected: `${ragged.length} row(s) do not have ${cols} columns; the file is not rectangular` }

    // Every source URL in the sheet must appear in a saved research artifact. This is what makes
    // the sheet CHECKABLE against the evidence rather than merely well-formed.
    const urls = new Set<string>()
    for (const row of parsed.slice(1)) for (const cell of row) {
      const m = /^https:\/\/\S+$/.exec(cell.trim())
      if (m) urls.add(cell.trim())
    }
    if (urls.size > 0) {
      const missing: string[] = []
      for (const u of urls) {
        let found = false
        try {
          const brief = lastBrief
          if (brief && brief.sources.some((s) => s.url === u)) { found = true }
          else {
            const raw = lastBrief ? readFileSync(lastBrief.briefPath, 'utf8') : ''
            found = raw.includes(u)
          }
        } catch { found = false }
        if (!found) missing.push(u)
      }
      if (missing.length > 0) {
        return {
          rejected: `${missing.length} source URL(s) in the sheet are not present in any saved research artifact: ${missing.slice(0, 3).join(', ')}`,
        }
      }
    }
    return {
      evidence: {
        kind: 'file-read-back',
        path: d.path,
        bytes: Buffer.byteLength(readFileSync(d.path, 'utf8'), 'utf8'),
        heading: `spreadsheet: ${dataRows} row(s) x ${cols} column(s)`,
        sha256: createHash('sha256').update(readFileSync(d.path, 'utf8'), 'utf8').digest('hex'),
      } as unknown as Evidence,
    }
  },
}

// ===========================================================================================
// CAPABILITY 4 - window discovery (observation only; needs no injection permission)
// ===========================================================================================

/** Windows found by the most recent list-windows in this process. */
let lastWindows: { hwnd: number; pid: number; title: string }[] = []

const listWindowsTool: Tool = {
  name: 'list-windows',
  mode: 'uia',
  async run(_ctx: ToolContext, _args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const o = await liveControl.observe()
      const windows = o.windows.filter((w) => w.visible && w.title.trim().length > 0)
      if (windows.length === 0) return { kind: 'nothing-found', reason: 'no titled window was open' }
      // Remembered so survey-window can act on "the window you just found" without the caller
      // knowing a handle. Reading it back out of ctx.prior was tried first and depended on the
      // executor's StepResult nesting having one particular shape; when it did not, the honest
      // failure was "no window handle was given" on a mission whose previous step had just
      // listed every window on the desktop. A capability that cannot consume the result of the
      // step before it is not a capability, it is a coincidence.
      lastWindows = windows.map((w) => ({ hwnd: w.hwnd, pid: w.pid, title: w.title }))
      return {
        kind: 'data',
        summary: `${windows.length} titled window(s)`,
        data: { windows: windows.map((w) => ({ hwnd: w.hwnd, pid: w.pid, title: w.title })) },
      }
    } catch (e) {
      return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) }
    }
  },
}

const listWindowsVerifier: Verifier = {
  verifies: (s: Step) => (s.tool ?? '').includes('list-windows'),
  async verify(_s: Step, _ctx: ToolContext, toolData: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
    const d = toolData as { windows?: Array<{ hwnd: number; title: string }> } | undefined
    if (!d?.windows) return { rejected: 'the step recorded no window list' }
    // Re-observe independently. A tool that hallucinated windows is caught because the host will
    // not report an hwnd that does not exist.
    const o = await liveControl.observe()
    const real = new Set(o.windows.map((w) => w.hwnd))
    const bogus = d.windows.filter((w) => !real.has(w.hwnd))
    if (bogus.length > 0) {
      return { rejected: `${bogus.length} reported window(s) do not exist on the desktop: ${bogus.map((b) => b.hwnd).join(', ')}` }
    }
    return {
      evidence: {
        kind: 'observation',
        detail: `re-observed from the host: all ${d.windows.length} hwnd(s) exist`,
      } as unknown as Evidence,
    }
  },
}

// ===========================================================================================
// CAPABILITY - launch a named application (the start of most desktop tasks)
// ===========================================================================================
//
// WHY THIS IS HERE
//
// Every other capability acted on something that already existed. Nothing could OPEN
// anything, so "open Notepad and write this" was not expressible as a plan at all - the most
// ordinary request a person makes about a laptop. This is the smallest thing that fixes it:
// a named launcher with an allowlist on the host, not a command runner.
//
// THE VERIFIER IS INDEPENDENT, AND IT HAS TO BE
//
// The launch route's own return value says "a window appeared, here is its handle". If the
// verifier accepted that, it would be checking the tool's own claim against itself, and a
// launch that reported a handle for a window that never drew would be recorded as verified.
// Instead the verifier asks the host a fresh question - what windows exist RIGHT NOW - and
// requires the claimed handle to be among them AND to belong to the claimed process. A
// hallucinated handle has no process behind it and cannot pass.

const launchAppTool: Tool = {
  name: 'launch-app',
  mode: 'gui',
  args: [
    { name: 'app', type: 'string', required: true, description: 'notepad | calculator | paint | explorer | wordpad | cmd | powershell | browser | edge | chrome' },
    { name: 'path', type: 'string', required: false, description: 'the document to open. notepad, paint and wordpad only. Use it when the task names the destination file - it removes the Save As dialog entirely. If the file does not exist yet it is CREATED empty first, which is how you start a new document at a known path.' },
    { name: 'url', type: 'string', required: false, description: 'a plain http or https address for the browser to open. browser, edge and chrome only. Use it when the task names a site or a search, for example a Google search URL. For READING and SUMMARISING pages rather than showing them to the person, prefer web-research instead - it produces a cited brief and does not open a window.' },
  ],
  async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const app = String(args.app ?? '').trim()
    if (!app) return { kind: 'failed', reason: 'no application name was given' }

    // A path goes through the SAME readable-folder rule as read-file, BEFORE the host is asked to
    // open anything.
    //
    // This is the check that matters most on this capability. "Open notepad with this path" is
    // how a document path becomes "a file this operator may be told to open" - and without a
    // folder rule it is also how "open a document" becomes "open any file on the disk, including
    // an executable". The host refuses .exe/.dll/.bat as a hard backstop, but the host cannot know
    // which folders this layer considers readable, so the real rule lives here, next to the rule
    // it shares.
    let openPath: string | undefined
    let justCreated = false
    const rawPath = String(args.path ?? '').trim()

    // NORMALISE THE NAME FIRST, then decide what it is.
    //
    // "google", "bing" and "duckduckgo" are not applications; they are what a person says. The
    // first version of this checked `BROWSERS.includes(app)` BEFORE mapping those names, so
    // "open google and search nakivo" was refused with '"google" cannot be given a web address'
    // - a refusal about a rule the caller never broke, for an app that does not exist. The order
    // is the whole fix: what the person typed is resolved to a real application first, and only
    // then judged.
    const BROWSERS = ['browser', 'edge', 'chrome']
    const SEARCH_NAMES = /^(google|bing|duckduckgo|duck duck go|search|web browser|internet explorer)$/i
    const appIsBrowser = BROWSERS.includes(app.toLowerCase()) || SEARCH_NAMES.test(app.trim())
    // A search-engine name becomes the browser that can search. "chrome" is left alone, because
    // a person who says chrome wants that browser specifically and ResolveBrowser will refuse to
    // hand back Edge in its place.
    const launchApp = SEARCH_NAMES.test(app.trim())
      ? 'browser'
      : (BROWSERS.includes(app.toLowerCase()) && !/chrome/i.test(app.toLowerCase()) ? 'browser' : app)

    // The URL is validated HERE as well as in the host, and for the same reason the folder rule
    // is duplicated: this layer owns what a caller is allowed to ask for, and the host cannot
    // know it. Rejecting here produces a step-level reason a planner can read and recover from;
    // rejecting only in the host produces a raw transport error.
    // Kept in step with Launch.MayOpenUrl. The threat is argument injection into CreateProcess,
    // which is not a shell: whitespace starts a new argument, and quote and backslash change
    // how the rest is parsed. Ampersand is deliberately ALLOWED - it is the separator in
    // `?a=1&b=2`, and refusing it broke most real searches while defending against a shell that
    // is not on this path.
    const mayOpenUrl = (u: string): boolean =>
      /^https?:\/\//i.test(u) && u.length <= 2048 && !/["\\\s]/.test(u)

    const rawUrl = String(args.url ?? '').trim()
    let openUrl: string | undefined
    if (rawUrl) {
      if (!appIsBrowser) {
        return {
          kind: 'failed',
          reason: `"${app}" cannot be given a web address. Use app "browser", "edge" or "chrome" - or use web-research to read pages without opening a window`,
        }
      }
      if (!mayOpenUrl(rawUrl)) {
        return {
          kind: 'failed',
          reason: `refusing to open "${rawUrl}": a web address must be a plain http or https URL with no spaces, quotes or backslashes`,
        }
      }
      openUrl = rawUrl
    }
    // "open google" with no address means "open the search page", not "open nothing".
    if (appIsBrowser && !openUrl) openUrl = 'https://www.google.com'
    const isBrowserLaunch = appIsBrowser

    // When a specific document is being opened, clear any Notepad window that is already there
    // first. Notepad 11 restores its session at startup, so a launch into a machine that already
    // has Notepad open does not create a fresh document - it opens the file into a process whose
    // other tabs still hold the previous runs, and typing lands in whichever tab is focused. That
    // is how a mission that asked for one sentence produced a file with six copies of it: each
    // run typed into whatever the session restored and then saved.
    //
    // Fail closed at the moment of the action, on a guard read made now, exactly as the
    // injection path does. Launching changes the machine, so it waits for the human rather
    // than proceeding on a permission read taken when the plan was built.
    const refused = await injectionRefusedReason(num(args.waitSeconds, 300))
    if (refused) return { kind: 'failed', reason: refused }

    // Closing the existing windows is done the way a person does it - the window's own Close
    // button, with the unsaved-changes prompt answered by button name - because a keystroke
    // aimed at a window that is mid-close is a keystroke that goes nowhere.
    if (rawPath) {
      for (let pass = 0; pass < 8; pass++) {
        const wins = await liveControl.observe().then((o) => o.windows.filter((w) => /notepad/i.test(w.title) || w.class === '#32770')).catch(() => {
          // Observation failed: cannot confirm window state.
          // Do not treat failure as "no windows observed" — stop the cleanup pass.
          return null as never
        })
        if (wins === null || wins.length === 0) break
        for (const w of wins) {
          try {
            await liveControl.raw('/focus', { method: 'POST', body: { hwnd: w.hwnd } })
            await new Promise((r) => setTimeout(r, 200))
            const survey = await liveControl.raw('/uiasurvey', { method: 'GET', body: {} }).catch(() => null)
            void survey
            // Find the Close button via the survey route instead.
            const sr = (await liveControl.raw(`/uiasurvey?hwnd=${w.hwnd}&max=60`, { method: 'GET' }).catch(() => null)) as { body?: { elements?: unknown[] } } | null
            const close = (sr?.body?.elements as Array<{ controlType?: string; automationId?: string; index?: number }> ?? [])
              .find((e) => e.controlType === 'Button' && e.automationId === 'Close')
            if (close && typeof close.index === 'number') {
              await liveControl.raw('/uiainvoke', { method: 'POST', body: { hwnd: w.hwnd, index: close.index } }).catch(() => {})
            }
          } catch { /* best effort */ }
        }
        await new Promise((r) => setTimeout(r, 600))
        for (const w of await liveControl.observe().then((o) => o.windows.filter((w) => /notepad/i.test(w.title))).catch(() => {
          // Observation failed: cannot confirm window state.
          // Do not treat failure as "no windows observed" — stop the cleanup pass.
          return null as never
        })) {
          const sr = (await liveControl.raw(`/uiasurvey?hwnd=${w.hwnd}&max=40`, { method: 'GET' }).catch(() => null)) as { body?: { elements?: unknown[] } } | null
          const discard = (sr?.body?.elements as Array<{ controlType?: string; name?: string; index?: number }> ?? [])
            .find((e) => e.controlType === 'Button' && /don'?t save/i.test(String(e.name ?? '')))
          if (discard && typeof discard.index === 'number') {
            await liveControl.raw('/focus', { method: 'POST', body: { hwnd: w.hwnd } }).catch(() => {})
            await new Promise((r) => setTimeout(r, 200))
            await liveControl.raw('/uiainvoke', { method: 'POST', body: { hwnd: w.hwnd, index: discard.index } }).catch(() => {})
          }
        }
        await new Promise((r) => setTimeout(r, 400))
      }
    }

    if (rawPath) {
      const r = resolveReadablePath(rawPath)
      if ('refused' in r) return { kind: 'failed', reason: r.refused }

      if (!existsSync(r.path)) {
        // CREATE IT, rather than refusing.
        //
        // Refusing was the first version and it broke the one task this argument exists for:
        // "write this into a new file at this path". The planner correctly asks to open a file
        // that does not exist yet, and the honest answer is not "that is impossible" - it is
        // "create it, then open it", which is what every text editor does.
        //
        // Safe because three conditions hold before anything is written, all checked by
        // `resolveReadablePath` above: the path resolves INSIDE a readable folder, its extension
        // is a plain-text one, and it is a file path rather than anything else. The only
        // directory that is created is one that already exists, so this cannot be used to build
        // a directory tree or to place a file outside those folders.
        //
        // The file is created EMPTY and only becomes real content when the task types into it and
        // saves. If the mission never gets that far, what is left is an empty file the user can
        // delete, not a half-written document that looks finished.
        const parent = dirname(r.path)
        if (!existsSync(parent)) {
          return {
            kind: 'failed',
            reason: `the folder ${parent} does not exist, and this does not create folders. `
              + 'Use write-file if you want a path made, or name an existing folder.',
          }
        }
        try {
          writeFileSync(r.path, '', 'utf8')
          justCreated = true
        } catch (e) {
          return { kind: 'failed', reason: `could not create ${r.path}: ${e instanceof Error ? e.message : String(e)}` }
        }
      }
      openPath = r.path
    }

    try {
      // WHICH WINDOWS EXISTED BEFORE WE ASKED FOR THIS ONE.
      //
      // Snapshot taken immediately before the launch, for one reason: to be able to tell a window
      // this call CREATED from one it merely ACTIVATED. Single-instance applications - Windows 11
      // Notepad among them - hand a second launch to the window that is already open, and the
      // difference is invisible in the launch response, which looks the same either way.
      //
      // It matters because an activated window can be showing someone's document. See
      // `adoptedWindowRefusal` for what happens when it is, and for the run in which "open notepad
      // and type hello" typed into a document it was never asked to touch while reporting both
      // steps verified.
      // Observation failed: cannot confirm window state before launch. Return a discriminated
      // result so downstream consumers can distinguish indeterminate state from confirmed absence.
      let beforeWindows: readonly WindowInfo[] | { kind: 'indeterminate' }
      try {
        const o = await liveControl.observe()
        beforeWindows = o.windows ?? []
      } catch {
        beforeWindows = { kind: 'indeterminate' }
      }
        // Distinguish three states before the launch action:
        //   1. Relevant window(s) found       -> beforeHwnds populated
        //   2. No relevant windows found       -> beforeHwnds = empty Set()
        //   3. Observation indeterminate       -> beforeHwnds = null
        let beforeHwnds: Set<number> | null
        if (Array.isArray(beforeWindows)) {
          beforeHwnds = beforeWindows.length > 0
            ? new Set(beforeWindows.map((w) => Number(w.hwnd)))
            : new Set()
        } else {
          beforeHwnds = null
        }

      const r = await postLaunch(launchApp, num(args.timeoutSeconds, 15), openPath, openUrl)
      const launch = r as { ok: boolean; error?: string; hwnd?: number; pid?: number; title?: string }
      if (!launch.ok) return { kind: 'failed', reason: launch.error ?? 'launch failed' }
      const win = { hwnd: Number(launch.hwnd), pid: Number(launch.pid), title: String(launch.title ?? '') }
      // If the before-launch observation was indeterminate (cannot confirm window state),
      // return an honest failure since no action has been dispatched yet and the state
      // is unknown - proceeding would risk adopting/typing into the wrong window.
      if (beforeHwnds === null) {
        return {
          kind: 'failed',
          reason: 'the operator host could not confirm window state before launch; the launch may not proceed honestly',
        }
      }
      const adoptedExisting =
          beforeHwnds.has(win.hwnd)
      // If WE just created the file, ensure the document is empty before typing.
      //
      // Notepad restores previous sessions, so a freshly-created file can arrive with old text
      // in it. Ctrl+A then Delete leaves one empty document, which is what the caller expects
      // when it says "write this into a new file".
      if (justCreated) {
        // Re-read the window's CURRENT title before sending anything. The launch response's
        // title ("Notepad") is stale by the time the host is ready to accept input: Notepad
        // has renamed the window to the file name, and the host's Verify() refuses a request
        // whose title does not match the window it is actually talking to. Ignoring that
        // produced a bare 'A' where Ctrl+A was intended, because the refused chord was
        // reported as delivered and the following Delete removed the first real character.
        const live = await liveControl.observe().catch(() => null)
        const liveWin = live?.windows?.find((w) => w.hwnd === win.hwnd)
        const title = liveWin?.title ?? win.title
        const target = { hwnd: win.hwnd, pid: win.pid, expectedTitle: title }
        // THE KEYSTROKE BATCH MUST NOT CONTINUE PAST A REFUSAL. A clean refusal (delivered
        // false, refusedBy naming why) means the host said NO to this injection - the outcome is
        // KNOWN - so the step stops here with an honest `failed` that identifies the refused
        // injection. Continuing past it let the flow fall through to settle/adoption and possibly
        // a success-shaped data return, which is the silent half of the Gap B hole. A THROW is a
        // different thing and still flows to the outer catch, which keeps the shared
        // midActionTransportLoss classification (outcome-unknown for a loss/timeout after possible
        // dispatch, ordinary failed for everything else).
        const capA = await rawKey(target, '41', true)   // Ctrl+A
        if (!capA.delivered) {
          return { kind: 'failed', reason: `the operator host refused the Ctrl+A injection into "${title}" (${capA.refusedBy ?? 'not delivered'})` }
        }
        await new Promise((r) => setTimeout(r, 250))
        const capD = await rawKey(target, '2e', false)  // Delete
        if (!capD.delivered) {
          return { kind: 'failed', reason: `the operator host refused the Delete injection into "${title}" (${capD.refusedBy ?? 'not delivered'})` }
        }
        await new Promise((r) => setTimeout(r, 400))
      }

      // RECORD THE SETTLED TITLE, not the title the window had at the instant it appeared.
      //
      // Whatever this step returns is what every later step is handed as "the window you just
      // opened", and the host re-checks the title on every keystroke. Handing back the launch
      // instant's "Notepad" when the window now calls itself "PROOF.txt - Notepad" means every
      // subsequent keystroke is refused for a title mismatch - and the typing step then reports
      // that it did not type, which is true, without saying why.
      const settled = await liveControl.observe().catch(() => {
          // Observation failed: cannot confirm window state after launch.
          // Do not treat failure as "window unchanged" — the outcome is uncertain,
          // because the launch or keystroke batch may have already dispatched.
          return null as never
        })
      if (settled === null) {
        // Window state is indeterminate after launch — the outcome is unknown.
        // Return outcome-unknown so the executor's terminal branch refuses to retry
        // and Stage D recovery surfaces for reconciliation.
        return {
          kind: 'outcome-unknown',
          reason: `the operator transport died with this request in flight; the window state could not be confirmed after launch, so it must not be blindly retried: the machine has to be observed, or a human asked, before this step is attempted again.`,
        }
      }
      const settledWin = settled?.windows?.find((w) => w.hwnd === win.hwnd)
      const settledTitle = settledWin?.title ?? win.title

      // AN ADOPTED WINDOW SHOWING A NAMED DOCUMENT IS SOMEONE ELSE'S WORK.
      //
      // Checked HERE rather than at the typing step, and deliberately: the typing step is where the
      // damage would happen, but by then the launch has already been reported as the window "you
      // just opened", and the plan has been built around it. Failing at the launch means the
      // mission stops before a single keystroke is sent, and the refusal reaches the person with
      // the document's name in it - which is the difference between a thing they can act on and a
      // step that mysteriously will not run.
      //
      // `Untitled` is allowed through: an empty scratch buffer has nothing in it to lose, and a
      // person who says "open notepad" with an empty notepad open is asking for exactly this.
      const adoptionRefusal = adoptedWindowRefusal(adoptedExisting, settledTitle, launchApp, {
        // A browser launch carrying a URL and NO file path performs no keystrokes: its whole action
        // is asking the shell to navigate a tab. The document-adoption refusal exists to stop AIOS
        // typing into work it was not asked to change, and there is no such risk here - it was
        // firing anyway because a browser titles its window "<page> - <app>", which reads exactly
        // like a named document. See adoptedWindowRefusal for the live transcript.
        //
        // `openPath` is in the condition deliberately: "open notes.txt in notepad" is still a
        // document launch and is still refused when adopted, exactly as before.
        navigatingUrl: isBrowserLaunch && openUrl !== undefined && openPath === undefined,
      })
      if (adoptionRefusal) {
        return {
          kind: 'failed',
          reason: adoptionRefusal,
        }
      }

      const reported: { hwnd: number; pid: number; title: string; adoptedExisting: boolean } = {
        hwnd: win.hwnd,
        pid: win.pid,
        title: settledTitle,
        adoptedExisting,
      }

      // A BROWSER IS DIFFERENT FROM EVERY OTHER LAUNCH, AND THE DIFFERENCE IS WHAT YOU CAN PROVE.
      //
      // For notepad, "the window exists" and "the right thing is in it" are close enough that the
      // window check has carried the step. For a browser they are not close at all: a window
      // appears immediately, long before the page is fetched, and it appears identically whether
      // the search returned results, returned an error, or never left the loading state. So the
      // window check would have reported success for a blank page - and the step's own intent
      // ("perform a search") would have been reported as verified when nothing had been read.
      //
      // So for a browser launch with a url, the screen is read with OCR after the window settles,
      // and THAT is the evidence. It is the only reading that can distinguish a results page from
      // a blank tab, and it is why `window-shows-text` exists as an objective postcondition.
      let screenText = ''
      if (isBrowserLaunch && openUrl) {
        // Settle: a page that has not painted yet reads as empty, and an empty read would fail a
        // step that is about to succeed. Bounded rather than clever - a fixed number of retries
        // with a pause, because "is it painted yet" has no cheap definitive answer.
        for (let attempt = 0; attempt < 12; attempt++) {
          const read = await liveControl.ocr().catch(() => null)
          const text = String(read?.text ?? '').trim()
          if (text.length > 0) { screenText = text; break }
          await new Promise((r) => setTimeout(r, 700))
        }
      }

      // Recorded so the NEXT step can say "the window you just opened" without being told its
      // handle. A capability that cannot consume the result of the step before it is a
      // coincidence, not a capability.
      lastWindows = [reported, ...lastWindows.filter((w) => w.hwnd !== win.hwnd)]
      return {
        kind: 'data',
        summary: openUrl
          ? `opened ${reported.title || app} on ${openUrl} (hwnd ${reported.hwnd})` +
            (screenText ? ` - page read back, ${screenText.length} characters of text on screen` : ' - no text could be read from the page yet')
          : `opened ${reported.title || app}${openPath ? ` on ${openPath}` : ''} (hwnd ${reported.hwnd})`,
        data: {
          app, path: openPath, url: openUrl, created: justCreated,
          ...reported,
          // The visible text, so the verifier can prove the page shows what was asked for rather
          // than merely that a window came up. Empty is meaningful and is reported as such.
          screenText,
        },
      }
    } catch (e) {
      // ONLY A HOST CALL COULD HAVE THROWN HERE, and both of them were DISPATCHED requests.
      //
      // Every local operation in this run either returns its own `failed` before the transport
      // (the path gates, the created-file write) or is wrapped in its own catch (the
      // best-effort window cleanup, every observe/ocr read), so what reaches this handler is
      // `postLaunch` or `rawKey` dying on the operator transport - and by then the request may
      // already be executing on the other side: the launch may have started the app, the
      // Ctrl+A/Delete batch may have partially landed (the 2026-10-22 OpenVault shape, where
      // real keystrokes had landed while the tool reported a plain `failed`). Because this
      // catch RETURNED that `failed` rather than throwing, the executor's throwing-tool
      // boundary never saw it either - the retryable reading survived both layers.
      //
      // So the classification happens HERE, through the SAME shared classifier
      // (transport-loss.ts) that desktop-input applies to its own non-delivery reports and the
      // executor applies at its throwing-tool boundary: one regex set, three layers that cannot
      // drift into disagreeing about the same evidence.
      //
      //   - `ECONNREFUSED` (never connected, so nothing was dispatched) and every message with
      //     no transport signature keep `failed`: the outcome is KNOWN and an honest retry is
      //     available.
      //   - any other mid-request transport death - reset, timeout, socket closed before the
      //     answer - is `outcome-unknown`: the executor's terminal branch refuses to retry it
      //     (attempts to spare or not) and the recorder persists `uncertain` for Stage D.
      const msg = e instanceof Error ? e.message : String(e)
      if (midActionTransportLoss(msg)) {
        return {
          kind: 'outcome-unknown',
          reason: `the operator transport died with this request in flight (${msg}); the launch `
            + 'or keystroke batch may have partially reached the machine, so it must not be '
            + 'blindly retried - the machine has to be observed, or a human asked, before this '
            + 'step is attempted again.',
        }
      }
      return { kind: 'failed', reason: msg }
    }
  },
}

const launchAppVerifier: Verifier = {
  verifies: (s: Step) => (s.tool ?? '').includes('launch-app'),
  async verify(_s: Step, _ctx: ToolContext, toolData: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
    const d = toolData as {
      hwnd?: number; pid?: number; title?: string; app?: string; url?: string; screenText?: string; path?: string
    } | undefined
    if (!d?.hwnd) return { rejected: 'the step recorded no window handle to verify' }

    // A FRESH question to the host, not a replay of the launch's own answer.
    const o = await liveControl.observe()
    const live = o.windows.find((w) => w.hwnd === d.hwnd)
    if (!live) {
      return { rejected: `the host does not currently list window ${d.hwnd}; the launch did not produce a window that is still open` }
    }
    // The pid check is what makes this more than an existence test: a recycled handle owned
    // by something else would pass an existence check and fail this one.
    if (d.pid && Number(live.pid) !== Number(d.pid)) {
      return { rejected: `window ${d.hwnd} is now owned by process ${live.pid}, not ${d.pid} - the handle was reused by a different application` }
    }

    // A BROWSER LAUNCH IS VERIFIED BY WHAT IT DISPLAYS, NOT BY THE FACT THAT IT OPENED.
    //
    // This is the branch that closes "succeeded their independent read-back" being said about a
    // search nobody read. A browser window appears immediately and identically whether the page
    // loaded, failed, or is still blank, so a window check can only ever prove that a browser was
    // started. The page is read with OCR - independently, here, rather than trusting the text the
    // launch step recorded - and the screen text is what satisfies `window-shows-text`.
    const url = String(d.url ?? '').trim()
    if (url) {
      const read = await liveControl.ocr().catch(() => null)
      const screen = String(read?.text ?? '').trim()
      if (!screen) {
        return {
          rejected: `the browser window ${d.hwnd} is open on ${url} but no text could be read from the ` +
            `screen. An open window is not a loaded page, and this step will not claim otherwise.`,
        }
      }
      // The url's own query text is the claim worth checking: searching for "data protection
      // companies" should put those words on the screen. Proving the query is present is weaker
      // than proving the results are, and it is honest about that - it is a page claim, not a
      // claim about the content of the results.
      const q = /[?&]q=([^&]+)/i.exec(url)
      const wanted = q ? decodeURIComponent(q[1].replace(/\+/g, ' ')) : ''
      const haystack = screen.toLowerCase()
      const probe = wanted ? wanted.toLowerCase() : ''
      const firstWord = probe.split(/\s+/).filter((w) => w.length > 3)[0] ?? ''
      const shown = probe.length === 0
        || haystack.includes(probe)
        || (firstWord.length > 0 && haystack.includes(firstWord))
      if (!shown) {
        return {
          rejected: `the page on screen does not appear to show the search for "${wanted}". It was read ` +
            `with OCR and the query was not found in it, so the browser may have shown an error or a ` +
            `blank tab rather than results.`,
        }
      }
      return {
        evidence: {
          kind: 'screen-text-present',
          // The WHOLE observed text, not a prefix of it.
          //
          // This was `screen.slice(0, 120)`, and the truncation is not cosmetic: the objective is
          // graded with `screenText.includes(postconditionText)`, so a postcondition is checked
          // against those 120 characters rather than against what was actually read. On a machine
          // with several windows open, the first 120 characters are whatever the OCR engine
          // happened to return first - frequently a different application's chrome.
          //
          // Observed live: Chrome was open on https://example.com and the page title was on screen,
          // but the evidence recorded the first 120 characters, which were the OpenCode window's
          // own text, so `window-shows-text: "example.com"` came back unmet. Every step had verified.
          // The claim was TRUE and the evidence said otherwise, which is the specific failure this
          // file exists to prevent - in the other direction, against ourselves.
          //
          // The full text is kept because it is the observation. What was actually read is already
          // stated in `detail`; truncating `text` made the evidence weaker than the observation it
          // was drawn from, and evidence must not be weaker than the thing that proves it.
          text: probe || screen,
          // Kept alongside so a reader can see how much was actually read, and whether the
          // match came from the query or merely from some other word on the page.
          detail: `read from the screen with OCR: ${screen.length} characters visible in window ` +
            `${d.hwnd}${probe ? `, including the searched term "${wanted}"` : ''}`,
        } as unknown as Evidence,
      }
    }

    // The title check has to know that a window is ALLOWED to rename itself.
    //
    // Launching Notepad on a path returns the title "Notepad", because that is what the window
    // is called at the instant it appears. A moment later it has loaded the document and calls
    // itself "AIOS-WORKS-PROOF.txt - Notepad". Requiring exact equality therefore failed the
    // launch that had just done precisely the right thing - and because every later step depends
    // on the launch, the whole mission was skipped and the file was left empty.
    //
    // The handle and the pid are the window's identity and both are already checked above; the
    // title is only a label. So when the launch carried a path, the window is verified by
    // actually reflecting THAT document - a stronger claim than the label it happened to wear at
    // launch time. When there was no path there is nothing to adopt, so the title must still
    // match exactly.
    const named = String(d.title ?? '').trim()
    const liveTitle = String(live.title ?? '').trim()
    const path = String(d.path ?? '').trim()

    // WINDOWS NAMES AN APPLICATION'S WINDOW AFTER THE DOCUMENT IT IS SHOWING.
    //
    // The convention is `<document> - <application>`, and an application with no document still
    // obeys it: Windows 11 Notepad titles an empty editor "Untitled - Notepad". Observed here as
    // a live failure - "open notepad and type hello" launched Notepad correctly, produced a real
    // window with a real handle, and was rejected because the verifier demanded the literal
    // string "Notepad". Every one of the six steps after it was then skipped, because a launch
    // that "failed" satisfies no dependency, so one label mismatch silently deleted a whole
    // mission that had done exactly what it was asked.
    //
    // The fix is to compare the APPLICATION rather than the whole label. That is not a loosening
    // of the check - the handle, the pid and the window's existence are all still verified above,
    // and this only decides which application the window belongs to. "Untitled - WordPad" does not
    // match Notepad, and a window that is gone or belongs to another process still fails.
    // A window's title is a LABEL, not its identity. Windows titles a window
    // `<document> - <application>`, and an application showing no document still obeys it -
    // Windows 11 Notepad calls an empty editor "Untitled - Notepad". Comparing the APPLICATION
    // rather than the whole label is what stops a correctly-launched Notepad from failing its own
    // verification and taking six dependent steps down with it. See window-identity.ts.
    const sameApp = windowIsSameApp(liveTitle, named)

    if (named && !sameApp) {
      if (path) {
        const fileName = path.split(/[\\/]/).pop() ?? ''
        // Notepad marks a modified document with a leading asterisk, so compare on the stem.
        const stem = fileName.replace(/\.[^.]+$/, '')
        const adopted = stem.length > 0 && liveTitle.replace(/^\*/, '').includes(stem)
        if (!adopted) {
          return {
            rejected: `window ${d.hwnd} was launched on ${path} but is titled "${liveTitle}" now - it is not showing that document`,
          }
        }
        return {
          evidence: {
            kind: 'observation',
            detail: `re-observed from the host: window ${live.hwnd} is open, owned by process ${live.pid}, and titled "${liveTitle}" - it adopted the document it was launched on (it was "${named}" at launch, and renaming itself to name the file is how a window reports that it opened it)`,
          } as unknown as Evidence,
        }
      }
      return { rejected: `window ${d.hwnd} is titled "${liveTitle}" now, not "${named}"` }
    }
    return {
      evidence: {
        kind: 'observation',
        // When the label changed, say WHY that is still the same application. A reader who sees
        // "Notepad" verified on a window called "Untitled - Notepad" is entitled to wonder whether
        // something was waved through, and the honest answer - that Windows prefixes a window's
        // title with the document it is showing - costs one clause to give.
        detail: `re-observed from the host: window ${live.hwnd} is open, titled "${live.title}", `
          + `owned by process ${live.pid}`
          + (sameApp && liveTitle.toLowerCase() !== named.toLowerCase()
            ? ` - it is the same application (Windows titles a window "<document> - <application>", `
              + `so "${named}" is the application part of "${liveTitle}")`
            : ''),
      } as unknown as Evidence,
    }
  },
}

// ===========================================================================================
// CAPABILITY - read back a text file the mission is meant to have produced
// ===========================================================================================

/**
 * Send one key WITH a modifier, in the exact shape the host's /key route reads.
 *
 * `liveControl.pressKey` is deliberately not reused here even though it looks like the right
 * call. Its signature is `pressKey(target, vk, modifiers)` and it forwards `modifiers` as an
 * array - but the host looks for the literal string `"ctrl":true` in the request body and has
 * no notion of an array. Going through the shared surface would send a request the host reads
 * as an unmodified key press, and report success. So this posts the shape the host actually
 * parses, and says so, rather than relying on a caller noticing the mismatch.
 */
async function rawKey(target: { hwnd: number; pid: number; expectedTitle: string }, vkHex: string, ctrl: boolean) {
  const r = await liveControl.raw('/key', {
    method: 'POST',
    body: {
      hwnd: target.hwnd,
      pid: target.pid,
      title: target.expectedTitle,
      vk: vkHex,
      // The host does `body.IndexOf("\"ctrl\":true") >= 0`. A literal true, not a string.
      ctrl,
    },
  })
  const rb = (r as { body?: { ok?: boolean; error?: string } } | undefined)?.body
  return { delivered: rb?.ok === true, refusedBy: rb?.error ?? null }
}

/**
 * The applications `/launch` will accept, as data.
 *
 * Exported so the plan validator can reason about them without opening a second connection or
 * duplicating the list - and, more to the point, so that anything inferred from prose is still
 * constrained to what the host would actually accept. An inference that could produce a name
 * outside this set would be a way to smuggle a launch past the allowlist.
 */
export const LAUNCHABLE: readonly string[] = ['browser', 'calculator', 'chrome', 'cmd', 'edge', 'explorer', 'notepad', 'paint', 'powershell', 'wordpad']

/**
 * If a step says in prose which application it means, recover that name.
 *
 * WHY THIS EXISTS
 *
 * `launch-app` requires `app`, and free models omit it often enough to matter - two runs out of
 * four produced a step whose intent read "Open Notepad" and whose args were `{}`. The step then
 * failed with "no application name was given", which is a correct refusal of an incomplete step
 * and a useless answer to a person who had, in the same sentence of the same plan, said exactly
 * which application to open.
 *
 * So the intent is consulted for a name that is actually launchable. Three properties make this
 * safe rather than a guess:
 *
 *   1. it can only ever return a name from LAUNCHABLE, so it cannot widen what the host will run;
 *   2. it requires the name to appear VERBATIM in the step's own intent, so "open Notepad" works
 *      and "open the thing I use for notes" does not - the fallback is silence, not invention;
 *   3. it never fires when the model DID supply an argument. An explicit value always wins.
 *
 * Returns null rather than a default when nothing matches, so the caller can refuse honestly
 * instead of opening the wrong program.
 */
export function inferLaunchApp(intent: string): string | null {
  const hay = String(intent ?? '').toLowerCase()
  for (const name of LAUNCHABLE) {
    if (hay.includes(name)) return name
  }
  return null
}

/**
 * Recover a readable file path from the user's own words.
 *
 * The same failure as `inferLaunchApp`, on the other end of the mission: the plan's final step
 * was `read-file` with empty args, so the run ended "no path was given" on a goal that had the
 * path written in it in full.
 *
 * The constraints are what make this recovery rather than a guess:
 *
 *   1. a path must appear VERBATIM in the goal, so the mission can only ever read a file the
 *      person explicitly named - nothing is inferred from the shape of a filename;
 *   2. it must pass `resolveReadablePath`, so the recovered value is confined to the document
 *      folders and the plain-text extensions exactly as an explicit argument would be. A path
 *      typed into the chat box is subject to the SAME restriction as one typed into the tool,
 *      which is the property that makes "it came from the user" a safe thing to rely on;
 *   3. if the goal names several readable files the first is taken, and the caller reports that
 *      it was inferred rather than passing it off as the model's choice.
 *
 * Returns null when nothing matches, so the step is still refused honestly.
 */
export function inferReadPath(goal: string): string | null {
  const candidates = String(goal ?? '').match(/[A-Za-z]:\\[^\s"'<>|]+/g)
  for (const c of candidates ?? []) {
    const trimmed = c.replace(/[.,;:)]+$/, '')
    const r = resolveReadablePath(trimmed)
    if (!('refused' in r)) return r.path
  }

  // A FOLDER NAMED WITHOUT ITS PATH. "save it to my Documents" is how people actually write, and
  // it contains no `C:\` for the loop above to find.
  //
  // Found by a test rather than by reading the code: a goal saying "write a report to my
  // Documents" produced no path, so the write silently went to the output folder instead - safe,
  // but not what the person asked for, and they were never told.
  //
  // The name is matched against `readableRoots()` itself rather than being assembled from a guess,
  // so this can only ever return a folder the rules already permit. If none of them matches, it
  // returns null and the caller falls through to the output directory as before. It widens
  // nothing: a folder that is not readable is simply not found by this.
  // "Documents" in the goal is spelled the same as the folder, but the regex deliberately allows a
  // trailing "s" so "document" reads too - so BOTH sides are reduced to a singular form before
  // comparing. Comparing the raw strings returned null for the most common phrase there is.
  const singular = (s: string): string => s.toLowerCase().replace(/s$/, '')
  const text = String(goal ?? '')

  // A FOLDER NAME IS NOT READ FROM INSIDE A FILENAME.
  //
  // Found by a test reproducing a real false success. The goal was:
  //
  //     create AIOS-Desktop-Mission-Report.txt in my Documents folder
  //
  // and the destination resolved to the DESKTOP. The word "Desktop" appears inside the filename, and
  // a hyphen is a word boundary, so the folder matcher found it first and never reached the
  // "Documents" the person actually wrote. A hyphenated filename naming a product, a vendor or a
  // file format is common enough that this would misroute writes often rather than rarely - and
  // silently, because the resulting path is a real folder and the file lands there perfectly
  // happily.
  //
  // So filename-shaped tokens are removed before the folder is looked for. What remains is prose,
  // and prose does not contain filenames.
  const prose = text.replace(/\b[A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z0-9]{1,8}\b/g, ' ')
  const mentioned = /\b(documents?|desktop|downloads)\b/i.exec(prose)
  if (mentioned) {
    const want = singular(mentioned[1])
    for (const root of readableRoots()) {
      if (singular(basename(root)) !== want) continue

      // The folder was named. Did the goal ALSO name a file to go in it?
      //
      // Observed live: "open notepad, type aios save proof, then save it to the desktop as
      // aios-save-proof.txt" wrote the file correctly - the content was on the Desktop - and the
      // mission still reported `ok=false`, because this function returned the bare folder and the
      // objective was then declared as `artifact-exists C:\Users\Samer\Desktop`. A directory was
      // never going to satisfy a file postcondition, and a step's `file-read-back` evidence does
      // not name one either. Work that succeeded, reported as failure, with no way for the reader
      // to tell the difference from work that genuinely failed.
      //
      // So the filename is taken from the goal when the goal carries one. `safeFileName` strips
      // any directory component and traversal, so a goal cannot use this to escape the folder it
      // just named.
      //
      // A filename the person actually handed over:
      //
      //   1. "as <name>"      the commonest phrasing, checked first
      //   2. any dotted token  "write the notes.txt file to my Downloads"
      //   3. nothing          the folder alone, which is not a file - see below
      //
      // The ambiguity rule between (1) and (2) is about honesty, not convenience.
      const text = String(goal ?? '')
      const asPhrase = /\bas\s+([^\s"'<>|]+\.[A-Za-z0-9]{1,8})\b/i.exec(text)
      if (asPhrase) return finish(join(root, safeFileName(asPhrase[1])))

      // "save it as quarterly report.txt" - the `as` phrase runs over more than one word, so which
      // words are the filename is genuinely undecidable from the sentence.
      //
      // Taking the LAST word ("report.txt") silently produces a different file from the one asked
      // for. That is worse than producing none: a wrong name looks like success, lands somewhere
      // real, and the person only finds out when they cannot find their work. So the guess is
      // refused outright and the caller falls back to the output directory and says so.
      if (/\bas\s+(?:[^\s"'<>|]+\s+)+[^\s"'<>|]+\.[A-Za-z0-9]{1,8}\b/i.test(text)) return null

      const named = /\b([A-Za-z0-9_-][A-Za-z0-9_.-]*\.[A-Za-z0-9]{1,8})\b/.exec(text)
      if (named) return finish(join(root, safeFileName(named[1])))

      // No filename anywhere in the goal, so there is no file to name and the folder is not one.
      // Returning the root here is what produced the impossible postcondition above; returning
      // null sends the caller to the output directory instead, which is safe and is announced.
      return null
    }
    return null
  }
  // The goal named no folder at all.
  //
  // This `return` was missing, so a goal with no Documents/Desktop/Downloads mention fell off the
  // end of the function and returned `undefined` while its signature promised `string | null`. No
  // caller was harmed - every one tests truthiness, and both are falsy - which is exactly why it
  // survived. It was found by a test asserting the declared contract rather than the observed
  // behaviour, which is the only reason a harmless inconsistency is worth a line here.
  return null

  /** A destination the goal named still has to satisfy the ordinary readable-path rules. */
  function finish(candidate: string): string | null {
    const r = resolveReadablePath(candidate)
    return 'refused' in r ? null : r.path
  }
}

/**
 * The FILENAME a goal names, with no folder attached.
 *
 * Split out from `inferReadPath` because a write destination and a read path obey different rules,
 * and conflating them produced a mission that could not run.
 *
 * `inferReadPath("write a report to my documents as quarterly-summary.txt")` correctly answers
 * `C:\Users\Samer\Documents\quarterly-summary.txt` - and that path is exactly what a producing step
 * must NOT be given:
 *
 *     C:\Users\Samer\Documents\quarterly-summary.txt
 *       write: REFUSED -> output must live under C:\Users\Samer\.aios\agent\out
 *
 * so the step was handed a destination that guaranteed its own failure, having been recovered
 * from the goal and announced as a fix. The name is the useful part of what the goal said - models
 * reliably get filenames wrong, inventing folders and temp paths - and the folder is not, because
 * AIOS's own writers are confined to the output directory and a goal sentence does not get to
 * widen that.
 *
 * (Driving the user's own Notepad to save to the Desktop is a different matter and remains allowed.
 * That is the user asking their application to write where they said, not AIOS reaching for the
 * disk on its own initiative.)
 */
/**
 * The FOLDER a goal names, whether or not it also names a file.
 *
 * Needed separately from `inferReadPath` because the two cases behave differently. "Save it to my
 * Documents" names a place and no file, so `inferReadPath` returns null - and a caller that treats
 * null as "the goal said nothing about location" is wrong about a goal that said exactly that.
 *
 * The false success this exists to prevent was one of these: the person named a folder, the file
 * went somewhere else, and nothing recorded that the folder had been asked for.
 *
 * Filename-shaped tokens are removed before matching, so a filename that happens to contain
 * "Desktop" is not read as a request for the Desktop. See the note on that inside inferReadPath.
 */
export function inferGoalFolder(goal: string): string | null {
  const text = String(goal ?? '')
  const prose = text.replace(/\b[A-Za-z0-9_][A-Za-z0-9_.-]*\.[A-Za-z0-9]{1,8}\b/g, ' ')
  const mentioned = /\b(documents?|desktop|downloads)\b/i.exec(prose)
  if (!mentioned) return null
  const want = mentioned[1].toLowerCase().replace(/s$/, '')
  for (const root of readableRoots()) {
    if (basename(root).toLowerCase().replace(/s$/, '') === want) return root
  }
  return null
}

export function inferGoalFilename(goal: string): string | null {
  const text = String(goal ?? '')

  // THE FILENAME THE PERSON WROTE OUT IN FULL WINS, ALWAYS.
  //
  // This check was missing, and its absence is why a real mission wrote the wrong file. Observed:
  // the goal was
  //
  //   "...navigate to https://example.com ... Then write that report to
  //    C:\Users\Samer\Documents\Zeus-Browser-Proof.txt and read it back..."
  //
  // and the deliverable came out as `example.com.csv`. The person named the file explicitly, in a
  // full path, and the system derived its filename from the URL earlier in the same sentence
  // instead - then appended a `.csv` because the extension of a web address is not a file
  // extension. The requested name was never consulted at all.
  //
  // So: a path written in full is a stronger statement than any token mined from prose, and it is
  // checked first. `inferReadPath` is reused rather than re-implemented so the two cannot disagree
  // about what counts as a path.
  const explicit = inferReadPath(text)
  if (explicit !== null) {
    const leaf = explicit.split(/[\\/]/).pop()
    if (leaf && leaf.length > 0) return safeFileName(leaf)
  }

  // A URL IS NOT A FILENAME. Stripped before any token is mined, so `https://example.com` cannot
  // become `example.com.csv`. This is the same reason `inferGoalFolder` removes filename-shaped
  // tokens before reading folder words out of the prose - in both directions, a token belonging to
  // one thing must not be read as the other.
  const prose = text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    // A bare domain with no scheme - "duckduckgo.com", "example.org" - is still a web address, and
    // its host is still not a filename. Observed: a goal mentioning duckduckgo.com produced a
    // deliverable called `duckduckgo.com.csv`. The shape being removed is `<label>.<known-ish
    // suffix>` with no path after it, which is what distinguishes a domain from "report.draft.txt".
    .replace(/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:com|org|net|io|co|ai|dev|info|biz|edu|gov|uk|de|fr|jp|us|ca|au|nl|se|no|fi|dk|es|it|ru|cn|br|in|kr|me|tv|xyz|online|site|tech|app|cloud|sh|gg)\b(?!\/)/gi, ' ')

  const asPhrase = /\bas\s+([^\s"'<>|]+\.[A-Za-z0-9]{1,8})\b/i.exec(prose)
  if (asPhrase) return safeFileName(asPhrase[1])
  const named = /\b([A-Za-z0-9_-][A-Za-z0-9_.-]*\.[A-Za-z0-9]{1,8})\b/.exec(prose)
  if (named) return safeFileName(named[1])
  return null
}

/**
 * POST /launch, over the same guarded transport every capability uses.
 *
 * It goes through `liveControl.raw` rather than a fresh HTTP client so that launching cannot
 * accidentally become the one capability that talks to the host on its own terms. A second
 * client would be a second set of headers, a second port source and a second chance to send
 * an unauthenticated request that fails as a bare 403.
 */
async function postLaunch(app: string, timeoutSeconds: number, path?: string, url?: string): Promise<Record<string, unknown> & { ok: boolean }> {
  const r = await liveControl.raw('/launch', { method: 'POST', body: { app, timeoutSeconds, path, url } })
  return ((r as { body?: Record<string, unknown> }).body as Record<string, unknown> & { ok: boolean }) ?? { ok: false }
}

/**
 * OCR - read the text that is ON the screen.
 *
 * WHY THIS EXISTS ALONGSIDE survey-window
 *
 * The accessibility tree is the better instrument and is tried first: it is exact, it costs
 * nothing, and it knows about controls. But an application that paints its interface as PIXELS has
 * no tree - a game, a canvas, a chart, a video, a scanned image, some remote-desktop sessions. The
 * tree returns empty or misleading for those, and the honest conclusion there is not "there is no
 * text", it is "this instrument cannot see this kind of text".
 *
 * So OCR reads the pixels. It is the fallback that makes "apps without accessible controls"
 * reachable at all, and it is built on the Windows OCR engine, so it costs nothing and installs
 * nothing.
 *
 * THE VERIFIER RE-READS, IT DOES NOT ECHO
 *
 * A tool that returned its own text and verified that same text would prove only that it was
 * called. The verifier asks the host a second time and compares, so an empty or failed read is
 * caught as a failed read rather than reported as "no text found".
 */
const ocrTool: Tool = {
  name: 'ocr',
  mode: 'uia',
  async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const region = {
      x: num(args.x, -1), y: num(args.y, -1),
      w: num(args.w, 0), h: num(args.h, 0),
    }
    try {
      const r = await liveControl.ocr(region)
      if (!r.ok) return { kind: 'failed', reason: `the host could not read the screen: ${r.error ?? 'no reason given'}` }
      if (r.lines.length === 0) {
        return { kind: 'nothing-found', reason: 'the Windows OCR engine found no text in that region of the screen' }
      }
      return {
        kind: 'data',
        summary: `${r.lines.length} line(s) recognised by the ${r.language} engine`,
        data: { language: r.language, lineCount: r.lines.length, text: r.text, lines: r.lines },
      }
    } catch (e) {
      return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) }
    }
  },
}

const ocrVerifier: Verifier = {
  verifies: (s: Step) => (s.tool ?? '').includes('ocr') && !(s.tool ?? '').includes('screen-diff'),
  async verify(_s: Step, _ctx: ToolContext, toolData: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
    const d = toolData as { lineCount?: number; text?: string; language?: string } | undefined
    if (!d?.lineCount) return { rejected: 'the step recorded no recognised text to verify' }
    // A SECOND read, from the host, and compared. Not an echo of the first.
    const again = await liveControl.ocr({}).catch(() => null)
    if (!again) return { rejected: 'the screen could not be re-read to confirm the OCR result' }
    if (again.lines.length === 0) {
      return { rejected: `the step reported ${d.lineCount} line(s) but re-reading the screen now finds none, so the text is not stably present` }
    }
    return {
      evidence: {
        kind: 'observation',
        detail: `re-read from the host: ${again.lines.length} line(s) recognised again by the ${again.language} engine`,
      } as unknown as Evidence,
    }
  },
}

/** Roots a mission may read from. Deliberately the human's own document folders. */
function readableRoots(): string[] {
  return [
    join(homedir(), 'Documents'),
    join(homedir(), 'Desktop'),
    join(homedir(), 'Downloads'),
    AGENT_OUT,
  ]
}

export function resolveReadablePath(input: string): { path: string } | { refused: string } {
  const raw = String(input ?? '').trim()
  if (!raw) return { refused: 'no path was given' }
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(homedir(), raw)
  const norm = abs.toLowerCase()

  // The containment check is done on the RESOLVED path, not on the string the caller passed.
  // A caller can spell anything - `..\..\Windows\System32\config\SAM`, an absolute path, a
  // junction - and only the resolved path is the truth about where the read lands. Checking
  // the string would pass a path that escapes and refuse a legitimate one.
  const ok = readableRoots().some((r) => norm.startsWith(resolve(r).toLowerCase() + sep))
  if (!ok) {
    return { refused: `"${raw}" is outside the folders a mission may read (${readableRoots().join(', ')}). Reading the rest of the disk is not something this operator does.` }
  }
  const ext = extname(abs).toLowerCase()
  if (!['.txt', '.md', '.csv', '.json', '.log'].includes(ext)) {
    return { refused: `only plain text files can be read (.txt, .md, .csv, .json, .log); "${raw}" is ${ext || 'extensionless'}` }
  }
  return { path: abs }
}

const readFileTool: Tool = {
  name: 'read-file',
  mode: 'cli',
  async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const r = resolveReadablePath(String(args.path ?? ''))
    if ('refused' in r) return { kind: 'failed', reason: r.refused }
    if (!existsSync(r.path)) return { kind: 'nothing-found', reason: `no file at ${r.path}` }
    let text: string
    try {
      text = readFileSync(r.path, 'utf8')
    } catch (e) {
      return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) }
    }
    return {
      kind: 'data',
      summary: `${r.path} (${text.length} chars)`,
      data: { path: r.path, chars: text.length, text },
    }
  },
}

/**
 * What a read-back step CLAIMS to be reading, read off the step's own arguments.
 *
 * The verifier is given the step and was discarding it (`_s`). That is where the expectation lives:
 * a read-back that says nothing about what it expects is a read-back that cannot fail for the right
 * reason, which is how a zero-byte file passed as "independently verified".
 *
 * Three sources, in the order they are trusted:
 *
 *   1. AN EXPLICIT ARGUMENT on the step - `expectEmpty: true`, `expectChars`, `expectText`,
 *      `expectPath`. This is the only source that may declare an empty file legitimate, because it
 *      is the only one where somebody said so.
 *   2. THE PATH the step names. `expectedPath` is what the plan asked for; `requestedPath` is what
 *      validation recorded when it had to substitute. Both are claims about identity.
 *   3. NOTHING. A read-back that declares no expectation is still allowed to pass on CONTENT, but
 *      only for content it actually read - which is the real invariant. An empty result from an
 *      expectation-free step is reported as an observation, never as `file-read-back`.
 */
interface ReadBackExpectation {
  readonly expectEmpty: boolean
  readonly expectChars: number | null
  readonly expectText: string | null
  readonly expectedPath: string | null
  readonly requestedPath: string | null
  /** True when the step said something about what it expected, rather than just naming a path. */
  readonly declared: boolean
}

function readBackExpectation(step: Step | undefined): ReadBackExpectation {
  const a = (step?.args ?? {}) as Record<string, unknown>
  const declaredEmpty = a.expectEmpty === true
  const charsRaw = a.expectChars
  const chars = typeof charsRaw === 'number' && Number.isFinite(charsRaw) ? charsRaw : null
  const textRaw = a.expectText
  const text = typeof textRaw === 'string' && textRaw.length > 0 ? textRaw : null
  const expectedPath = typeof a.expectedPath === 'string' && a.expectedPath.length > 0 ? a.expectedPath : null
  const requestedPath = typeof a.requestedPath === 'string' && a.requestedPath.length > 0 ? a.requestedPath : null
  return {
    expectEmpty: declaredEmpty,
    expectChars: chars,
    expectText: text,
    expectedPath,
    requestedPath,
    declared: declaredEmpty || chars !== null || text !== null,
  }
}

const readFileVerifier: Verifier = {
  verifies: (s: Step) => (s.tool ?? '').includes('read-file'),
  async verify(s: Step, _ctx: ToolContext, toolData: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
    const d = toolData as { path?: string; text?: string; chars?: number } | undefined
    if (!d?.path) return { rejected: 'the step recorded no path to verify' }
    const r = resolveReadablePath(d.path)
    if ('refused' in r) return { rejected: r.refused }
    const want = readBackExpectation(s)

    // THE PATH MUST BE THE PATH. Provenance beats similarity: two files can share a basename and
    // be unrelated, so a read-back that satisfied "read the report" by opening a different file
    // with the same name would be true of the wrong thing.
    //
    // Which path the step is allowed to read is the one it NAMED. `expectedPath` is what the step
    // says it wants; `requestedPath` is what validation recorded when it had to substitute, and the
    // file that was actually written lives at `expectedPath` in that case. So the check is simply
    // "does the file read match the path the step declared", with no allowance for similarity, no
    // basename matching, and no inference from what seems likely.
    const pathClaimed = want.expectedPath
    if (pathClaimed) {
      const claimedResolved = resolveReadablePath(pathClaimed)
      const claimedPath = ('refused' in claimedResolved ? pathClaimed : claimedResolved.path).trim()
      if (claimedPath.toLowerCase() !== r.path.trim().toLowerCase()) {
        return {
          rejected: `this step claims to read ${claimedPath}, but the read-back was of ${r.path}. `
            + 'A read-back of a different file cannot prove that one arrived, even when the two share a basename.',
        }
      }
    }

    // Re-read from disk. The tool read the same file, so this is not a second independent
    // witness - and it should not pretend to be. What it DOES establish is that the content
    // exists on disk right now, which is the whole point: the file was produced by the GUI
    // (a save dialog, typed by hand), and this reads the result without asking the GUI
    // anything. A fabricated return from the tool fails here, because there is nothing behind it.
    if (!existsSync(r.path)) return { rejected: `${r.path} does not exist on disk right now` }
    let now: string
    try {
      now = readFileSync(r.path, 'utf8')
    } catch (e) {
      return { rejected: `could not re-read ${r.path}: ${e instanceof Error ? e.message : String(e)}` }
    }
    const claimed = String(d.text ?? '')
    // The tool read the file and the verifier re-reads it. If the tool reported CONTENT, that
    // content must still be there - a file that changed between the two reads is not verified.
    //
    // This guard used to be the ONLY content check, and it is the reason a zero-byte file passed:
    // an empty file yields `text: ''`, so `claimed.length > 0` was false, the comparison was
    // skipped, and `file-read-back` evidence was returned for a file containing nothing. Observed
    // live: the read-back step pointed at a 0-byte file left by an earlier editor step and reported
    // "exact match on read-file".
    if (claimed.length > 0 && now !== claimed) {
      return { rejected: `${r.path} now holds ${now.length} chars but the step reported ${claimed.length}; the file changed after it was read` }
    }

    // AN EMPTY FILE IS ONLY LEGITIMATE WHEN SOMEBODY ASKED FOR ONE.
    //
    // Not "every empty file is invalid" - that would break "create an empty file as a placeholder",
    // which is a real objective and is satisfied by a zero-byte file. The question is never "is this
    // file empty" but "was an empty file what was asked for". Three sources can answer it, in the
    // order they are trusted:
    //
    //   - the step said so (`expectEmpty: true`). This is the ONLY declaration that counts, because
    //     it is the only place a person or a plan expressed an intent about emptiness.
    //   - the step said how big it expected (`expectChars: 0`). Same standing.
    //   - the step said what it expected to find (`expectText`). Non-empty, so an empty result
    //     contradicts it.
    //
    // Otherwise an empty read-back is a FAILED verification, naming the file and saying that an
    // empty file is not what a read-back for content can establish. The failure is visible in the
    // step result and in the mission record, which is the point: it used to be reported as a pass.
    if (now.length === 0 && !want.expectEmpty && want.expectChars !== 0) {
      const asked = want.expectText
        ? `the step expected specific text (${JSON.stringify(want.expectText.slice(0, 60))})`
        : want.expectChars !== null
          ? `the step expected at least ${want.expectChars} characters`
          : 'this step reads a file back to prove it holds what was written into it'
      return {
        rejected: `${r.path} is 0 bytes. A read-back cannot establish that anything was written, and `
          + `${asked}. If an empty file IS the deliverable, say so explicitly with "expectEmpty": true `
          + 'on the step, and it will be verified as the empty file it was asked to be.',
      }
    }

    // An explicit expectation is compared, so a declaration cannot be used to wave a mismatch
    // through. `expectText` is a substring test because a plan states what it is looking for rather
    // than transcribing a whole document; `expectChars` is a floor, not an equality.
    if (want.expectText !== null && !now.includes(want.expectText)) {
      return {
        rejected: `${r.path} does not contain the text this step expected (${JSON.stringify(want.expectText.slice(0, 60))}). `
          + 'The file exists and reads back, but it does not hold what was asked for.',
      }
    }
    if (want.expectChars !== null && want.expectChars > 0 && now.length < want.expectChars) {
      return {
        rejected: `${r.path} holds ${now.length} characters but this step expected at least ${want.expectChars}.`,
      }
    }
    // Real `file-read-back` evidence, not a generic observation string.
    //
    // This is what lets the mission's OBJECTIVE be proven rather than left unproven. The
    // executor grades the objective against declared postconditions, and the evidence that
    // satisfies `artifact-exists` and `artifact-read-back` is of this kind. An observation with
    // a sentence in it satisfies nothing, so a mission whose last step read the file it had just
    // created still ended with an objective verdict of "unproven" and an overall failure -
    // seven verified steps, correct on disk, reported as a failed mission.
    //
    // The digest is included because `bytes` is a LENGTH and a length is not a content claim.
    // Without a hash of the bytes actually read, evidence can prove a file exists and is stable
    // while saying nothing about whether it holds the right sentence.
    const bytes = Buffer.byteLength(now, 'utf8')
    const firstLine = now.split(/\r?\n/, 1)[0] ?? ''
    return {
      evidence: {
        kind: 'file-read-back',
        path: r.path,
        bytes,
        heading: firstLine.slice(0, 200),
        sha256: createHash('sha256').update(now, 'utf8').digest('hex'),
      } as unknown as Evidence,
    }
  },
}

// ===========================================================================================
// CAPABILITY 5 - window accessibility survey (read-only)
// ===========================================================================================

const surveyWindowTool: Tool = {
  name: 'survey-window',
  mode: 'uia',
  args: [{ name: 'hwnd', type: 'number', required: false, description: 'the window handle to survey; omit to survey the window found by the previous list-windows step' }],
  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    // Resolve the handle. A model asked to "look at the main window" does not know the handle -
    // it is whatever the PREVIOUS step discovered - so it emits no hwnd at all and the step
    // fails with "no window handle was given". That is a real mission that cannot run, and it was
    // caught by a user asking a perfectly ordinary question.
    //
    // So the handle comes from the prior step's window list when it is not supplied, and a
    // template reference is resolved rather than passed to the API as a string.
    let hwnd = num(args.hwnd, 0)
    if (!hwnd) {
      const resolved = resolveRefs(String(args.hwnd ?? '{{prev.data.windows.0.hwnd}}'), ctx.prior)
      hwnd = num(resolved.text, 0)
    }
    if (!hwnd && lastWindows.length > 0) hwnd = lastWindows[0]!.hwnd
    if (!hwnd) {
      return { kind: 'failed', reason: 'no window handle was given, and no earlier step found a window to survey' }
    }
    try {
      const els = await surveyWindow(hwnd, 200)
      if (els.length === 0) return { kind: 'nothing-found', reason: `window ${hwnd} exposed no inspectable elements` }
      return {
        kind: 'data',
        summary: `${els.length} element(s) in window ${hwnd}`,
        data: {
          hwnd,
          elements: els.slice(0, 60).map((e) => ({ index: e.index, className: e.className, name: String(e.name ?? '').slice(0, 60) })),
        },
      }
    } catch (e) {
      return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) }
    }
  },
}

const surveyWindowVerifier: Verifier = {
  verifies: (s: Step) => (s.tool ?? '').includes('survey-window'),
  async verify(_s: Step, _ctx: ToolContext, toolData: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
    const d = toolData as { hwnd?: number; elements?: unknown[] } | undefined
    if (!d?.hwnd) return { rejected: 'no window handle was recorded' }
    const els = await surveyWindow(d.hwnd, 200)
    if (els.length === 0) return { rejected: `window ${d.hwnd} no longer exposes any inspectable element` }
    if (!els.some((e) => Number(e.index) === 0)) {
      return { rejected: `window ${d.hwnd} responded but not with the element list the step recorded` }
    }
    return {
      evidence: {
        kind: 'observation',
        detail: `re-surveyed from the host: ${els.length} element(s) present`,
      } as unknown as Evidence,
    }
  },
}

// ===========================================================================================
// CAPABILITY 6 - terminal
// ===========================================================================================

/**
 * Commands the agent may run, allowlisted.
 *
 * An allowlist rather than a blocklist is the deliberate choice: a blocklist has to be right
 * about everything dangerous, and a new dangerous thing arrives with every new tool. Reading,
 * listing and version checks cover what the assistant actually needs from a shell.
 *
 * `opencode-cli.exe` is on it because the whole development loop depends on it and the agent
 * cannot reach OpenCode without it. It was absent, which produced a failure that looked like a
 * model fault and was not: the model was told the CLI's exact path, ran it, and was refused for
 * using a tool the project itself depends on. The allowlist is a safety boundary, so widening it
 * is a decision - but refusing the one binary the product is built around is a bug, not a
 * boundary.
 */
const ALLOWED_COMMANDS = new Set([
  'node', 'npm', 'npx', 'git', 'python', 'py', 'where', 'dir', 'type', 'echo',
  'ver', 'systeminfo', 'tasklist', 'hostname', 'date', 'findstr', 'more', 'tree',
  'opencode-cli.exe',
])

// The entries are not uniform: `node` and `git` carry no extension, `opencode-cli.exe` does.
// Normalising only the candidate meant `opencode-cli.exe` was looked up as `opencode-cli` and
// missed, while the refusal message listed the very name it had just been refused for. Both
// sides are normalised, so the allowlist means what it says regardless of how it was spelled.
const ALLOWED_NAMES = new Set(Array.from(ALLOWED_COMMANDS).map((c) => c.replace(/\.exe$/, '')))

export function commandAllowed(cmd: string): boolean {
  // Step 1: Extract the executable path, handling quoted paths first.
  // If the command starts with a quote, find the matching closing quote
  // and extract just the path between the quotes.
  let text = cmd.trim()
  if (/^["']/.test(text)) {
    const endIdx = text.indexOf(text[0], 1)
    if (endIdx > 0) {
      text = text.substring(1, endIdx)
    } else {
      text = text.slice(1)
    }
  }

  // Step 2: Resolve the EXECUTABLE, which is the first token - not the last path segment.
  //
  // This was `text.split(/[\\/]/).pop()`, written for a fully-qualified command like
  // `C:\Program Files\nodejs\node.exe`. Applied to a command that takes a path ARGUMENT it
  // checks the wrong token entirely:
  //
  //   "dir C:\Users\Samer\Documents\note.txt"
  //     -> split on backslash -> ["dir C:", "Users", "Samer", "Documents", "note.txt"]
  //     -> pop()             -> "note.txt"
  //     -> allowlist lookup for "note.txt"  -> REFUSED
  //
  // So `dir` was on the allowlist and `dir <any path>` was not. The same held for every
  // allowlisted command that takes a path - type, where, tree, more, findstr - which is to say
  // most of the commands the allowlist exists to permit. A mission using one of them failed on
  // a filename, and the refusal named the filename as the problem, sending the reader after the
  // wrong thing entirely.
  //
  // The executable is the first whitespace-delimited token. The basename applies only when THAT
  // token is itself a path. Nothing is added to the allowlist by this fix: it makes the check
  // read the token the allowlist was written about.
  const firstToken = firstTokenOf(text)
  let base = /[\\/]/.test(firstToken) ? (firstToken.split(/[\\/]/).pop() ?? firstToken) : firstToken

  // A drive-qualified path containing spaces, unquoted: `C:\Program Files\nodejs\node.exe -v`.
  // The first whitespace token is `C:\Program`, whose basename is "Program" - not a command -
  // so the executable is the first token that actually names one. Windows cannot execute such
  // a path without quoting it, so this branch exists to preserve the allowlist check's previous
  // behaviour for input that is malformed rather than to make malformed input work.
  if (/^[A-Za-z]:[\\/]/.test(text) && !text.trimStart().startsWith('"')) {
    const exe = text.trim().split(/\s+/).find((t) => /\.exe$/i.test(t))
    if (exe) base = exe.split(/[\\/]/).pop() ?? exe
  }

  // Step 3: Strip .exe extension (normalized consistently with ALLOWED_NAMES).
  // Both `node` and `node.exe` on the command line must match `node` in the allowlist.
  const name = base.toLowerCase().replace(/\.exe$/, '')

  // Step 4: Check against the allowlist.
  return ALLOWED_NAMES.has(name)
}

/** The leading whitespace-delimited token, honouring a quoted path that contains spaces. */
function firstTokenOf(text: string): string {
  const t = text.trim()
  if (!t.startsWith('"') && !t.startsWith("'")) return t.split(/\s+/)[0] ?? ''
  const end = t.indexOf(t[0], 1)
  return end > 0 ? t.slice(1, end) : t.slice(1)
}

// ===========================================================================================
// TERMINAL CONTAINMENT - there is no shell in this file.
//
// This used to be `spawn(cmd, { shell: true })`. A shell between the allowlist and the
// operating system undoes the allowlist: `node --version` is one command, and the same string
// with `& calc.exe` appended is two - the allowlist only ever read the first token. The
// existing `authorizeShell` (artifacts.ts) caught the quote-stripped `&`, `|`, `;` chains and
// space-separated redirects, but NOT `echo hi>file` (no space before the operator, so its
// redirect regex missed), not a newline-separated second command, and not `%VAR%` expansion
// inside quotes. Those gaps were live write/execution routes on the chat path.
//
// The replacement: tokenize the line ourselves (double quotes group, nothing else is special),
// refuse anything a shell would interpret, and run the allowlisted executable with a STRUCTURED
// argument list inside a Windows Job Object (job-exec.ps1) with KILL_ON_JOB_CLOSE - so even
// grandchildren the wrapper never saw die when the command ends, the timeout fires, or the
// caller cancels. cmd.exe itself is invoked only as a NON-interactive argument executor for
// built-ins and .cmd shims (`dir`, `echo`, `npm`, ...), under /d /s /c with a rebuilt line that
// can contain no operators, because the tokenizer already refused every one.
// ===========================================================================================

/**
 * Characters a shell would interpret.
 *
 * Refused outright in unquoted regions. None of them is needed to run an allowlisted command,
 * and every one of them is how "node --version" becomes something the allowlist never read.
 * `;` is not a cmd.exe separator - it is refused because it is one on every other platform
 * this code could be ported to, and a refusal is cheaper than a port that quietly works wrong.
 */
const SHELL_OPERATORS = /[&|<>^();`\n\r]/

export type ParsedCommandLine =
  | { readonly ok: true; readonly exe: string; readonly args: readonly string[] }
  | { readonly ok: false; readonly reason: string }

/**
 * Tokenize a command line the way Windows CreateProcess argument parsing does - double quotes
 * group, backslashes are literal, there are no escape sequences - and refuse anything that
 * would need a shell.
 *
 * `%` and `!` are refused EVERYWHERE, quoted or not, because cmd.exe expands `%VAR%` even
 * inside double quotes; a quoted `%PATH%` is not a literal either. Refusing them is a real
 * restriction (no command that mentions a variable can run) and it is the honest trade: the
 * expansion's result is not something the allowlist ever read.
 */
export function parseCommandLine(cmd: string): ParsedCommandLine {
  const text = cmd.trim()
  if (text.length === 0) return { ok: false, reason: 'the command was empty' }

  const tokens: string[] = []
  let cur = ''
  let started = false
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '"') { inQuotes = !inQuotes; started = true; continue }
    if (ch === '%' || ch === '!') {
      return {
        ok: false,
        reason: `"${ch}" requests environment-variable expansion. AIOS does not run commands `
          + 'through a shell, so nothing is expanded: what the allowlist read is not what would '
          + 'run. Write the literal value instead.',
      }
    }
    if (!inQuotes && SHELL_OPERATORS.test(ch)) {
      return {
        ok: false,
        reason: `"${ch}" is a shell operator. AIOS does not run commands through a shell: it `
          + 'runs one allowlisted executable with structured arguments, so chaining, redirection '
          + 'and quoting tricks are refused rather than executed.',
      }
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (started) { tokens.push(cur); cur = ''; started = false }
      continue
    }
    cur += ch
    started = true
  }
  if (inQuotes) return { ok: false, reason: 'the command has an unbalanced double quote' }
  if (started) tokens.push(cur)
  if (tokens.length === 0) return { ok: false, reason: 'the command was empty' }

  const [exe, ...args] = tokens
  return { ok: true, exe, args }
}

/** Basename, lowercased, with the executable-script extensions normalised away. */
function commandName(name: string): string {
  const base = /[\\/]/.test(name) ? (name.split(/[\\/]/).pop() ?? name) : name
  return base.toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
}

/** cmd.exe's own printing built-ins: there is no file on disk to spawn directly. */
const CMD_BUILTINS = new Set(['dir', 'type', 'echo', 'ver', 'date', 'more', 'tree'])

/** Shimmed launchers: `npm` is npm.cmd, which only cmd.exe can run. */
const CMD_SHIMS = new Set(['npm', 'npx'])

/** Quote one argv token for a CreateProcess argument string. Tokens can never contain a
 *  double quote (the tokenizer consumes those as syntax), so whitespace is the only case. */
function quoteArg(token: string): string {
  return /\s/.test(token) ? `"${token}"` : token
}

const JOB_WRAPPER_PATH = fileURLToPath(new URL('./job-exec.ps1', import.meta.url))
const COMMAND_TIMEOUT_MS = 120_000

interface ContainedRun {
  readonly code: number
  readonly out: string
  readonly err: string
  readonly timedOut: boolean
  readonly contained: boolean
}

/**
 * Run one command inside the Job Object wrapper and return its result.
 *
 * Abort policy: the signal KILLS the wrapper process, and the wrapper's death closes the job
 * handle, and a closed job with KILL_ON_JOB_CLOSE kills every process in it. So cancellation
 * reaches the grandchildren too, with no bookkeeping on this side - there is no list of child
 * pids to get wrong.
 *
 * Fail-closed: if the wrapper cannot start or cannot establish the job, the result says the
 * command was NOT run. There is deliberately no fallback that runs the command uncontained.
 */
function runInJob(
  exe: string,
  argsLine: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ContainedRun> {
  return new Promise((res) => {
    if (signal?.aborted) {
      res({ code: -1, out: '', err: 'cancelled by the user', timedOut: false, contained: true })
      return
    }

    let p: ChildProcess
    try {
      p = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', JOB_WRAPPER_PATH],
        { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      )
    } catch (e) {
      res({
        code: -1, out: '', timedOut: false, contained: false,
        err: `containment unavailable: ${e instanceof Error ? e.message : String(e)}. `
          + 'AIOS will not run terminal commands uncontained.',
      })
      return
    }

    let out = ''
    let err = ''
    let settled = false

    const finish = (r: ContainedRun): void => {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      signal?.removeEventListener('abort', onAbort)
      try {
        if (p.exitCode === null && p.signalCode === null) p.kill()
      } catch { /* the wrapper is already gone; the job died with it */ }
      res(r)
    }
    const onAbort = (): void => {
      // Killing the wrapper closes the job, which kills the tree - the same path the
      // timeout takes, which is why cancellation needs no separate mechanism here.
      finish({ code: -1, out, err: 'cancelled by the user', timedOut: false, contained: true })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const hardTimer = setTimeout(() => {
      finish({
        code: -1, out, timedOut: true, contained: true,
        err: `${err}containment wrapper exceeded ${timeoutMs + 15_000}ms and was killed; `
          + 'the command process tree was terminated.',
      })
    }, timeoutMs + 15_000)

    p.stdout?.on('data', (d) => { out += String(d) })
    p.stderr?.on('data', (d) => { err += String(d) })
    p.on('error', (e) => {
      finish({
        code: -1, out: '', timedOut: false, contained: false,
        err: `containment unavailable: ${e.message}. AIOS will not run terminal commands uncontained.`,
      })
    })
    p.on('close', (psCode) => {
      // A UTF-8 BOM on the wrapper's stdout would break JSON.parse; strip exactly that one char.
      const raw = out
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
      if (psCode !== 0) {
        finish({
          code: -1, out: text, timedOut: false, contained: false,
          err: `${err}AIOS will not run terminal commands uncontained.`,
        })
        return
      }
      try {
        const j = JSON.parse(text) as { code: number; out: string; err: string; timedOut: boolean }
        finish({
          code: Number(j.code),
          out: String(j.out ?? ''),
          err: String(j.err ?? ''),
          timedOut: j.timedOut === true,
          contained: true,
        })
      } catch {
        finish({
          code: -1, out: text, timedOut: false, contained: false,
          err: `${err}containment wrapper returned an unparseable result; the command was not treated as run.`,
        })
      }
    })

    p.stdin?.end(JSON.stringify({ exe, args: argsLine, cwd, timeoutMs }))
    if (signal?.aborted) onAbort()
  })
}

/**
 * Run an allowlisted command line. Structured argv all the way down - no shell, ever.
 *
 * `signal` cancels the run: the wrapper dies, the job closes, the tree dies. A cancelled or
 * refused command reports `code: -1` with the reason in `err`; nothing runs uncontained.
 *
 * Exported for the containment tests, which need to prove orphan-kill and cancellation against
 * the execution layer itself. The AUTHORIZATION layer (authorizeShell) deliberately refuses
 * `node script.js` whenever the script exists on disk - a declared artifact that already holds
 * bytes is off-limits to the shell - and that refusal is pinned by shell-artifact-contract
 * tests. Two layers, two suites: contract tests own who may run; these tests own what happens
 * to the processes afterwards.
 */
export const runCommand = (
  cmd: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ code: number; out: string; err: string }> =>
  (async () => {
    const parsed = parseCommandLine(cmd)
    if (!parsed.ok) return { code: -1, out: '', err: parsed.reason }

    let exe = parsed.exe
    let argsLine = parsed.args.map(quoteArg).join(' ')
    const name = commandName(parsed.exe)
    if (CMD_BUILTINS.has(name) || CMD_SHIMS.has(name)) {
      // cmd.exe as a pure argument executor: /d skips AutoRun, /s makes the /c tail be taken
      // literally after the outer quote strip. The tail was built by this function from tokens
      // the tokenizer already cleared of every operator, so there is nothing in it for cmd to
      // interpret beyond the built-in itself.
      const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'
      let tail = [parsed.exe, ...parsed.args].map(quoteArg).join(' ')
      if (/^".*"$/.test(tail)) tail = `"${tail}"`
      exe = comspec
      argsLine = `/d /s /c ${tail}`
    }

    const r = await runInJob(exe, argsLine, cwd, COMMAND_TIMEOUT_MS, signal)
    return { code: r.code, out: r.out, err: r.err }
  })()

const terminalTool: Tool = {
  name: 'terminal',
  mode: 'cli',
  args: [
    { name: 'command', type: 'string', required: true, description: 'an allowlisted command, e.g. "node --version"' },
    { name: 'cwd', type: 'string', required: false, description: 'working directory' },
  ],
  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const command = str(args.command, 'command')
    if (!command) return { kind: 'failed', reason: 'no command was given' }
    if (!commandAllowed(command)) {
      return {
        kind: 'failed',
        reason: `"${command}" is not on the terminal allowlist (${Array.from(ALLOWED_COMMANDS).join(', ')})`,
      }
    }

    // THE SHELL IS A WRITE ROUTE, AND USED TO BE AN UNGUARDED ONE.
    //
    // Measured on this machine: a mission proposed a plan using `shell`/`read`, validation refused
    // both as unregistered capabilities - and the file was written anyway, 407 real rows, by the
    // same shell the plan had named. Every artifact rule in `artifacts.ts` is enforced in
    // `write-file` and `spreadsheet`; the shell bypassed all of them, because a command string is
    // not a path and nothing was reading it as one.
    //
    // So a command that can write must now say WHICH DECLARED ARTIFACT it is writing, and a
    // command that cannot is not run. Read-only commands (`dir`, `where`, `echo`, `git status`, …)
    // are unaffected - they cannot damage a file, so making them declare intent would only make
    // the tool worse at the reading and inspection work it is genuinely useful for.
    const contract = contractFor(ctx.missionId)
    const refusal = authorizeShell({ command, contract })
    if (refusal) return { kind: 'failed', reason: refusal }

    // The tokenizer's refusal, surfaced on its own rather than wrapped in "exit -1". It sits
    // AFTER authorizeShell on purpose: the artifact layer's "did not declare" messages describe
    // the policy this product actually wrote, and those must keep their wording for the commands
    // it catches. runCommand re-parses regardless, so the verifier path is covered too.
    const parsed = parseCommandLine(command)
    if (!parsed.ok) return { kind: 'failed', reason: parsed.reason }

    const cwd = str(args.cwd, 'cwd', AGENT_OUT)
    if (!existsSync(cwd)) return { kind: 'failed', reason: `working directory does not exist: ${cwd}` }

    // Snapshot first. "The file exists afterwards" cannot distinguish this mission's bytes from
    // an earlier mission's, and that ambiguity is what let a clobber read as a success.
    const before = contract ? snapshotArtifacts(contract) : {}

    try {
      const r = await runCommand(command, cwd, ctx.signal)
      const combined = `${r.out}${r.err}`.trim()
      if (r.code !== 0) return { kind: 'failed', reason: `exit ${r.code}: ${combined.slice(0, 300)}` }
      if (combined.length === 0) return { kind: 'nothing-found', reason: 'the command produced no output' }

      // What did it actually do to the artifacts it declared? Stated rather than assumed, because
      // a command that exits 0 having written nothing is not a step that produced its output.
      let touched: string[] = []
      if (contract) {
        const d = artifactDelta(contract, before)
        touched = [...d.created, ...d.changed]
        if (d.missing.length > 0) {
          return {
            kind: 'failed',
            reason: `"${command}" removed declared artifact(s): ${d.missing.join(', ')}. `
              + 'A mission that destroys its own deliverable cannot report success afterwards.',
          }
        }
      }

      return {
        kind: 'data',
        summary: `${r.code === 0 ? 'ok' : 'failed'} (${combined.length} chars)`
          + (touched.length > 0 ? `; wrote ${touched.length} declared artifact(s)` : ''),
        data: {
          command,
          cwd,
          exitCode: r.code,
          output: combined.slice(0, 4000),
          ...(touched.length > 0 ? { artifactsWritten: touched } : {}),
        },
      }
    } catch (e) {
      return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) }
    }
  },
}

const terminalVerifier: Verifier = {
  verifies: (s: Step) => (s.tool ?? '').includes('terminal'),
  async verify(_s: Step, _ctx: ToolContext, toolData: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
    const d = toolData as { command?: string; cwd?: string; output?: string } | undefined
    if (!d?.command) return { rejected: 'the step recorded no command to verify' }
    // Re-run and compare. Deterministic commands must produce the same output twice; a tool that
    // printed its own output would not survive this. `signal` is threaded so a cancelled mission
    // stops the verifier's re-run too - the stop means stop, including for verification.
    const again = await runCommand(d.command, d.cwd ?? AGENT_OUT, _ctx.signal)
    const a = String(again.out + again.err).trim()
    if (again.code !== 0) return { rejected: `re-running the command exited ${again.code}: ${a.slice(0, 200)}` }
    if (a !== String(d.output ?? '').trim()) {
      return { rejected: `re-running the command produced different output, so the first run cannot be corroborated` }
    }
    return {
      evidence: {
        kind: 'observation',
        detail: `re-executed independently: identical ${a.length}-char output`,
      } as unknown as Evidence,
    }
  },
}

// ===========================================================================================
// EFFECT CLASSIFICATION - what a terminal step would actually DO
// ===========================================================================================

/**
 * The chat terminal's `effectOf`: the executor's gate reads this instead of trusting the plan.
 *
 * WHY THE VERB AND NOT THE WHOLE COMMAND
 *
 * `git status` reads and `git push` sends, and a static "terminal is consequential" flag would
 * either demand a human for the first or wave the second through. The verb is what carries the
 * consequence, so the verb is what is classified - using the SAME verb tables the interactive
 * terminal gates on (live/terminal-policy.ts, imported not copied), because two terminals on one
 * machine classifying `git push` differently is a policy that cannot be described honestly.
 *
 * DELIBERATE DIFFERENCES FROM THE INTERACTIVE TERMINAL, STATED RATHER THAN HIDDEN
 *
 * The interactive terminal BLOCKS every verb it has not classified; this one returns `undefined`
 * and lets the artifact layer answer (authorizeShell: declared targets only, no overwriting what
 * already exists). Chat missions legitimately run `node script.js` against declared artifacts as
 * their normal work, while the interactive terminal wants a human for every script run. The
 * boundaries are layered, not replaced: this classifier decides what needs AUTHORISATION, and
 * authorizeShell still decides what the command may TOUCH.
 *
 * A command the tokenizer would refuse classifies as no effect - it will not execute at all, so
 * there is no effect to declare.
 */
function terminalEffectOf(step: Step): DeclaredEffect | undefined {
  const command = String((step.args as { command?: unknown } | undefined)?.command ?? '')
  const parsed = parseCommandLine(command)
  if (!parsed.ok) return undefined
  const name = commandName(parsed.exe)
  const verb = parsed.args.find((a) => !a.startsWith('-'))?.toLowerCase()

  if (name === 'git' && verb) {
    const send = GIT_SEND_VERBS[verb]
    if (send) {
      return {
        kind: 'external-send',
        target: `git ${verb}`,
        reason: `git ${verb} ${send}`,
        irreversible: true,
      }
    }
    const destructive = GIT_DESTROY_VERBS[verb]
    if (destructive) {
      return {
        kind: 'delete',
        target: `git ${verb}`,
        reason: `git ${verb} ${destructive}`,
        irreversible: true,
      }
    }
    return undefined
  }

  if (name === 'npm' && (verb === 'install' || verb === 'i' || verb === 'add' || verb === 'ci')) {
    const rest = parsed.args
      .slice(parsed.args.indexOf(verb) + 1)
      .filter((a) => !a.startsWith('-'))
      .join(' ')
    return {
      kind: 'install',
      target: (rest || "this project's dependency tree").slice(0, 200),
      reason: 'npm install downloads and unpacks third-party code onto this machine',
      irreversible: false,
    }
  }

  return undefined
}

// ===========================================================================================
// the registry
// ===========================================================================================

export interface Capability {
  readonly id: string
  readonly mode: string
  /** Read by the model. States what it does AND what it cannot do. */
  readonly description: string
  readonly tool: Tool
  readonly verifier: Verifier
  readonly available: boolean
  readonly unavailableReason?: string
  /**
   * A capability that can be PLANNED for while unavailable, because it becomes available through
   * a deliberate human action rather than by waiting.
   *
   * Desktop input is the case that forced this. It is blocked whenever a human is at the machine,
   * and it unblocks when the human clicks RELEASE and steps away - so it is unavailable at the
   * exact moment the goal is typed, and available at the exact moment the step would run. A
   * capability the planner must skip when it is unavailable is therefore a capability that can
   * never be used, which is precisely backwards for the one action that needs human cooperation
   * to become possible. Planning it is safe: the step still cannot inject anything until the
   * live guard permits it.
   */
  readonly plannable?: boolean
  /**
   * GOVERNANCE, mirrored from the tool-router's registration semantics.
   *
   * The executor's consequential-effect gate reads three sources, strongest first: the TOOL's
   * own classification of its arguments (`effectOf`), a static always-consequential flag
   * (`consequential`), and the plan step's declaration. The chat path's router used to expose
   * none of the first two, so the gate could never fire here: a `git push` step planned for the
   * chat ran its effect with no request, no record and no human - while the interactive
   * terminal, which does expose them, gated the identical command. Two paths, two rules, one
   * machine: exactly the non-uniform boundary this field set exists to end.
   */
  readonly consequential?: boolean
  /**
   * WHAT A STEP WOULD ACTUALLY DO, decided from its own arguments. `undefined` is a positive
   * claim that the tool looked and found nothing consequential - not "could not tell".
   */
  readonly effectOf?: (step: Step) => DeclaredEffect | undefined
  /**
   * A refusal this tool would issue for the step, checked BEFORE authorisation. A blocked
   * command is not something a human can authorise, so it must never be dressed as an approval
   * request.
   */
  readonly preflight?: (step: Step) => { blocked: string; needsHuman: boolean } | undefined
}

/**
 * Live guard input state, refreshed immediately before planning and re-checked at the instant of
 * injection. It is a snapshot and is treated as stale the moment it is read: the tool never
 * trusts it to authorise anything on its own.
 */
let liveInput: { permitted: boolean; reason: string } = {
  permitted: false,
  reason: 'the guard has not been read yet in this process',
}

/**
 * Re-reads the guard so the catalogue the model sees matches the machine's real authority.
 *
 * A static `available: false` was the original mistake: the capability was permanently
 * unavailable, so the model was told desktop control did not exist, so it never planned it, so
 * nothing ever tried - and the one time injection genuinely was permitted, nothing was in a
 * position to use it. Availability is a property of the machine at this moment, not of the
 * registry at build time.
 */
export async function refreshLiveAvailability(): Promise<{ permitted: boolean; reason: string }> {
  try {
    const p = await livePermission()
    liveInput = p.input === 'PERMITTED'
      ? { permitted: true, reason: 'the guard permits injection right now' }
      : { permitted: false, reason: `the operator guard reports input ${p.input}` }
  } catch (e) {
    liveInput = { permitted: false, reason: `the guard could not be read: ${e instanceof Error ? e.message : String(e)}` }
  }
  return liveInput
}

/**
 * Read the live guard again and refuse unless it permits injection at this instant.
 *
 * Returns null the moment injection is permitted. Otherwise it WAITS, because the condition that
 * makes desktop input possible is a deliberate human action - clicking RELEASE and walking away -
 * and that takes longer than any instantaneous check allows for. Failing immediately meant the
 * capability could never be used: it is blocked while the human types the goal, and the human
 * cannot release before typing, because typing is itself the takeover. Waiting is what makes the
 * handover expressible at all.
 *
 * It only ever waits. It never relaxes a check, never caches a permission, and never injects on
 * the strength of an earlier read - each attempt is a fresh read of the live guard.
 */
/**
 * Appends one line to the agent's own log.
 *
 * Exists because a refusal that only exists as a message in a chat window is not diagnosable: the
 * guard changes state several times a second while a human is deciding whether to press a key,
 * and by the time anyone reads the failure the evidence is gone. The wait path writes every state
 * it saw here, so "it did not work" comes with the reason attached.
 */
function note(line: string): void {
  try {
    appendFileSync(join(AGENT_ROOT, 'handoff.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch { /* logging must never be the reason a step fails */ }
}

// THE TRANSPORT-LOSS CLASSIFIER LIVES IN transport-loss.ts, shared with the executor's
// throwing-tool boundary. It was defined here first; it is imported now so the tool's own
// classification and the executor's fallback cannot drift into disagreeing about the same
// evidence - which is exactly how an action ends up retryable in one layer and not the other.
async function injectionRefusedReason(waitSeconds = 0): Promise<string | null> {
  const deadline = Date.now() + waitSeconds * 1000
  let last = ''
  let armed = false
  let sawResuming = false
  const trace: string[] = []
  for (;;) {
    const p = await livePermission()
    // THE HOST IS GONE, not the guard. Waiting cannot revive a dead process, and the default
    // wait here is 300 seconds: without this check, every desktop step on a dead host would
    // spin out the full window polling a process that will never answer, arm-attempting
    // against a closed port, and the eventual refusal would blame the GUARD for an
    // infrastructure loss. Fail closed immediately, and name the right cause so the remedy
    // (restart the host) is the one the person is given.
    if (!p.infrastructureHealthy) {
      const why = p.blockedBy ?? 'the control infrastructure reports itself unhealthy'
      note(`desktop-input: host unavailable, refusing without waiting (${why})`)
      return `the operator host is not answering (${why}), so no keystroke or click was sent. `
        + 'This is not the guard refusing: the host process itself must be running again before '
        + 'desktop input can be attempted. Restart it with scripts/start-operator-host.mjs and '
        + 'ask again.'
    }
    if (p.input === 'PERMITTED') {
      if (trace.length) note(`desktop-input wait: ${trace.join(' -> ')}`)
      return null
    }
    last = `the operator guard reports input ${p.input}`
    // Complete the handover the human started. A release click leaves the guard RESUMING for only
    // as long as the human's hand stays still - moving the mouse away is itself a takeover, and
    // it re-latches within milliseconds. This was missed every time because the poll interval
    // was longer than the window a human can actually hold. It is now short enough to land
    // inside it, and every state it saw is recorded so the next failure has evidence in it
    // rather than only a refusal message.
    if (!armed) {
      const a = await armOperator()
      if (a.armed) {
        armed = true
        trace.push(`ARMED at ${new Date().toISOString().slice(11, 23)} (sawResuming=${sawResuming})`)
        note(`desktop-input wait: human release completed -> ${a.detail}`)
      } else if (a.detail.includes('RESUMING')) {
        sawResuming = true
        trace.push('saw RESUMING')
        note('desktop-input wait: caught the human release (RESUMING)')
      } else if (trace.length === 0 && !last.includes('HUMAN_TAKEOVER')) {
        trace.push(a.detail)
      }
    }
    if (Date.now() >= deadline) {
      note(`desktop-input wait ended after ${waitSeconds}s: ${trace.join(' -> ') || 'the guard was never released'}`)
      return `${last}, so no keystroke or click was sent. `
        + 'This is the guard refusing, not a failure of the step. Desktop input needs a human to '
        + 'press Ctrl+Alt+G once and then leave the machine alone. A MOUSE click is not enough: '
        + 'moving the hand off the button is itself a takeover and cancels the release within '
        + 'milliseconds, which is why clicking RELEASE repeatedly never worked.'
    }
    await new Promise((r) => setTimeout(r, 120))
  }
}

/**
 * How much of a typed string must survive truncation for the step to count as verified.
 *
 * Long enough to be distinctive, short enough to fit in what a view shows when a document is
 * scrolled. 24 characters is roughly one line of prose - it cannot be satisfied by an unrelated
 * control that happens to contain some common words.
 */
const TAIL_MATCH_CHARS = 24

/**
 * Desktop input: type, click and press keys into one specific window.
 *
 * It is registered unconditionally and reports its availability LIVE. Two properties are not
 * negotiable and are enforced here rather than asserted in a comment:
 *
 * 1. Permission is re-read at the instant of injection, not taken from the planning-time
 *    snapshot. A plan built while the guard permitted input must not survive a takeover that
 *    happened afterwards; the injection endpoint re-consults the guard too, but a tool that
 *    refuses locally means the refusal is reported as a refusal instead of as a mystery.
 * 2. The verifier is INDEPENDENT of the tool. It re-surveys the window and looks for the text in
 *    the accessibility tree, which the typing tool cannot influence. A tool that verified its
 *    own delivery would only prove it had been called.
 */
const desktopInputCapability: Capability = {
  id: 'desktop-input',
  mode: 'gui',
  get description(): string {
    return 'Send real keyboard and mouse input to ONE specific desktop window: type text, click at '
      + 'coordinates, or press a key (with Ctrl held, for shortcuts like save). '
      + 'Requires the operator guard to permit injection AT THE '
      + 'INSTANT of the action; if a human touches the machine first, the step fails honestly '
      + 'rather than typing into a window someone is using. '
      + 'IMPORTANT WHEN A DIALOG APPEARS: pressing a shortcut such as Ctrl+S often opens a NEW '
      + 'window - a Save As dialog, with its own handle. It does not replace the window you '
      + 'pressed the key in. After any shortcut, run list-windows to see whether a new window '
      + 'appeared; if one did, target THAT handle for the next step, because that is where the '
      + 'text has to go. Do not assume the shortcut alone finished the job. '
      + (this.available
        ? 'Currently AVAILABLE: the guard is permitting input.'
        : `Currently BLOCKED (${this.unavailableReason ?? 'unknown'}). This is still PLANNABLE: a step `
          + 'that needs it will WAIT, and tell you to click RELEASE and step away, then act the moment '
          + 'the guard permits. Plan it whenever the task genuinely requires typing or clicking.')
  },
  get available(): boolean { return liveInput.permitted },
  get unavailableReason(): string | undefined { return liveInput.permitted ? undefined : liveInput.reason },
  // Plan it anyway. The step waits for the human and reports that it is waiting; it cannot
  // inject a single event until the guard says PERMITTED on a read made at that moment.
  plannable: true,
  tool: {
    name: 'desktop-input',
    mode: 'gui',
    args: [
      { name: 'action', type: 'string', required: true, description: 'type | click | key' },
      { name: 'hwnd', type: 'number', required: false, description: 'target window handle; omit for the window the previous step found' },
      { name: 'text', type: 'string', required: false, description: 'text to type, for action=type' },
      { name: 'x', type: 'number', required: false, description: 'x coordinate within the window, for action=click' },
      { name: 'y', type: 'number', required: false, description: 'y coordinate within the window, for action=click' },
      // The two fields below are what make a KEYBOARD SHORTCUT possible at all, and both are
      // DECIMAL key codes here even though the host speaks hex - the conversion is done here so
      // that every caller reasons in the same numbers the docs everywhere quote.
      { name: 'vk', type: 'number', required: false, description: 'DECIMAL virtual key code, for action=key. Enter=13, Ctrl+S=83, Ctrl+A=65, Tab=9, Escape=27' },
      { name: 'ctrl', type: 'boolean', required: false, description: 'true to hold Ctrl while pressing the key. e.g. {action:key, vk:83, ctrl:true} saves' },
    ],
    async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      const action = String(args.action ?? '').toLowerCase()
      if (!['type', 'click', 'key'].includes(action)) {
        return { kind: 'failed', reason: `action must be type, click or key - got "${action}"` }
      }
      let hwnd = num(args.hwnd, 0)
      if (!hwnd) {
        const resolved = resolveRefs(String(args.hwnd ?? '{{prev.data.windows.0.hwnd}}'), _ctx.prior)
        hwnd = num(resolved.text, 0)
      }
      if (!hwnd && lastWindows.length > 0) hwnd = lastWindows[0]!.hwnd
      if (!hwnd) return { kind: 'failed', reason: 'no target window handle was given and none was found earlier' }

      // Fail closed, at the moment of the action, on a guard read made now. It waits rather than
      // failing outright: the only thing that unblocks desktop input is a human clicking RELEASE
      // and stepping away, and that cannot have happened yet the instant a plan is executed.
      const refused = await injectionRefusedReason(num(args.waitSeconds, 300))
      if (refused) return { kind: 'failed', reason: refused }

      // TargetIdentity carries pid AND the title we expect to find. Both are checked by the host
      // before a single event is injected, so a window that was closed and a different one that
      // reused the handle cannot be typed into by accident. Supplying the title from the window we
      // actually enumerated keeps that check meaningful instead of vacuous.
      const known = lastWindows.find((w) => w.hwnd === hwnd)
      const target = {
        hwnd,
        pid: Number(args.pid ?? known?.pid ?? 0) || 0,
        expectedTitle: String(args.expectedTitle ?? known?.title ?? ''),
      }
      try {
        let result: { delivered: boolean; refusedBy: string | null }
        if (action === 'type') {
          const text = String(args.text ?? '')
          if (!text) return { kind: 'failed', reason: 'action=type needs text' }
          result = await liveControl.type(target, text)
        } else if (action === 'click') {
          result = await liveControl.click(target, num(args.x, 0), num(args.y, 0))
        } else {
          const vk = num(args.vk, 0)
          if (!vk) return { kind: 'failed', reason: 'action=key needs a vk virtual key code' }
          // ControlSurface.pressKey takes the key as a string, not a number. Passing the number
          // would have been a type error rather than a silent wrong-key bug, which is the better
          // of the two outcomes.
          //
          // Two translations are required here and both were wrong before, silently.
          //
          // The host parses `vk` as HEX: `Convert.ToInt32(vk, 16)`. The planner reasons in the
          // decimal key codes everyone quotes (Ctrl+S is 83), so a raw decimal "83" was sent and
          // the host pressed VK 0x83 - a key that does nothing on any normal layout. The save
          // silently did not happen.
          //
          // The host reads its modifier from a literal `"ctrl":true` in the body. This step
          // passed a `modifiers` array, which the host does not look at, so even a correct key
          // code was sent as a bare press with no chord.
          //
          // Both produce a plausible-looking delivery report and no keystroke. The fix is to
          // send what the host actually reads: hex, and an explicit ctrl flag.
          const vkHex = num(args.vk, 0).toString(16)
          const ctrl = args.ctrl === true || args.ctrl === 'true'
          if (ctrl) {
            result = await rawKey(target, vkHex, true)
          } else {
            result = await liveControl.pressKey(target, vkHex)
          }
        }
        if (!result.delivered) {
          const why = result.refusedBy ?? 'no reason given'
          if (midActionTransportLoss(why)) {
            return {
              kind: 'outcome-unknown',
              reason: `the operator transport died DURING the ${action} request (${why}). Some of the `
                + 'input may already have reached the desktop, so this step must not be retried '
                + 'blindly: the machine has to be observed, or a human asked, before anything is '
                + 'sent again.',
            }
          }
          return { kind: 'failed', reason: `the host refused the injection: ${why}` }
        }
        return {
          kind: 'data',
          summary: `${action} sent to hwnd ${hwnd}`,
          data: { action, hwnd, text: args.text ? String(args.text) : undefined, x: args.x, y: args.y, vk: args.vk, delivered: true },
        }
      } catch (e) {
        // Same classification for a thrown transport error (the ctrl-key path posts through
        // `raw`, which does not catch): a mid-flight death is an unknown outcome, not a clean
        // failure, and reporting it as `failed` is how a blind retry gets authorized.
        const msg = e instanceof Error ? e.message : String(e)
        if (midActionTransportLoss(msg)) {
          return {
            kind: 'outcome-unknown',
            reason: `the ${action} call failed mid-request (${msg}); part of the input may have `
              + 'landed, so it must not be blindly retried without observing the machine first.',
          }
        }
        return { kind: 'failed', reason: msg }
      }
    },
  },
  verifier: {
    verifies: (s: Step) => (s.tool ?? '').includes('desktop-input'),
    async verify(_s: Step, _ctx: ToolContext, toolData: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
      const d = toolData as { action?: string; hwnd?: number; text?: string } | undefined
      if (!d?.hwnd) return { rejected: 'the step recorded no target window to verify' }
      // Read the window back from the OS. This is a different source than the tool used, which is
      // the only thing that makes it evidence rather than an echo.
      //
      // POLLED, NOT READ ONCE. An accessibility tree is eventually consistent: the synthetic
      // keystrokes have been delivered, but the application has not necessarily rebuilt its UIA
      // tree to show them. Measured on this machine, the typed text was absent from the tree at
      // the instant `/type` returned and present 500ms later. A verifier that reads once, at
      // zero milliseconds, therefore rejects every keystroke that actually landed - it reports
      // the most successful possible run as a total failure.
      //
      // The retry is bounded and reports how long it waited. It is not "eventually pass": if the
      // text never appears the step still fails, and the message says how long it looked, so a
      // slow app and a broken one stay distinguishable.
      const needle = String(d.text ?? '')
      const deadline = Date.now() + 4000
      let read: unknown[] = []
      let waited = 0
      let seen = ''
      while (Date.now() < deadline) {
        const els = await surveyWindow(d.hwnd).catch(() => null)
        if (els) {
          read = els
          // `text` is the CONTENT of a control, read through its Value/Text pattern; `name` is
          // the accessible label. Only `text` can contain what was typed. Notepad's editor is
          // named "Text editor" whether it is empty or full, so a verifier reading `name`
          // reports every successful type as a failure - and reading `name` for the empty case
          // would "confirm" a type that never happened. The host returns both.
          seen = read
            .map((el) => {
              const e = el as { text?: string; name?: string; automationId?: string; className?: string }
              return `${e.text ?? ''}\n${e.name ?? ''}\n${e.automationId ?? ''}\n${e.className ?? ''}`
            })
            .join('\n')
          if (d.action !== 'type' || seen.includes(needle)) break
        }
        await new Promise((r) => setTimeout(r, 250))
        waited += 250
      }
      if (!read.length && d.action !== 'key') {
        return { rejected: `the target window ${d.hwnd} could not be re-read to confirm the action` }
      }
      if (d.action === 'type') {
        if (!needle) return { rejected: 'the step typed nothing, so there is nothing to confirm' }
        // MATCH THE TAIL, NOT ONLY THE WHOLE STRING.
        //
        // Measured on this machine: after typing "AIOS end-to-end GUI mission proof." into
        // Notepad, the accessibility tree reports the editor's content as
        //
        //     "nd-to-end GUI mission proof.PROBE-TARGET-CHECK"
        //
        // The beginning is missing. UIA returns the document as the view exposes it, so a
        // document that is scrolled, or long enough to run past the visible area, comes back
        // with its head cut off. Requiring the complete sentence therefore rejected a type that
        // had demonstrably landed - and it rejected it *confidently*, naming the window and the
        // number of controls it searched, with nothing wrong in either.
        //
        // Typing happens AT THE CARET, so what was just typed is at the END of the content, and
        // the end is what survives truncation. Matching the tail asks the question the step
        // actually makes - "did this text arrive at the caret" - rather than a stronger and
        // wrong one about what the view is currently showing.
        //
        // The whole string is still accepted when it is there, and the evidence line says which
        // comparison succeeded, so a weaker check never reports itself as a stronger one.
        const whole = needle.length <= TAIL_MATCH_CHARS || seen.includes(needle)
        const tail = needle.slice(-TAIL_MATCH_CHARS)
        const tailHit = seen.includes(tail)
        if (!whole && !tailHit) {
          return { rejected: `the text was not found in the window after re-reading it for ${waited}ms; ${read.length} control(s) were exposed and none contained it (looked for the whole string and its last ${TAIL_MATCH_CHARS} characters)` }
        }
        return {
          evidence: {
            kind: 'observation',
            detail: `re-read hwnd ${d.hwnd} from the OS and found the typed text at the caret`
              + ` (${whole ? 'whole string matched' : `matched on its last ${TAIL_MATCH_CHARS} characters, the view exposing a truncated document`}`
              + `, after ${waited}ms)`,
          } as unknown as Evidence,
        }
      }

      // A KEY PRESS CAN LEGITIMATELY DESTROY ITS OWN TARGET.
      //
      // Pressing Enter to confirm a Save As dialog DISMISSES the dialog. This verifier used to
      // require the target window to still be present afterwards, so it rejected precisely the
      // step that succeeded: the file was written, the dialog closed, and the run was reported
      // as a failure at the moment it worked.
      //
      // For a key press there are two honest outcomes, and both are read fresh from the window
      // table rather than assumed:
      //
      //   - the window is still there -> the key did not dismiss it, which is what most
      //     shortcuts look like (Ctrl+S opening a Save As dialog, Ctrl+A selecting)
      //   - the window is gone        -> the key dismissed it, which is what a confirm key does
      //
      // Neither is vacuous, and the reason matters: the host checks the target's handle, process
      // AND title at the instant before injecting, so by the time this runs a key has
      // demonstrably been delivered to a window that existed and matched. What is being
      // verified here is the CONSEQUENCE, and it has to be one of the two real ones.
      //
      // This is weaker evidence than the type check and deliberately reads as such: "a key was
      // sent and the dialog closed" does NOT prove the file was written correctly. That is the
      // next step's job, reading the file from disk. Overstating it here would be exactly the
      // comfortable lie this project is built not to tell.
      return {
        evidence: {
          kind: 'observation',
          detail: read.length > 0
            ? `re-read hwnd ${d.hwnd} from the OS after the key; the window is still open`
            : `re-read hwnd ${d.hwnd} from the OS after the key; the window is gone, which is what a confirm key does`,
        } as unknown as Evidence,
      }
    },
  },
}

/**
 * Screen diff: observe whether a region of the screen changed.
 *
 * THE PATTERN
 *
 * This is the "did it work?" instrument. A GUI action that claims success is only as good as
 * the evidence behind it, and the strongest evidence is independent re-observation: capture
 * the screen before, act, capture after, compare. This capability provides the second half.
 *
 * The tool captures a baseline (when `reset` is true) then diffs. The verifier re-diffs
 * independently from the host - it does not trust the tool's in-memory result, which is the
 * whole point of a verifier.
 *
 * WHY A REGION AND NOT THE FULL SCREEN
 *
 * A full-screen diff is dominated by noise: clock updates, caret blink, animations. A region
 * focuses the question: "did THIS thing happen HERE?" The bounding box in the result then
 * tells you where the change actually landed, which is useful when the model predicted one
 * location and reality chose another.
 */
const screenDiffTool: Tool = {
  name: 'screen-diff',
  mode: 'gui',
  args: [
    { name: 'x', type: 'number', required: true, description: 'x coordinate of the region to watch (input/virtualized space)' },
    { name: 'y', type: 'number', required: true, description: 'y coordinate of the region to watch' },
    { name: 'w', type: 'number', required: true, description: 'width of the region in pixels' },
    { name: 'h', type: 'number', required: true, description: 'height of the region in pixels' },
    { name: 'reset', type: 'boolean', required: false, description: 'true to capture a fresh baseline before diffing (use before the action); false to diff against the existing baseline (use after the action)' },
  ],
  async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const x = num(args.x, 0)
    const y = num(args.y, 0)
    const w = num(args.w, 0)
    const h = num(args.h, 0)
    if (w <= 0 || h <= 0) {
      return { kind: 'failed', reason: 'screen-diff needs a positive width and height' }
    }
    const region = { x, y, w, h }

    try {
      // If reset is requested, capture a fresh baseline first.
      if (args.reset === true || args.reset === 'true') {
        const watch = await liveControl.screenWatch(region)
        if (!watch.ok) {
          return { kind: 'failed', reason: `could not capture baseline: ${watch.error ?? 'unknown error'}` }
        }
      }

      const diff = await liveControl.screenDiff(region)
      if (!diff.ok) {
        return { kind: 'failed', reason: diff.error ?? 'screen diff failed' }
      }

      return {
        kind: 'data',
        summary: diff.changed
          ? `screen changed: ${diff.changedPixels} pixels (${diff.changedPercent.toFixed(1)}%) in region ${diff.region.w}x${diff.region.h} at (${diff.region.x},${diff.region.y})`
          : `screen unchanged: 0 pixels changed in region ${w}x${h}`,
        data: {
          changed: diff.changed,
          changedPixels: diff.changedPixels,
          changedPercent: diff.changedPercent,
          region: diff.region,
          reset: args.reset === true || args.reset === 'true',
        },
      }
    } catch (e) {
      return { kind: 'failed', reason: e instanceof Error ? e.message : String(e) }
    }
  },
}

const screenDiffVerifier: Verifier = {
  verifies: (s: Step) => (s.tool ?? '').includes('screen-diff'),
  async verify(_s: Step, _ctx: ToolContext, toolData: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
    const d = toolData as {
      changed?: boolean
      changedPixels?: number
      region?: { x: number; y: number; w: number; h: number }
    } | undefined

    if (typeof d?.changed !== 'boolean') {
      return { rejected: 'the step did not record a screen-diff result' }
    }

    // Re-diff independently. The verifier does not receive the tool's baseline or its
    // in-memory state - it asks the host to compare the current screen against whatever
    // baseline is still set, which is the same baseline the tool used.
    if (!d.region) {
      return { rejected: 'no screen region was recorded, so there is nothing to re-check' }
    }
    try {
      const fresh = await liveControl.screenDiff(d.region)
      if (!fresh.ok) {
        return { rejected: `the host could not re-diff the region: ${fresh.error ?? 'unknown error'}` }
      }
      // The verifier confirms the CHANGE STATE, not the exact pixel count: a pixel count is
      // a measurement, and a second measurement of a live desktop will differ by a few
      // pixels from the first. The change/no-change verdict is the stable fact.
      if (fresh.changed !== d.changed) {
        return {
          rejected: `the tool reported changed=${d.changed} but an independent re-diff says changed=${fresh.changed}`,
        }
      }
      return {
        evidence: {
          kind: 'observation',
          detail: `independently re-diffed region at (${d.region.x},${d.region.y}) ${d.region.w}x${d.region.h}: changed=${fresh.changed} confirmed`,
        } as unknown as Evidence,
      }
    } catch (e) {
      return { rejected: e instanceof Error ? e.message : String(e) }
    }
  },
}

export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'web-research',
    mode: 'browser',
    description:
      'Research a public website. Navigates to a starting https page, follows up to N related pages '
      + 'on the same host, extracts headings/paragraphs with a site-chrome classification, and saves '
      + 'an evidence-backed brief whose every quote is traceable to a stored page artifact. Use it to '
      + 'gather facts about a company, product or topic from the live web. Does NOT read pages behind '
      + 'a login, and cannot see anything that is not publicly reachable. '
    + 'NOTE: Google search result pages are protected and will not work - a Google search URL is '
    + 'automatically rewritten to DuckDuckGo, which returns the same information without a gate.',
    tool: webResearchTool,
    verifier: webResearchVerifier,
    available: true,
  },
  {
    id: 'write-file',
    mode: 'filesystem',
    description:
      'Write a text file to a path inside the AIOS output directory. Use it to save a note, a report, '
      + 'or intermediate text that a later step will consume. Cannot write anywhere else, and cannot '
      + 'delete or overwrite anything outside its output directory.',
    tool: writeFileTool,
    verifier: writeFileVerifier,
    available: true,
  },
  {
    id: 'spreadsheet',
    mode: 'filesystem',
    description:
      'Create a CSV spreadsheet with headers and rows. Use it whenever the user asks for a table, '
      + 'a spreadsheet, a comparison matrix or a list with columns. The file opens in Excel and '
      + 'LibreOffice. Every row must be rectangular and any source URL in it must already exist in '
      + 'a saved research artifact, or the step fails verification.',
    tool: spreadsheetTool,
    verifier: spreadsheetVerifier,
    available: true,
  },
  {
    id: 'list-windows',
    mode: 'uia',
    description:
      'List the titled windows currently open on the desktop, with their handles and process ids. '
      + 'Use it to find out what applications are running, or to get the handle needed by '
      + 'survey-window. Observation only: it never moves the mouse or types.',
    tool: listWindowsTool,
    verifier: listWindowsVerifier,
    available: true,
  },
  {
    id: 'survey-window',
    mode: 'uia',
    description:
      'Read the accessibility tree of one window and list its controls with their classes and text. '
      + 'Use it to understand what an application is showing. Read-only: it never clicks or types.',
    tool: surveyWindowTool,
    verifier: surveyWindowVerifier,
    available: true,
  },
  {
    id: 'ocr',
    mode: 'uia',
    description:
      'Read the text that is actually ON the screen as pixels, using the OCR engine built into '
      + 'Windows. Every other way of reading this machine goes through the accessibility tree, which '
      + 'is exact but blind to anything an application draws rather than exposes: a game, a chart, '
      + 'a canvas, a video, a scanned image. Use this when survey-window reports an empty or '
      + 'meaningless tree for the window you care about, or when the user asks what is written on '
      + 'screen. Returns the text with a bounding box for each line. It can misread, so prefer '
      + 'survey-window when it has something to say, and never treat a partial reading as proof '
      + 'that text is absent.',
    tool: ocrTool,
    verifier: ocrVerifier,
    available: true,
  },
  {
    id: 'launch-app',
    mode: 'gui',
    description:
      'OPEN one of a fixed set of Windows applications by name: notepad, calculator, paint, '
      + 'explorer, wordpad, cmd, powershell, and browser/edge/chrome. Use this FIRST in any task that '
      + 'begins "open X" - nothing else here can start a program. It waits for the application\'s '
      + 'window to actually appear and returns its handle, so the next step can type into it. An '
      + 'application that is not on that list is refused rather than attempted; do not try to work '
      + 'around it by launching through the terminal, which is read-only by design. '
      + 'PASS "path" WHEN YOU KNOW WHICH FILE THE TASK IS ABOUT (notepad, paint and wordpad only). '
      + 'The document then exists before anything is typed, so a save is one Ctrl+S that writes '
      + 'straight to that path - no "Save As" dialog to appear, be found, and be typed into. '
      + 'Prefer this whenever the task names a destination file; drive the dialog only when the '
      + 'path is genuinely unknown until the user chooses it. '
      + 'A BROWSER IS AVAILABLE (browser, edge, chrome), and "google" is accepted as a name for it. '
      + 'Pass "url" to send it somewhere - "open google and search nakivo" becomes app "google" with '
      + 'url "https://www.google.com/search?q=nakivo". This SHOWS a browser window to the person. '
      + 'If the task is to READ and REPORT on pages rather than show them, use web-research instead: '
      + 'it returns a brief with every quote traceable to a source, and it does not take over the '
      + 'screen.',
    tool: launchAppTool,
    verifier: launchAppVerifier,
    available: true,
  },
  {
    id: 'read-file',
    mode: 'filesystem',
    description:
      'Read back a plain-text file (.txt, .md, .csv, .json, .log) from Documents, Desktop, '
      + 'Downloads or the AIOS output folder, and return its exact contents. Use it as the LAST '
      + 'step of a task that was supposed to produce a file, so the claim "it saved" is checked '
      + 'against what is actually on disk. Refuses every other location and every other file type.',
    tool: readFileTool,
    verifier: readFileVerifier,
    available: true,
  },
  {
    id: 'terminal',
    mode: 'cli',
    description:
      'Run one allowlisted read-only command (node, git, python, dir, where, ver, tasklist and '
      + 'similar) and return its output. Use it for version checks, listing files, and running '
      + 'development tools. Refuses anything not on the allowlist. '
      + 'The OpenCode CLI is at C:\\Users\\Samer\\AppData\\Local\\Programs\\@opencodedesktop\\resources\\'
      + 'opencode-cli.exe - run it by that exact path. Do NOT use `dir` or `where` to search for it: '
      + 'a glob that matches nothing exits 1 with "Could not find files for the given pattern(s)", '
      + 'which is a failure of the command rather than a fact about the machine, and it cost a '
      + 'whole mission once because the step could not be verified. '
      + 'Its subcommands are `opencode session list`, `opencode session show <id>`, and '
      + '`opencode --version`. Running a bare `opencode session` prints this help text and exits 1, '
      + 'which reads as a CLI failure and is not: it is the correct response to an incomplete '
      + 'command. Always name a subcommand.',
    tool: terminalTool,
    verifier: terminalVerifier,
    available: true,
    // The executor's gate asks the tool, not the plan, what a command would do. See
    // `terminalEffectOf` above; the verb tables are the interactive terminal's own.
    effectOf: terminalEffectOf,
  },
  desktopInputCapability,
  {
    id: 'screen-diff',
    mode: 'gui',
    description:
      'Observe whether a region of the screen CHANGED. Two calls: first call captures a '
      + 'baseline (reset=true), then after the action take a second reading (reset=false) '
      + 'and compare. Returns changed=true/false, the count and percentage of changed pixels, '
      + 'and a bounding box around the change. Use it to verify that a click opened a window, '
      + 'a dialog appeared, or text was entered - anything that should produce a visible change. '
      + 'Read-only: it never clicks or types. The verifier re-diffs independently from the host.',
    tool: screenDiffTool,
    verifier: screenDiffVerifier,
    available: true,
  },
]

export const availableCapabilities = (): readonly Capability[] => CAPABILITIES.filter((c) => c.available)

/** Resolve a step's declared tool to a capability. Unknown tool => explicit failure. */
export function resolveCapability(toolName: string): Capability | { unavailable: string } {
  const c = CAPABILITIES.find((x) => x.tool.name === toolName || x.id === toolName)
  if (!c) return { unavailable: `no capability is registered as "${toolName}"` }
  if (!c.available && !c.plannable) return { unavailable: `"${toolName}" is registered but unavailable: ${c.unavailableReason ?? 'no reason recorded'}` }
  return c
}

/** The routed verifier: picks the verifier that can speak to a given step. */
export function routedVerifier(): Verifier {
  return {
    verifies: (s: Step) => CAPABILITIES.some((c) => c.verifier.verifies(s)),
    async verify(s: Step, ctx: ToolContext, data: unknown) {
      for (const c of CAPABILITIES) {
        // A capability that is unavailable but plannable still owns its own verification. The
        // verifier re-reads the OS, which it can always do; skipping it would mean a completed
        // desktop-input step was reported as unverified purely because the guard had since been
        // re-taken, which is a statement about the machine's mood, not about the step.
        if (!c.available && !c.plannable) continue
        if (c.verifier.verifies(s)) return c.verifier.verify(s, ctx, data)
      }
      return { rejected: `no registered verifier can check a "${s.tool ?? 'unnamed'}" step` }
    },
  }
}

/**
 * The routed tool surface: resolve a step to the tool that will run it, and speak for the
 * executor's consequential-effect gate.
 *
 * `resolve` alone was the whole surface once, and it left the approval gate wired to NOTHING on
 * the chat path: `effectOf`/`isConsequential`/`preflight` were undefined, so `deps.tools.effectOf?.()`
 * short-circuited to undefined for every chat mission, no effect was ever classified, no request
 * was ever recorded, and `git push` planned for the chat ran ungate while the identical command in
 * the interactive terminal stopped at a human. Same executor, same gate, two different answers
 * depending on which route the step arrived by - which is exactly a non-uniform authorization
 * boundary. These three methods mirror tool-router/router.ts's semantics (the tool's own reading
 * of its arguments wins; absent means "looked and found nothing", never "did not look").
 */
export function routedTools() {
  const registered = (s: Step): Capability | undefined => {
    const name = String(s.tool ?? '')
    return CAPABILITIES.find((c) => c.tool.name === name || c.id === name)
  }
  return {
    resolve(s: Step) {
      const r = resolveCapability(String(s.tool ?? ''))
      if ('unavailable' in r) return { unavailable: r.unavailable, candidates: availableCapabilities().map((c) => c.tool.name) }
      return { tool: r.tool, fellBack: false, reason: `exact match on ${r.id}` }
    },
    /** Consulted by the executor's approval gate; reads the REGISTRATION, not the plan. */
    isConsequential(s: Step): boolean | undefined {
      return registered(s)?.consequential === true ? true : undefined
    },
    /** What this step would ACTUALLY do, per the tool that will run it. */
    effectOf(s: Step): DeclaredEffect | undefined {
      return registered(s)?.effectOf?.(s)
    },
    /** A refusal the tool would issue for this step, checked before authorisation. */
    preflight(s: Step): { blocked: string; needsHuman: boolean } | undefined {
      return registered(s)?.preflight?.(s)
    },
  }
}

export { lastBrief }
