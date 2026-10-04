/**
 * `filesystem` execution mode, and its independent verifier.
 *
 * A THIRD genuinely different mechanism:
 *
 *   cli - HTTP poll of the host's guard and window endpoints
 *   uia - IUIAutomation COM accessibility tree
 *   fs  - Node's fs directly: no host round-trip, no COM, no input path at all
 *
 * The tool WRITES. The verifier READS BACK through a different code path - `fs.statSync`
 * rather than the writer - which is what makes the verification independent rather than the
 * tool agreeing with itself.
 *
 * SAFETY
 *
 * Everything happens inside ONE dedicated directory under %TEMP%. Nothing else on the machine
 * is read or written. No deletion of user data, no overwriting of anything that exists, no
 * registry, no permissions, no installs. The workspace is disposable and is cleaned up by the
 * OS, not by this module.
 *
 * A refusal to write outside the workspace is enforced structurally: the path is checked
 * before every operation rather than trusted from the caller, because a tool that trusts its
 * own arguments is a tool one bad mission away from writing somewhere it should not.
 */

import { mkdirSync, writeFileSync, statSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { Evidence, Step } from '../state.ts'
import type { Tool, ToolContext, ToolResult, Verifier } from '../executor.ts'

/** The one directory this module may touch. */
export const WORKSPACE = join(tmpdir(), 'aios-fs-probe')

/**
 * Refuses any path outside the workspace.
 *
 * Checked internally rather than accepted from the caller. The executor passes step
 * arguments through; if the containment check lived in the argument, a mission could simply
 * omit it.
 */
function insideWorkspace(p: string): boolean {
  const root = resolve(WORKSPACE)
  const full = resolve(p)
  return full === root || full.startsWith(root.endsWith(sep) ? root : root + sep)
}

export function ensureWorkspace(): string {
  mkdirSync(WORKSPACE, { recursive: true })
  return WORKSPACE
}

// ---------------------------------------------------------------- the tool

/**
 * Writes one probe file inside the workspace.
 *
 * Reversible by construction: it refuses to overwrite anything, so a rerun cannot destroy an
 * earlier run's evidence. It reports failure rather than throwing, because a refusal is an
 * outcome the mission engine is built to record honestly.
 */
export const writeProbeTool: Tool = {
  name: 'write-probe-file',
  mode: 'filesystem',
  async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    const rel = String(args.rel ?? 'probe.txt')
    const body = String(args.body ?? 'aios filesystem probe')
    const target = join(WORKSPACE, rel)

    if (!insideWorkspace(target)) {
      return {
        kind: 'failed',
        reason: `refused: "${target}" is outside the dedicated workspace ${WORKSPACE}`,
      }
    }

    ensureWorkspace()

    if (existsSync(target)) {
      // Refusing rather than overwriting keeps every run's evidence independently checkable
      // and makes the operation genuinely reversible.
      return {
        kind: 'failed',
        reason: `refused: "${rel}" already exists in the workspace and will not be overwritten`,
      }
    }

    try {
      writeFileSync(target, body, 'utf8')
      return {
        kind: 'data',
        data: { path: target, rel, bytes: Buffer.byteLength(body, 'utf8') },
        summary: `wrote ${rel} (${Buffer.byteLength(body, 'utf8')} bytes) into the workspace`,
      }
    } catch (e) {
      return { kind: 'failed', reason: `write failed: ${e instanceof Error ? e.message : String(e)}` }
    }
  },
}

/**
/**
 * A tool that CLAIMS a write happened without performing it.
 *
 * It takes the filename to claim from the step's own `args`, so it is handed the exact operand
 * the real tool would have written - and writes nothing. That makes it a faithful lie: same
 * tool name, same mode, same arguments, same claimed shape, no file on disk.
 *
 * HISTORY - why an earlier version of this control proved nothing
 *
 * It hardcoded `probe.txt`, which the POSITIVE run had already created milliseconds earlier.
 * The lie was therefore TRUE by the time it was verified, the verifier correctly accepted it,
 * and the control passed while demonstrating nothing.
 *
 * A second attempt would have failed for the wrong reason: a hardcoded name the positive run
 * never creates would be rejected because of a typo, not because the lie was caught. So it
 * takes the operand from the plan, leaving the absent write as the only difference.
 *
 * A control that cannot fail is not a control, and neither is one that fails for the wrong
 * reason. This is the third time in this project that the instrument, not the system, was the
 * broken thing.
 */
export const lyingFilesystemTool: Tool = {
  name: 'write-probe-file',
  mode: 'filesystem',
  async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
    // Derived from the step's REAL operand, then made distinct, so the claim names a
    // specific file that no real run creates. Same arguments, same mode, same claimed
    // shape; the only difference is that nothing was written.
    const rel = String(args.rel ?? 'probe.txt') + '.claimed-but-never-written'
    const target = join(WORKSPACE, rel)
    return {
      kind: 'data',
      data: { path: target, rel, bytes: 21 },
      summary: `wrote ${rel} (21 bytes) into the workspace`,
    }
  },
}

// ---------------------------------------------------------------- the verifier

/**
 * Independent verification of a filesystem write.
 *
 * It stats and READS the file itself. It never reads the tool's claimed bytes - a verifier
 * that compares a tool's numbers against the tool's own numbers is not verifying anything.
 */
export function filesystemVerifier(): Verifier {
  return {
    verifies: (step: Step) => step.mode === 'filesystem',
    async verify(step: Step, _ctx: ToolContext, toolData: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
      const claimed = toolData as { path?: string; bytes?: number } | undefined
      if (!claimed?.path) return { rejected: 'the tool named no path, so there is nothing to verify' }
      if (!insideWorkspace(claimed.path)) {
        return { rejected: `refused to verify "${claimed.path}": it is outside the workspace` }
      }

      let st: ReturnType<typeof statSync>
      try {
        // Independent: fs.statSync, not the writer, and not the tool's own return value.
        st = statSync(claimed.path)
      } catch {
        return { rejected: `went and looked for "${claimed.path}"; it is not there` }
      }

      if (!st.isFile()) return { rejected: `"${claimed.path}" exists but is not a regular file` }
      if (st.size === 0) return { rejected: `"${claimed.path}" exists but is empty` }

      // Read it back, so the evidence is about CONTENT and not merely about existence. A file
      // that exists but holds the wrong thing is not a completed write.
      const body = readFileSync(claimed.path, 'utf8')
      if (body.trim().length === 0) {
        return { rejected: `"${claimed.path}" exists and has a non-zero size but no readable content` }
      }

      return {
        evidence: {
          kind: 'file-exists',
          path: `${claimed.path} (${st.size} bytes on disk, content "${body.slice(0, 40)}")`,
        },
      }
    },
  }
}

// ---------------------------------------------------------------- housekeeping

/** Removes the workspace entirely. Only ever called for the probe's own directory. */
export function teardownWorkspace(): void {
  if (!insideWorkspace(WORKSPACE)) throw new Error('refusing to remove anything outside the workspace')
  rmSync(WORKSPACE, { recursive: true, force: true })
}

/** Current workspace contents, for the record. */
export function workspaceListing(): string[] {
  if (!existsSync(WORKSPACE)) return []
  return [WORKSPACE]
}
