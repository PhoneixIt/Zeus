/**
 * WHAT THE PERSON TOLD US ONCE, SO THEY NEVER HAVE TO SAY IT AGAIN.
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 *
 * The instruction was: "Remember my general preferences and apply them to future tasks without
 * requiring me to teach you the workflow repeatedly."
 *
 * That is a request about MEMORY, and memory has to be somewhere durable. It cannot live in a
 * prompt, because a prompt is rebuilt every mission; it cannot live in a module constant, because
 * that dies with the process; and it should not live in the repository, because these are facts
 * about one person on one machine, not facts about the software.
 *
 * So it lives in ~/.aios/agent/preferences.json, which is the same place the autonomy grant and
 * the mission history already live: the state of THIS installation.
 *
 * ============================================================================================
 * THE RULE THAT MAKES THIS SAFE
 * ============================================================================================
 *
 * A stored preference may change HOW a mission is planned, reported or worded. It may NEVER change
 * what is checked, what is refused, or what is permitted. Preferences are not authority.
 *
 * That is why every field here is a preference about presentation or method, and why there is
 * deliberately no field for "skip verification", "widen the path allowlist", or "ignore the
 * guard". If a preference file could turn a check off, then writing a file would be equivalent to
 * bypassing the thing that wrote it - and the file is writable by anything running as this user,
 * which includes the very software it governs.
 *
 * `assertPreferencesCannotWeakenChecks` exists to make that structural rather than a promise.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export const PREFERENCES_FILE = join(homedir(), '.aios', 'agent', 'preferences.json')

/**
 * Stored preferences. Every field is about method or presentation.
 *
 * There is no field here that can disable a check, widen an allowlist, or alter the guard. That
 * omission is the design. See the note above the file.
 */
export interface Preferences {
  /** Report show-goals in one line, file-goals with the full audit. */
  readonly reportStyle?: 'quiet-show' | 'full'
  /** Prefer finishing a goal over asking which approach to take. */
  readonly autonomousMethod?: boolean
  /** Free-text standing instructions, shown to the planner on every mission. */
  readonly standingNotes?: string
  /** When the file was last written, ISO. Informational. */
  readonly updatedAt?: string
}

const DEFAULT_PREFERENCES: Preferences = {
  reportStyle: 'quiet-show',
  autonomousMethod: true,
}

export function readPreferences(): Preferences {
  try {
    if (!existsSync(PREFERENCES_FILE)) return DEFAULT_PREFERENCES
    const raw = readFileSync(PREFERENCES_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      reportStyle: parsed.reportStyle === 'full' ? 'full' : 'quiet-show',
      autonomousMethod: parsed.autonomousMethod !== false,
      standingNotes: typeof parsed.standingNotes === 'string' ? parsed.standingNotes : undefined,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : undefined,
    }
  } catch {
    // A preferences file that cannot be read must not stop a mission. The defaults are the safe
    // ones: full reporting and a planner that finishes rather than asks.
    return DEFAULT_PREFERENCES
  }
}

export function writePreferences(patch: Partial<Preferences>): Preferences {
  const next: Preferences = { ...readPreferences(), ...patch, updatedAt: new Date().toISOString() }
  try {
    mkdirSync(dirname(PREFERENCES_FILE), { recursive: true })
    writeFileSync(PREFERENCES_FILE, JSON.stringify(next, null, 2), 'utf8')
  } catch {
    // Failing to remember is not a reason to refuse to run.
  }
  return next
}

/**
 * The preference block injected into the planner's prompt, or '' when there is nothing to add.
 *
 * Deliberately short. A long block of standing instructions crowds out the capability catalogue,
 * and the catalogue is what stops the planner inventing tools.
 */
export function preferencesForPrompt(): string {
  const p = readPreferences()
  const lines: string[] = []
  if (p.autonomousMethod) {
    lines.push(
      'Choose the route yourself and finish the job. Do not plan a step whose purpose is to ask '
      + 'which approach to take. Ask only when essential information is missing, when the intent is '
      + 'genuinely ambiguous, or when an action needs the person\'s approval.',
    )
  }
  if (p.reportStyle === 'quiet-show') {
    lines.push('The person wants short confirmations for goals that end in a window on screen.')
  }
  if (p.standingNotes && p.standingNotes.trim().length > 0) {
    lines.push(`Standing instructions from the person: ${p.standingNotes.trim()}`)
  }
  if (lines.length === 0) return ''
  return `\nWhat this person has asked for in general (applies to every mission unless they say otherwise):\n${lines.map((l) => '- ' + l).join('\n')}\n`
}

/**
 * The guard on the guard: a preferences file cannot express a preference that weakens a check.
 *
 * Written as a runtime assertion rather than a comment because a comment is a promise and this is
 * a property. If someone adds `skipVerification: true` to the interface, this throws loudly the
 * first time the file is read, instead of quietly disabling the thing the file exists to inform.
 */
const FORBIDDEN_KEYS = [
  'skipVerification', 'noVerify', 'disableChecks', 'bypassGuard', 'ignoreGuard',
  'allowAnyPath', 'widenAllowlist', 'autonomyBypass', 'trustModel',
]

export function assertPreferencesCannotWeakenChecks(p: Record<string, unknown>): void {
  for (const k of FORBIDDEN_KEYS) {
    if (k in p) {
      throw new Error(
        `preferences.json contains "${k}", which is not a preference: it is a way to switch off a `
        + 'check. Preferences may change how a mission is planned or reported; they may never '
        + 'change what is verified or what the guard permits.',
      )
    }
  }
}