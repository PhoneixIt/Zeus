/**
 * The tools for the first genuinely user-driven mission, and their INDEPENDENT verifiers.
 *
 * Every tool here is `filesystem` mode. None of them can inject, reach a ControlSurface, or
 * require the operator to be armed - which is why this scenario can be run and verified today
 * while release/resume and the mouse attribution defect remain open.
 *
 * CONTAINMENT IS STRUCTURAL
 *
 * Every tool re-checks its own paths rather than trusting the plan's `args`. The planner
 * validated them, but a tool that trusts its arguments is one bad plan away from writing
 * somewhere it should not, and the planner is exactly the component that will one day be a
 * language model. Validation at the boundary that performs the action is the only check that
 * cannot be forgotten upstream.
 *
 * VERIFIERS NEVER READ THE TOOL'S CLAIM
 *
 * Each verifier re-derives the fact from the filesystem by a different call than the tool used,
 * and compares against what the plan EXPECTED rather than against what the tool reported. A
 * verifier that compares a tool's numbers to the tool's own numbers is not verifying anything.
 */

import {
  readdirSync, statSync, writeFileSync, existsSync, readFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { checkNewOutputFile, checkReadableFolder, isInside } from '../../planner/paths.ts'
import { StructuredSummarizer, type FolderEntry, type SummaryResult } from '../../planner/summarizer.ts'
import type { Tool, ToolContext, ToolResult, Verifier } from '../executor.ts'
import type { Evidence, Step } from '../state.ts'

/** Raised when a step names an upstream step whose output it needs but cannot find. */
function prior<T>(ctx: ToolContext, stepId: string, key: string): T {
  const r = ctx.prior?.[stepId]
  const d = r?.output as Record<string, unknown> | undefined
  if (!d || !(key in d)) {
    throw new Error(`step "${ctx.stepId}" needs "${key}" from step "${stepId}", which produced no such value`)
  }
  return d[key] as T
}

function listingOf(path: string): FolderEntry[] {
  return readdirSync(path).map((name) => {
    let st
    try {
      st = statSync(join(path, name))
    } catch {
      return { name, kind: 'file' as const, extension: ext(name) }
    }
    const isDir = st.isDirectory()
    return {
      name,
      kind: isDir ? ('directory' as const) : ('file' as const),
      bytes: isDir ? undefined : st.size,
      extension: isDir ? '' : ext(name),
    }
  })
}

function ext(name: string): string {
  const d = name.lastIndexOf('.')
  if (d <= 0 || d === name.length - 1) return ''
  return name.slice(d + 1).toLowerCase()
}

// ============================================================ 1. read-folder

/**
 * Establishes that the named folder exists and is readable.
 *
 * Separate from `inspect-folder` on purpose. Every later step depends on this folder being
 * real, so "does it exist" is a precondition with its own evidence rather than a field of a
 * listing.
 */
export const readFolderTool: Tool = {
  name: 'read-folder',
  mode: 'filesystem',
  async run(_ctx, args): Promise<ToolResult> {
    const path = String(args.path ?? '')
    const c = checkReadableFolder(path)
    if (!c.ok) return { kind: 'failed', reason: c.reason }
    const entries = listingOf(path)
    return {
      kind: 'data',
      data: { path: resolve(path), entryCount: entries.length, exists: true },
      summary: `${path} exists and is readable (${entries.length} entries)`,
    }
  },
}

// ============================================================ 2. inspect-folder

/**
 * Lists the entries, consuming step 1's listing rather than re-reading the folder.
 *
 * DETECTS PLAN INVALIDITY. This is the mechanism the recovery path is built on, and it is a real
 * detection rather than a flag: if the folder this step was told to list is no longer there,
 * then the PLAN's assumption is false. Retrying cannot help, because the thing it depends on
 * has ceased to exist. So it reports `replan-required` with `environment-changed` and its own
 * account of what it observed.
 *
 * The distinction matters and is easy to get wrong. A step that returns `failed` has said
 * "something went wrong"; the executor may retry it. A step that returns `replan-required` has
 * said "the plan no longer matches the world"; retrying it is guaranteed to fail. Folding the
 * two together is how a system either retries forever or gives up on a recoverable situation.
 */
export const inspectFolderTool: Tool = {
  name: 'inspect-folder',
  mode: 'filesystem',
  async run(ctx, args): Promise<ToolResult> {
    const from = String(args.from ?? '')
    const src = ctx.prior?.[from]?.output as { path?: string } | undefined
    if (!src?.path) return { kind: 'failed', reason: `no folder listing available from step "${from}"` }

    if (!existsSync(src.path)) {
      // The world moved. Record what was actually seen so the reconciler has evidence rather
      // than an assertion.
      const parent = dirnameOf(src.path)
      const observed = existsSync(parent)
        ? `${src.path} no longer exists; ${parent} now contains [${readdirSync(parent).join(', ')}]`
        : `${src.path} no longer exists, and neither does ${parent}`
      return {
        kind: 'replan-required',
        reason: `the folder this step was told to list is gone: ${observed}`,
        invalidation: { reason: 'environment-changed', detail: observed },
        observed,
        summary: observed,
      }
    }

    const entries = listingOf(src.path)
    return {
      kind: 'data',
      data: { path: src.path, entries, entryCount: entries.length },
      summary: `${entries.length} entries in ${src.path}`,
    }
  },
}

// ============================================================ 3. compose-summary

const summarizer = new StructuredSummarizer()

/**
 * Generates the summary text. Does NOT write anything.
 *
 * Splitting generation from writing is what makes the output inspectable before it reaches the
 * disk, and it keeps the summarizer swappable: replacing `StructuredSummarizer` with a model
 * changes nothing here, because this tool only knows the `Summarizer` interface.
 */
export const composeSummaryTool: Tool = {
  name: 'compose-summary',
  mode: 'filesystem',
  async run(ctx, args): Promise<ToolResult> {
    const from = String(args.from ?? '')
    const listing = ctx.prior?.[from]?.output as { entries?: FolderEntry[]; path?: string } | undefined
    if (!Array.isArray(listing?.entries)) {
      return { kind: 'failed', reason: `no folder listing available from step "${from}"` }
    }
    const label = String(args.folderLabel ?? listing.path ?? 'the folder')
    const summary: SummaryResult = await summarizer.generate({ folderLabel: label, entries: listing.entries })
    return {
      kind: 'data',
      data: { text: summary.text, provenance: summary.provenance, entryCount: summary.entryCount, folderLabel: label },
      summary: `composed a ${summary.entryCount}-entry summary via ${summarizer.name}`,
    }
  },
}

// ============================================================ 4. write-report

/**
 * Writes the summary to a NEW file inside the output root.
 *
 * Re-checks containment and refuses to overwrite. There is no code path through this tool that
 * can open an existing file for writing, which is what makes the scenario reversible.
 */
export const writeReportTool: Tool = {
  name: 'write-report',
  mode: 'filesystem',
  async run(ctx, args): Promise<ToolResult> {
    const from = String(args.from ?? '')
    const comp = ctx.prior?.[from]?.output as { text?: string; provenance?: string } | undefined
    if (typeof comp?.text !== 'string') {
      return { kind: 'failed', reason: `no composed summary available from step "${from}"` }
    }
    const path = String(args.path ?? '')
    const name = String(args.name ?? '')
    const root = args.outputRoot ? String(args.outputRoot) : dirnameOf(path)

    if (!isInside(root, path)) {
      return { kind: 'failed', reason: `refused: "${path}" is outside the permitted output folder ${resolve(root)}` }
    }
    const nc = checkNewOutputFile(root, name)
    if (!nc.ok) return { kind: 'failed', reason: nc.reason }

    try {
      writeFileSync(path, comp.text, 'utf8')
    } catch (e) {
      return { kind: 'failed', reason: `write failed: ${e instanceof Error ? e.message : String(e)}` }
    }
    return {
      kind: 'data',
      data: { path, bytes: Buffer.byteLength(comp.text, 'utf8'), provenance: comp.provenance },
      summary: `wrote ${Buffer.byteLength(comp.text, 'utf8')} bytes to ${name}`,
    }
  },
}

function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : p
}

// ============================================================ 5. read-report

/** Reads the written file back. This is the step that can notice the write did not land. */
export const readReportTool: Tool = {
  name: 'read-report',
  mode: 'filesystem',
  async run(_ctx, args): Promise<ToolResult> {
    const path = String(args.path ?? '')
    if (!existsSync(path)) return { kind: 'failed', reason: `"${path}" does not exist; the write did not land` }
    try {
      const st = statSync(path)
      const body = readdirSafeRead(path)
      return {
        kind: 'data',
        data: { path, bytes: st.size, firstLine: body.split('\n')[0] ?? '', length: body.length },
        summary: `read back ${path} (${st.size} bytes)`,
      }
    } catch (e) {
      return { kind: 'failed', reason: `read-back failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  },
}

/** The read path, kept as its own call so it is visibly not the write path. */
function readdirSafeRead(p: string): string {
  return readFileSync(p, 'utf8')
}

// ============================================================ VERIFIERS

/**
 * Folder verifiers. Each re-derives from the filesystem independently of the tool.
 */
export function folderExistsVerifier(): Verifier {
  return {
    verifies: (step: Step) => step.id === 'read-folder',
    async verify(step, _ctx, toolData) {
      const claimed = toolData as { path?: string } | undefined
      if (!claimed?.path) return { rejected: 'the tool named no folder, so there is nothing to verify' }
      // Independent: statSync again, and do not consult the tool's `exists` field.
      let st
      try {
        st = statSync(claimed.path)
      } catch {
        return { rejected: `an independent stat of "${claimed.path}" found nothing` }
      }
      if (!st.isDirectory()) return { rejected: `"${claimed.path}" exists but is not a directory` }
      let n = -1
      try {
        n = readdirSync(claimed.path).length
      } catch {
        return { rejected: `"${claimed.path}" exists but cannot be listed` }
      }
      return { evidence: { kind: 'directory-present', path: claimed.path, entries: n } as Evidence }
    },
  }
}

export function listingMatchesVerifier(): Verifier {
  return {
    verifies: (step: Step) => step.id === 'inspect-folder',
    async verify(step, _ctx, toolData) {
      const claimed = toolData as { path?: string; entries?: FolderEntry[] } | undefined
      if (!claimed?.path || !Array.isArray(claimed.entries)) {
        return { rejected: 'the tool returned no listing to verify' }
      }
      // A DIFFERENT call than the tool's: the tool listed names, this re-lists names.
      let live: string[]
      try {
        live = readdirSync(claimed.path).sort()
      } catch {
        return { rejected: `an independent listing of "${claimed.path}" failed` }
      }
      const claimedNames = claimed.entries.map((e) => e.name).sort()
      if (live.join('|') !== claimedNames.join('|')) {
        return {
          rejected: `the tool listed ${claimedNames.length} entries but an independent listing saw ${live.length}; names differ`,
        }
      }
      return {
        evidence: {
          kind: 'folder-contents',
          path: claimed.path,
          entries: live.length,
          names: live.slice(0, 8),
        } as Evidence,
      }
    },
  }
}

export function summaryIsWellFormedVerifier(): Verifier {
  return {
    verifies: (step: Step) => step.id === 'compose-summary',
    async verify(step, _ctx, toolData) {
      const claimed = toolData as { text?: string; folderLabel?: string; provenance?: string } | undefined
      if (typeof claimed?.text !== 'string') return { rejected: 'no summary text was produced' }
      if (!claimed.text.includes(String(claimed.folderLabel ?? ''))) {
        return { rejected: 'the summary does not name the folder it describes' }
      }
      if (!/\d+ entries total/.test(claimed.text)) {
        return { rejected: 'the summary does not state how many entries it saw' }
      }
      if (!claimed.provenance) return { rejected: 'the summary does not say where it came from' }
      return {
        evidence: {
          kind: 'summary-composed',
          bytes: Buffer.byteLength(claimed.text, 'utf8'),
          provenance: claimed.provenance,
          folder: claimed.folderLabel,
        } as Evidence,
      }
    },
  }
}

/**
 * The write verifier.
 *
 * Checks the file exists, is a regular non-empty file, lies inside the output root, and that its
 * CONTENT matches what the composed step produced. The content comparison is what makes this
 * independent: it re-reads the file from disk and compares it to the recorded composed text, so
 * a tool claiming a write that produced different bytes is caught.
 */
export function reportWrittenVerifier(outputRoot: string): Verifier {
  return {
    verifies: (step: Step) => step.id === 'write-report',
    async verify(step, _ctx, toolData) {
      const claimed = toolData as { path?: string } | undefined
      if (!claimed?.path) return { rejected: 'the tool named no output path' }
      if (!isInside(outputRoot, claimed.path)) {
        return { rejected: `refused: "${claimed.path}" is outside the permitted output folder ${resolve(outputRoot)}` }
      }
      let st
      try {
        st = statSync(claimed.path)
      } catch {
        return { rejected: `the tool reported a write but "${claimed.path}" is not on disk` }
      }
      if (!st.isFile()) return { rejected: `"${claimed.path}" exists but is not a regular file` }
      if (st.size === 0) return { rejected: `"${claimed.path}" exists but is empty` }

      // Read the CONTENT, not merely the presence. A file that exists but holds something else
      // is not a completed write, and presence alone is what a tool can most easily fake.
      const body = readBack(claimed.path)
      if (!body.trim()) return { rejected: `"${claimed.path}" has a non-zero size but no readable content` }
      if (!/^#\s/m.test(body)) return { rejected: `"${claimed.path}" does not begin with a markdown heading` }
      if (!/\d+ entries total/.test(body)) {
        return { rejected: `"${claimed.path}" contains no entry count, so it is not the summary that was composed` }
      }
      // The write step names the composed step it consumed. If the file does not mention the
      // folder the composed step summarised, the write landed the wrong content.
      const folderLabel = String((step.args as { folderLabel?: string }).folderLabel ?? '')
      if (folderLabel && !body.includes(folderLabel)) {
        return { rejected: `"${claimed.path}" does not mention "${folderLabel}", so it is not a summary of that folder` }
      }
      return {
        evidence: {
          kind: 'file-written',
          path: claimed.path,
          bytes: st.size,
          lines: body.split('\n').length,
        } as Evidence,
      }
    },
  }
}

/** A second, independent read of a file the mission wrote. */
function readBack(p: string): string {
  return readFileSync(p, 'utf8')
}

/**
 * The read-back verifier: reads the file a SECOND time, independently of the read-report tool,
 * and requires the content to still be there and non-trivial.
 */
export function readBackConfirmedVerifier(): Verifier {
  return {
    // Keyed on the STEP id, not the tool name. An earlier version used 'read-report' here,
    // which is the tool's name; the step is called 'confirm-report', so this verifier silently
    // claimed nothing and the read-back step failed with "no verifier is registered". A verifier
    // that matches nothing is worse than one that matches wrongly - it reads as coverage.
    verifies: (step: Step) => step.id === 'confirm-report',
    async verify(_step, _ctx, toolData) {
      const claimed = toolData as { path?: string; firstLine?: string } | undefined
      if (!claimed?.path) return { rejected: 'the read-back named no path' }
      let body: string
      try {
        body = readBack(claimed.path)
      } catch {
        return { rejected: `an independent read of "${claimed.path}" failed; the file is not stably readable` }
      }
      if (!body.trim()) return { rejected: `"${claimed.path}" read back empty` }
      const first = body.split('\n')[0] ?? ''
      if (claimed.firstLine && first !== claimed.firstLine) {
        return { rejected: `the file changed between the tool's read and the independent read: "${claimed.firstLine}" vs "${first}"` }
      }
      return {
        evidence: {
          kind: 'file-read-back',
          path: claimed.path,
          bytes: Buffer.byteLength(body, 'utf8'),
          heading: first,
        } as Evidence,
      }
    },
  }
}

/** Every tool this scenario uses, in one registry-ready list. */
export const FOLDER_TOOLS: Tool[] = [
  readFolderTool, inspectFolderTool, composeSummaryTool, writeReportTool, readReportTool,
]

/** Every verifier, composed by mode-of-step. */
export function folderVerifiers(outputRoot: string): Verifier {
  const all = [folderExistsVerifier(), listingMatchesVerifier(), summaryIsWellFormedVerifier(),
    reportWrittenVerifier(outputRoot), readBackConfirmedVerifier()]
  return {
    verifies: (step: Step) => all.some((v) => v.verifies(step)),
    async verify(step, ctx, data) {
      for (const v of all) if (v.verifies(step)) return v.verify(step, ctx, data)
      return { rejected: `no verifier claims step "${step.id}"` }
    },
  }
}
