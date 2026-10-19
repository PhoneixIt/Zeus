// ===========================================================================================
// Free-model failover.
//
// WHY THIS EXISTS
//
// Every model AIOS can use is free, and free models are rate limited. Measured on this machine:
// running five missions back to back exhausted the provider's allowance, and the next five all
// failed in about 2.5 seconds with "Rate limit exceeded. Please try again later."
//
// Before this, a throttled model ended the mission. The user was told the planner failed, which
// was true, and the machine sat idle while eleven OTHER free models sat unused. The budget
// constraint is not "one model" - it is "no paid models" - so falling over to a different FREE
// model spends nothing and keeps the work moving.
//
// WHY A MODEL THAT RECENTLY FAILED IS NOT RETRIED
//
// Without this the failover is worse than useless: it burns its remaining attempts on the same
// throttled model, because the preferred one is tried first every time and the limit lasts
// minutes rather than seconds. The failures are remembered on disk, across processes, so a
// cooldown survives the mission runner being restarted - which is exactly when it is needed,
// because the throttle outlives the process.
//
// The memory is deliberately small and deliberately FORGETTING. An entry older than the cooldown
// is dropped rather than kept forever, so a model that recovers is eligible again without anyone
// having to clear anything by hand. A stale "this model is broken" note is its own failure mode.
//
// WHAT IS NOT DONE HERE
//
// There is no silent substitution. The model that actually produced the plan is recorded on it
// and reported, and every switch is announced with the reason. A plan produced by a different
// model than the one asked for is a fact the user is entitled to know before the plan runs.
// ===========================================================================================
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Where cooldowns live.
 *
 * Resolved at CALL time, not once at import. A path frozen at import is only correct for as long as
 * the user's home directory never changes - and it silently breaks anything that redirects HOME,
 * including the tests that exist to prove a model that just failed is not retried. Those tests then
 * read an empty store, conclude nothing was ever recorded, and pass against a router that would
 * happily reuse a throttled model.
 */
function cooldownFile(): string {
  return join(homedir(), '.aios', 'agent', 'model-cooldown.json')
}

/** How long a model stays out of rotation after failing. */
const COOLDOWN_MS = 10 * 60 * 1000

type Cooldown = { failedAt: number; reason: string }

function read(): Record<string, Cooldown> {
  try {
    if (!existsSync(cooldownFile())) return {}
    const parsed = JSON.parse(readFileSync(cooldownFile(), 'utf8')) as Record<string, Cooldown>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    // An unreadable memory file must not stop a mission. Losing the cooldown costs a few wasted
    // attempts; refusing to plan because of it would cost the mission.
    return {}
  }
}

function write(all: Record<string, Cooldown>): void {
  try {
    mkdirSync(dirname(cooldownFile()), { recursive: true })
    writeFileSync(cooldownFile(), JSON.stringify(all, null, 2), 'utf8')
  } catch { /* the cooldown is an optimisation, never a precondition */ }
}

/** Is this model currently in cooldown? */
export function inCooldown(model: string): boolean {
  const e = read()[model]
  return !!e && Date.now() - e.failedAt < COOLDOWN_MS
}

/** Record a failure, and forget anything whose cooldown has expired. */
export function noteFailure(model: string, reason: string): void {
  const all = read()
  const now = Date.now()
  for (const [k, v] of Object.entries(all)) {
    if (now - v.failedAt >= COOLDOWN_MS) delete all[k]
  }
  all[model] = { failedAt: now, reason: String(reason).slice(0, 200) }
  write(all)
}

/** Forget one model's failures. Exposed so a user can retry a model they believe has recovered. */
export function clearCooldown(model: string): void {
  const all = read()
  delete all[model]
  write(all)
}

/** Models currently in cooldown, newest first. For display. */
export function cooldowns(): Array<{ model: string; reason: string; minutesLeft: number }> {
  const now = Date.now()
  return Object.entries(read())
    .filter(([, v]) => now - v.failedAt < COOLDOWN_MS)
    .map(([model, v]) => ({
      model,
      reason: v.reason,
      minutesLeft: Math.max(1, Math.round((COOLDOWN_MS - (now - v.failedAt)) / 60000)),
    }))
    .sort((a, b) => a.minutesLeft - b.minutesLeft)
}

/**
 * The order to try free models in: the preferred one first, then the rest.
 *
 * Models in cooldown are pushed to the END rather than removed, so they are still used when
 * nothing else is left. Dropping them entirely would turn a temporary throttle into a permanently
 * smaller catalogue, and "the only model available is the one that just failed" is a better
 * outcome than "no model available" - the second is a dead mission.
 */
export function orderCandidates(preferred: string, all: string[]): string[] {
  const usable = all.includes(preferred) ? all : [preferred, ...all]
  const fresh = usable.filter((m) => !inCooldown(m))
  const cooling = usable.filter((m) => inCooldown(m))
  // The preferred model leads, then everything not in cooldown, then the cooling remainder.
  const rest = fresh.filter((m) => m !== preferred)
  return [preferred, ...rest, ...cooling].filter((m, i, a) => a.indexOf(m) === i)
}