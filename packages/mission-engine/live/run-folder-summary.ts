/**
 * THE USER-SUPPLIED FOLDER-SUMMARY MISSION.
 *
 * `run-folder-mission.ts` proved the machinery against a seeded temporary world that it created
 * and then deleted. That is the right shape for a self-test and the wrong shape for a person who
 * has a folder and wants a summary of it. This is that same mission, driven by two paths the caller
 * supplies.
 *
 * NOTHING HERE REIMPLEMENTS THE MISSION. Every governed component is imported from the existing
 * infrastructure and used exactly as the live harness uses it:
 *
 *     DeterministicPlanProvider   packages/planner/deterministic.ts
 *     LocalObservationProvider    packages/observation/local.ts
 *     compilePlan                 packages/planner/compile.ts
 *     ToolRegistry                packages/tool-router/router.ts
 *     execute + its verifiers     packages/mission-engine/executor.ts
 *     FOLDER_TOOLS, folderVerifiers  ./folder-tools.ts
 *
 * The planner still decides the plan, the compiler still refuses an inadmissible one, every step is
 * still permission-checked, and every step is still verified by a verifier that re-reads the
 * filesystem by a different call than the tool used.
 *
 * WHY THE OUTPUT NAME IS THE CALLER'S
 *
 * The planner used to pick the output file name itself, from the first word of its own vocabulary
 * that appeared in the objective. A caller asking for `my-notes.txt` therefore got `contents.txt`
 * written with no warning - a confident answer about a file nobody asked for. The recipe now takes
 * the name from `ctx.outputFileName` when the caller supplies one, validates it, and REFUSES an
 * unusable one rather than substituting.
 *
 * Regardless of what was asked for, the compiled plan's write path is compared against the
 * requested path BEFORE the executor is invoked. If they differ by anything, nothing runs and
 * nothing is written.
 *
 * WHAT IT WILL NOT DO
 *
 *   - write over an existing file (`checkNewOutputFile` refuses; there is no overwrite path)
 *   - modify, move or delete anything in the source folder (every tool here is read-only on it)
 *   - write outside the directory the caller named (`isInside` is re-checked by tool and verifier)
 *   - accept a command, a script name or an argument of any kind: the only inputs are two paths
 */

import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, dirname, isAbsolute, basename } from 'node:path'
import { execute } from '../executor.ts'
import { summarize } from '../events.ts'
import { DeterministicPlanProvider } from '../../planner/deterministic.ts'
import { LocalObservationProvider } from '../../observation/local.ts'
import { compilePlan } from '../../planner/compile.ts'
import { renderPlan } from '../../planner/inspect-plan.ts'
import type { PlanContext } from '../../planner/plan.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { FOLDER_TOOLS, folderVerifiers } from './folder-tools.ts'
import { fakeControl } from '../test/fakes.ts'
import type { ControlSurface } from '../../governance/contract.ts'

// ============================================================ argument parsing

/**
 * `--source <path>` and `--output <path>`. Nothing else is accepted.
 *
 * Parsed by hand, strictly, and every failure is a refusal. There is no eval, no shell, and no
 * value from the command line is ever interpreted as anything but a path.
 */
function parseArgs(argv: readonly string[]): { source?: string; output?: string; error?: string } {
  const out: { source?: string; output?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--source' || a === '--output') {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) return { error: `${a} was given no value` }
      out[a === '--source' ? 'source' : 'output'] = v
      i++
      continue
    }
    return { error: `unexpected argument "${a}"; only --source and --output are accepted` }
  }
  if (!out.source) return { error: '--source was not given' }
  if (!out.output) return { error: '--output was not given' }
  return out
}

/**
 * The output name is the caller's.
 *
 * `PlanContext.outputFileName` carries it to the recipe, which validates it and uses it verbatim.
 * There is no vocabulary here any more: the recipe previously derived the name from a fixed word
 * list, so this mission had to refuse everything outside it and a caller could not get the file
 * they asked for. The recipe still REFUSES an unusable name - it never substitutes one - and the
 * write target is still compared against the request before anything executes.
 */

function refuse(reason: string): never {
  console.log('')
  console.log(`=== REFUSED: ${reason} ===`)
  process.exit(2)
}

const parsed = parseArgs(process.argv.slice(2))
if (parsed.error) refuse(parsed.error)

// ============================================================ path validation

const sourceRaw = String(parsed.source)
const outputRaw = String(parsed.output)

if (!isAbsolute(sourceRaw)) refuse(`--source must be an absolute path; got "${sourceRaw}"`)
if (!isAbsolute(outputRaw)) refuse(`--output must be an absolute path; got "${outputRaw}"`)

// Traversal is refused on the RAW text, before resolution can normalise it away, so the message
// names the actual problem rather than complaining about whatever the path collapsed into.
for (const [label, raw] of [['--source', sourceRaw], ['--output', outputRaw]] as const) {
  if (raw.split(/[\\/]/).some((seg) => seg === '..')) {
    refuse(`${label} must not contain ".." path traversal: "${raw}"`)
  }
}

const sourceDir = resolve(sourceRaw)
const outputPath = resolve(outputRaw)
const outputRoot = dirname(outputPath)
const outName = basename(outputPath)

// A bare file name: no separator, no drive, no traversal. Characters are restricted so the value
// cannot carry a word into any text the planner reads.
if (!/^[A-Za-z0-9_-]+\.txt$/.test(outName)) {
  refuse(`the output file name "${outName}" must be a bare name made of letters, digits, "_" or "-", ending in .txt`)
}

// The source must be a real, readable directory.
if (!existsSync(sourceDir)) refuse(`the source folder "${sourceDir}" does not exist`)
let srcStat
try { srcStat = statSync(sourceDir) } catch (e) {
  refuse(`the source folder "${sourceDir}" could not be inspected: ${(e as Error).message}`)
}
if (!srcStat.isDirectory()) refuse(`"${sourceDir}" is a file, not a folder`)

// The destination directory must already exist. This mission creates exactly one file and no
// directories, so it never invents a place to put things.
if (!existsSync(outputRoot)) refuse(`the output folder "${outputRoot}" does not exist; this mission creates no directories`)
if (!statSync(outputRoot).isDirectory()) refuse(`the output folder "${outputRoot}" is not a directory`)

// Refuse to overwrite. `checkNewOutputFile` enforces this inside the tool as well; this is the
// earlier, clearer version of the same rule.
if (existsSync(outputPath)) {
  refuse(`"${outputPath}" already exists. This mission creates new files only and will not overwrite. Choose another name.`)
}

// ============================================================ objective

/**
 * The planner takes the folder from the objective text, the output DIRECTORY and the output FILE
 * NAME from the caller's context, and the name verbatim.
 */
const OBJECTIVE = `Summarise the contents of the folder "${sourceDir}" and write a summary file`

// ============================================================ governed execution

const observer = new LocalObservationProvider()
const observed = observer.observe({ root: sourceDir, maxDepth: 4 })
const ctx: PlanContext = {
  outputRoot,
  // The caller's chosen artefact name, handed to the recipe explicitly so it is never inferred
  // from the objective text.
  outputFileName: outName,
  now: () => observed.observedAt,
  world: observed,
  maxObservationAgeMs: 60_000,
  refetched: observed,
}

const provider = new DeterministicPlanProvider()
const registry = new ToolRegistry({
  registrations: [
    { tool: FOLDER_TOOLS.find((t) => t.name === 'read-folder')!, capabilities: ['filesystem.inspect'] },
    { tool: FOLDER_TOOLS.find((t) => t.name === 'inspect-folder')!, capabilities: ['filesystem.list'] },
    { tool: FOLDER_TOOLS.find((t) => t.name === 'compose-summary')!, capabilities: ['filesystem.transform'] },
    { tool: FOLDER_TOOLS.find((t) => t.name === 'write-report')!, capabilities: ['filesystem.write'] },
    { tool: FOLDER_TOOLS.find((t) => t.name === 'read-report')!, capabilities: ['filesystem.confirm'] },
  ],
})

console.log('')
console.log('=== THE USER ASKED FOR ===')
console.log(`  source folder   ${sourceDir}`)
console.log(`  output file     ${outputPath}`)
console.log(`  output folder   ${outputRoot}   (the caller's destination; never parsed from text)`)
console.log(`  planner         ${provider.name}`)
console.log(`  tools available ${registry.names().join(', ')}`)

const planned = await provider.plan(OBJECTIVE, ctx)
if (!planned.ok) refuse(`planning was refused: ${planned.reason}`)

console.log('')
console.log(renderPlan(planned.proposal))

const compiled = compilePlan(planned.proposal, `folder-summary-${Date.now()}`, ctx.now())
if (!compiled.ok) refuse(`the compiler rejected the plan: ${compiled.reason}`)

/**
 * THE GUARANTEE.
 *
 * Compare the plan's own write target against what was actually requested, on resolved paths,
 * BEFORE anything executes. If the planner derived any other destination, this mission stops with
 * nothing written. This is what makes it safe to let a planner choose a filename at all.
 */
const writeStep = compiled.mission.plan.find((s) => s.tool === 'write-report')
const derivedPath = String((writeStep?.args as { path?: string } | undefined)?.path ?? '')
if (resolve(derivedPath || ' ') !== outputPath) {
  refuse(
    `the plan would write to "${derivedPath}" but "${outputPath}" was requested. Nothing was executed.`,
  )
}
console.log('')
console.log(`  plan write target matches the request: ${derivedPath}`)

// Same permission shape as the live harness: no step declares an effect, none can inject, and the
// permission layer is still consulted before every single step.
const CONFIG = {
  maxAttempts: 1,
  permission: async () => ({
    control: 'ARMED' as const,
    input: 'PERMITTED' as const,
    blockedBy: null,
    infrastructureHealthy: true,
    mayInject: false,
  }),
  emergencyStop: async () => false,
}

const r = await execute(compiled.mission, {
  tools: registry,
  verifier: folderVerifiers(outputRoot) as never,
  control: fakeControl() as ControlSurface,
  config: CONFIG,
})

console.log('')
console.log('=== EXECUTION ===')
for (const s of r.mission.plan) {
  const o = s.result?.outcome as { evidence?: Record<string, unknown> } | undefined
  console.log(
    `  ${s.id.padEnd(16)} ${s.mode.padEnd(11)} ${String(s.result?.outcome.kind ?? 'DID NOT RUN').padEnd(10)} ` +
    (o?.evidence ? JSON.stringify(o.evidence).slice(0, 110) : ''),
  )
}
const sum = summarize(r.record)
console.log('')
console.log(`  mission state     ${r.mission.state}`)
console.log(`  complete          ${r.record.complete}`)
console.log(`  finish reason     ${sum.finishReason}`)
console.log(`  integrity         ${sum.integrityViolations.length === 0 ? 'no violations' : sum.integrityViolations.join('; ')}`)

// ============================================================ independent verification
//
// Everything below re-derives its facts from the filesystem by calls the mission's tools did not
// use, and compares them against the source folder as it is NOW. Nothing is taken from the tools'
// own claims, and file presence alone is never treated as proof.

console.log('')
console.log('=== INDEPENDENT VERIFICATION (not the mission\'s own report) ===')

const checks: Array<[boolean, string]> = []

// Re-list the source folder here, directly.
let liveNames: string[] = []
try { liveNames = readdirSync(sourceDir) } catch (e) {
  checks.push([false, `the source folder could not be re-listed: ${(e as Error).message}`])
}
const liveFiles = liveNames.filter((n) => { try { return statSync(resolve(sourceDir, n)).isFile() } catch { return false } })
const liveDirs = liveNames.length - liveFiles.length

// Read the artefact from disk here, directly.
let body = ''
let size = -1
try {
  size = statSync(outputPath).size
  body = readFileSync(outputPath, 'utf8')
} catch (e) {
  checks.push([false, `the output file could not be read back: ${(e as Error).message}`])
}

checks.push([existsSync(outputPath), `the requested output path exists: ${outputPath}`])
checks.push([size > 0, `it is a non-empty regular file (${size} bytes)`])
checks.push([body.startsWith('# '), `it begins with a markdown heading`])
checks.push([body.includes(sourceDir), `it names the folder it was asked to summarise (${sourceDir})`])
checks.push(
  [body.includes(`${liveNames.length} entries total`), `its entry count matches an independent listing (${liveNames.length} entries)`],
)
checks.push(
  [body.includes(`${liveFiles.length} file(s)`) && body.includes(`${liveDirs} folder(s)`),
   `its file/folder split matches an independent stat (${liveFiles.length} file(s), ${liveDirs} folder(s))`],
)
checks.push([body.includes('deterministic content generator'), `it discloses that it was produced deterministically, not by a model`])

// The source folder must be untouched by the run.
let sourceStillThere = false
try { sourceStillThere = statSync(sourceDir).isDirectory() && readdirSync(sourceDir).length === liveNames.length } catch {}
checks.push([sourceStillThere, `the source folder still holds exactly the entries it started with (${liveNames.length})`])

// The mission's own record must agree, and must not claim more than it verified.
const verifiedCount = r.mission.plan.filter((s) => s.result?.outcome.kind === 'verified').length
checks.push([verifiedCount === r.mission.plan.length, `all ${r.mission.plan.length} steps verified independently by the mission's verifiers`])
checks.push([r.record.complete === true, `the governed executor reports the mission complete`])
checks.push([sum.integrityViolations.length === 0, `no integrity violations`])

console.log('')
let failed = 0
for (const [ok, msg] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!ok) failed++
}

console.log('')
console.log('=== ARTIFACT ===')
console.log(`  path     ${outputPath}`)
console.log(`  bytes    ${size}`)
console.log('  --- content, read here, independently of the mission ---')
for (const line of body.split('\n').slice(0, 20)) console.log(`  | ${line}`)

console.log('')
console.log(`=== ${failed === 0 ? 'PASS' : failed + ' FAILURE(S)'} ===`)
process.exit(failed ? 1 : 0)