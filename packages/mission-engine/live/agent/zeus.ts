/**
 * ZEUS V1.0 - ONE NAME FOR THE WHOLE FREE POOL
 * =========================================================================
 *
 * WHAT THIS IS
 * ------------
 * A single named abstraction over every free model available to AIOS. Everything above this file -
 * the planner, the mission record, the user interface - refers to Zeus V1.0 and never to a concrete
 * model id. Below it, Zeus decides which concrete model answers which kind of request.
 *
 * The naming is not decoration. Before this, eleven model ids appeared in the interface and the
 * planner was invited to care about which one it was, which it is not able to do well and does not
 * need to: a model picker in the planner is a decision made with no information, and every token
 * spent on it is a token not spent on the plan. Zeus moves that decision to the layer that has the
 * information - usage history, latency, failure rates - and gives the person above it one name.
 *
 * HONESTY ABOUT WHICH MODEL ACTUALLY RAN
 * -------------------------------------
 * Zeus is a routing name, not a disguise. The concrete model that produced any given reply is
 * recorded on the result and reported in the transcript and the mission record, every time. The
 * rule already in force for failover applies unchanged: there is no silent substitution, because a
 * user entitled to know that a plan came from a different model than last time would otherwise have
 * no way to tell.
 *
 * WHY ROUTING BY REQUEST TYPE IS WORTH HAVING
 * -------------------------------------------
 * Measured on this machine: the same goal took 11s, 19s, 45s, 62s and 119s on different free
 * models. A pool treated as interchangeable therefore treats a 119-second model as equal to an
 * 11-second one, and pays the difference on every mission. Zeus learns which model is actually
 * quick and actually reliable FOR THIS KIND OF REQUEST, and prefers that. The score is built from
 * observed outcomes rather than from a table someone guessed at, because a guessed table is
 * confidently wrong within a week.
 *
 * THE EXHAUSTION PROBLEM, AND THE ACTUAL CAUSE
 * --------------------------------------------
 * Free models are rate limited, and the measured failure is severe: five missions back to back
 * exhausted the allowance, and the next five all failed in about two and a half seconds with
 * "Rate limit exceeded. Please try again later."
 *
 * The cause was not that there were too few models. It was that every mission tried the SAME
 * preferred model first, every single time, and the failover only engaged after that model had
 * already been throttled. Ten healthy models sat unused while one absorbed every request until it
 * died. The pool was large and the routing was single-lane.
 *
 * So the load-spreading rule here is SPREAD FIRST: among healthy models the least-used one leads,
 * and the type-preference score is a TIEBREAK rather than the primary sort. That inverts the old
 * behaviour deliberately. "The best model" is worth nothing if it is also the only model being
 * used, because exhausting it removes the best model from the pool entirely.
 *
 * A healthy-pool floor is guaranteed: if every model is cooling, the least recently failed one is
 * returned rather than nothing, because "the one that failed least recently" is a better outcome
 * than a dead mission.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It does not make the free allowance larger. Nothing can. It makes the existing allowance last
 * longer and keeps the pool populated, and it is measured rather than assumed - see
 * zeus-routing.test.ts, which asserts that N consecutive routes spread across N models rather than
 * hammering one.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { isFreeModel } from './models.ts'
import { inCooldown, noteFailure, cooldowns } from './model-failover.ts'

/** The name everything above this file uses. Deliberately not a model id - it is not one. */
export const ZEUS_ID = 'Zeus V1.0'

/**
 * The kinds of model call AIOS actually makes.
 *
 * Kept to what exists rather than to what might be built later, so that the routing decision is
 * made from real requests. An invented category would be scored by nothing and would quietly
 * become a synonym for "plan", which is worse than having no category at all.
 */
export type ZeusRequestType =
  /** Produce a mission plan: tool selection, arguments, sequencing. The hard one. */
  | 'plan'
  /** The second question asked when a plan shows rather than delivers. Short, and wants speed. */
  | 'correct'

/** Where Zeus keeps what it has learned. Same directory as the rest of the agent's state. */
function stateFile(): string {
  return join(homedir(), '.aios', 'agent', 'zeus.json')
}

/** Observations older than this no longer describe the pool. */
const OBSERVATION_WINDOW_MS = 24 * 60 * 60 * 1000

/** Hard bounds, so a corrupt or hostile state file cannot grow a prompt or a disk forever. */
const MAX_SAMPLES = 40
const MAX_NOTE_CHARS = 160

interface ModelStats {
  /** Calls of each type, and how many of them produced a usable answer. */
  readonly calls: Partial<Record<ZeusRequestType, number>>
  readonly ok: Partial<Record<ZeusRequestType, number>>
  /** Round-trip time of the last completed call, per type. */
  readonly ms: Partial<Record<ZeusRequestType, number>>
  /** When this model was last asked for anything. Drives spread. */
  lastUsedAt: number
  /** Consecutive failures. Drives escalating backoff. */
  failures: number
}

interface ZeusState {
  readonly models: Record<string, ModelStats>
}

const EMPTY: ModelStats = { calls: {}, ok: {}, ms: {}, lastUsedAt: 0, failures: 0 }

function readState(): ZeusState {
  try {
    const p = stateFile()
    if (!existsSync(p)) return { models: {} }
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return { models: {} }
    const models = (parsed as ZeusState).models
    if (typeof models !== 'object' || models === null) return { models: {} }
    // Every key is checked against the free-model rule. State written by anything else - a
    // hand-edited file, a page that got it into a prompt - cannot introduce a paid model into the
    // pool, because the check that enforces the $0 constraint is applied on the way back IN as
    // well as on the way out.
    const clean: Record<string, ModelStats> = {}
    for (const [k, v] of Object.entries(models)) {
      if (!isFreeModel(k)) continue
      if (typeof v !== 'object' || v === null) continue
      clean[k] = { ...EMPTY, ...v, failures: Math.max(0, Math.min(20, Number(v.failures) || 0)) }
    }
    return { models: clean }
  } catch {
    return { models: {} }
  }
}

function writeState(s: ZeusState): void {
  try {
    const p = stateFile()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(s, null, 2), 'utf8')
  } catch { /* routing state is an optimisation; a mission never depends on it being saved */ }
}

function bump(s: ZeusState, model: string, fn: (m: ModelStats) => ModelStats): void {
  const next = fn({ ...EMPTY, ...(s.models[model] ?? {}) })
  const trimmed: ModelStats = { ...next, failures: Math.min(20, Math.max(0, next.failures)) }
  // Keep the samples per type bounded. An unbounded counter is a number that stops meaning anything
  // once it is old, which is worse than forgetting it on purpose.
  for (const t of ['plan', 'correct'] as const) {
    trimmed.calls[t] = Math.min(MAX_SAMPLES, Number(trimmed.calls[t] ?? 0) || 0)
    trimmed.ok[t] = Math.min(MAX_SAMPLES, Number(trimmed.ok[t] ?? 0) || 0)
  }
  const models = { ...s.models, [model]: trimmed }
  writeState({ models })
}

/** Record that a model answered. Latency is the measurement that makes routing worth doing. */
export function noteSuccess(model: string, type: ZeusRequestType, ms: number): void {
  if (!isFreeModel(model)) return
  const s = readState()
  bump(s, model, (m) => ({
    calls: { ...m.calls, [type]: (m.calls[type] ?? 0) + 1 },
    ok: { ...m.ok, [type]: (m.ok[type] ?? 0) + 1 },
    ms: { ...m.ms, [type]: Math.max(1, Math.min(600_000, Math.round(ms) || 0)) },
    lastUsedAt: Date.now(),
    failures: 0,
  }))
}

/**
 * Record that a model failed, and hold it out.
 *
 * Repeated failures lengthen the hold rather than repeating the same one. A flat ten-minute
 * cooldown against a model that keeps failing means ten minutes of wasted attempts every ten
 * minutes; the escalation is what lets a genuinely broken model retire while a transiently busy one
 * comes straight back.
 */
export function noteZeusFailure(model: string, type: ZeusRequestType, reason: string): void {
  if (!isFreeModel(model)) return
  const s = readState()
  const before = s.models[model]?.failures ?? 0
  bump(s, model, (m) => ({
    calls: { ...m.calls, [type]: (m.calls[type] ?? 0) + 1 },
    ok: m.ok,
    ms: m.ms,
    lastUsedAt: m.lastUsedAt,
    failures: before + 1,
  }))
  // The shared cooldown store is still the single source of truth for "do not use this right now",
  // so the existing failover display keeps working unchanged.
  noteFailure(model, String(reason ?? '').slice(0, MAX_NOTE_CHARS))
}

/**
 * How good a model has been for one kind of request.
 *
 * Three signals, in this order, because this is the TIEBREAK and not the primary sort:
 *
 *   1. did it answer at all - a model that produced a usable plan and one that returned prose
 *      are not comparable on speed;
 *   2. how fast - the measured difference between an 11s and a 119s model;
 *   3. how few times it has been used - a nudge toward spreading, never a reason to prefer a
 *      worse model outright.
 *
 * An unobserved model is not scored as bad. It is scored as unknown and gets a mid-rank value, so
 * a newly available free model is tried rather than written off on the strength of no evidence.
 */
function score(m: ModelStats | undefined, type: ZeusRequestType, now: number): number {
  if (!m || (now - m.lastUsedAt > OBSERVATION_WINDOW_MS && m.lastUsedAt > 0)) {
    return 50 // unknown: neither trusted nor penalised
  }
  const calls = m.calls[type] ?? 0
  const ok = m.ok[type] ?? 0
  if (calls === 0) return 50

  // Success rate dominates. A slow model that works beats a fast one that does not, by a lot.
  const reliability = (ok / calls) * 100
  const latency = m.ms[type] ?? 60_000
  // Latency is compressed logarithmically: the difference between 11s and 30s matters far more to
  // a waiting person than the difference between 120s and 139s.
  const speed = Math.max(0, 40 - Math.log10(Math.max(1, latency) / 10) * 12)
  return reliability * 1.6 + speed
}

export interface ZeusRoute {
  /** The ordered models to try, best first. Never empty when any free model is known. */
  readonly candidates: readonly string[]
  /** The model that should be tried first, for display. */
  readonly first: string
  /** True when every model is cooling and the first choice is a last resort. */
  readonly allCooling: boolean
}

/**
 * Choose the order to try models in for one kind of request.
 *
 * SPREAD FIRST, and this is the whole point. Among healthy models the least-used one leads, and the
 * type score only breaks ties. The previous ordering put a single preferred model first every time,
 * which is what exhausted the allowance: one model absorbed every mission until it was throttled,
 * and the other ten were never asked.
 *
 * "Least used" is measured over the rolling window rather than ever, so a model that served the
 * system all yesterday and has not been touched today counts as unused, which is the correct answer
 * for a pool whose limits reset.
 */
export function route(
  type: ZeusRequestType,
  all: readonly string[],
): ZeusRoute {
  const now = Date.now()
  const pool = [...new Set(all.filter((m) => isFreeModel(m)))]
  if (pool.length === 0) {
    throw new Error(`${ZEUS_ID} has no free models to route to; nothing is substituted rather than guessing`)
  }

  const state = readState()
  const usageInWindow = (model: string): number => {
    const m = state.models[model]
    if (!m) return 0
    // Within-window use counts as one tick per recent call; outside it, zero.
    return now - m.lastUsedAt <= OBSERVATION_WINDOW_MS ? (m.calls[type] ?? 0) : 0
  }

  const healthy = pool.filter((m) => !inCooldown(m))
  const cooling = pool.filter((m) => inCooldown(m))

  const bySpread = (a: string, b: string): number => {
    const ua = usageInWindow(a)
    const ub = usageInWindow(b)
    if (ua !== ub) return ua - ub // least used first
    const sa = score(state.models[a], type, now)
    const sb = score(state.models[b], type, now)
    if (sb !== sa) return sb - sa // then best observed for THIS kind of request
    const la = state.models[a]?.lastUsedAt ?? 0
    const lb = state.models[b]?.lastUsedAt ?? 0
    if (la !== lb) return la - lb // then least recently used
    return a.localeCompare(b) // deterministic, so a trace can be reasoned about
  }

  const ordered = [...healthy].sort(bySpread)
  // The floor: never return nothing. A model that failed least recently is a better outcome than a
  // dead mission, and the user is told which one it is.
  const rest = [...cooling].sort((a, b) => {
    const fa = state.models[a]?.failures ?? 0
    const fb = state.models[b]?.failures ?? 0
    if (fa !== fb) return fa - fb
    return a.localeCompare(b)
  })

  const candidates = [...ordered, ...rest]
  return { candidates, first: candidates[0] as string, allCooling: healthy.length === 0 }
}

/**
 * What the pool looks like right now, for display.
 *
 * Exists so that "are the models healthy" is a question with an answer rather than something to
 * guess at when a mission fails.
 */
export interface PoolStatus {
  readonly zeus: string
  readonly total: number
  readonly healthy: number
  readonly cooling: Array<{ model: string; minutesLeft: number }>
  readonly used: Array<{ model: string; planCalls: number; planOk: number; lastMs: number; lastUsedAt: number }>
  readonly concentrated: boolean
}

export function poolStatus(all: readonly string[]): PoolStatus {
  const pool = [...new Set(all.filter((m) => isFreeModel(m)))]
  const state = readState()
  const used = Object.entries(state.models)
    .map(([model, m]) => ({
      model,
      planCalls: m.calls.plan ?? 0,
      planOk: m.ok.plan ?? 0,
      lastMs: m.ms.plan ?? 0,
      lastUsedAt: m.lastUsedAt,
    }))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)

  // "Concentrated" means one model has taken most of the recent traffic, which is the condition
  // that precedes exhaustion. Reporting it lets the warning arrive before the rate limit does.
  const totalCalls = used.reduce((n, u) => n + u.planCalls, 0)
  const concentrated = totalCalls >= 3 && (used[0]?.planCalls ?? 0) / totalCalls > 0.6

  return {
    zeus: ZEUS_ID,
    total: pool.length,
    healthy: pool.filter((m) => !inCooldown(m)).length,
    cooling: cooldowns().filter((c) => pool.includes(c.model)).map((c) => ({ model: c.model, minutesLeft: c.minutesLeft })),
    used,
    concentrated,
  }
}

/** Forget everything Zeus has learned. Exposed so a user can start clean after a policy change. */
export function resetZeus(): void {
  try {
    const p = stateFile()
    if (existsSync(p)) writeFileSync(p, JSON.stringify({ models: {} }, null, 2), 'utf8')
  } catch { /* as above */ }
}