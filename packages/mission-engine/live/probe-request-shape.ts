/**
 * A FAST PROBE FOR THE MODEL-FACING REQUEST FORMAT.
 *
 * Sends several renderings of the SAME information to the same local model and reports which one
 * produces a parseable `PlanProposal`. It exists because the full mission harness takes ~7 minutes per
 * attempt on this machine, and tuning a prompt at that rate is not possible.
 *
 * It does NOT weaken anything. Every rendering is parsed by the same strict `parseModelPlan`, and a
 * rendering only counts as a success if the parser accepts it. The question being asked is narrow and
 * factual - which prompt shape does this model answer - and it is not a licence to accept weaker plans.
 *
 * The renderings exist because the model's 0/4 output revealed a real flaw in the REQUEST: its
 * top-level keys were `objective`, `availableCapabilities`, `outputRoot`, `world`, and its output came
 * back with those same keys. A completion model reads a JSON object as a template for what comes next,
 * so a request shaped like the answer teaches it to echo the request.
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { LocalObservationProvider } from '../../observation/local.ts'
import { filesIn, directoriesIn } from '../../observation/world.ts'
import { SYSTEM_INSTRUCTIONS, buildExample, CAPABILITY_RULE } from '../../model/protocol.ts'
import { CAPABILITIES } from '../../planner/plan.ts'
import type { WorldState } from '../../observation/world.ts'
import { parseModelPlan } from '../../model/parse.ts'
import { buildRequest } from '../../model/provider.ts'

const PORT = Number(process.env.AIOS_LOCAL_MODEL_PORT ?? 8792)
const URL = `http://127.0.0.1:${PORT}/v1/chat/completions`

const world = mkdtempSync(join(tmpdir(), 'aios-probe-'))
const SUBJECT = join(world, 'subject')
mkdirSync(SUBJECT, { recursive: true })
for (const [name, body] of [['alpha.md', '# alpha\n'], ['beta.txt', 'beta\n'], ['gamma.json', '{"a":1}\n']] as const) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(SUBJECT, name), body, 'utf8')
}
const OBS: WorldState = new LocalObservationProvider().observe({ root: SUBJECT, maxDepth: 3 })
const OUT = join(world, 'out')
mkdirSync(OUT, { recursive: true })
const objective = `Summarise the contents of the folder "${SUBJECT}" and write the summary to a new file.`

/** The facts, as plain lines. Key names deliberately do NOT match the response's key names. */
function facts(): string {
  const L: string[] = []
  L.push(`folder observed: ${OBS.scope.root}`)
  L.push(`where you may write: ${OUT}`)
  L.push('files observed:')
  for (const f of filesIn(OBS)) L.push(`  ${f.relative} (${f.sizeBytes ?? 0} bytes)`)
  L.push(`subfolders: ${directoriesIn(OBS).map((d) => d.relative).join(', ') || 'none'}`)
  return L.join('\n')
}

/**
 * The production request, via the real `buildRequest`.
 *
 * Rendering A previously hand-wrote the OLD key names, so re-running the probe after the rename would
 * have tested a shape the system no longer sends. Reading it from the real builder is what makes this
 * probe a measurement of the shipped interface rather than of a copy of it.
 */
function productionRequest(): string {
  return JSON.stringify(buildRequest(objective, OBS, OUT, CAPABILITIES))
}

/**
 * The example, filled with THIS request's real folder and output path - the same call the provider
 * makes. The previous version of this probe used a literal `<the observed root>` placeholder, and the
 * model faithfully copied it into a plan. That is a defect in the probe AND in the shipped prompt, and
 * it is the reason `buildExample` takes real values: a worked example with fake data teaches copying.
 */
const EX = buildExample(OBS.scope.root, join(OUT, 'summary.txt'))

interface Rendering { label: string; system: string; user: string }

const RENDERINGS: Rendering[] = [
  {
    label: 'P  THE PRODUCTION request, straight from buildRequest()',
    system: `${SYSTEM_INSTRUCTIONS}\n\n${CAPABILITY_RULE}\n\nEXAMPLE:\n${EX}`,
    user: productionRequest(),
  },
  {
    label: 'A  the OLD JSON request - keys collided with the response (the bug)',
    system: `${SYSTEM_INSTRUCTIONS}\n\n${CAPABILITY_RULE}\n\nEXAMPLE:\n${EX}`,
    user: JSON.stringify({
      objective,
      availableCapabilities: [...CAPABILITIES],
      outputRoot: OUT,
      world: {
        root: OBS.scope.root, observationId: OBS.observationId, observedAt: OBS.observedAt,
        fingerprint: OBS.fingerprint,
        files: filesIn(OBS).map((f) => ({ path: f.path, relative: f.relative, bytes: f.sizeBytes ?? 0, extension: f.extension ?? '' })),
        directories: directoriesIn(OBS).map((d) => d.relative),
        maxDepth: 2, extensions: [],
        programs: OBS.capabilities.map((c) => ({ name: c.name, path: c.path, exists: c.exists, permitted: c.permitted })),
      },
    }, null, 2),
  },
  {
    label: 'B  plain-text facts, no JSON at all',
    system: `${SYSTEM_INSTRUCTIONS}\n\n${CAPABILITY_RULE}\n\nEXAMPLE OF A CORRECT REPLY:\n${EX}`,
    user: `WHAT THE USER ASKED FOR:\n${objective}\n\nWHAT IS ON THIS MACHINE:\n${facts()}`,
  },
  {
    label: 'C  plain-text facts + an explicit "reply with this shape" pointer',
    system: `${SYSTEM_INSTRUCTIONS}\n\n${CAPABILITY_RULE}\n\nEXAMPLE OF A CORRECT REPLY (copy the shape, not the paths):\n${EX}`,
    user: `WHAT THE USER ASKED FOR:\n${objective}\n\nWHAT IS ON THIS MACHINE:\n${facts()}\n\nNow reply with your plan JSON and nothing else.`,
  },
  {
    label: 'D  compact JSON with short renamed keys (what the 0.5B answered best)',
    system: `${SYSTEM_INSTRUCTIONS}\n\n${CAPABILITY_RULE}\n\nEXAMPLE OF A CORRECT REPLY:\n${EX}`,
    user: JSON.stringify({
      task: objective,
      mayUse: [...CAPABILITIES],
      mayWriteHere: OUT,
      observed: {
        at: OBS.scope.root,
        entries: filesIn(OBS).map((f) => `${f.relative} (${f.sizeBytes ?? 0}b)`),
        subfolders: directoriesIn(OBS).map((d) => d.relative),
      },
    }),
  },
]

async function ask(r: Rendering): Promise<{ text: string; ms: number; tokens: number; meta: Record<string, unknown> }> {
  const t0 = Date.now()
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'probe', temperature: 0,
      messages: [
        { role: 'system', content: r.system },
        { role: 'user', content: r.user },
      ],
    }),
    signal: AbortSignal.timeout(300_000),
  })
  const json = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { completion_tokens?: number; prompt_tokens?: number }
    local_inference?: Record<string, unknown>
    error?: string
  }
  if (!res.ok) throw new Error(`${res.status}: ${json.error}`)
  return {
    text: json.choices?.[0]?.message?.content ?? '',
    ms: Date.now() - t0,
    tokens: json.usage?.completion_tokens ?? 0,
    meta: json.local_inference ?? {},
  }
}

console.log('')
console.log('#'.repeat(78))
console.log('# WHICH REQUEST SHAPE DOES THIS MODEL ACTUALLY ANSWER?')
console.log('#'.repeat(78))
console.log('')
console.log(`  model on 127.0.0.1:${PORT}`)
console.log(`  subject ${filesIn(OBS).length} files, parsed by the SAME strict parser in every case`)
console.log('')

const results: Array<{ label: string; ok: boolean; why: string; ms: number; tokens: number; meta: Record<string, unknown>; text: string }> = []

for (const r of RENDERINGS) {
  let a: Awaited<ReturnType<typeof ask>>
  try {
    a = await ask(r)
  } catch (e) {
    results.push({ label: r.label, ok: false, why: `request failed: ${(e as Error).message}`, ms: 0, tokens: 0, meta: {}, text: '' })
    continue
  }
  const parsed = parseModelPlan(a.text)
  const why = parsed.ok
    ? `PARSED, ${parsed.plan.steps.length} steps: ${parsed.plan.steps.map((s) => s.capability).join(', ')}`
    : `[${parsed.code}] ${parsed.reason.slice(0, 120)}`
  results.push({ label: r.label, ok: parsed.ok, why, ms: a.ms, tokens: a.tokens, meta: a.meta, text: a.text })

  console.log('')
  console.log(`--- ${r.label} ---`)
  console.log(`  ${(a.ms / 1000).toFixed(1)}s   ${a.tokens} tokens   repetition=${a.meta.repetition_ratio}   eos=${a.meta.stopped_on_eos}`)
  console.log(`  parsed: ${parsed.ok ? 'YES' : 'no'}   ${why}`)
  console.log(`  first 700 chars of what it actually said:`)
  console.log(a.text.slice(0, 700).split('\n').map((l) => `    | ${l}`).join('\n'))
}

console.log('')
console.log('='.repeat(78))
console.log('=== SUMMARY ===')
console.log('='.repeat(78))
for (const r of results) {
  console.log(`  ${r.ok ? 'PARSES ' : 'rejects'} ${(r.ms / 1000).toFixed(1).padStart(6)}s ${r.tokens.toString().padStart(4)} tok  ${r.label}`)
  console.log(`          ${r.why}`)
}
const winners = results.filter((r) => r.ok)
console.log('')
console.log(`  ${winners.length} of ${results.length} renderings produced a parseable plan.`)
if (winners.length) {
  const best = winners.reduce((a, b) => (a.ms < b.ms ? a : b))
  console.log(`  fastest that parsed: ${best.label}  (${(best.ms / 1000).toFixed(1)}s)`)
}

rmSync(world, { recursive: true, force: true })
console.log('')
console.log(`  world removed: ${!existsSync(world)}`)
process.exit(0)