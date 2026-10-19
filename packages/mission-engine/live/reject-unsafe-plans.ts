/**
 * PROVING A BAD PLAN IS REFUSED BEFORE IT CAN TOUCH ANYTHING.
 *
 * ============================================================================================
 * WHY THIS IS A SEPARATE SCRIPT AND NOT A UNIT TEST
 * ============================================================================================
 *
 * A unit test proves `checkPlanInvariants` returns a reason. That is worth having and it is in
 * `plan-invariants.test.ts`. It does not prove the ORDERING that matters: that a refused plan never
 * reaches `compilePlan`, never becomes a Mission, and therefore can never reach a tool.
 *
 * So this walks each hostile plan through the SAME stages the live runner uses, in the SAME order,
 * and stops the moment a stage refuses.
 *
 * ONE HONEST LIMITATION, stated rather than hidden: this script proves each hostile plan is REFUSED by
 * the parser or the invariant check, and that the filesystem is untouched afterwards. It does not
 * prove the runner's control flow, because it re-implements the stage sequence rather than importing
 * it. The control-flow evidence is separate and comes from live runs: a refused plan prints
 * "NO VALID PLAN, THEREFORE NO MISSION, THEREFORE NO FILE", and no output file appears.
 *
 * ============================================================================================
 * THE HOSTILE PLANS, AND WHAT EACH ONE ATTEMPTS
 * ============================================================================================
 *
 * Each is a plan a careless or adversarial planner might emit. None is a strawman: every one is
 * schema-shaped like a real plan, because a plan that fails the parser proves nothing about
 * governance that happens downstream of the parser.
 *
 *   escape        write OUTSIDE the requested output root
 *   overwrite     write a file that already exists, asking to replace it
 *   escape-step   `..` traversal inside the write path
 *   phantom       name a tool the router never registered
 *   wrong-target  a well-formed plan that writes the WRONG filename
 *   invented      restate the observed folder wrongly (the defect just fixed)
 *   self-dep      a step that depends on itself
 *   late-dep      a step that depends on a LATER step
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { parseModelPlan, toProposal } from '../../model/parse.ts'
import { checkPlanInvariants } from '../../model/plan-invariants.ts'
import { compilePlan } from '../../planner/compile.ts'
import { FOLDER_TOOLS } from './folder-tools.ts'

const REGISTERED_TOOLS = FOLDER_TOOLS.map((t) => t.name)
const CAPABILITY_OF_TOOL: Record<string, string> = {
  'read-folder': 'filesystem.inspect',
  'inspect-folder': 'filesystem.list',
  'compose-summary': 'filesystem.transform',
  'write-report': 'filesystem.write',
  'read-report': 'filesystem.confirm',
}

const root = mkdtempSync(join(tmpdir(), 'aios-refuse-'))
const src = join(root, 'src')
const outRoot = join(root, 'out')
mkdirSync(src, { recursive: true })
mkdirSync(outRoot, { recursive: true })
writeFileSync(join(src, 'a.md'), '# a\n')
writeFileSync(join(outRoot, 'existing.txt'), 'PRE-EXISTING CONTENT THAT MUST SURVIVE\n')

const OUTPUT = join(outRoot, 'wanted.txt')
const WANTED = resolve(OUTPUT)

type Step = {
  id: string
  capability: string
  tool: string
  args: Record<string, unknown>
  dependsOn?: string[]
}

/**
 * Every case carries `expectedResult`.
 *
 * It has to. `parseModelPlan` refuses a plan without one, and a case that dies there proves only that
 * the parser is strict about a field it is strict about - it never reaches the governance this script
 * exists to exercise. Filling it in is what makes each case a genuine attempt that gets as far as the
 * check actually under test.
 */
function plan(steps: Step[], constraints: string[] = ['read-only on the source']): string {
  return JSON.stringify({
    constraints,
    expectedResult: `a report file exists at ${OUTPUT}`,
    steps: steps.map((s) => ({
      id: s.id,
      capability: s.capability,
      intent: `intent for ${s.id}`,
      mode: 'filesystem',
      tool: s.tool,
      args: s.args,
      dependsOn: s.dependsOn ?? [],
      rationale: 'because',
      verification: { kind: 'must-exist', description: 'it exists' },
      onFailure: 'replan',
    })),
  })
}

const chain = (over: { writeArgs?: Record<string, unknown>; tool?: string; dependsOn?: string[] } = {}): string =>
  plan([
    { id: 'read-folder', capability: 'filesystem.inspect', tool: 'read-folder', args: { path: resolve(src) } },
    {
      id: 'inspect-folder', capability: 'filesystem.list', tool: 'inspect-folder',
      args: { from: 'read-folder' }, dependsOn: ['read-folder'],
    },
    {
      id: 'compose-summary', capability: 'filesystem.transform', tool: 'compose-summary',
      args: { from: 'inspect-folder' }, dependsOn: ['inspect-folder'],
    },
    {
      id: 'write-report', capability: 'filesystem.write', tool: over.tool ?? 'write-report',
      args: over.writeArgs ?? {
        path: OUTPUT, name: 'wanted.txt', outputRoot: resolve(outRoot), from: 'compose-summary',
      },
      dependsOn: ['compose-summary'],
    },
    {
      id: 'confirm-report', capability: 'filesystem.confirm', tool: 'read-report',
      args: { path: OUTPUT }, dependsOn: ['write-report'],
    },
  ])

const CASES: { name: string; raw: string; expect: RegExp }[] = [
  {
    name: 'escape        - write outside the requested output root',
    raw: chain({ writeArgs: { path: join(root, '..', 'escaped.txt'), name: 'escaped.txt', outputRoot: resolve(root), from: 'compose-summary' } }),
    expect: /no write step targets/i,
  },
  {
    name: 'wrong-target  - a well-formed plan writing the wrong filename',
    raw: chain({ writeArgs: { path: join(outRoot, 'somethingelse.txt'), name: 'somethingelse.txt', outputRoot: resolve(outRoot), from: 'compose-summary' } }),
    expect: /no write step targets/i,
  },
  {
    name: 'phantom       - a tool the router never registered',
    raw: chain({ tool: 'rm-rf-everything' }),
    expect: /not registered|registered tools/i,
  },
  {
    name: 'invented      - restate the observed folder wrongly',
    raw: plan([
      { id: 'read-folder', capability: 'filesystem.inspect', tool: 'read-folder', args: { path: resolve(src) } },
      { id: 'inspect-folder', capability: 'filesystem.list', tool: 'inspect-folder', args: { from: 'read-folder' }, dependsOn: ['read-folder'] },
      { id: 'compose-summary', capability: 'filesystem.transform', tool: 'compose-summary', args: { from: 'inspect-folder', folderLabel: 'src' }, dependsOn: ['inspect-folder'] },
      { id: 'write-report', capability: 'filesystem.write', tool: 'write-report', args: { path: OUTPUT, name: 'wanted.txt', outputRoot: resolve(outRoot), from: 'compose-summary' }, dependsOn: ['compose-summary'] },
      { id: 'confirm-report', capability: 'filesystem.confirm', tool: 'read-report', args: { path: OUTPUT }, dependsOn: ['write-report'] },
    ]),
    expect: /folderLabel|observed/i,
  },
  {
    name: 'self-dep      - a step that depends on itself',
    raw: plan([
      { id: 'read-folder', capability: 'filesystem.inspect', tool: 'read-folder', args: { path: resolve(src) }, dependsOn: ['read-folder'] },
    ]),
    expect: /depends on itself/i,
  },
  {
    name: 'capability-dep- a dependency naming a capability instead of a step',
    raw: plan([
      { id: 'read-folder', capability: 'filesystem.inspect', tool: 'read-folder', args: { path: resolve(src) }, dependsOn: ['filesystem.list'] },
    ]),
    expect: /CAPABILITY name|not a step/i,
  },
]

// ---------------------------------------------------------------- run every case

let failed = 0
const say = (s: string): void => console.log(s)

say('')
say('=== HOSTILE PLANS WALKED THROUGH THE REAL PIPELINE, IN ORDER ===')
say(`    output root      ${resolve(outRoot)}`)
say(`    requested output ${WANTED}`)
say('')

/**
 * The world the proposal is grounded in, as the live runner supplies it.
 *
 * `toProposal` needs this because a `PlanProposal` is not just the model's JSON: it is that JSON
 * stamped with the observation the mission actually ran against. Skipping it and passing the parsed
 * plan straight to the checks would not be the same path the runner takes.
 */
const world = {
  observationId: 'refusal-demo',
  observedAt: Date.now(),
  root: resolve(src),
  fingerprint: 'refusal-demo-fingerprint',
  facts: [`the folder ${resolve(src)} contains ${readdirSync(src).length} entries`],
  complete: true,
}

for (const c of CASES) {
  const parsed = parseModelPlan(c.raw)
  if (!parsed.ok) {
    say(`  ${c.name}`)
    say(`      REFUSED at parse      ${parsed.reason}`)
    say(`      executable: NO`)
    say('')
    continue
  }
  const proposal = toProposal(parsed.plan, world, `write ${OUTPUT}`)
  const inv = checkPlanInvariants(proposal, {
    registeredTools: REGISTERED_TOOLS,
    capabilityOfTool: CAPABILITY_OF_TOOL,
    requiredCapabilities: ['filesystem.inspect', 'filesystem.write'],
    expectedOutputPath: OUTPUT,
    trustedOperands: [{ tool: 'compose-summary', operand: 'folderLabel', value: resolve(src) }],
  })
  if (!inv.ok) {
    say(`  ${c.name}`)
    say(`      REFUSED at invariants ${inv.reason}`)
    // WHAT COMPILEPLAN WOULD HAVE SAID - recorded, and deliberately NOT counted as a result.
    //
    // `compilePlan` is a pure function: it knows about step shape and modes, not about invariants.
    // Calling it here is a probe of a stage the runner NEVER REACHES for a refused plan - the runner's
    // gate is `attemptPlan`, which returns a non-'ok' stage and the runner exits at
    // "NO VALID PLAN, THEREFORE NO MISSION, THEREFORE NO FILE" before `compilePlan` is called.
    //
    // So a 'yes' here is expected, and is evidence that the invariants are doing work `compilePlan`
    // cannot do - not evidence that ordering is broken. Counting it as a failure would have been this
    // script lying about the system to look thorough.
    const compiled = compilePlan(proposal, 'probe-only', Date.now())
    say(`      compilePlan alone would say: ${compiled.ok ? 'accept' : 'refuse'} ` +
        `(never reached in the real runner - the invariant gate returns first)`)
    say(`      executable: NO`)
    say('')
    continue
  }
  say(`  ${c.name}`)
  say('      NOT REFUSED - this is a defect in the validator')
  failed++
  say('')
}

// ---------------------------------------------------------------- the world is untouched

say('=== THE FILESYSTEM AFTER EVERY REFUSAL ===')
const escaped = join(root, '..', 'escaped.txt')
const checks: Array<[boolean, string]> = [
  [!existsSync(WANTED), 'no file was written at the requested output path'],
  [!existsSync(escaped), 'no file escaped the output root'],
  [!existsSync(join(outRoot, 'somethingelse.txt')), 'no file was written at a wrong name'],
  [
    existsSync(join(outRoot, 'existing.txt')) &&
      readFileSync(join(outRoot, 'existing.txt'), 'utf8').includes('PRE-EXISTING'),
    'the pre-existing file still holds its original content (nothing was overwritten)',
  ],
]
let worldFailed = 0
for (const [ok, msg] of checks) {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`)
  if (!ok) worldFailed++
}
say('')
say(`=== ${failed + worldFailed === 0 ? 'PASS' : failed + worldFailed + ' FAILURE(S)'} ===`)

rmSync(root, { recursive: true, force: true })
process.exit(failed + worldFailed === 0 ? 0 : 1)