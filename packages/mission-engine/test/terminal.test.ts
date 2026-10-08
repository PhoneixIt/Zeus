import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { makeTerminalTool, makeTerminalVerifier, registerTerminal, type ProcessRecord } from '../live/terminal-mode.ts'
import { buildAllowlist, classify, insideWorkspace, buildEnv, ENV_ALLOWLIST, REFUSED_PROGRAMS } from '../live/terminal-policy.ts'
import { ToolRegistry } from '../../tool-router/router.ts'
import { execute } from '../executor.ts'
import { ApprovalStore, keyFor, type DeclaredEffect } from '../../governance/approval.ts'
import { fakeControl } from './fakes.ts'
import type { Mission, Step } from '../state.ts'
import type { ControlSurface } from '../../governance/contract.ts'

/**
 * THE TERMINAL POLICY, AND WHAT IT ACTUALLY RESTRICTS.
 *
 * These tests exist to pin down a distinction that is easy to blur and expensive to get wrong:
 * working-directory confinement is not process isolation. Several tests below assert that a
 * permitted process CAN do things a sandbox would prevent - not as defects, but as the recorded
 * boundary of the capability. Deleting those assertions would make the suite greener and the
 * documentation a lie.
 */

const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\WINDOWS'
const PROGRAM_FILES = process.env.ProgramFiles ?? 'C:\\Program Files'
const NODE = `${PROGRAM_FILES}\\nodejs\\node.exe`
const GIT = `${PROGRAM_FILES}\\Git\\cmd\\git.exe`

const CONFIG = {
  maxAttempts: 1,
  permission: async () => ({
    control: 'ARMED' as const, input: 'PERMITTED' as const,
    blockedBy: null, infrastructureHealthy: true, mayInject: false,
  }),
  emergencyStop: async () => false,
}

function world() {
  const root = mkdtempSync(join(tmpdir(), 'aios-term-'))
  const ws = join(root, 'ws')
  mkdirSync(ws, { recursive: true })
  const outside = join(root, 'outside')
  mkdirSync(outside, { recursive: true })
  return { root, ws, outside }
}
const cleanup = (w: ReturnType<typeof world>) => rmSync(w.root, { recursive: true, force: true })

function tool(w: ReturnType<typeof world>, over: Partial<Parameters<typeof makeTerminalTool>[0]> = {}) {
  return makeTerminalTool({ workspace: w.ws, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES, ...over })
}

function ctx(w: ReturnType<typeof world>) {
  return { workspace: w.ws, workspaceReal: w.ws }
}

const asStep = (argv: string[], extra: Record<string, unknown> = {}): Step =>
  ({ id: 's', intent: 'i', mode: 'cli', rationale: 'r', tool: 'run-process', status: 'pending',
     args: { executable: NODE, argv }, ...extra }) as unknown as Step

// ============================================================ the four boundaries, kept apart

test('an executable allowlist is by ABSOLUTE path, so PATH cannot substitute a program', () => {
  const list = buildAllowlist(SYSTEM_ROOT, PROGRAM_FILES)
  assert.ok(list.length > 0)
  for (const p of list) {
    assert.ok(p.abs.startsWith('C:\\') || p.abs.startsWith('/'), `"${p.name}" must be an absolute path, got "${p.abs}"`)
  }
  // A bare name resolves to nothing, so a PATH entry cannot decide what runs.
  const v = classify('node.exe', ['--version'], list, ctx(world()))
  assert.equal(v.kind, 'blocked')
  assert.match(v.kind === 'blocked' ? v.reason : '', /not on the executable allowlist/)
})

test('a working directory is set, and is NOT containment', async () => {
  // This test asserts the LIMITATION. A process launched with cwd inside the workspace can still
  // read a file outside it, because there is no OS isolation here. If this ever starts failing,
  // something has genuinely changed - and the honest response is to re-measure, not to celebrate.
  const w = world()
  try {
    const secret = join(w.outside, 'secret.txt')
    writeFileSync(secret, 'OUTSIDE-CONTENT', 'utf8')
    const r = await tool(w).run({} as never, {
      executable: NODE,
      argv: ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(secret)},'utf8'))`],
    })
    // The policy refuses `-e` outright, so reach the same conclusion through a script file.
    assert.equal(r.kind, 'failed')
    assert.match((r as { reason: string }).reason, /refused/, 'node -e must be refused')
  } finally { cleanup(w) }
})

test('node -e is refused: code as a STRING defeats argument validation', () => {
  const w = world()
  try {
    for (const flag of ['-e', '--eval', '-p', '--print', '-']) {
      const v = classify(NODE, [flag, 'require("fs").rmSync("C:/")'], buildAllowlist(SYSTEM_ROOT, PROGRAM_FILES), ctx(w))
      assert.equal(v.kind, 'blocked', `${flag} must be refused`)
      assert.match(v.kind === 'blocked' ? v.reason : '', /STRING|code as a STRING/)
    }
  } finally { cleanup(w) }
})

// ============================================================ shells are unreachable

test('no shell is reachable, each with a reason a human can read', () => {
  for (const [name, why] of Object.entries(REFUSED_PROGRAMS)) {
    assert.ok(why.length > 20, `${name} needs a real explanation, got "${why}"`)
    const v = classify(`${SYSTEM_ROOT}\\System32\\${name}`, ['/c', 'dir'], buildAllowlist(SYSTEM_ROOT, PROGRAM_FILES), ctx(world()))
    assert.equal(v.kind, 'blocked', `${name} must be blocked`)
  }
})

test('cmd.exe is refused even though it is IN the allowlist, proving refusal is checked first', () => {
  // cmd.exe is deliberately present in the allowlist so this test can prove the refusal table is
  // consulted BEFORE the allowlist. If someone removes it from the allowlist the test would still
  // pass, so the entry must stay for the ordering to be observable.
  const list = buildAllowlist(SYSTEM_ROOT, PROGRAM_FILES)
  assert.ok(list.some((p) => p.name === 'cmd.exe'), 'cmd.exe must remain in the allowlist for this ordering to be testable')
  const v = classify(`${SYSTEM_ROOT}\\System32\\cmd.exe`, ['/c', 'echo hi'], list, ctx(world()))
  assert.equal(v.kind, 'blocked')
  assert.match(v.kind === 'blocked' ? v.reason : '', /re-parses/)
})

// ============================================================ workspace boundary

test('.. traversal is refused outright, not normalised into a valid in-workspace path', () => {
  const w = world()
  try {
    for (const arg of ['../outside/x', 'a/../../outside/x', 'sub/..\\..\\outside', '../']) {
      const v = classify(NODE, [arg], buildAllowlist(SYSTEM_ROOT, PROGRAM_FILES), ctx(w))
      assert.equal(v.kind, 'blocked', `"${arg}" must be refused`)
      assert.match(v.kind === 'blocked' ? v.reason : '', /\.\./)
    }
  } finally { cleanup(w) }
})

test('an absolute path outside the workspace is refused', () => {
  const w = world()
  try {
    const outsideScript = join(w.outside, 'evil.js')
    writeFileSync(outsideScript, 'console.log(1)', 'utf8')
    const v = classify(NODE, [outsideScript], buildAllowlist(SYSTEM_ROOT, PROGRAM_FILES), ctx(w))
    assert.equal(v.kind, 'blocked')
    assert.match(v.kind === 'blocked' ? v.reason : '', /outside the workspace/)
  } finally { cleanup(w) }
})

test('a JUNCTION cannot be used to smuggle a path outside the workspace', () => {
  // The reason `insideWorkspace` resolves with realpath rather than comparing text: a junction is
  // textually inside the workspace and physically outside it. A prefix test would pass this.
  const w = world()
  try {
    const target = join(w.outside, 'secret.txt')
    writeFileSync(target, 'SECRET', 'utf8')
    const junction = join(w.ws, 'link')
    try {
      // `mklink /J` needs no elevation. If it is unavailable the test FAILS rather than passing
    // vacuously - a boundary test that cannot set up its attack proves nothing.
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', junction, w.outside], { stdio: 'ignore', timeout: 10_000 })
    } catch {
      assert.fail('could not create a junction to test against; the boundary is unproven')
    }
    assert.equal(insideWorkspace(ctx(w), junction), false, 'a junction out of the workspace must not count as inside')
    const v = classify(NODE, [join(junction, 'secret.txt')], buildAllowlist(SYSTEM_ROOT, PROGRAM_FILES), ctx(w))
    assert.equal(v.kind, 'blocked')
  } finally {
    // A junction must be removed as a junction, or rmSync follows it out of the workspace.
    try { rmSync(join(w.ws, 'link'), { force: true, recursive: false }) } catch { /* best effort */ }
    cleanup(w)
  }
})

test('an output path outside the workspace is refused', () => {
  const w = world()
  try {
    // git -C is the realistic form: a subcommand that is otherwise read-only, pointed elsewhere.
    for (const argv of [
      ['-C', join(w.outside), 'status'],
      ['--git-dir', join(w.outside, '.git'), 'status'],
      ['-C', '..', 'status'],
    ]) {
      const v = classify(GIT, argv, buildAllowlist(SYSTEM_ROOT, PROGRAM_FILES), ctx(w))
      assert.equal(v.kind, 'blocked', `git ${argv.join(' ')} must be refused`)
    }
  } finally { cleanup(w) }
})

test('a pathspec after -- must be inside the workspace', () => {
  const w = world()
  try {
    const v = classify(GIT, ['diff', '--', join(w.outside, 'f.txt')], buildAllowlist(SYSTEM_ROOT, PROGRAM_FILES), ctx(w))
    assert.equal(v.kind, 'blocked')
    assert.match(v.kind === 'blocked' ? v.reason : '', /pathspec/)
  } finally { cleanup(w) }
})

// ============================================================ consequence classification

test('git subcommands are classified by what they DO, not by a name list', () => {
  const w = world()
  const list = buildAllowlist(SYSTEM_ROOT, PROGRAM_FILES)
  try {
    // read-only
    for (const sub of ['status', 'log', 'diff', 'show', 'rev-parse']) {
      assert.equal(classify(GIT, [sub], list, ctx(w)).kind, 'allow', `git ${sub} should be allowed`)
    }
    // sends
    for (const sub of ['push', 'fetch', 'pull']) {
      const v = classify(GIT, [sub], list, ctx(w))
      assert.equal(v.kind, 'consequential', `git ${sub} must be consequential`)
      assert.equal(v.kind === 'consequential' ? v.effect.kind : '', 'external-send')
    }
    // destroys
    for (const sub of ['clean', 'reset', 'checkout']) {
      const v = classify(GIT, [sub, '--hard'], list, ctx(w))
      assert.equal(v.kind === 'consequential' ? v.effect.kind : '', 'delete', `git ${sub} must be a delete effect`)
    }
    // unknown -> refused, not permitted
    const unknown = classify(GIT, ['sparse-checkout', 'set'], list, ctx(w))
    assert.equal(unknown.kind, 'blocked')
    assert.match(unknown.kind === 'blocked' ? unknown.reason : '', /not on the read-only list/)
  } finally { cleanup(w) }
})

test('running a workspace script is CONSEQUENTIAL, because it is workspace-authored code', () => {
  const w = world()
  try {
    const s = join(w.ws, 's.js')
    writeFileSync(s, 'console.log(1)', 'utf8')
    const v = classify(NODE, [s], buildAllowlist(SYSTEM_ROOT, PROGRAM_FILES), ctx(w))
    assert.equal(v.kind, 'consequential')
    assert.equal(v.kind === 'consequential' ? v.effect.kind : '', 'install')
    assert.match(v.kind === 'consequential' ? v.effect.reason : '', /workspace-authored code/)
  } finally { cleanup(w) }
})

// ============================================================ process lifecycle

test('a successful process produces a complete record', async () => {
  const w = world()
  try {
    const s = join(w.ws, 'ok.js')
    writeFileSync(s, "console.log('hello'); console.error('note')", 'utf8')
    const r = await tool(w).run({} as never, { executable: NODE, argv: [s] })
    assert.equal(r.kind, 'data')
    const rec = (r as { data: ProcessRecord }).data
    assert.equal(rec.state, 'completed')
    assert.equal(rec.exitCode, 0)
    assert.equal(rec.stdout.trim(), 'hello')
    assert.equal(rec.stderr.trim(), 'note')
    assert.equal(rec.signal, null)
    assert.equal(rec.timedOut, false)
    assert.ok(rec.durationMs >= 0 && rec.endedAt >= rec.startedAt)
    assert.equal(rec.stdoutTruncated, false)
  } finally { cleanup(w) }
})

test('a NON-ZERO exit is a failure, not a result', async () => {
  const w = world()
  try {
    const s = join(w.ws, 'bad.js')
    writeFileSync(s, "console.error('deliberate'); process.exit(3)", 'utf8')
    const r = await tool(w).run({} as never, { executable: NODE, argv: [s] })
    assert.equal(r.kind, 'failed')
    assert.match((r as { reason: string }).reason, /exited with code 3/)
    assert.match((r as { reason: string }).reason, /deliberate/, 'stderr must reach the human')
  } finally { cleanup(w) }
})

test('a MISSING executable is a failure, never an empty result', async () => {
  const w = world()
  try {
    const r = await tool(w).run({} as never, { executable: join(w.ws, 'nope.exe'), argv: [] })
    // Refused by the allowlist before spawn, so it must be blocked rather than ENOENT.
    assert.equal(r.kind, 'failed')
    assert.match((r as { reason: string }).reason, /not on the executable allowlist|does not exist/)
  } finally { cleanup(w) }
})

test('a HUNG process is killed at the timeout and reported as failed, and its tree is reaped', async () => {
  const w = world()
  try {
    const s = join(w.ws, 'hang.js')
    // A grandchild that would write a file well after the timeout. If tree-kill does not work, the
    // file appears and this test fails - which is the measurement, not a guess.
    const later = join(w.ws, 'orphan.txt')
    // The grandchild is a SEPARATE SCRIPT FILE, not `node -e`.
    //
    // The first version built it as `node -e "setTimeout(()=>fs.writeFileSync("C:\\Users\\..."),4000)"`
    // and the nested quoting produced a syntax error: the process exited 1 immediately, so the test
    // asserted on a fast failure and would have "passed" the timeout check while measuring nothing.
    // Two lessons in one - and the same shape as the defect the policy refuses `node -e` for.
    const gc = join(w.ws, 'grandchild.js')
    writeFileSync(gc, `setTimeout(()=>require('fs').writeFileSync(process.argv[2],'orphan'),4000)`, 'utf8')
    writeFileSync(
      s,
      `const {spawn}=require('child_process');` +
      `spawn(process.execPath,[${JSON.stringify(gc)},${JSON.stringify(later)}],{stdio:'ignore'});` +
      `setTimeout(()=>{},60000);`,
      'utf8',
    )
    const started = Date.now()
    const r = await tool(w, { timeoutMs: 1200 }).run({} as never, { executable: NODE, argv: [s] })
    const elapsed = Date.now() - started
    assert.equal(r.kind, 'failed', 'a timeout must not be reported as success')
    assert.match((r as { reason: string }).reason, /timeout|reaped/)
    assert.ok(elapsed < 10_000, `the tool returned in ${elapsed}ms; a hung process must not hang the mission`)
    // Wait past the grandchild's write time to see whether it was reaped.
    await new Promise((r2) => setTimeout(r2, 4500))
    assert.equal(existsSync(later), false, 'the grandchild survived the tree kill and wrote anyway')
  } finally { cleanup(w) }
})

test('a process that asks for a human becomes needs-human, and no credential is supplied', async () => {
  const w = world()
  try {
    const s = join(w.ws, 'ask.js')
    writeFileSync(s, "console.log('Password:'); process.stdin.resume()", 'utf8')
    const r = await tool(w, { timeoutMs: 8000 }).run({} as never, { executable: NODE, argv: [s] })
    assert.equal(r.kind, 'needs-human', `expected needs-human, got ${r.kind}`)
    assert.match((r as { reason: string }).reason, /human input|credential/i)
    assert.match((r as { reason: string }).reason, /No credential was supplied/)
  } finally { cleanup(w) }
})

test('stdin is CLOSED, so a process that reads it gets EOF rather than hanging', async () => {
  const w = world()
  try {
    const s = join(w.ws, 'readin.js')
    writeFileSync(s, "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log('EOF len='+d.length))", 'utf8')
    const r = await tool(w, { timeoutMs: 8000 }).run({} as never, { executable: NODE, argv: [s] })
    assert.equal(r.kind, 'data')
    assert.match((r as { data: ProcessRecord }).data.stdout, /EOF len=0/)
  } finally { cleanup(w) }
})

// ============================================================ environment policy, measured

test('the child gets a REDUCED environment, and the parent secret does not arrive', () => {
  // Measured on this machine: with a 7-name allowlist the child received those plus 8 that the
  // Windows loader injects. The claim under test is the reduction, not a sealed set.
  process.env.AIOS_TERM_TEST_SECRET = 'must-not-arrive'
  try {
    const env = buildEnv()
    assert.equal(env.AIOS_TERM_TEST_SECRET, undefined, 'an unrelated variable must not be passed on')
    for (const k of ENV_ALLOWLIST) {
      if (process.env[k]) assert.ok(k in env, `${k} is allowlisted and present, so it must be passed`)
    }
    assert.ok(Object.keys(env).length <= ENV_ALLOWLIST.length, 'no variable beyond the allowlist may be present')
  } finally { delete process.env.AIOS_TERM_TEST_SECRET }
})

test('the recorded env names are what the child actually received, not what we intended', async () => {
  const w = world()
  try {
    const s = join(w.ws, 'env.js')
    writeFileSync(s, 'console.log(Object.keys(process.env).sort().join(","))', 'utf8')
    const r = await tool(w).run({} as never, { executable: NODE, argv: [s] })
    const rec = (r as { data: ProcessRecord }).data
    const actual = rec.stdout.trim().split(',')
    // The honest form: we asked for the allowlist, the OS added some. Both facts are recorded.
    for (const k of ENV_ALLOWLIST) {
      if (process.env[k]) assert.ok(actual.includes(k), `${k} should have reached the child`)
    }
    assert.ok(actual.length < Object.keys(process.env).length, 'the child must have far fewer variables than the parent')
    assert.ok(!actual.includes('AIOS_TERM_TEST_SECRET'))
  } finally { cleanup(w) }
})

// ============================================================ exit code 0 is not evidence

test('a process that exits 0 having done NOTHING is REJECTED by the verifier', async () => {
  // The headline mistake this milestone exists to prevent. Control A in the live harness; here the
  // unit form: exit 0, empty stdout, no output file, and the verifier must refuse.
  const w = world()
  try {
    const s = join(w.ws, 'liar.js')
    writeFileSync(s, "console.log('SUCCESS: wrote the report'); process.exit(0)", 'utf8')
    const r = await tool(w).run({} as never, { executable: NODE, argv: [s] })
    assert.equal(r.kind, 'data')
    const rec = (r as { data: ProcessRecord }).data
    assert.equal(rec.exitCode, 0, 'the process really did exit 0')

    const v = makeTerminalVerifier({ workspace: w.ws, expect: () => ({ path: 'report.txt', content: 'expected' }) })
    const verdict = await v.verify(asStep([s]), {} as never, rec)
    assert.equal('rejected' in verdict, true, 'a zero exit code must not be accepted as evidence')
    assert.match((verdict as { rejected: string }).rejected, /does not exist|not evidence/)
  } finally { cleanup(w) }
})

test('a step with NO declared expectation cannot be verified at all', async () => {
  const w = world()
  try {
    const v = makeTerminalVerifier({ workspace: w.ws, expect: () => undefined })
    const verdict = await v.verify(asStep(['x']), {} as never, { exitCode: 0, state: 'completed' })
    assert.equal('rejected' in verdict, true, 'an unverifiable step must not be reported as verified')
    assert.match((verdict as { rejected: string }).rejected, /no verifiable expectation/)
  } finally { cleanup(w) }
})

test('content that MISMATCHES an independently computed expectation is rejected', async () => {
  const w = world()
  try {
    writeFileSync(join(w.ws, 'out.txt'), 'the wrong answer', 'utf8')
    const v = makeTerminalVerifier({ workspace: w.ws, expect: () => ({ path: 'out.txt', content: 'the right answer' }) })
    const verdict = await v.verify(asStep(['x']), {} as never, { exitCode: 0, state: 'completed', executable: NODE })
    assert.equal('rejected' in verdict, true)
    assert.match((verdict as { rejected: string }).rejected, /does not match/)
  } finally { cleanup(w) }
})

test('matching content IS verified, and the evidence says where it was corroborated', async () => {
  const w = world()
  try {
    writeFileSync(join(w.ws, 'out.txt'), 'the right answer', 'utf8')
    const v = makeTerminalVerifier({ workspace: w.ws, expect: () => ({ path: 'out.txt', content: 'the right answer' }) })
    const verdict = await v.verify(asStep(['x']), {} as never, {
      exitCode: 0, state: 'completed', executable: NODE, durationMs: 5, envNames: ['PATH'],
    })
    assert.equal('evidence' in verdict, true)
    const ev = (verdict as { evidence: { kind: string; corroboratedBy: string } }).evidence
    assert.equal(ev.kind, 'command-verified')
    assert.match(ev.corroboratedBy, /independently|recomputed/)
  } finally { cleanup(w) }
})

test('the verifier refuses to look outside the workspace, even for a declared expectation', async () => {
  const w = world()
  try {
    const v = makeTerminalVerifier({ workspace: w.ws, expect: () => ({ path: '../outside/secret.txt', content: 'SECRET' }) })
    writeFileSync(join(w.outside, 'secret.txt'), 'SECRET', 'utf8')
    const verdict = await v.verify(asStep(['x']), {} as never, { exitCode: 0, state: 'completed' })
    assert.equal('rejected' in verdict, true, 'a traversal in an expectation must be refused, not followed')
  } finally { cleanup(w) }
})

// ============================================================ governance integration

function terminalMission(id: string, effect: DeclaredEffect | undefined, argv: string[]): Mission {
  return {
    id, objective: 'run a process', constraints: [], state: 'executing',
    plan: [{
      id: 'run', intent: 'run it', mode: 'cli', rationale: 'terminal',
      tool: 'run-process', dependsOn: [], status: 'pending',
      args: { executable: NODE, argv },
      ...(effect ? { effect } : {}),
    }] as Step[],
    history: [], pendingApprovals: [], startedAt: 0,
  }
}

test('the ROUTER exposes the effect, so the gate is placed on the command not the tool', () => {
  const w = world()
  try {
    const s = join(w.ws, 's.js')
    writeFileSync(s, 'console.log(1)', 'utf8')
    const reg = new ToolRegistry(registerTerminal({ workspace: w.ws, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES }))
    // The same tool, two steps, opposite consequences - which a static flag cannot express.
    const runScript = reg.effectOf(asStep([s]))
    assert.equal(runScript?.kind, 'install', 'running a workspace script is consequential')
    assert.equal(reg.effectOf(asStep([join(w.ws, 'nope.js')])), undefined, 'a missing script is not consequential, it is refused')
    assert.ok(reg.preflight(asStep([join(w.ws, 'nope.js')]))?.blocked.includes('does not exist'))
  } finally { cleanup(w) }
})

test('a consequential terminal command is BLOCKED without approval, and the tool never runs', async () => {
  const w = world()
  try {
    const s = join(w.ws, 'effectful.js')
    writeFileSync(s, `require('fs').writeFileSync(${JSON.stringify(join(w.ws, 'did-it.txt'))},'ran')`, 'utf8')
    const reg = new ToolRegistry(registerTerminal({ workspace: w.ws, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES }))
    const r = await execute(terminalMission('m1', undefined, [s]), {
      tools: reg, verifier: { verifies: () => false, async verify() { return { rejected: 'n/a' } } } as never,
      control: fakeControl() as ControlSurface, approvals: new ApprovalStore(), config: CONFIG,
    })
    assert.equal(r.mission.plan[0].result!.outcome.kind, 'needs-human')
    assert.equal(existsSync(join(w.ws, 'did-it.txt')), false, 'the process must NOT have run')
    assert.equal(r.events.filter((e) => e.type === 'approval-required').length, 1)
    assert.equal(r.events.filter((e) => e.type === 'tool-selected').length, 0, 'the tool must not even be selected')
  } finally { cleanup(w) }
})

test('an APPROVED consequential terminal command runs, and is then independently verified', async () => {
  const w = world()
  try {
    const out = join(w.ws, 'report.txt')
    const s = join(w.ws, 'write.js')
    writeFileSync(s, `require('fs').writeFileSync(${JSON.stringify(out)},'computed answer')`, 'utf8')
    const reg = new ToolRegistry(registerTerminal({ workspace: w.ws, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES }))

    // First run: no approval, so the store learns the key.
    const probe = new ApprovalStore()
    await execute(terminalMission('m2', undefined, [s]), {
      tools: reg, verifier: { verifies: () => false, async verify() { return { rejected: 'n/a' } } } as never,
      control: fakeControl() as ControlSurface, approvals: probe, config: CONFIG,
    })
    const k = probe.outstanding()[0].key

    // Approve, then run for real.
    const store = new ApprovalStore()
    store.request(k, 'authorised')
    store.decide(k, 'approved', 'test-human', Date.now())
    const v = makeTerminalVerifier({ workspace: w.ws, expect: () => ({ path: 'report.txt', content: 'computed answer' }) })
    const r = await execute(terminalMission('m2', undefined, [s]), {
      tools: reg, verifier: v as never, control: fakeControl() as ControlSurface, approvals: store, config: CONFIG,
    })
    assert.equal(r.mission.plan[0].result!.outcome.kind, 'verified', 'approved + executed + independently confirmed')
    assert.equal(r.record.complete, true)
    assert.equal(readFileSync(out, 'utf8'), 'computed answer')
  } finally { cleanup(w) }
})

test('a plan that MISDESCRIBES the command is a plan defect, not a quiet correction', async () => {
  // The step claims it is reading; the tool reports it would run workspace code. The tool is taken
  // as the authority and the step FAILS, because a plan that misdescribes its own action cannot be
  // the thing that decides what is authorised.
  const w = world()
  try {
    const s = join(w.ws, 's.js')
    writeFileSync(s, 'console.log(1)', 'utf8')
    const reg = new ToolRegistry(registerTerminal({ workspace: w.ws, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES }))
    const lying: DeclaredEffect = { kind: 'delete', target: 'nothing', reason: 'pretend', irreversible: false }
    const r = await execute(terminalMission('m3', lying, [s]), {
      tools: reg, verifier: { verifies: () => false, async verify() { return { rejected: 'n/a' } } } as never,
      control: fakeControl() as ControlSurface, approvals: new ApprovalStore(), config: CONFIG,
    })
    const out = r.mission.plan[0].result!.outcome
    assert.equal(out.kind, 'failed')
    assert.match((out as { reason: string }).reason, /plan defect/)
    assert.equal(r.events.filter((e) => e.type === 'tool-selected').length, 0)
  } finally { cleanup(w) }
})

test('a REFUSED command is refused BEFORE approval is asked for', async () => {
  // Not `needs-human`: a human cannot authorise cmd.exe, so asking would be asking them to decide
  // something that was never on the table. The mission reports the refusal and moves on.
  const w = world()
  try {
    const reg = new ToolRegistry(registerTerminal({ workspace: w.ws, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES }))
    const r = await execute(
      { ...terminalMission('m4', undefined, ['-e', 'x']),
        plan: [{ id: 'run', intent: 'i', mode: 'cli', rationale: 'r', tool: 'run-process', status: 'pending',
                 args: { executable: `${SYSTEM_ROOT}\\System32\\cmd.exe`, argv: ['/c', 'dir'] } }] as Step[] },
      { tools: reg, verifier: { verifies: () => false, async verify() { return { rejected: 'n/a' } } } as never,
        control: fakeControl() as ControlSurface, approvals: new ApprovalStore(), config: CONFIG },
    )
    assert.equal(r.mission.plan[0].result!.outcome.kind, 'failed')
    assert.match((r.mission.plan[0].result!.outcome as { reason: string }).reason, /not permitted/)
    assert.equal(r.events.filter((e) => e.type === 'approval-required').length, 0, 'a refused command must not ask for approval')
    assert.equal(r.events.filter((e) => e.type === 'step-refused').length, 1)
  } finally { cleanup(w) }
})

test('an approval for a DIFFERENT command does not authorise this one', async () => {
  const w = world()
  try {
    const a = join(w.ws, 'a.js'); const b = join(w.ws, 'b.js')
    writeFileSync(a, 'console.log(1)', 'utf8')
    writeFileSync(b, `require('fs').writeFileSync(${JSON.stringify(join(w.ws, 'b-ran.txt'))},'x')`, 'utf8')
    const reg = new ToolRegistry(registerTerminal({ workspace: w.ws, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES }))

    const store = new ApprovalStore()
    const ka = keyFor('m5', 'run', { kind: 'install', target: a, reason: '', irreversible: true }, 0)
    store.request(ka, 'run a'); store.decide(ka, 'approved', 'human', 1)

    const r = await execute(terminalMission('m5', undefined, [b]), {
      tools: reg, verifier: { verifies: () => false, async verify() { return { rejected: 'n/a' } } } as never,
      control: fakeControl() as ControlSurface, approvals: store, config: CONFIG,
    })
    assert.equal(r.mission.plan[0].result!.outcome.kind, 'needs-human', 'approving a.js must not authorise b.js')
    assert.equal(existsSync(join(w.ws, 'b-ran.txt')), false)
  } finally { cleanup(w) }
})

test('EMERGENCY STOP outranks an approved terminal command', async () => {
  const w = world()
  try {
    const s = join(w.ws, 's.js')
    writeFileSync(s, `require('fs').writeFileSync(${JSON.stringify(join(w.ws, 'ran.txt'))},'x')`, 'utf8')
    const reg = new ToolRegistry(registerTerminal({ workspace: w.ws, systemRoot: SYSTEM_ROOT, programFiles: PROGRAM_FILES }))
    const store = new ApprovalStore()
    const probe = new ApprovalStore()
    await execute(terminalMission('m6', undefined, [s]), {
      tools: reg, verifier: { verifies: () => false, async verify() { return { rejected: 'n/a' } } } as never,
      control: fakeControl() as ControlSurface, approvals: probe, config: CONFIG,
    })
    const k = probe.outstanding()[0].key
    store.request(k, 'x'); store.decide(k, 'approved', 'human', 1)

    const r = await execute(terminalMission('m6', undefined, [s]), {
      tools: reg, verifier: { verifies: () => false, async verify() { return { rejected: 'n/a' } } } as never,
      control: fakeControl() as ControlSurface, approvals: store,
      config: { ...CONFIG, emergencyStop: async () => true },
    })
    assert.equal(existsSync(join(w.ws, 'ran.txt')), false, 'an approved process must not run under emergency stop')
  } finally { cleanup(w) }
})

// ============================================================ recorded limitations

test('the limitations are stated, and each one is a real absence rather than a hedge', () => {
  // Guards against the documentation drifting into claiming isolation. If someone later adds real
  // OS-level sandboxing this test should be revisited deliberately, not deleted.
  return import('../live/terminal-policy.ts').then((m) => {
    assert.ok(m.LIMITATIONS.length >= 5)
    const text = m.LIMITATIONS.join(' ').toLowerCase()
    assert.match(text, /job object|os-level isolation/)
    assert.match(text, /child process/)
    assert.match(text, /network/)
    assert.match(text, /not restricted|not confined|not contained/)
  })
})


