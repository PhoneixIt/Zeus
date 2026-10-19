/**
 * THE MODEL CATALOGUE.
 *
 * ============================================================================================
 * WHY THIS FILE EXISTS, AND WHY IT ONLY LISTS FREE MODELS
 * ============================================================================================
 *
 * `opencode-cli.exe models` reports 121 models on this machine. Ten of them are free; 111 are
 * not - 79 of them are `openai/*`, which are billable.
 *
 * The $0 constraint in this project is not a preference, it is a hard requirement, and a
 * model picker that lists 111 paid models beside 10 free ones invites exactly the mistake the
 * constraint exists to prevent: a user picks something that looks better, and a silent cost
 * appears. A picker is a spending mechanism if it is built carelessly.
 *
 * So the catalogue is built from the CLI's own output, and it REPORTS what it found rather than
 * assuming: if the free-model list ever comes back empty or the CLI is missing, that is
 * surfaced as an error and the picker shows nothing selectable. It does not fall back to a paid
 * model, because "the free list failed so here is a paid one" is precisely the wrong default.
 *
 * ============================================================================================
 * WHY THE CLI IS ASKED EVERY TIME, AND CACHED BRIEFLY
 * ============================================================================================
 *
 * Model availability changes. Asking on every request would make a page load cost a process
 * spawn. A short cache keeps the picker instant while staying fresh enough to be true.
 */

import { execFile } from 'node:child_process'
import { DEFAULT_OPENCODE_CLI } from '../../../agent/opencode-adapter.ts'
import { existsSync } from 'node:fs'

export interface ModelInfo {
  readonly id: string
  /** True only when the id is served by the free provider namespace. */
  readonly free: boolean
  readonly provider: string
}

/**
 * How long a catalogue is reused before the CLI is asked again.
 *
 * Short on purpose: the picker is opened often, and a stale list that is missing a brand new
 * free model is a smaller problem than a page load that spawns a process every time.
 */
const CACHE_MS = 60_000

let cached: { at: number; models: ModelInfo[] } | null = null

/**
 * A model id is FREE only if it is exactly `<namespace>/<name>`, the namespace is `opencode`,
 * and the name ends in `-free`.
 *
 * Every part matters, and each one was added because a looser version passed something it
 * should not have:
 *
 *   - the suffix, because the namespace alone would accept a future `opencode/paid-thing`;
 *   - the namespace, because a `-free` suffix in `openai/` would otherwise pass;
 *   - the EXACTLY-ONE-slash shape, because `opencode/nested/path-model-free` satisfies both a
 *     prefix check and a suffix check while being a different kind of string entirely.
 *
 * This classification is the mechanism the $0 constraint is enforced through, so it is
 * deliberately strict: a model that cannot be positively identified as free is NOT offered.
 */
export function isFreeModel(id: string): boolean {
  const parts = id.split('/')
  if (parts.length !== 2) return false
  return parts[0] === 'opencode' && parts[1]!.endsWith('-free')
}

function runCliModels(cli: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cli, ['models'], { timeout: 20_000, windowsHide: true, maxBuffer: 4_000_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`the model CLI failed: ${stderr || err.message}`))
        else resolve(String(stdout))
      })
  })
}

/**
 * Every free model the CLI reports.
 *
 * Throws rather than returning a paid model or an empty-but-successful result: the caller must
 * be able to distinguish "no free models" from "the list could not be read", because only the
 * first is a legitimate state to show the user.
 */
export async function freeModels(opts: { force?: boolean; cliPath?: string } = {}): Promise<ModelInfo[]> {
  const now = Date.now()
  if (!opts.force && cached && now - cached.at < CACHE_MS) return cached.models

  const cli = opts.cliPath ?? DEFAULT_OPENCODE_CLI
  if (!existsSync(cli)) {
    throw new Error(`the OpenCode CLI is not at ${cli}, so no model list can be read`)
  }

  const out = await runCliModels(cli)
  const models: ModelInfo[] = []
  for (const line of out.split(/\r?\n/)) {
    const id = line.trim()
    if (!id || !id.includes('/')) continue
    if (!isFreeModel(id)) continue
    models.push({ id, free: true, provider: id.split('/')[0]! })
  }
  if (models.length === 0) {
    // Named explicitly, because "no free models" is a fact the user must be told, not an empty
    // dropdown they have to interpret.
    throw new Error('the model CLI reported no free models; nothing is selectable rather than silently substituting a paid one')
  }
  models.sort((a, b) => a.id.localeCompare(b.id))
  cached = { at: now, models }
  return models
}

/** Test seam: drop the cache so a test is not reading another test's result. */
export function resetModelCache(): void {
  cached = null
}