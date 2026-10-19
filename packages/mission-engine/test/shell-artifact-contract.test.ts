/**
 * The shell cannot write outside the mission's declared artifacts.
 *
 * Regression tests for P0.1 - the last high-severity correctness gap in the execution path.
 *
 * THE FAILURE, measured on this machine. A mission proposed a two-step plan using `shell` and
 * `read`. `validatePlan` refused both: neither is a registered capability. The file was written
 * anyway - 407 real rows to `nakivo-mission-2026-10-19-R4.csv` - by the very shell the plan had
 * named. The refusal was correct and the damage was real, in the same mission.
 *
 * The reason is structural, not a missing check. Every artifact rule in `artifacts.ts` is enforced
 * inside `write-file` and `spreadsheet`, which take a PATH. A shell command is a STRING, and
 * nothing was reading it as a path. The gap was not that `terminal` lacked the check; it was that
 * `terminal` had never been considered a write route at all.
 *
 * THE INVARIANT. A command that can write must name a file this mission declared as an artifact.
 * A command that cannot write runs unchanged. The asymmetry is deliberate: read-only commands
 * (`dir`, `where`, `echo`, `git status`) cannot damage a file, so making them declare intent would
 * only make the tool worse at the inspection work it is genuinely useful for, while an unlisted
 * command fails safe because it is assumed to write.
 *
 * These tests call the REAL `terminal` tool through the real registry. The contract is registered
 * the way `runGoal` registers it - by mission id, not through a tool argument - because a contract
 * passed through `args` would be a contract the model wrote.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { resolveCapability } from '../live/agent/capabilities.ts'
import {
  buildArtifactContract, registerContract, forgetContract, authorizeShell,
  shellMentionedTargets, snapshotArtifacts, artifactDelta, contractFor,
  READ_ONLY_COMMANDS, type ArtifactContract,
} from '../live/agent/artifacts.ts'

const AGENT_OUT = join(homedir(), '.aios', 'agent', 'out')

/** Run the real terminal tool with a real mission id. */
async function runTerminal(
  missionId: string, command: string, cwd?: string,
): Promise<Record<string, unknown>> {
  const cap = resolveCapability('terminal')
  assert.ok(!('unavailable' in cap), 'terminal must be available in the real registry')
  const tool = (cap as { tool: { run: (c: unknown, a: unknown) => Promise<unknown> } }).tool
  const ctx = { missionId, stepId: 's1', attempt: 1, prior: {}, observation: {} }
  return await tool.run(ctx, cwd ? { command, cwd } : { command }) as never
}

const sha = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

function fixtureDir(): string {
  const d = mkdtempSync(join(AGENT_OUT, 'shellfx-'))
  return d
}

/**
 * A mission whose declared artifacts are `names`, registered under a real mission id.
 *
 * Named `missionWith` rather than `contractFor` because that identifier is imported from
 * artifacts.ts - and the collision shadowed the import, so the tests were building a contract with
 * an undefined argument list and asserting against `undefined`. A failure in a test that looks
 * like a product bug is usually a test bug, and this one was hiding three real ones.
 */
function missionWith(dir: string, names: string[]): { id: string; contract: ArtifactContract } {
  const id = `mission-${Math.random().toString(36).slice(2)}`
  const steps = names.map((n, i) => ({
    id: `s${i + 1}`,
    intent: `write ${n}`,
    tool: 'write-file',
    args: { path: join(dir, n) },
  }))
  const contract = buildArtifactContract(steps, null, dir)
  registerContract(id, contract)
  return { id, contract }
}

// ===========================================================================================
// 1. THE SHELL CANNOT REACH AN UNDECLARED FILE
// ===========================================================================================

test('a shell command aimed at an undeclared file is refused, and the file is not created', async () => {
  const dir = fixtureDir()
  const id = 'm-redirect'
  try {
    registerContract(id, buildArtifactContract([], null, dir))
    const victim = join(dir, 'not-declared.csv')

    const r = await runTerminal(id, `echo "a,b" > "${victim}"`)

    assert.equal(r.kind, 'failed', 'a redirect to an undeclared file must be refused')
    assert.match(String(r.reason), /did not declare as an artifact/i)
    assert.equal(existsSync(victim), false,
      'the refused command must not have created the file')
  } finally {
    forgetContract(id); rmSync(dir, { recursive: true, force: true })
  }
})

test('a python script run against an undeclared path is refused', async () => {
  // The shape that actually happened: a model wrote a script and ran it against the deliverable's
  // directory. `python scan.py out.csv` names its targets as cheaply as a full path does.
  const dir = fixtureDir()
  const id = 'm-python'
  try {
    registerContract(id, buildArtifactContract([], null, dir))
    const r = await runTerminal(id, `python ${join(dir, 'scan.py')} ${join(dir, 'out.csv')}`)
    assert.equal(r.kind, 'failed')
    assert.match(String(r.reason), /did not declare as an artifact/i)
  } finally {
    forgetContract(id); rmSync(dir, { recursive: true, force: true })
  }
})

test('a command that can write but names no file is refused', async () => {
  const id = 'm-nofile'
  try {
    registerContract(id, buildArtifactContract([], null, dir => dir, ))
  } catch { /* setup only */ }
  const dir = fixtureDir()
  try {
    registerContract(id, buildArtifactContract([], null, dir))
    const r = await runTerminal(id, 'npm install express')
    assert.equal(r.kind, 'failed', 'a command that cannot say what it writes must be refused')
    assert.match(String(r.reason), /names no file|not a read-only command/i)
  } finally {
    forgetContract(id); rmSync(dir, { recursive: true, force: true })
  }
})

test('a mission with NO contract cannot run anything that writes', async () => {
  const id = 'm-nocontract'
  try {
    // No contract registered at all - the state a step runs in if validation was skipped.
    const r = await runTerminal(id, 'python script.py')
    assert.equal(r.kind, 'failed')
    assert.match(String(r.reason), /no artifact contract/i)
  } finally {
    forgetContract(id)
  }
})

// ===========================================================================================
// 2. READ-ONLY COMMANDS ARE UNAFFECTED
// ===========================================================================================

test('read-only commands still run with no contract', async () => {
  // The control that matters. A guard that refuses everything has not fixed anything; it has
  // broken the inspection work `terminal` exists to do.
  const id = 'm-readonly'
  try {
    const r = await runTerminal(id, 'echo hello')
    assert.notEqual(r.kind, 'failed', `echo must still work: ${JSON.stringify(r)}`)
  } finally { forgetContract(id) }
})

test('read-only commands are recognised without a contract', () => {
  for (const c of READ_ONLY_COMMANDS) {
    assert.equal(authorizeShell({ command: `${c} something`, contract: null }), null,
      `${c} is read-only and must not need a contract`)
  }
  // Flags do not change the answer - an earlier whole-subcommand match demanded a contract for
  // `git log --oneline`, which would have taught the model to avoid the most ordinary form.
  for (const c of ['git status', 'git log --oneline', 'git diff --stat', 'git show HEAD', 'git ls-files']) {
    assert.equal(authorizeShell({ command: c, contract: null }), null,
      `"${c}" is read-only and must not need a contract`)
  }
})

test('git verbs whose FLAGS write need a contract even in their read-only form', () => {
  // `git branch` alone lists but `-d` deletes; `git remote -v` reads but `remote add` writes.
  // Matching on the verb alone would allow the destructive form of each, so neither is treated as
  // read-only. The cost is that the harmless form needs a contract too - and that is the right
  // trade: a refusal costs one step, whereas an allowed `git branch -d` costs the user a branch.
  for (const c of ['git branch --list', 'git remote -v', 'git stash list']) {
    assert.match(String(authorizeShell({ command: c, contract: null })),
      /no artifact contract/i,
      `"${c}" shares a verb with a destructive form and must fail safe`)
  }
})

test('git commands that write still need a contract', () => {
  for (const c of ['git push', 'git commit -m x', 'git reset --hard']) {
    assert.match(String(authorizeShell({ command: c, contract: null })), /no artifact contract/i,
      `"${c}" writes and must not run without a contract`)
  }
})

// ===========================================================================================
// 3. A DECLARED ARTIFACT IS STILL PROTECTED
// ===========================================================================================

test('the shell cannot OVERWRITE an existing declared artifact either', async () => {
  const dir = fixtureDir()
  const { id } = missionWith(dir, ['declared.csv'])
  try {
    const target = join(dir, 'declared.csv')
    // The file exists BEFORE the contract was built, so the contract records it as pre-existing.
    writeFileSync(target, '"A","B"\n"original","row"\n', 'utf8')
    const original = sha(target)

    const { id: id2 } = missionWith(dir, ['declared.csv'])
    try {
      const r = await runTerminal(id2, `echo "clobber" > "${target}"`)
      assert.equal(r.kind, 'failed', 'overwriting a declared artifact via the shell must be refused')
      assert.equal(sha(target), original,
        'the declared artifact changed after a refused shell overwrite')
    } finally { forgetContract(id2) }
  } finally {
    forgetContract(id); rmSync(dir, { recursive: true, force: true })
  }
})

test('a command naming only declared artifacts is allowed through', () => {
  const dir = fixtureDir()
  try {
    const { contract } = missionWith(dir, ['declared.csv'])
    const r = authorizeShell({
      command: `python scan.py ${join(dir, 'declared.csv')}`,
      contract,
    })
    // The bare `scan.py` is undeclared, so this is still refused - and that is correct: the script
    // itself must be declared. The assertion that matters is that it is refused for the RIGHT
    // reason, not silently allowed.
    assert.match(String(r), /scan\.py/)
    const ok = authorizeShell({
      command: `echo x > ${join(dir, 'declared.csv')}`,
      contract,
    })
    assert.equal(ok, null, 'a redirect to a declared artifact must be allowed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ===========================================================================================
// 4. TARGET EXTRACTION
// ===========================================================================================

test('bare filenames are recognised, not only absolute paths', () => {
  // A guard that only understood absolute paths would pass the exact command that caused the
  // damage: `python scan.py` names its target as cheaply as a full path does.
  const t = shellMentionedTargets('python scan.py out.csv')
  assert.ok(t.includes('scan.py'), `bare filename missed: ${JSON.stringify(t)}`)
  assert.ok(t.includes('out.csv'), `bare output filename missed: ${JSON.stringify(t)}`)
})

test('redirects and quoted paths are recognised', () => {
  assert.ok(shellMentionedTargets('echo a > "C:\\out\\x.csv"').includes('C:\\out\\x.csv'))
  assert.ok(shellMentionedTargets('echo a >> appended.csv').includes('appended.csv'))
  assert.ok(shellMentionedTargets('node build.js').includes('build.js'))
})

// ===========================================================================================
// 5. THE SNAPSHOT ACTUALLY DETECTS A CHANGE
// ===========================================================================================

test('the snapshot detects creation, change and removal', () => {
  const dir = fixtureDir()
  try {
    const p = join(dir, 'a.csv')
    writeFileSync(p, 'one\n', 'utf8')
    const c = buildArtifactContract(
      [{ id: 's1', intent: 'w', tool: 'write-file', args: { path: p } }], null, dir)

    const before = snapshotArtifacts(c)
    writeFileSync(p, 'two\n', 'utf8')
    const d1 = artifactDelta(c, before)
    assert.deepEqual(d1.changed, [p], 'a modified artifact must be reported as changed')

    rmSync(p)
    const d2 = artifactDelta(c, before)
    assert.deepEqual(d2.missing, [p], 'a removed artifact must be reported as missing')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('an unchanged artifact reports nothing', () => {
  const dir = fixtureDir()
  try {
    const p = join(dir, 'a.csv')
    writeFileSync(p, 'one\n', 'utf8')
    const c = buildArtifactContract(
      [{ id: 's1', intent: 'w', tool: 'write-file', args: { path: p } }], null, dir)
    const d = artifactDelta(c, snapshotArtifacts(c))
    assert.deepEqual(d.changed, [])
    assert.deepEqual(d.created, [])
    assert.deepEqual(d.missing, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ===========================================================================================
// 6. CONTRACTS ARE PER-MISSION AND DO NOT ACCUMULATE
// ===========================================================================================

test('two missions cannot see each other artifacts', () => {
  const dir = fixtureDir()
  try {
    const a = missionWith(dir, ['mine.csv'])
    const b = missionWith(dir, ['theirs.csv'])
    assert.equal(authorizeShell({
      command: `echo x > ${join(dir, 'mine.csv')}`, contract: b.contract,
    }) !== null, true, 'mission B must not be able to write mission A artifact')
    assert.equal(authorizeShell({
      command: `echo x > ${join(dir, 'theirs.csv')}`, contract: b.contract,
    }), null, 'mission B must be able to write its own artifact')
    forgetContract(a.id); forgetContract(b.id)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a released contract is gone, and an empty one declares nothing', () => {
  const dir = fixtureDir()
  try {
    const { id } = missionWith(dir, ['x.csv'])

    // While registered: the artifact is declared, so a redirect to it is allowed.
    assert.equal(
      authorizeShell({ command: `echo x > ${join(dir, 'x.csv')}`, contract: contractFor(id) }),
      null,
      'a declared, not-yet-existing artifact must be writable by the shell',
    )

    forgetContract(id)
    assert.equal(contractFor(id), null, 'a released contract must not be readable')

    // And an empty contract declares nothing, so the same command is now refused. This is the
    // failure mode that matters: permission comes from the declaration, and once it is gone the
    // mission can write nothing.
    assert.match(
      String(authorizeShell({
        command: `echo x > ${join(dir, 'x.csv')}`,
        contract: buildArtifactContract([], null, dir),
      })),
      /did not declare as an artifact/i,
    )
  } finally { rmSync(dir, { recursive: true, force: true }) }
})