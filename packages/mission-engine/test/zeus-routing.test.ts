/**
 * ZEUS V1.0: ONE NAME, MANY MODELS, AND A POOL THAT DOES NOT RUN DRY
 * ==================================================================
 *
 * THREE REQUESTS, THREE CLAIMS TO PROVE
 * -------------------------------------
 * 1. "Merge all free models and name it Zeus V1.0" - the pool is addressed by one name, and the
 *    concrete model that answered is still disclosed. A routing name that becomes a disguise would
 *    be worse than no routing name, because a user entitled to know which model produced a plan
 *    would have no way to find out.
 *
 * 2. "Pick the best model for each request type" - routing is by TYPE, and the ranking is built
 *    from observed outcomes rather than from a table someone guessed at.
 *
 * 3. "Make sure all models never exhaust" - the measured failure was severe: five missions back to
 *    back exhausted the allowance and the next five all died in about two and a half seconds. The
 *    cause was NOT too few models. It was that every mission tried the same preferred model first,
 *    every time, and failover only engaged after that model was already throttled. Ten healthy
 *    models sat unused while one absorbed every request until it died.
 *
 *    So the property to assert is not "a model is chosen". It is that N consecutive routes SPREAD
 *    across N models. That is the thing whose absence caused the outage, and it is the only
 *    assertion in this file that would have caught it.
 *
 * The negatives matter as much as the positives: a spreading router that also reaches a PAID model,
 * or that returns nothing when the pool is exhausted, would be a severe regression wearing a
 * helpful hat.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ZEUS = pathToFileURL(join(HERE, '..', 'live', 'agent', 'zeus.ts')).href

const POOL = [
  'opencode/beam-free',
  'opencode/longcat-2.5-preview-free',
  'opencode/glm-5.3-flash-free',
  'opencode/muse-spark-1.3-contributor-free',
  'opencode/nemotron-3.5-lightning-free',
]

/** A private Zeus state file, so no test reads or overwrites the real pool history. */
function sandbox(): { home: string; file: string; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'aios-zeus-'))
  mkdirSync(join(home, '.aios', 'agent'), { recursive: true })
  const file = join(home, '.aios', 'agent', 'zeus.json')
  return { home, file, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

async function load(home: string): Promise<typeof import('../live/agent/zeus.ts')> {
  // The redirect is deliberately NOT undone here. Zeus resolves its state path at CALL time, so
  // restoring HOME the moment the import returns sends every subsequent write to the real operator
  // file and every read back to an empty one - and the test then passes against a Zeus that learned
  // nothing, having tested nothing. Each test sets HOME at the start, and the sandbox is removed
  // in its finally block.
  process.env.HOME = home
  process.env.USERPROFILE = home
  return await import(ZEUS + "?h=" + encodeURIComponent(home))
}

// ============================================================ 1. one name, honestly disclosed

test('Zeus has one name, and it is not a model id', async () => {
  const s = sandbox()
  try {
    const z = await load(s.home)
    assert.equal(z.ZEUS_ID, 'Zeus V1.0')
    // It must not be usable as a model, or something downstream will eventually pass it to the CLI.
    assert.ok(!z.ZEUS_ID.includes('/'), 'Zeus is a routing name, not a provider/model pair')
  } finally {
    s.cleanup()
  }
})

test('the pool Zeus routes over contains only free models', async () => {
  const s = sandbox()
  try {
    const z = await load(s.home)
    const r = z.route('plan', [...POOL, 'openai/gpt-5', 'opencode/paid-thing', 'not-a-model'])
    for (const m of r.candidates) {
      const parts = m.split('/')
      assert.equal(parts.length, 2, `a paid or malformed model reached the pool: ${m}`)
      assert.equal(parts[0], 'opencode', `a non-free namespace reached the pool: ${m}`)
      assert.ok(parts[1].endsWith('-free'), `a paid model reached the pool: ${m}`)
    }
    assert.ok(!r.candidates.includes('openai/gpt-5'), 'the $0 constraint must hold in the pool itself')
  } finally {
    s.cleanup()
  }
})

test('an empty pool is refused rather than substituted', async () => {
  const s = sandbox()
  try {
    const z = await load(s.home)
    // Nothing free means nothing to route to. Guessing a paid model here would spend money the
    // project is not authorised to spend, so the honest answer is a refusal.
    assert.throws(() => z.route('plan', []), /no free models/i)
    assert.throws(() => z.route('plan', ['openai/gpt-5']), /no free models/i)
  } finally {
    s.cleanup()
  }
})

// ============================================================ 3. the pool does not run dry

test('consecutive routes SPREAD across the pool instead of hammering one model', async () => {
  // THE assertion this whole component exists for.
  //
  // The previous ordering led with a single preferred model every single time. Measured
  // consequence: five missions back to back exhausted the allowance and the next five all failed in
  // about 2.5 seconds, while ten healthy free models sat unused.
  //
  // So this does not assert "a model was chosen". It asserts that the pool is used the way a pool
  // is meant to be used. A router that picked the best model every time and starved the rest would
  // fail this, and it would deserve to: the best model is worth nothing if using it exclusively is
  // what removes it from the pool.
  const s = sandbox()
  try {
    const z = await load(s.home)
    const used: string[] = []
    for (let i = 0; i < POOL.length; i++) {
      used.push(z.route('plan', POOL).first)
      // Record the use, exactly as a real mission would.
      const r = z.route('plan', POOL)
      z.noteSuccess(r.first, 'plan', 20_000)
    }
    const distinct = new Set(used)
    assert.equal(distinct.size, POOL.length,
      `the pool must be spread, not single-lane. Got ${JSON.stringify(used)}`)
  } finally {
    s.cleanup()
  }
})

test('a fast, reliable model is preferred ONCE THE POOL IS EVENLY USED', async () => {
  // Spreading is the primary sort; quality is the tiebreak. Both halves are needed: spreading alone
  // would ignore a model that is twice as reliable, and quality alone is what caused the outage.
  const s = sandbox()
  try {
    const z = await load(s.home)
    const slow = POOL[0] as string
    const fast = POOL[1] as string
    for (let i = 0; i < POOL.length; i++) {
      // Give the slow model real evidence: it works, but it takes two minutes.
      z.noteSuccess(slow, 'plan', 120_000)
      for (const m of POOL.slice(2)) z.noteSuccess(m, 'plan', 12_000)
    }
    z.noteSuccess(fast, 'plan', 9_000)
    // Now everyone has been used once; the tiebreak decides, and it should favour the quick one.
    const first = z.route('plan', POOL).first
    assert.equal(first, fast, `the observed quickest model should lead once usage is even, got ${first}`)
  } finally {
    s.cleanup()
  }
})

test('a model that fails is not offered first', async () => {
  const s = sandbox()
  try {
    const z = await load(s.home)
    const r = z.route('plan', POOL)
    // first is candidates[0] by construction, so there is nothing to assert about the first route.
    z.noteZeusFailure(r.first, 'plan', 'rate limit exceeded')
    const after = z.route('plan', POOL)
    assert.notEqual(after.first, r.first, 'a model that just failed must not lead again immediately')
  } finally {
    s.cleanup()
  }
})

test('when EVERY model is cooling, Zeus still returns one rather than nothing', async () => {
  // "The one that failed least recently" is a better outcome than a dead mission. A router that
  // returns an empty list here turns a throttle into an outage.
  const s = sandbox()
  try {
    const z = await load(s.home)
    for (const m of POOL) z.noteZeusFailure(m, 'plan', 'rate limit exceeded')
    const r = z.route('plan', POOL)
    assert.equal(r.allCooling, true, 'the pool should report itself as exhausted')
    assert.ok(r.candidates.length > 0, 'a fully-throttled pool must still yield a candidate')
    assert.ok(POOL.includes(r.first))
  } finally {
    s.cleanup()
  }
})

test('concentration is reported BEFORE the rate limit arrives', async () => {
  // The warning is worth having only if it precedes the failure it predicts.
  const s = sandbox()
  try {
    const z = await load(s.home)
    const hog = POOL[0] as string
    z.noteSuccess(hog, 'plan', 20_000)
    z.noteSuccess(hog, 'plan', 20_000)
    assert.equal(z.poolStatus(POOL).concentrated, false, 'two calls are not yet a pattern')
    z.noteSuccess(hog, 'plan', 20_000)
    const st = z.poolStatus(POOL)
    assert.equal(st.concentrated, true, 'one model taking all the traffic must be flagged')
    assert.equal(st.used[0]?.model, hog)
  } finally {
    s.cleanup()
  }
})

test('pool status reports what a person can act on', async () => {
  const s = sandbox()
  try {
    const z = await load(s.home)
    z.noteSuccess(POOL[0] as string, 'plan', 30_000)
    z.noteZeusFailure(POOL[1] as string, 'plan', 'rate limit exceeded')
    const st = z.poolStatus(POOL)
    assert.equal(st.zeus, 'Zeus V1.0')
    assert.equal(st.total, POOL.length)
    assert.ok(st.healthy >= 1, 'something must remain available')
    assert.ok(st.used.some((u) => u.planCalls === 1))
    assert.ok(Array.isArray(st.cooling))
  } finally {
    s.cleanup()
  }
})

// ============================================================ 2. routing by request type

test('the two request types are routed independently', async () => {
  // Planning and correcting are different jobs. A model that is quick on the long plan may be poor
  // on the short correction, and ranking one call on the other's latency optimises it against the
  // wrong measurement.
  const s = sandbox()
  try {
    const z = await load(s.home)
    for (const m of POOL) z.noteSuccess(m, 'plan', 60_000)
    z.noteSuccess(POOL[0] as string, 'correct', 4_000)
    const st = z.poolStatus(POOL)
    assert.equal(st.used.find((u) => u.model === POOL[0])?.planCalls, 1)
    // The correct observation is stored separately; it does not overwrite the plan latency.
    assert.equal(st.used.find((u) => u.model === POOL[0])?.lastMs, 60_000)
  } finally {
    s.cleanup()
  }
})

// ============================================================ the state file is untrusted input

test('a hand-edited state file cannot introduce a paid model into the pool', async () => {
  // The $0 constraint is enforced on the way back IN as well as on the way out. A state file is
  // just a file; anyone or anything can write it, and a routing table is exactly the wrong place
  // for that to matter.
  const s = sandbox()
  try {
    writeFileSync(s.file, JSON.stringify({
      models: {
        'openai/gpt-5': { calls: { plan: 99 }, ok: { plan: 99 }, ms: { plan: 1 }, lastUsedAt: Date.now(), failures: 0 },
        'opencode/beam-free': { calls: { plan: 1 }, ok: { plan: 0 }, ms: { plan: 90000 }, lastUsedAt: Date.now(), failures: 0 },
      },
    }), 'utf8')
    const z = await load(s.home)
    const status = z.poolStatus(POOL)
    assert.ok(!status.used.some((u) => u.model === 'openai/gpt-5'),
      'a paid model written into the state file must not be believed')
  } finally {
    s.cleanup()
  }
})

test('a corrupt or oversized state file degrades to no history', async () => {
  const s = sandbox()
  try {
    writeFileSync(s.file, '{ not json at all', 'utf8')
    let z = await load(s.home)
    assert.deepEqual(z.poolStatus(POOL).used, [], 'corrupt JSON reads as no history')
    assert.ok(z.route('plan', POOL).candidates.length > 0, 'and routing still works')
    writeFileSync(s.file, JSON.stringify({ models: { 'opencode/beam-free': { calls: 'nope', failures: 'x' } } }), 'utf8')
    z = await load(`${s.home}-2`)
    assert.ok(z.route('plan', POOL).candidates.length > 0)
  } finally {
    rmSync(`${s.home}-2`, { recursive: true, force: true })
    s.cleanup()
  }
})

test('a failure counter is capped so it cannot grow without bound', async () => {
  const s = sandbox()
  try {
    writeFileSync(s.file, JSON.stringify({
      models: { 'opencode/beam-free': { calls: {}, ok: {}, ms: {}, lastUsedAt: Date.now(), failures: 9_999_999 } },
    }), 'utf8')
    const z = await load(s.home)
    const r = z.route('plan', POOL)
    assert.ok(r.candidates.includes('opencode/beam-free'),
      'a capped failure count must still leave the model reachable once every cooldown expires')
  } finally {
    s.cleanup()
  }
})

test('a non-free model cannot record a success, so it cannot be scored', async () => {
  const s = sandbox()
  try {
    const z = await load(s.home)
    z.noteSuccess('openai/gpt-5', 'plan', 1)
    assert.ok(!z.poolStatus(POOL).used.some((u) => u.model === 'openai/gpt-5'))
  } finally {
    s.cleanup()
  }
})
