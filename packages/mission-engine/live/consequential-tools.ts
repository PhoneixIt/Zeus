/**
 * A CONSEQUENTIAL-EFFECT SIMULATOR, for proving the approval boundary without doing anything
 * dangerous.
 *
 * WHY A SIMULATOR
 *
 * A real deletion, purchase, message send or credential use cannot be used to demonstrate a
 * governance boundary — you cannot delete something real to prove you cannot delete it without
 * authorisation. So the consequence is modelled inside a disposable directory.
 *
 * WHY IT IS NOT A BYPASS
 *
 * This tool has no privileged position. The approval gate never inspects what a tool DOES; it
 * reads the effect the step DECLARES and consults the approval store. So this tool is governed by
 * exactly the same code path that a real `delete` tool would be, unchanged. That is the property
 * under test: **the gate is on the declaration, not on the implementation.**
 *
 * If someone later adds a genuine delete tool and gives its step the same declared effect, it is
 * governed by this gate with no change here. That is the intent.
 *
 * EVERY ACTION IS RECORDED WHERE THE TEST CAN READ IT
 *
 * `delete-probe` writes a line to a journal file outside the workspace's data directory. The
 * tests read the journal to establish whether the tool actually ran — as required, because a
 * Proxy counting method calls measures intent rather than events, which is the mistake this
 * project has already made once.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Tool, ToolContext, ToolResult, Verifier } from '../executor.ts'
import type { Evidence, Step } from './state.ts'

/**
 * The journal. Every consequential action appends here before it reports success.
 *
 * Deliberately append-only and outside the disposable data directory, so it survives the
 * teardown that removes the workspace and can still be read afterwards. A test that destroys its
 * own evidence cannot prove the action happened.
 */
export interface ActionJournal {
  append(entry: string): void
  read(): string[]
}

export function createJournal(path: string): ActionJournal {
  return {
    append(entry: string) {
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, entry + '\n', 'utf8')
    },
    read() {
      if (!existsSync(path)) return []
      return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim().length > 0)
    },
  }
}

/**
 * Deletes one probe file inside the disposable workspace.
 *
 * Refuses anything outside the workspace root, and refuses a directory, so the simulator cannot
 * be pointed at something real even by accident. A real delete tool would need the same
 * containment plus a recoverability guarantee; here the workspace is disposable and the journal
 * is the audit record.
 */
export function makeDeleteProbeTool(workspace: string, journal: ActionJournal): Tool {
  const root = resolve(workspace)
  const inside = (p: string): boolean => {
    const full = resolve(p)
    return full === root || full.startsWith(root.endsWith('\\') ? root : root + '\\')
  }

  return {
    name: 'delete-probe',
    mode: 'filesystem',
    async run(_ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
      const target = String(args.path ?? '')
      if (!inside(target)) {
        return { kind: 'failed', reason: `refused: "${target}" is outside the disposable workspace ${root}` }
      }
      if (!existsSync(target)) {
        return { kind: 'failed', reason: `"${target}" does not exist` }
      }
      if (statSync(target).isDirectory()) {
        return { kind: 'failed', reason: `refused: "${target}" is a directory; this simulator deletes files only` }
      }

      // The action, and the record of it, in that order.
      rmSync(target, { force: true })
      journal.append(`deleted ${target}`)

      return {
        kind: 'data',
        data: { path: target, deleted: true },
        summary: `deleted ${target}`,
      }
    },
  }
}

/**
 * Independent verification of a consequential action.
 *
 * Checks the WORLD, not the tool's return value: the journal must record the deletion, and the
 * file must genuinely be gone. A tool claiming a deletion it did not perform fails both.
 *
 * It deliberately cannot tell whether the action was authorised. Approval is a separate question
 * answered at the gate, and a verifier that also checked authorisation would conflate "was this
 * permitted" with "did this work" — which is precisely the separation this milestone exists to
 * keep.
 */
export function consequentialActionVerifier(workspace: string, journal: ActionJournal): Verifier {
  const root = resolve(workspace)
  return {
    verifies: (step: Step) => Boolean(step.effect),
    async verify(step: Step, _ctx: ToolContext, toolData: unknown) {
      const claimed = toolData as { path?: string } | undefined
      if (!claimed?.path) return { rejected: 'the tool named no target, so there is nothing to verify' }
      if (!claimed.path.startsWith(root)) {
        return { rejected: `refused to verify "${claimed.path}": outside the disposable workspace` }
      }

      // The world, independently: the file must be gone.
      if (existsSync(claimed.path)) {
        return { rejected: `the tool reported deleting "${claimed.path}" but it is still on disk` }
      }
      // And the record must show it, from a different source than the tool's return value.
      const recorded = journal.read().some((l) => l.includes(claimed.path!))
      if (!recorded) {
        return { rejected: `no journal entry records a deletion of "${claimed.path}"; the tool's claim is uncorroborated` }
      }

      return {
        evidence: {
          kind: 'file-deleted',
          path: claimed.path,
          effect: step.effect?.kind,
          corroboratedBy: 'journal-and-filesystem',
        } as Evidence,
      }
    },
  }
}

/** Composes the tool and its verifier for a given disposable workspace. */
export function consequentialCapability(workspace: string, journal: ActionJournal) {
  return {
    tool: makeDeleteProbeTool(workspace, journal),
    verifier: consequentialActionVerifier(workspace, journal),
  }
}

/** Creates the probe files a mission will be asked to delete. */
export function seedProbes(workspace: string, names: readonly string[]): string[] {
  mkdirSync(workspace, { recursive: true })
  return names.map((n) => {
    const p = join(workspace, n)
    writeFileSync(p, `probe ${n}\n`, 'utf8')
    return p
  })
}
