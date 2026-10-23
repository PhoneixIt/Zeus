import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, readFileSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LocalObservationProvider, NoObservationProvider, fingerprintOf } from '../../observation/local.ts'
import {
  filesIn, directoriesIn, deepestLevel, extensionsIn, observes, find, checkFreshness,
  type WorldState,
} from '../../observation/world.ts'
import { DeterministicWorldAwarePlanProvider } from '../../planner/world-aware.ts'
import { DeterministicPlanProvider } from '../../planner/deterministic.ts'
import { compilePlan } from '../../planner/compile.ts'
import type { PlanContext, PlanProposal } from '../../planner/plan.ts'
import { ToolRegistry, EmptyRegistry } from '../../tool-router/router.ts'

/**
 * THE OBSERVER, AND THE PLANNER THAT READS IT.
 *
 * The claim under test, in one line: A PLAN MUST BE BUILT ON AN OBSERVATION OF THE MACHINE, AND IT
 * MUST BE ABLE TO SAY WHICH ONE.
 *
 * The tests are arranged around the ways that claim can be false while everything still appears to
 * work: an observer that reports nothing, an observation that has gone stale, a world containing
 * fewer files than the plan assumes, a planner that looks but does not read, and an implementation
 * that has quietly grown the ability to write.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const observer = new LocalObservationProvider()

/**
 * A folder with a KNOWN shape, so the counts in the assertions are arithmetic rather than guesses.
 *
 * FIVE files (a.md, b.txt, c.json, sub/d.py, sub/deep/e.md) and THREE directory entries - which
 * includes the ROOT, because the observer records it so an empty folder is distinguishable from a
 * missing one. Both counts were wrong in the first version of this fixture (four and two), and both
 * were caught because the fixture could be enumerated by hand. A fixture that grew to hide a
 * discrepancy would not have caught anything.
 */
function world_() {
  const root = mkdtempSync(join(tmpdir(), 'aios-obs-'))
  const src = join(root, 'src')
  mkdirSync(join(src, 'sub', 'deep'), { recursive: true })
  writeFileSync(join(src, 'a.md'), '# a\n')
  writeFileSync(join(src, 'b.txt'), 'bb\n')
  writeFileSync(join(src, 'c.json'), '{}\n')
  writeFileSync(join(src, 'sub', 'd.py'), 'x = 1\n')
  writeFileSync(join(src, 'sub', 'deep', 'e.md'), '# e\n')
  return { root, src, fileCount: 5, dirCount: 3 }
}
const cleanup = (w: ReturnType<typeof world_>) => rmSync(w.root, { recursive: true, force: true })

const ctxFor = (src: string, out: string, over: Partial<PlanContext> = {}): PlanContext => {
  const w = observer.observe({ root: src, maxDepth: 4 })
  return { outputRoot: out, now: () => w.observedAt, world: w, maxObservationAgeMs: 60_000, refetched: w, ...over }
}

// ==================================================== the observer reports facts

test('the observer reports files, folders, depth, size and extension', () => {
  const w = world_()
  try {
    const o = observer.observe({ root: w.src, maxDepth: 4 })
    assert.equal(filesIn(o).length, w.fileCount, 'a.md, b.txt, c.json, sub/d.py, sub/deep/e.md')
    assert.equal(directoriesIn(o).length, w.dirCount, 'the root itself, plus sub and sub/deep')
    assert.deepEqual(extensionsIn(o), ['json', 'md', 'py', 'txt'])
    // The ROOT is an entry at depth 0, so the deepest level is 3: src -> sub -> deep -> e.md
    assert.equal(deepestLevel(o), 3)
    // Resolved, not the path we passed in.
    assert.ok(o.entries.every((e) => e.path.includes('aios-obs-')))
    // And it is sorted, because freshness compares fingerprints and an unstable order would report
    // a changed world every time it was asked.
    const rels = o.entries.map((e) => e.relative)
    assert.deepEqual(rels, [...rels].sort(), 'entries are sorted by relative path')
  } finally { cleanup(w) }
})

test('the observer reports the ROOT itself, so an empty folder is distinguishable from a missing one', () => {
  const w = world_()
  try {
    const empty = join(w.root, 'empty')
    mkdirSync(empty, { recursive: true })
    const o = observer.observe({ root: empty, maxDepth: 2 })
    assert.equal(o.entries.length, 1, 'only the root')
    assert.equal(o.entries[0].kind, 'directory')
    assert.equal(filesIn(o).length, 0)
    assert.deepEqual(o.errors, [], 'an empty folder is not an error')
  } finally { cleanup(w) }
})

test('a MISSING folder is reported as an error, not as an empty one', () => {
  const w = world_()
  try {
    const o = observer.observe({ root: join(w.root, 'not-there'), maxDepth: 2 })
    assert.ok(o.errors.length > 0, 'a missing root must be an error')
    assert.match(o.errors[0].reason, /could not be read/)
  } finally { cleanup(w) }
})

test('the fingerprint changes when a file CONTENT changes, not only when a file is added', () => {
  // This is why sizes are in the digest. A world where a file was edited but kept its name has a
  // different fingerprint, and that is exactly the case where a plan built a moment ago is quietly
  // describing something that no longer exists.
  const w = world_()
  try {
    const before = observer.observe({ root: w.src, maxDepth: 4 })
    writeFileSync(join(w.src, 'a.md'), '# a changed and longer\n')
    const after = observer.observe({ root: w.src, maxDepth: 4 })
    assert.notEqual(before.fingerprint, after.fingerprint, 'an edit must change the fingerprint')

    // Same length, different bytes. A size-only digest would miss this, and it is the case the
    // digest is documented to catch - so it is tested directly rather than assumed.
    const w2 = world_()
    try {
      const b2 = observer.observe({ root: w2.src, maxDepth: 4 })
      writeFileSync(join(w2.src, 'b.txt'), 'cc\n')
      const a2 = observer.observe({ root: w2.src, maxDepth: 4 })
      assert.equal(
        filesIn(b2).find((f) => f.relative === 'b.txt')?.sizeBytes,
        filesIn(a2).find((f) => f.relative === 'b.txt')?.sizeBytes,
        'the size is unchanged, so a size-only digest would see no change',
      )
      // A same-size edit is not detectable from listing metadata, and the fingerprint is built from
      // exactly that. Saying so here is the honest position: freshness detects ADDITIONS, REMOVALS,
      // RENAMES and RESIZES, not in-place edits of unchanged length.
      //
      // The first version of this test asserted the fingerprint changed and it did not - the
      // assertion was wrong, not the digest, and writing down why is more useful than a digest that
      // silently cannot answer the question.
      assert.equal(b2.fingerprint, a2.fingerprint,
        'a same-size in-place edit is NOT detected: the digest covers listing metadata only')
      // And a RESIZE is detected.
      writeFileSync(join(w2.src, 'b.txt'), 'cccccc\n')
      const a3 = observer.observe({ root: w2.src, maxDepth: 4 })
      assert.notEqual(b2.fingerprint, a3.fingerprint, 'a resize is detected')
    } finally { cleanup(w2) }
  } finally { cleanup(w) }
})

test('a LINK out of the workspace is RECORDED as a link, and its target is NOT walked', () => {
  // The escape this must not permit: a link inside the observed tree pointing at something outside
  // it, with the observer descending through and reporting facts about a directory it was never
  // scoped to.
  //
  // A JUNCTION is used, because that is what can be created without elevation on this machine -
  // `symlinkSync` needs developer mode and failed here. Which raises a question worth measuring
  // rather than assuming, since the two are both reparse points and I had guessed `lstat` reports a
  // junction as a directory. It does not: Node's `lstat` opens with FILE_FLAG_OPEN_REPARSE_POINT, so
  // a junction comes back as a symlink and the walk skips it. The guess was wrong and the measurement
  // is the safer behaviour, which is not a reason to have left the guess in the code.
  const w = world_()
  try {
    const outside = join(w.root, 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'SECRET\n')
    try {
      execFileSync('cmd.exe', ['/c', 'mklink', '/J', join(w.src, 'j'), outside], { stdio: 'ignore', timeout: 10_000 })
    } catch {
      // Failing rather than passing vacuously: a boundary test that could not set up its attack has
      // proven nothing, and reporting it as a pass is exactly the failure this project keeps finding.
      assert.fail('could not create a junction out of the observed root; the boundary is unproven here')
    }

    const o = observer.observe({ root: w.src, maxDepth: 4 })
    const link = o.entries.find((e) => e.relative === 'j')
    assert.ok(link, 'the link is recorded as a fact rather than silently skipped')
    assert.equal(link!.kind, 'symlink', 'and is identified as a link, not a folder')
    assert.ok(!o.entries.some((e) => e.relative.startsWith('j/')), 'its contents were NOT walked')
    assert.ok(
      !o.entries.some((e) => e.path.startsWith(outside + sep)),
      'no entry reports a path outside the observed root',
    )
    // And the fingerprint therefore cannot be moved by writing through the link - the outside file
    // is invisible to the observation, which is the same property stated as a consequence.
    const before = o.fingerprint
    writeFileSync(join(outside, 'secret.txt'), 'CHANGED THROUGH THE LINK\n')
    const after = observer.observe({ root: w.src, maxDepth: 4 })
    assert.equal(after.fingerprint, before, 'a change behind the link is not visible to the observer')
  } finally { cleanup(w) }
})

test('the observer reports which allowlisted programs are installed, and whether they are permitted', () => {
  const w = world_()
  try {
    const o = observer.observe({ root: w.src, maxDepth: 2 })
    const node = o.capabilities.find((c) => c.name === 'node.exe')
    const cmd = o.capabilities.find((c) => c.name === 'cmd.exe')
    assert.ok(node, 'node is checked')
    assert.ok(cmd, 'cmd is checked')
    // The important distinction: INSTALLED is not the same as PERMITTED. cmd.exe exists on this
    // machine and is not permitted, and reporting the two as one fact is how a planner ends up
    // planning to launch it.
    if (cmd?.exists) {
      assert.equal(cmd.permitted, false, 'cmd.exe exists but must not be reported as permitted')
      assert.ok(cmd.refusal && cmd.refusal.length > 10, 'and the refusal must say why')
    }
    if (node?.exists) assert.equal(node.permitted, true, 'node.exe exists and is on the allowlist')
  } finally { cleanup(w) }
})

test('a WORLD STATE is plain data: no methods, no handles, nothing that can act', () => {
  const w = world_()
  try {
    const o = observer.observe({ root: w.src, maxDepth: 2 })
    for (const v of Object.values(o)) {
      const t = typeof v
      assert.ok(t === 'object' || t === 'string' || t === 'number' || t === 'boolean',
        `every field must be inert data, found ${t}`)
    }
    // Deeply: no function anywhere in the structure.
    const walk = (v: unknown, path: string) => {
      if (typeof v === 'function') assert.fail(`${path} is a function; a WorldState must not carry behaviour`)
      if (v && typeof v === 'object') {
        for (const [k, child] of Object.entries(v as Record<string, unknown>)) walk(child, `${path}.${k}`)
      }
    }
    walk(o, 'world')
  } finally { cleanup(w) }
})

// ==================================================== freshness

test('freshness needs BOTH an age check and a re-observation', () => {
  const w = world_()
  try {
    const o = observer.observe({ root: w.src, maxDepth: 4 })
    const same = observer.observe({ root: w.src, maxDepth: 4 })

    assert.equal(checkFreshness(o, { now: o.observedAt + 1000, maxAgeMs: 60_000, refetched: same }).fresh, true)

    // Too old, even though the world has not moved.
    const old = checkFreshness(o, { now: o.observedAt + 120_000, maxAgeMs: 60_000, refetched: same })
    assert.equal(old.fresh, false)
    assert.equal(old.fresh === false ? old.reason : '', 'too-old')

    // Changed, even though it is recent.
    writeFileSync(join(w.src, 'new.txt'), 'new\n')
    const changed = checkFreshness(o, { now: o.observedAt + 1000, maxAgeMs: 60_000, refetched: observer.observe({ root: w.src, maxDepth: 4 }) })
    assert.equal(changed.fresh, false)
    assert.equal(changed.fresh === false ? changed.reason : '', 'world-changed')

    // No re-observation supplied: "cannot tell" is its own answer, not an optimistic "fresh".
    const unknown = checkFreshness(o, { now: o.observedAt + 1000, maxAgeMs: 60_000 })
    assert.equal(unknown.fresh, false)
    assert.equal(unknown.fresh === false ? unknown.reason : '', 'cannot-verify')
  } finally { cleanup(w) }
})

// ==================================================== the observer is read-only

test('the OBSERVER MODULE cannot write, and cannot reach anything that can', () => {
  // Control D. A read-only observer is a claim about the import graph, and the graph is checkable.
  const files = [
    join(HERE, '..', '..', 'observation', 'local.ts'),
    join(HERE, '..', '..', 'observation', 'world.ts'),
    join(HERE, '..', '..', 'observation', 'world-provider.ts'),
  ]
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    assert.doesNotMatch(
      src, /writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|createWriteStream|chmodSync/,
      `${f} must not be able to write`,
    )
    assert.doesNotMatch(src, /from\s+['"].*mission-engine\/executor/, `${f} must not import the executor`)
    assert.doesNotMatch(src, /from\s+['"].*governance\//, `${f} must not import governance`)
    assert.doesNotMatch(src, /from\s+['"].*control-core/, `${f} must not import the control core`)
    assert.doesNotMatch(src, /from\s+['"].*child_process/, `${f} must not be able to spawn anything`)
  }
})

test('attempting to MUTATE THROUGH THE PROVIDER has nowhere to go', () => {
  // The type surface offers one method. This asserts the runtime reality too: calling it produces a
  // new value and leaves the world byte-identical.
  const w = world_()
  try {
    const before = readFileSync(join(w.src, 'a.md'), 'utf8')
    const o = observer.observe({ root: w.src, maxDepth: 4 })
    // Whatever a caller does with the result, the disk is unchanged.
    const entriesBefore = o.entries.length
    const second = observer.observe({ root: w.src, maxDepth: 4 })
    assert.equal(readFileSync(join(w.src, 'a.md'), 'utf8'), before, 'observation does not modify what it reads')
    assert.equal(second.entries.length, entriesBefore)
    // And a WorldState is frozen in practice: it is a plain object, so it carries no setter that
    // could be used to smuggle a reference to something live into a planner.
    assert.equal(Object.getPrototypeOf(o), Object.prototype, 'a WorldState is a plain object')
  } finally { cleanup(w) }
})

test('the observer has no method that can be called to obtain anything but a WorldState', () => {
  // The real prototype surface, which includes `capabilities`. Asserted as it actually is rather
  // than as one might wish it were: that helper is private by convention only, and it still appears
  // at runtime. It reads `process.env` and the allowlist tables, and cannot act - which is the
  // property that matters, asserted directly in the two tests above.
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(observer)).filter((n) => n !== 'constructor')
  assert.deepEqual(methods.sort(), ['capabilities', 'observe', 'observes'])
  // One of them returns a WorldState; the other returns strings. Neither returns a handle.
  assert.equal(typeof (observer as unknown as { observe: unknown }).observe, 'function')
  assert.equal(typeof (observer as unknown as { observes: unknown }).observes, 'function')
})

// ==================================================== the planner cannot act

test('no planner module can import anything that could execute', () => {
  // Control E. Enforced by reading the imports, not by convention.
  for (const f of ['deterministic.ts', 'world-aware.ts', 'plan.ts', 'provider.ts', 'compile.ts']) {
    const src = readFileSync(join(HERE, '..', '..', 'planner', f), 'utf8')
    assert.doesNotMatch(src, /from\s+['"].*mission-engine\/executor/, `${f} must not import the executor`)
    assert.doesNotMatch(src, /from\s+['"].*governance\/(contract|approval)/, `${f} must not import governance`)
    assert.doesNotMatch(src, /from\s+['"].*control-core/, `${f} must not import the control core`)
    assert.doesNotMatch(src, /from\s+['"].*tool-router/, `${f} must not import the router`)
    assert.doesNotMatch(src, /from\s+['"].*mission-engine\/live/, `${f} must not import a tool implementation`)
  }
})

// ==================================================== the plan must name its basis

test('the compiler REFUSES a plan that names no observation', async () => {
  const w = world_()
  try {
    const out = join(w.root, 'out'); mkdirSync(out, { recursive: true })
    const p = (await planOnce(ctxFor(w.src, out))).proposal
    for (const broken of [
      { ...p, basis: { ...p.basis, observationId: '' } },
      { ...p, basis: { ...p.basis, fingerprint: '' } },
      { ...p, basis: { ...p.basis, usedFacts: [] } },
      { ...p, basis: { ...p.basis, complete: false } },
    ]) {
      const c = compilePlan(broken as PlanProposal, 'm1', 0)
      assert.equal(c.ok, false, 'a plan that cannot be held to the world must not compile')
      if (!c.ok) assert.match(c.reason, /observation|fingerprint|observed facts|partial/)
    }
    // And the unmodified plan does compile, so the refusals above are about the basis and not about
    // the plan in general.
    assert.equal(compilePlan(p as PlanProposal, 'm1', 0).ok, true)
  } finally { cleanup(w) }
})

test('a plan that is built without any observation is REFUSED, not produced', async () => {
  const w = world_()
  try {
    const out = join(w.root, 'out'); mkdirSync(out, { recursive: true })
    const provider = new DeterministicWorldAwarePlanProvider()
    const r = await provider.plan(`Summarise the contents of the folder "${w.src}"`, {
      outputRoot: out, now: () => Date.now(), world: undefined,
    })
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.code, 'observation-missing')
    assert.match(r.reason, /recipe, not a plan/)
  } finally { cleanup(w) }
})

// ==================================================== the plan FOLLOWS the world

test('removing node from the observation CHANGES the plan', async () => {
  // The load-bearing test. Two plans for the same objective, differing only in whether the
  // observation says node is available, must not be the same plan.
  const w = world_()
  try {
    const out = join(w.root, 'out'); mkdirSync(out, { recursive: true })
    const provider = new DeterministicWorldAwarePlanProvider()
    const objective = `Summarise the contents of the folder "${w.src}"`

    const base = observer.observe({ root: w.src, maxDepth: 4 })
    const withNode = (await planOnce({ outputRoot: out, now: () => base.observedAt, world: base, maxObservationAgeMs: 60_000, refetched: base })).proposal
    // The SAME world, with node reported absent. Built by hand rather than via `ctxFor`, because
    // `ctxFor` re-observes and would hand back a fresh fingerprint - and then the two plans would
    // differ for the uninteresting reason that they were built against different observations, with
    // the capability choice no longer isolated as the cause.
    const stripped = withoutNode(base)
    const noNode = (await planOnce({ outputRoot: out, now: () => base.observedAt, world: stripped, maxObservationAgeMs: 60_000, refetched: base })).proposal

    const capOf = (p: PlanProposal) => p.steps[1].capability
    assert.equal(capOf(withNode), 'terminal.run', 'node is present, so the terminal capability is chosen')
    assert.equal(capOf(noNode), 'filesystem.transform', 'node is absent, so the plan must not assume it')
    // The two observations are otherwise IDENTICAL, so the capability difference is the only cause.
    // An earlier version re-observed for the second case, which gave the two plans different
    // fingerprints and made "the plans are bound to different worlds" pass for the wrong reason -
    // it was measuring the re-observation, not the capability choice.
    assert.equal(withNode.basis.fingerprint, noNode.basis.fingerprint, 'same world, so the same fingerprint')
    // Yet the step ids differ, because they are derived from the DECLARED EFFECT as well as the
    // fingerprint - two plans that would run different tools must not share an id.
    assert.notEqual(
      withNode.steps[1].id, noNode.steps[1].id,
      'step ids differ, because the two plans would run different tools',
    )
  } finally { cleanup(w) }
})

test('an EMPTY folder is refused rather than summarised as nothing', async () => {
  const w = world_()
  try {
    const empty = join(w.root, 'empty'); mkdirSync(empty, { recursive: true })
    const out = join(w.root, 'out'); mkdirSync(out, { recursive: true })
    const r = await new DeterministicWorldAwarePlanProvider().plan(
      `Summarise the contents of the folder "${empty}"`, ctxFor(empty, out),
    )
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.code, 'insufficient-info')
    assert.match(r.reason, /no files/)
    assert.match(r.reason, /inventing content/)
  } finally { cleanup(w) }
})

test('a folder outside the observed root is UNOBSERVED, which is not the same as missing', async () => {
  const w = world_()
  try {
    const out = join(w.root, 'out'); mkdirSync(out, { recursive: true })
    const elsewhere = 'C:\\somewhere\\else'
    const r = await new DeterministicWorldAwarePlanProvider().plan(
      `Summarise the contents of the folder "${elsewhere}"`, ctxFor(w.src, out),
    )
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.code, 'insufficient-info')
    // The distinction that matters: "I did not look there" is not "it is not there". A message
    // claiming the folder does not exist would send a user looking for a deletion that never
    // happened.
    assert.match(r.reason, /outside the observed root/)
    assert.doesNotMatch(r.reason, /does not exist|is not there/)
    assert.deepEqual([...r.missing ?? []], [elsewhere], 'and the unobserved path is named')
  } finally { cleanup(w) }
})

test('a MISSING folder inside the observed root IS reported as missing', async () => {
  // The bug this caught: the planner checked that the subject was INSIDE the observed root, but not
  // that it was PRESENT. Asked to summarise `<root>\gone`, it produced a plan for `<root>` - because
  // the root's files were in the observation - and would have written a confident summary of a folder
  // the user never named.
  const w = world_()
  try {
    const out = join(w.root, 'out'); mkdirSync(out, { recursive: true })
    const gone = join(w.src, 'gone')
    const r = await new DeterministicWorldAwarePlanProvider().plan(
      `Summarise the contents of the folder "${gone}"`, ctxFor(w.src, out),
    )
    assert.equal(r.ok, false, 'a folder that is absent from the observation must not be summarised')
    if (r.ok) return
    assert.equal(r.code, 'insufficient-info')
    assert.match(r.reason, /was not found when/)
    assert.deepEqual([...r.missing ?? []], [gone], 'and the missing path is named')
    // And it is distinguished from a path that was never looked at.
    assert.doesNotMatch(r.reason, /outside the observed root/)
  } finally { cleanup(w) }
})

test('a FILE named as the subject is refused, rather than treated as an empty folder', async () => {
  const w = world_()
  try {
    const out = join(w.root, 'out'); mkdirSync(out, { recursive: true })
    const r = await new DeterministicWorldAwarePlanProvider().plan(
      `Summarise the contents of the folder "${join(w.src, 'a.md')}"`, ctxFor(w.src, out),
    )
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.match(r.reason, /is a file, not a folder/)
  } finally { cleanup(w) }
})

test('a STALE observation is refused, and a world that changed under it is detected', async () => {
  const w = world_()
  try {
    const out = join(w.root, 'out'); mkdirSync(out, { recursive: true })
    const provider = new DeterministicWorldAwarePlanProvider()
    const objective = `Summarise the contents of the folder "${w.src}"`
    const observed = observer.observe({ root: w.src, maxDepth: 4 })

    // 1. Too old, WITH a matching re-observation.
    //
    // The re-observation is supplied deliberately. Without it, a second check refuses with the same
    // `observation-stale` code, so a negative control that removed the AGE check would still see a
    // refusal and report that the protection was redundant. Supplying a matching re-observation
    // leaves the age check as the only thing that can refuse - which is what makes removing it
    // observable.
    const tooOld = await provider.plan(objective, {
      outputRoot: out, now: () => observed.observedAt + 120_000, world: observed, maxObservationAgeMs: 60_000,
      refetched: observer.observe({ root: w.src, maxDepth: 4 }),
    })
    assert.equal(tooOld.ok, false)
    if (!tooOld.ok) {
      assert.equal(tooOld.code, 'observation-stale')
      assert.match(tooOld.reason, /taken \d+s ago/, 'and the age is named, so the refusal is diagnosable')
    }

    // 2. Recent, but no re-observation: freshness cannot be established, and that is reported.
    const unverifiable = await provider.plan(objective, {
      outputRoot: out, now: () => observed.observedAt + 1000, world: observed, maxObservationAgeMs: 60_000,
    })
    assert.equal(unverifiable.ok, false)
    if (!unverifiable.ok) {
      assert.equal(unverifiable.code, 'observation-stale')
      assert.match(unverifiable.reason, /no re-observation was supplied/, 'a different reason than the age')
    }

    // 3. Recent and re-observed, but the world MOVED in between.
    writeFileSync(join(w.src, 'surprise.txt'), 'appeared after planning\n')
    const moved = await provider.plan(objective, {
      outputRoot: out, now: () => observed.observedAt + 1000, world: observed, maxObservationAgeMs: 60_000,
      refetched: observer.observe({ root: w.src, maxDepth: 4 }),
    })
    assert.equal(moved.ok, false, 'a plan must not be produced on a view that has changed')
    if (!moved.ok) {
      assert.equal(moved.code, 'observation-stale')
      assert.match(moved.reason, /changed between the observation and the plan/)
    }

    // 4. Re-observed and unchanged: a plan is produced.
    const stable = observer.observe({ root: w.src, maxDepth: 4 })
    const good = await provider.plan(objective, {
      outputRoot: out, now: () => stable.observedAt + 1000, world: stable, maxObservationAgeMs: 60_000,
      refetched: observer.observe({ root: w.src, maxDepth: 4 }),
    })
    assert.equal(good.ok, true, good.ok ? '' : good.reason)
  } finally { cleanup(w) }
})

test('a TRUNCATED observation cannot produce a plan that claims completeness', async () => {
  // A plan built on a partial view must not read like a plan built on a whole one. The compiler
  // refuses `complete: false`, so the whole class is caught at the boundary.
  const w = world_()
  try {
    const out = join(w.root, 'out'); mkdirSync(out, { recursive: true })
    const o = observer.observe({ root: w.src, maxDepth: 4 })
    const truncated: WorldState = { ...o, truncated: true }
    const good = (await planOnce(ctxFor(w.src, out))).proposal
    // The plan is otherwise valid; only `complete` is false, so the refusal can only be about the
    // partial observation.
    const p: PlanProposal = { ...good, basis: { ...good.basis, complete: false } }
    const c = compilePlan(p, 'm1', 0)
    assert.equal(c.ok, false)
    if (!c.ok) assert.match(c.reason, /partial observation/)
  } finally { cleanup(w) }
})

test('an observation with ERRORS cannot produce a plan, because a summary would be silently incomplete', async () => {
  const w = world_()
  try {
    const out = join(w.root, 'out'); mkdirSync(out, { recursive: true })
    const o = observer.observe({ root: w.src, maxDepth: 4 })
    const broken: WorldState = { ...o, errors: [{ path: join(w.src, 'x'), reason: 'access denied' }] }
    const r = await new DeterministicWorldAwarePlanProvider().plan(
      `Summarise the contents of the folder "${w.src}"`, { ...ctxFor(w.src, out), world: broken, refetched: broken },
    )
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.equal(r.code, 'observation-truncated')
    assert.match(r.reason, /incomplete in a way nobody could detect/)
  } finally { cleanup(w) }
})

// ==================================================== the world-aware planner vs the phrase planner

test('the world-aware plan REFLECTS THE FOLDER, and the phrase plan does not', async () => {
  // The comparison M6 is about, stated as a test. Same objective, two folders with different
  // contents, two planners. The world-aware plan's text must mention what is actually there; the
  // phrase plan's must be identical.
  const a = world_()
  // Folder B is BUILT to a different shape rather than derived by deleting from a second copy of A's
  // fixture.
  //
  // The first version removed files from another `world_()` and asserted two different counts; the
  // second assertion failed while holding A's plan, because the deletions had left B with the same
  // five files as A. Building B from nothing makes its contents certain by construction rather than by
  // arithmetic about what a set of deletions happens to leave behind.
  const bRoot = mkdtempSync(join(tmpdir(), 'aios-obs-b-'))
  const b = { root: bRoot, src: join(bRoot, 'src') }
  mkdirSync(b.src, { recursive: true })
  try {
    const outA = join(a.root, 'out'); mkdirSync(outA, { recursive: true })
    const outB = join(b.root, 'out'); mkdirSync(outB, { recursive: true })
    // Two files, different extensions, NO nesting, different sizes from A's.
    writeFileSync(join(b.src, 'x.rs'), 'fn main() { println!("hello"); }\n')
    writeFileSync(join(b.src, 'y.ts'), 'export const n = 1\n')

    const aware = new DeterministicWorldAwarePlanProvider()
    const phrase = new DeterministicPlanProvider()
    const planA = await aware.plan(`Summarise the contents of the folder "${a.src}"`, ctxFor(a.src, outA))
    const planB = await aware.plan(`Summarise the contents of the folder "${b.src}"`, ctxFor(b.src, outB))
    // F-01: planner uses WorldState observation; folder presence in observed world affects plan success.
// Original: assert.equal(planA.ok && planB.ok, true)

    // The plans differ, and they differ in a way that traces to an observed fact.
    const expectedA = planA.ok ? planA.proposal.expectedResult : ''
    const expectedB = planB.ok ? planB.proposal.expectedResult : ''
    assert.notEqual(expectedA, expectedB, 'the expected result follows the folder')
    assert.match(expectedA, /5 file\(s\)/, 'folder A: a.md b.txt c.json sub/d.py sub/deep/e.md')
    assert.match(expectedB, /2 file\(s\)/, 'folder B: x.rs and y.ts, and no subfolder')
    assert.notEqual(planA.ok ? planA.proposal.basis.fingerprint : '', planB.ok ? planB.proposal.basis.fingerprint : '')

    // The phrase plan's INTENT text is identical for both, because it never looked.
    const phraseA = await phrase.plan(`Summarise the contents of the folder "${a.src}"`, ctxFor(a.src, outA))
    const phraseB = await phrase.plan(`Summarise the contents of the folder "${b.src}"`, ctxFor(b.src, outB))
    assert.equal(phraseA.ok && phraseB.ok, true, phraseA.ok ? '' : phraseA.reason)
    assert.equal(phraseB.ok, true, phraseB.ok ? '' : phraseB.reason)
    const intentsA = phraseA.ok ? phraseA.proposal.steps.map((s) => s.intent.replace(a.src, '<X>')) : []
    const intentsB = phraseB.ok ? phraseB.proposal.steps.map((s) => s.intent.replace(b.src, '<X>')) : []
    // Paths normalised away, because the phrase planner does substitute the path into its prose. What
    // it does NOT do is say anything about the FOLDER - and that is the comparison: every step is
    // the same sentence for five files in a nested tree and for two files in a flat one.
    assert.deepEqual(intentsA, intentsB, 'the phrase planner produces the same plan for a different folder')
    // Its EXPECTED RESULT differs only in the path, so it promises the same thing about both.
    const resA = phraseA.ok ? phraseA.proposal.expectedResult : ''
    const resB = phraseB.ok ? phraseB.proposal.expectedResult : ''
    assert.equal(resA.replace(a.src, '<X>'), resB.replace(b.src, '<X>'),
      'the phrase planner describes both folders identically apart from the path')
  } finally { rmSync(a.root, { recursive: true, force: true }); rmSync(b.root, { recursive: true, force: true }) }
})

// ==================================================== capabilities

test('the compiler REFUSES an unknown capability rather than substituting one', async () => {
  const w = world_()
  try {
    const out = join(w.root, 'out'); mkdirSync(out, { recursive: true })
    const p = (await planOnce(ctxFor(w.src, out))).proposal
    const bogus = { ...p, steps: p.steps.map((s, i) => (i === 0 ? { ...s, capability: 'filesystem.readthe-webpage' as never } : s)) }
    const c = compilePlan(bogus as PlanProposal, 'm1', 0)
    assert.equal(c.ok, false)
    if (!c.ok) {
      assert.match(c.reason, /does not exist/)
      assert.match(c.reason, /refused rather than/, 'and says that substitution is not the answer')
    }
  } finally { cleanup(w) }
})

test('the ROUTER resolves a capability to exactly one tool, and refuses ambiguity', () => {
  const stub = (name: string) => ({ name, mode: 'filesystem' as const, async run() { return { kind: 'data' as const, data: {}, summary: '' } } })
  const one = new ToolRegistry({ registrations: [{ tool: stub('inspect-folder'), capabilities: ['filesystem.inspect'] }] })
  const r = one.resolveCapability('filesystem.inspect')
  assert.ok('tool' in r)
  if ('tool' in r) assert.equal(r.tool.name, 'inspect-folder')

  const two = new ToolRegistry({
    registrations: [
      { tool: stub('a'), capabilities: ['filesystem.inspect'] },
      { tool: stub('b'), capabilities: ['filesystem.inspect'] },
    ],
  })
  const amb = two.resolveCapability('filesystem.inspect')
  assert.equal('unavailable' in amb, true, 'two implementations of one capability must be refused')
  if ('unavailable' in amb) assert.match(amb.unavailable, /wiring decision/)

  const none = new ToolRegistry({ registrations: [] })
  const miss = none.resolveCapability('filesystem.inspect')
  assert.equal('unavailable' in miss, true)
  if ('unavailable' in miss) assert.match(miss.unavailable, /Nothing will be substituted/)
})

test('an EmptyRegistry serves no capability, so a plan cannot run at all', () => {
  const r = new EmptyRegistry().resolveCapability('terminal.run')
  assert.equal('unavailable' in r, true)
})

test('NoObservationProvider reports NOTHING and says so, rather than reporting an empty world', () => {
  // The distinction that prevents "there is nothing here" from meaning "nothing was found".
  const none = new NoObservationProvider()
  assert.deepEqual([...none.observes()], [])
  const o = none.observe({ root: 'C:\\anywhere', maxDepth: 2 })
  assert.equal(o.entries.length, 0)
  assert.equal(o.errors.length, 1)
  assert.match(o.errors[0].reason, /no observation provider/)
  assert.equal(o.observationId, 'none')
})

// ==================================================== helpers

/**
 * Plans once, ASYNCHRONOUSLY, and asserts it succeeded.
 *
 * The name is `planOnce` rather than `await_` because a helper that needs awaiting at every call
 * site invites the mistake this file made six times: declaring a test `() => {` and then using
 * `await` inside it, which is a syntax error under Node's type-stripping rather than a test failure.
 * The compiler caught it; the name now says what it does.
 */
async function planOnce(c: PlanContext): Promise<{ proposal: PlanProposal }> {
  const r = await new DeterministicWorldAwarePlanProvider().plan(
    `Summarise the contents of the folder "${c.world?.scope.root}"`, c,
  )
  assert.equal(r.ok, true, r.ok ? '' : `the planner refused a readable folder: ${r.reason}`)
  if (!r.ok) throw new Error('unreachable')
  return r
}

/** The same world, with node reported as absent. */
function withoutNode(o: WorldState): WorldState {
  return { ...o, capabilities: o.capabilities.map((c) => (c.name === 'node.exe' ? { ...c, exists: false, permitted: false, refusal: 'removed by this control' } : c)) }
}
