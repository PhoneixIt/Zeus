/**
 * THE SUMMARY CAPABILITIES.
 *
 * Concrete implementations of the abstract capabilities a world-aware plan asks for. Each declares
 * which capability it serves, and the router - not the planner - decides that this is what
 * `filesystem.inspect` means.
 *
 * Every verifier here goes and LOOKS at the filesystem rather than trusting a tool's return value,
 * and every one recomputes what it expects. That pattern is the reason `filesystem.transform` can be
 * verified at all: the composed summary must agree with an independent reading of the same folder,
 * or the step is not verified.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve, extname, relative } from 'node:path'
import type { Tool, ToolContext, ToolResult, Verifier } from '../executor.ts'
import type { Evidence, Step } from '../state.ts'

/** Resolved root, so a junction cannot present a path the tools then treat as in-workspace. */
function rootOf(workspace: string): string {
  try { return realpathSync.native(resolve(workspace)) } catch { return resolve(workspace) }
}

function inside(root: string, p: string): boolean {
  const abs = resolve(root, p)
  const prefix = root.endsWith('\\') || root.endsWith('/') ? root : root + '\\'
  return abs === root || abs.startsWith(prefix)
}

// ============================================================ filesystem.inspect

/**
 * Reports what is in a folder, at execution time.
 *
 * Re-establishes the observation rather than trusting the plan. The plan was built on a snapshot;
 * this is the step where the world is asked again, and if it has moved the plan's own verification
 * fails - which is the behaviour that makes `replan` the right `onFailure` for it.
 */
export function makeInspectTool(workspace: string): Tool {
  const root = rootOf(workspace)
  return {
    name: 'inspect-folder',
    mode: 'filesystem',
    async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      const p = String(args.path ?? '')
      if (!inside(root, p)) return { kind: 'failed', reason: `refused: "${p}" is outside ${root}` }
      const abs = resolve(root, p)
      if (!existsSync(abs)) return { kind: 'failed', reason: `"${abs}" does not exist` }
      if (!statSync(abs).isDirectory()) return { kind: 'failed', reason: `"${abs}" is not a folder` }

      const files: string[] = []
      const dirs: string[] = []
      const walk = (dir: string) => {
        for (const name of readdirSync(dir).sort()) {
          const full = join(dir, name)
          const st = statSync(full)
          if (st.isDirectory()) { dirs.push(relative(abs, full).replace(/\\/g, '/')); walk(full) }
          else files.push(relative(abs, full).replace(/\\/g, '/'))
        }
      }
      walk(abs)
      return {
        kind: 'data',
        data: { path: abs, files, dirs, count: files.length },
        summary: `${files.length} file(s), ${dirs.length} subfolder(s) under ${abs}`,
      }
    },
  }
}

/** Independent: goes and looks, and does not compare against the tool's own numbers. */
export function makeInspectVerifier(workspace: string): Verifier {
  const root = rootOf(workspace)
  return {
    verifies: (step: Step) => (step as { capability?: string }).capability === 'filesystem.inspect',
    async verify(step: Step, _ctx: ToolContext, toolData: unknown) {
      const claimed = toolData as { path?: string } | undefined
      if (!claimed?.path) return { rejected: 'the tool named no path, so there is nothing to verify' }
      if (!inside(root, claimed.path)) return { rejected: `refused: "${claimed.path}" is outside ${root}` }
      if (!existsSync(claimed.path)) return { rejected: `"${claimed.path}" is not there` }
      if (!statSync(claimed.path).isDirectory()) return { rejected: `"${claimed.path}" is no longer a folder` }
      // Independently count, so the evidence is about the world and not about the tool's summary.
      let n = 0
      const walk = (d: string) => {
        for (const name of readdirSync(d)) {
          const full = join(d, name)
          if (statSync(full).isDirectory()) walk(full)
          else n++
        }
      }
      walk(claimed.path)
      return {
        evidence: {
          kind: 'file-exists',
          path: `${claimed.path} is still readable and contains ${n} file(s), counted independently`,
        } as Evidence,
      }
    },
  }
}

// ============================================================ filesystem.transform

/**
 * Composes a summary from the folder, at execution time.
 *
 * The file list in the plan's args is a PLANNING input, and this tool deliberately does not trust it:
 * it re-reads the folder. A plan built from an observation that has since changed would otherwise
 * produce a summary describing a folder that no longer holds those files, and the summary would read
 * perfectly.
 */
export function makeComposeTool(workspace: string): Tool {
  const root = rootOf(workspace)
  return {
    name: 'compose-summary',
    mode: 'filesystem',
    async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      const p = String(args.path ?? '')
      if (!inside(root, p)) return { kind: 'failed', reason: `refused: "${p}" is outside ${root}` }
      const abs = resolve(root, p)
      if (!existsSync(abs) || !statSync(abs).isDirectory()) {
        return { kind: 'failed', reason: `"${abs}" is not a readable folder` }
      }

      const rows: Array<{ rel: string; bytes: number; ext: string }> = []
      const walk = (dir: string) => {
        for (const name of readdirSync(dir).sort()) {
          const full = join(dir, name)
          const st = statSync(full)
          if (st.isDirectory()) { walk(full); continue }
          rows.push({
            rel: relative(abs, full).replace(/\\/g, '/'),
            bytes: st.size,
            ext: extname(name).replace(/^\./, '').toLowerCase(),
          })
        }
      }
      walk(abs)

      if (rows.length === 0) {
        // Never invent a summary of nothing. This is the same refusal the planner makes, repeated at
        // execution because the world may have emptied between planning and running.
        return { kind: 'nothing-found', reason: `${abs} contains no files to summarise` }
      }

      const total = rows.reduce((a, r) => a + r.bytes, 0)
      const byExt = new Map<string, number>()
      for (const r of rows) byExt.set(r.ext || '(none)', (byExt.get(r.ext || '(none)') ?? 0) + 1)

      const lines = [
        `SUMMARY OF ${abs}`,
        `files: ${rows.length}`,
        `total bytes: ${total}`,
        `subfolders included: yes`,
        '',
        'BY EXTENSION:',
        ...[...byExt.entries()].sort().map(([e, n]) => `  .${e}: ${n}`),
        '',
        'FILES:',
        ...rows.map((r) => `  ${r.rel} (${r.bytes} bytes)`),
        '',
        `TOTAL:${total}`,
      ]
      return {
        kind: 'data',
        data: { path: abs, text: lines.join('\n') + '\n', files: rows.length, total, byExt: Object.fromEntries(byExt) },
        summary: `composed a summary of ${rows.length} file(s), ${total} bytes`,
      }
    },
  }
}

/**
 * The verifier RECOMPUTES the whole summary independently and compares.
 *
 * This is the strongest verification in the system and it is worth being precise about why it is
 * not theatre: the compose tool walks the folder and builds text; this walks the same folder again,
 * with separate code, and builds the expected text. If the two disagree, the step is not verified -
 * and a compose tool that reported a confident summary of a folder it never read would be caught,
 * because the expected text comes from a different walk.
 */
export function makeComposeVerifier(workspace: string): Verifier {
  const root = rootOf(workspace)
  return {
    verifies: (step: Step) => (step as { capability?: string }).capability === 'filesystem.transform',
    async verify(step: Step, _ctx: ToolContext, toolData: unknown) {
      const claimed = toolData as { path?: string; text?: string } | undefined
      if (!claimed?.path) return { rejected: 'the tool named no path' }
      if (!inside(root, claimed.path)) return { rejected: `refused: "${claimed.path}" is outside ${root}` }
      if (!existsSync(claimed.path) || !statSync(claimed.path).isDirectory()) {
        return { rejected: `"${claimed.path}" is no longer a readable folder` }
      }

      // The independent walk.
      const rows: Array<{ rel: string; bytes: number; ext: string }> = []
      const walk = (dir: string) => {
        for (const name of readdirSync(dir).sort()) {
          const full = join(dir, name)
          const st = statSync(full)
          if (st.isDirectory()) { walk(full); continue }
          rows.push({
            rel: relative(claimed.path!, full).replace(/\\/g, '/'),
            bytes: st.size,
            ext: extname(name).replace(/^\./, '').toLowerCase(),
          })
        }
      }
      walk(claimed.path)
      const total = rows.reduce((a, r) => a + r.bytes, 0)
      const byExt = new Map<string, number>()
      for (const r of rows) byExt.set(r.ext || '(none)', (byExt.get(r.ext || '(none)') ?? 0) + 1)
      const expected =
        [
          `SUMMARY OF ${claimed.path}`,
          `files: ${rows.length}`,
          `total bytes: ${total}`,
          `subfolders included: yes`,
          '',
          'BY EXTENSION:',
          ...[...byExt.entries()].sort().map(([e, n]) => `  .${e}: ${n}`),
          '',
          'FILES:',
          ...rows.map((r) => `  ${r.rel} (${r.bytes} bytes)`),
          '',
          `TOTAL:${total}`,
        ].join('\n') + '\n'

      if (typeof claimed.text !== 'string') return { rejected: 'the tool produced no summary text' }
      if (claimed.text !== expected) {
        return {
          rejected:
            `the composed summary does not match what an independent walk of ${claimed.path} found. ` +
            `Expected ${expected.length} bytes describing ${rows.length} file(s); the tool produced ` +
            `${claimed.text.length} bytes.`,
        }
      }
      return {
        evidence: {
          kind: 'command-verified',
          executable: 'filesystem.transform',
          path: claimed.path,
          bytes: expected.length,
          exitCode: null,
          durationMs: 0,
          envVarCount: 0,
          corroboratedBy: 'the verifier re-walked the folder and recomputed the whole summary',
        } as unknown as Evidence,
      }
    },
  }
}

// ============================================================ filesystem.write

/** Writes text the previous step produced. Refuses to overwrite, so nothing existing is lost. */
export function makeWriteTool(workspace: string): Tool {
  const root = rootOf(workspace)
  return {
    name: 'write-summary',
    mode: 'filesystem',
    async run(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      const p = String(args.path ?? '')
      if (!inside(root, p)) return { kind: 'failed', reason: `refused: "${p}" is outside ${root}` }
      const abs = resolve(root, p)
      if (existsSync(abs)) {
        // Overwriting is a consequential act, and this capability does not do consequential acts.
        return { kind: 'failed', reason: `refused: "${abs}" already exists; this tool creates new files only` }
      }
      // The content comes from the step that composed it, NOT from the objective text.
      //
      // Two shapes, because the step before may have composed the text in-process or had a process
      // write it to a file. A terminal step's output is a process record with a path, not text, so a
      // writer that only understood `output.text` would fail on a plan whose composition ran as a
      // real process - and the failure would be "no composed summary available", which reads as a
      // missing operand rather than a shape mismatch.
      const from = String(args.from ?? '')
      const prior = from ? ctx.prior[from]?.output as { text?: string; stdout?: string } | undefined : undefined

      let content: string | undefined
      if (typeof prior?.text === 'string') {
        content = prior.text
      } else {
        // A process wrote a file; read it, and only from inside the output root.
        const rawPath = String((args.copyFrom ?? ''))
        if (rawPath) {
          if (!inside(root, rawPath)) {
            return { kind: 'failed', reason: `refused: "${rawPath}" is outside ${root}` }
          }
          if (!existsSync(rawPath)) {
            return { kind: 'failed', reason: `the process did not produce "${rawPath}"` }
          }
          content = readFileSync(rawPath, 'utf8')
        }
      }

      if (typeof content !== 'string' || content.length === 0) {
        return { kind: 'failed', reason: `no composed summary was available from step "${from}"` }
      }
      writeFileSync(abs, content, 'utf8')
      return { kind: 'data', data: { path: abs, bytes: content.length }, summary: `wrote ${content.length} bytes to ${abs}` }
    },
  }
}

// ============================================================ filesystem.read

/** Reads a file back. The step that proves the artifact is real and readable. */
export function makeReadBackTool(workspace: string): Tool {
  const root = rootOf(workspace)
  return {
    name: 'read-back',
    mode: 'filesystem',
    async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      const p = String(args.path ?? '')
      if (!inside(root, p)) return { kind: 'failed', reason: `refused: "${p}" is outside ${root}` }
      const abs = resolve(root, p)
      if (!existsSync(abs)) return { kind: 'failed', reason: `"${abs}" does not exist` }
      const text = readFileSync(abs, 'utf8')
      return { kind: 'data', data: { path: abs, text, bytes: text.length }, summary: `read ${text.length} bytes from ${abs}` }
    },
  }
}

/**
 * The read-back verifier checks the CONTENT against the plan's claim, not merely that bytes exist.
 *
 * `expectFiles` comes from the OBSERVATION, so if the world changed between planning and execution
 * the count no longer matches and the mission fails verification rather than reporting a summary of a
 * folder it no longer describes.
 */
export function makeReadBackVerifier(workspace: string): Verifier {
  const root = rootOf(workspace)
  return {
    verifies: (step: Step) => (step as { capability?: string }).capability === 'filesystem.read',
    async verify(step: Step, _ctx: ToolContext, toolData: unknown) {
      const claimed = toolData as { path?: string; text?: string } | undefined
      if (!claimed?.path) return { rejected: 'the tool named no path' }
      if (!inside(root, claimed.path)) return { rejected: `refused: "${claimed.path}" is outside ${root}` }
      if (!existsSync(claimed.path)) return { rejected: `went and looked for "${claimed.path}"; it is not there` }
      const body = readFileSync(claimed.path, 'utf8')
      if (body.trim().length === 0) return { rejected: `"${claimed.path}" exists but has no readable content` }

      const expectFiles = (step.args as { expectFiles?: number } | undefined)?.expectFiles
      if (typeof expectFiles === 'number') {
        const claimedCount = Number(/^files: (\d+)$/m.exec(body)?.[1] ?? -1)
        if (claimedCount !== expectFiles) {
          return {
            rejected:
              `the summary says it covers ${claimedCount} file(s) but the plan observed ${expectFiles}. ` +
              `The world changed between planning and execution, so this summary describes something ` +
              `that is no longer there.`,
          }
        }
      }
      return {
        evidence: {
          kind: 'file-exists',
          path: `${claimed.path} (${body.length} bytes, independently re-read; first line ${JSON.stringify(body.split('\n')[0])})`,
        } as Evidence,
      }
    },
  }
}

/** The capability each tool serves. The router uses this; the planner never sees it. */
export const SUMMARY_CAPABILITIES = {
  inspect: 'filesystem.inspect',
  compose: 'filesystem.transform',
  write: 'filesystem.write',
  read: 'filesystem.read',
} as const
