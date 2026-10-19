/**
 * FILE-CONTENT TOOLS - reading an EXISTING file and summarising what is actually in it.
 *
 * =============================================================================
 * WHY THIS EXISTS, AND WHY IT IS NOT A DUPLICATE OF folder-tools.ts
 * =============================================================================
 *
 * The existing `filesystem.transform` capability is fulfilled by `composeSummaryTool`, which hands
 * `StructuredSummarizer` a FOLDER LISTING (`FolderEntry[]`). The summariser's own documentation says
 * it "counts entries, groups them by extension, and formats them… it does not understand the files,
 * does not infer meaning". That is a summary of a DIRECTORY. It cannot summarise a file.
 *
 * And nothing read an arbitrary existing file: `read-report` is scoped to files the mission itself
 * wrote, and `filesystem-mode.ts` has `write-probe-file` but no reader at all.
 *
 * So this fills a real gap rather than repeating an existing one.
 *
 * =============================================================================
 * WHAT "SUMMARISE" MEANS HERE - STATED PLAINLY, BECAUSE IT MATTERS
 * =============================================================================
 *
 * This is a DETERMINISTIC content summary, not a semantic one. With no language model in the loop it
 * cannot say what a file MEANS, and it does not pretend to. It reports what can be measured:
 *
 *   - the first heading, if the file has one
 *   - line, word and character counts
 *   - the most frequent significant tokens
 *
 * Every one of those is re-derivable from the file by anyone who disagrees. The `provenance` field
 * in the emitted summary says exactly this, so the summary cannot be read as an interpretation:
 *
 *   "deterministic counts over the file's actual bytes; no model read this file"
 */

import { readFileSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'

import type { Tool, ToolContext, ToolResult, Verifier } from '../executor.ts'
import { sha256 } from './folder-tools.ts'
import type { Evidence, Step } from '../state.ts'

/** Refuse anything that is not plainly a readable text file. */
const TEXT_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'mjs', 'cjs', 'md', 'txt', 'json', 'yml', 'yaml', 'py', 'csv', 'log'])

/** Bound the work. A summary of a 400 MB file is not a summary. */
export const MAX_INPUT_BYTES = 512 * 1024

export interface FileFacts {
  readonly path: string
  readonly bytes: number
  readonly lines: number
  readonly words: number
  readonly characters: number
  readonly heading: string
  readonly topTerms: ReadonlyArray<{ term: string; count: number }>
  readonly truncated: boolean
}

function isInside(root: string, candidate: string): boolean {
  const r = resolve(root)
  const c = resolve(candidate)
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep)
}

/** Measure the file. Separated so the verifier can call it WITHOUT the tool's data. */
export function measureFile(absPath: string): { facts: FileFacts; text: string } | { error: string } {
  if (!existsSync(absPath)) return { error: `no file at "${absPath}"` }
  let st
  try { st = statSync(absPath) } catch (e) { return { error: `cannot stat "${absPath}": ${String(e)}` } }
  if (st.isDirectory()) return { error: `"${absPath}" is a directory, not a file` }
  const bytes = st.size
  const truncated = bytes > MAX_INPUT_BYTES
  const text = readFileSync(absPath, 'utf8')
  const lines = text.length ? text.split('\n').length : 0
  const words = text.split(/\s+/).filter((w) => w.length > 0).length

  const headingMatch = /^\s*#\s+(.+)$/m.exec(text)
  const heading = headingMatch ? headingMatch[1].trim().slice(0, 80) : ''

  // Frequency over identifiers and words alike. Stopwords are dropped because "the the the" is a
  // frequency table, not a summary of anything.
  const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'are', 'was', 'were', 'not', 'but', 'you', 'all', 'can', 'its', 'into', 'then', 'than', 'them', 'these', 'they', 'will', 'would', 'there', 'their', 'what', 'about', 'which', 'when', 'where', 'been', 'also', 'only', 'other', 'some', 'such', 'each', 'any'])
  const counts = new Map<string, number>()
  for (const tok of text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []) {
    if (STOP.has(tok)) continue
    counts.set(tok, (counts.get(tok) ?? 0) + 1)
  }
  const topTerms = [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([term, count]) => ({ term, count }))

  return {
    text,
    facts: { path: absPath, bytes, lines, words, characters: text.length, heading, topTerms, truncated },
  }
}

/** Renders the summary text. Shared so the writer and the verifier cannot drift. */
export function renderSummary(label: string, f: FileFacts): string {
  return [
    `# Summary of ${label}`,
    '',
    `- file: ${f.path}`,
    `- heading: ${f.heading || '(none found)'}`,
    `- lines: ${f.lines}`,
    `- words: ${f.words}`,
    `- characters: ${f.characters}`,
    `- bytes: ${f.bytes}${f.truncated ? '  (READ TRUNCATED - counts cover only the first ' + MAX_INPUT_BYTES + ' bytes)' : ''}`,
    `- most frequent terms: ${f.topTerms.map((t) => `${t.term} (${t.count})`).join(', ') || '(none)'}`,
    '',
    'Provenance: deterministic counts over the file\'s actual bytes. No model read this file and',
    'no meaning was inferred. Every number above is re-derivable from the file itself.',
    '',
  ].join('\n')
}

/**
 * Step 1: read the input file.
 *
 * The path is re-checked HERE, not trusted from the plan. A tool that trusts its arguments is one
 * bad plan away from reading somewhere it should not - and the planner is exactly the component that
 * will one day be a language model.
 */
export const readInputFileTool: Tool = {
  name: 'read-input-file',
  mode: 'filesystem',
  async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const requested = String(args.path ?? '')
    if (!requested) return { kind: 'failed', reason: 'no path given' }
    if (!isAbsolute(requested)) return { kind: 'failed', reason: `refusing a relative path: "${requested}"` }

    const root = String(args.workspaceRoot ?? '')
    if (root && !isInside(root, requested)) {
      return { kind: 'failed', reason: `"${requested}" is outside the workspace root ${root}` }
    }

    const ext = requested.includes('.') ? requested.split('.').pop()!.toLowerCase() : ''
    if (!TEXT_EXTENSIONS.has(ext)) {
      return { kind: 'failed', reason: `"${ext || requested}" is not a text type this summariser reads` }
    }

    const m = measureFile(requested)
    if ('error' in m) return { kind: 'failed', reason: m.error }
    return { kind: 'data', data: { path: requested, facts: m.facts }, summary: `read ${requested}` }
  },
}

/** Step 2: turn those facts into the summary text. */
export const summariseFileTool: Tool = {
  name: 'summarise-file',
  mode: 'filesystem',
  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const from = String(args.from ?? '')
    const src = ctx.prior?.[from]?.output as { path?: string; facts?: FileFacts } | undefined
    if (!src?.path || !src.facts) {
      return { kind: 'failed', reason: `no measured facts available from step "${from}"` }
    }
    const label = String(args.label ?? src.path)
    const text = renderSummary(label, src.facts)
    return { kind: 'data', data: { text, path: src.path, facts: src.facts }, summary: `summarised ${src.path}` }
  },
}

/** Writes the summary, refusing to overwrite so the scenario stays reversible. */
export const writeSummaryTool: Tool = {
  name: 'write-file-summary',
  mode: 'filesystem',
  async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const from = String(args.from ?? '')
    const text = (ctx.prior?.[from]?.output as { text?: string } | undefined)?.text
    const target = String(args.target ?? '')
    if (!text) return { kind: 'failed', reason: `no summary text available from step "${from}"` }
    if (!target) return { kind: 'failed', reason: 'no target given' }
    if (existsSync(target)) return { kind: 'failed', reason: `refusing to overwrite ${target}` }
    writeFileSync(target, text, 'utf8')
    return { kind: 'data', data: { target, text }, summary: `wrote ${target}` }
  },
}

/**
 * INDEPENDENT VERIFICATION.
 *
 * It re-measures the SOURCE file with its own call and re-reads the WRITTEN summary, then checks the
 * two agree. It never compares a number the tool produced to the same number the tool produced -
 * that would be checking arithmetic, not reality.
 */
export function fileSummaryVerifier(expectedPath: string): Verifier {
  return {
    // The ids the RECIPE emits. This list has to match them exactly: a step with no verifier cannot
    // complete, so a mismatch here does not fail loudly - it makes the mission unverifiable.
    verifies: (step: Step) =>
      step.id === 'read-input' || step.id === 'summarise-file' || step.id === 'write-summary',
    async verify(step, _ctx, toolData) {
      if (step.id === 'read-input') {
        const claimed = toolData as { path?: string; facts?: { lines: number; words: number } }
        if (!claimed?.path) return { rejected: 'the read named no path' }
        const again = measureFile(claimed.path)
        if ('error' in again) return { rejected: `an independent measure failed: ${again.error}` }
        if (!claimed.facts || again.facts.lines !== claimed.facts.lines || again.facts.words !== claimed.facts.words) {
          return { rejected: 'the measured facts do not match the file as it is now' }
        }
        return { evidence: { kind: 'file-measured', path: claimed.path, bytes: again.facts.bytes, heading: again.facts.heading } as unknown as Evidence }
      }
      if (step.id === 'summarise-file') {
        const facts = (toolData as { facts?: FileFacts }).facts
        if (!facts) return { rejected: 'the summarise step produced no facts' }
        // Re-measure from disk, independently.
        const again = measureFile(expectedPath)
        if ('error' in again) return { rejected: `an independent measure failed: ${again.error}` }
        if (again.facts.lines !== facts.lines || again.facts.words !== facts.words ||
            again.facts.bytes !== facts.bytes || again.facts.heading !== facts.heading) {
          return {
            rejected: `the summary does not match the file as it is NOW ` +
              `(file: ${again.facts.lines} lines/${again.facts.words} words, ` +
              `summary: ${facts.lines}/${facts.words}) - the file moved under the mission`,
          }
        }
        return { evidence: { kind: 'file-measured', path: expectedPath, bytes: again.facts.bytes, heading: again.facts.heading } as unknown as Evidence }
      }

      const claimed = toolData as { target?: string; text?: string } | undefined
      if (!claimed?.target) return { rejected: 'the write named no target' }
      if (!existsSync(claimed.target)) return { rejected: `an independent stat of "${claimed.target}" found nothing` }
      const onDisk = readFileSync(claimed.target, 'utf8')
      if (typeof claimed.text === 'string' && claimed.text !== onDisk) {
        return { rejected: 'the file on disk differs from what the writer reported writing' }
      }
      const again = measureFile(expectedPath)
      if ('error' in again) return { rejected: `an independent measure failed: ${again.error}` }
      // The summary must quote the CURRENT file's own numbers.
      for (const n of [String(again.facts.lines), String(again.facts.words), String(again.facts.bytes)]) {
        if (!onDisk.includes(`: ${n}`)) {
          return { rejected: `the written summary does not carry the file's current value ${n}` }
        }
      }
      if (!/no model read this file/i.test(onDisk)) {
        return { rejected: 'the summary does not disclose that no model read it' }
      }
      return { evidence: { kind: 'file-read-back', path: claimed.target, bytes: Buffer.byteLength(onDisk), heading: again.facts.heading, sha256: sha256(onDisk) } as unknown as Evidence }
    },
  }
}