import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeterministicPlanProvider } from '../deterministic.ts'
import { LocalObservationProvider } from '../../observation/local.ts'

/**
 * A SUMMARY MUST NOT BE WRITTEN INSIDE THE FOLDER IT DESCRIBES.
 *
 * Writing the report into the source folder makes the report part of the thing it reports on. Every
 * independent check afterwards - the entry count, the file/folder split, "the source folder still
 * holds what it started with" - is then comparing the folder against a listing taken before the
 * artefact existed. The mission's own verification is invalidated by its own success.
 *
 * Observed while running `run-folder-summary` with `--output` pointed inside `--source`: the artefact
 * was correct, and four independent checks failed purely because the folder had gained a file.
 *
 * REFUSED, NOT REPAIRED. The alternative is silently relocating the user's requested file, which is
 * the kind of quiet substitution this project refuses everywhere else. The caller chooses a
 * destination outside the folder.
 */

const provider = new DeterministicPlanProvider()

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mc-self-'))
  const src = join(root, 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'a.ts'), 'a'.repeat(40), 'utf8')
  writeFileSync(join(src, 'b.ts'), 'b'.repeat(30), 'utf8')
  const outDir = join(root, 'out')
  mkdirSync(outDir, { recursive: true })
  return { root, src, outDir }
}

async function plan(src: string, outputRoot: string) {
  const observed = await new LocalObservationProvider().observe({ root: src, maxDepth: 4 } as never)
  return provider.plan(`summarise all the files in ${src}`, {
    now: () => (observed as unknown as { observedAt: number }).observedAt,
    outputRoot, outputFileName: 'summary.txt',
    world: observed, maxObservationAgeMs: 60_000, refetched: observed,
  } as never)
}

test('output INSIDE the folder being summarised is REFUSED, clearly and before anything runs', async () => {
  const { root, src } = fixture()
  try {
    // The output folder IS the source folder.
    const r = await plan(src, src)
    assert.equal(r.ok, false, 'a self-referential destination is not plannable')
    if (r.ok) return
    assert.match(r.reason, /inside the folder being summarised/i)
    assert.match(r.reason, /would then change the very listing it claims to describe/i)
    // The refusal must name a way out rather than just complain.
    assert.match(r.reason, /outside/i)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('output in a SUBDIRECTORY of the summarised folder is refused too', async () => {
  const { root, src } = fixture()
  try {
    const inner = join(src, 'reports')
    mkdirSync(inner, { recursive: true })
    const r = await plan(src, inner)
    assert.equal(r.ok, false, 'a child of the source folder is still self-referential')
    if (r.ok) return
    assert.match(r.reason, /inside the folder being summarised/i)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('output OUTSIDE the folder being summarised is accepted unchanged', async () => {
  const { root, src, outDir } = fixture()
  try {
    const r = await plan(src, outDir)
    assert.equal(r.ok, true, 'the ordinary case must not be caught by this rule')
    if (!r.ok) return
    const written = r.proposal.steps.find((s) => s.id === 'write-report')?.args as { path?: string } | undefined
    assert.equal(written?.path, join(outDir, 'summary.txt'),
      'and the destination the caller asked for is the one used - nothing was silently relocated')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the refusal is lexical: no filesystem call is needed to reach it', async () => {
  // A path that does not exist is still inside the source folder lexically, so it is still refused.
  // That is the property that keeps this check out of the filesystem and inside the planner.
  const { root, src } = fixture()
  try {
    const notCreated = join(src, 'never-created')
    const r = await plan(src, notCreated)
    assert.equal(r.ok, false, 'containment is decided by the paths alone')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
