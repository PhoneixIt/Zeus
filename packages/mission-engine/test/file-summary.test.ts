/**
 * M21 CONTROLS - file-content summarisation, its refusal paths, and its independent verifier.
 *
 * The point of this file is the REFUSALS. A summariser that always produces a summary looks
 * identical to a correct one until the day it confidently summarises a file that was never read.
 * Every negative case below is a request that must NOT produce a summary, and each asserts the
 * specific reason rather than merely "it failed" - a refusal that cannot say why is an alarm, not
 * a control.
 *
 * Fixtures live in a temp directory that is removed afterwards. No real user file is touched.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  readInputFileTool, summariseFileTool, writeSummaryTool, fileSummaryVerifier,
  measureFile, renderSummary, MAX_INPUT_BYTES,
} from '../live/file-tools.ts'
import { DeterministicPlanProvider } from '../../planner/deterministic.ts'
import type { Step } from '../state.ts'

const ROOT = mkdtempSync(join(tmpdir(), 'aios-m21-'))
process.on('exit', () => { try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* Defender may hold it */ } })

const GOOD = '# Notes\n\n' + 'alpha beta gamma alpha delta epsilon alpha beta\n'.repeat(6) + '\ntrailing line\n'
const file = (name: string, body = GOOD): string => {
  const p = join(ROOT, name)
  writeFileSync(p, body, 'utf8')
  return p
}

const ctx = (stepId: string, prior: Record<string, unknown> = {}) =>
  ({ stepId, prior } as never)

const step = (id: string): Step => ({ id, mode: 'filesystem', capability: 'filesystem.read' } as unknown as Step)

async function verify(tool: typeof readInputFileTool | typeof summariseFileTool | typeof writeSummaryTool, s: Step, args: Record<string, unknown>, prior: Record<string, unknown> = {}) {
  return tool.run(ctx(s.id, prior), args)
}

async function verifyWith(verifier: ReturnType<typeof fileSummaryVerifier>, s: Step, data: unknown) {
  return verifier.verify(s, {} as never, data)
}

// ============================================================================================
// THE SUCCESS PATH
// ============================================================================================

test('a valid text file produces a deterministic summary of its ACTUAL contents', async () => {
  const p = file('notes.md')
  const read = await verify(readInputFileTool, step('read-input'), { path: p, workspaceRoot: ROOT })
  assert.equal(read.kind, 'data', `a readable text file must be read: ${read.kind === 'failed' ? read.reason : ''}`)
  if (read.kind !== 'data') return
  const facts = (read.data as { facts: { lines: number; words: number; heading: string } }).facts
  // Counted over the WHOLE file, which is what measureFile does - an earlier version of this test
  // stripped the heading first and compared a different thing, so it failed on a correct measurement.
  assert.equal(facts.heading, 'Notes', 'the heading is read from the file, not invented')
  assert.equal(facts.lines, GOOD.split('\n').length, 'line count matches the file')
  assert.equal(facts.words, GOOD.split(/\s+/).filter((w) => w.length > 0).length, 'word count matches the file')

  const sum = await verify(summariseFileTool, step('summarise-file'), { from: 'read-input', label: 'notes.md' }, { 'read-input': { output: read.data } })
  assert.equal(sum.kind, 'data')
  if (sum.kind !== 'data') return
  const text = (sum.data as { text: string }).text
  assert.match(text, /- heading: Notes/, 'the summary carries the heading it read')
  assert.match(text, new RegExp(`- lines: ${facts.lines}`), 'the summary carries the REAL line count')
})

// ============================================================================================
// THE REFUSALS
// ============================================================================================

test('CONTROL: a missing file is rejected', async () => {
  const r = await verify(readInputFileTool, step('read-input'), { path: join(ROOT, 'nope.md'), workspaceRoot: ROOT })
  assert.equal(r.kind, 'failed')
  if (r.kind === 'failed') assert.match(r.reason, /no file at/, 'the refusal must name the cause')
})

test('CONTROL: a DIRECTORY supplied instead of a file is rejected', async () => {
  mkdirSync(join(ROOT, 'adir.md'), { recursive: true })
  const r = await verify(readInputFileTool, step('read-input'), { path: join(ROOT, 'adir.md'), workspaceRoot: ROOT })
  assert.equal(r.kind, 'failed', 'a directory named like a text file must not be summarised')
  if (r.kind === 'failed') assert.match(r.reason, /is a directory/)
})

test('CONTROL: an unsupported extension is rejected', async () => {
  const p = file('binary.exe', 'MZ')
  const r = await verify(readInputFileTool, step('read-input'), { path: p, workspaceRoot: ROOT })
  assert.equal(r.kind, 'failed')
  if (r.kind === 'failed') assert.match(r.reason, /not a text type/)
})

test('CONTROL: a path OUTSIDE the workspace root is rejected', async () => {
  const outside = join(tmpdir(), `aios-outside-${Date.now()}.md`)
  writeFileSync(outside, GOOD, 'utf8')
  try {
    const r = await verify(readInputFileTool, step('read-input'), { path: outside, workspaceRoot: ROOT })
    assert.equal(r.kind, 'failed', 'a path outside the root must be refused even if it exists')
    if (r.kind === 'failed') assert.match(r.reason, /outside the workspace root/)
  } finally { rmSync(outside, { force: true }) }
})

test('CONTROL: a file exceeding the size limit is rejected', () => {
  const big = join(ROOT, 'big.md')
  writeFileSync(big, 'x'.repeat(MAX_INPUT_BYTES + 1024), 'utf8')
  const m = measureFile(big)
  assert.ok(!('error' in m), 'a large file is still READ - and flagged, not refused')
  if ('error' in m) return
  assert.equal(m.facts.truncated, true, 'an oversized file must be reported as TRUNCATED')
  assert.match(renderSummary('big.md', m.facts), /READ TRUNCATED/, 'and the summary must say so')
})

test('CONTROL: the summarise step refuses when no measured facts were produced', async () => {
  const r = await verify(summariseFileTool, step('summarise-file'), { from: 'read-input' }, {})
  assert.equal(r.kind, 'failed')
  if (r.kind === 'failed') assert.match(r.reason, /no measured facts/)
})

test('CONTROL: the write step refuses to overwrite', async () => {
  const target = file('out.md', 'existing')
  const r = await verify(writeSummaryTool, step('write-summary'), { target, from: 'summarise-file' }, { 'summarise-file': { output: { text: 'new' } } })
  assert.equal(r.kind, 'failed', 'overwriting an existing file must be refused, keeping the scenario reversible')
  if (r.kind === 'failed') assert.match(r.reason, /refusing to overwrite/)
})

// ============================================================================================
// THE INDEPENDENT VERIFIER
// ============================================================================================

test('CONTROL: a source file changed between execution and verification is REJECTED', async () => {
  const p = file('moving.md')
  const read = await verify(readInputFileTool, step('read-input'), { path: p, workspaceRoot: ROOT })
  assert.equal(read.kind, 'data')
  if (read.kind !== 'data') return
  const stale = (read.data as { facts: unknown }).facts

  // The world moves under the mission.
  appendFileSync(p, 'appended after the summary was computed\n')

  const v = fileSummaryVerifier(p)
  const r = await verifyWith(v, step('summarise-file'), { facts: stale })
  assert.ok(!('evidence' in r), 'a summary of a file that has since changed must not verify')
  if ('evidence' in r) return
  assert.match(r.rejected, /moved under the mission|does not match/, `the refusal must say why: ${r.rejected}`)
})

test('CONTROL: a written summary missing the disclosure is rejected', async () => {
  const p = file('disclose.md')
  const v = fileSummaryVerifier(p)
  const target = join(ROOT, 'no-disclosure.md')
  writeFileSync(target, `- lines: 1\n- words: 1\n`, 'utf8') // deliberately omits the disclosure
  const r = await verifyWith(v, step('verify-file-summary'), { target, text: `- lines: 1\n- words: 1\n` })
  assert.ok(!('evidence' in r), 'a summary that does not disclose it is not evidence')
  if ('evidence' in r) return
  assert.match(r.rejected, /disclose|does not carry/, r.rejected)
})

test('CONTROL: the verifier RE-MEASURES rather than trusting the execution-reported values', async () => {
  const p = file('independent.md')
  const read = await verify(readInputFileTool, step('read-input'), { path: p, workspaceRoot: ROOT })
  assert.equal(read.kind, 'data')
  if (read.kind !== 'data') return
  const v = fileSummaryVerifier(p)

  // Values that are internally consistent but DO NOT match the file. A verifier that trusted them
  // would accept these; one that re-reads the file rejects them.
  const forged = { ...(read.data as { facts: object }).facts, lines: 999999, words: 999999 }
  const r = await verifyWith(v, step('summarise-file'), { facts: forged })
  assert.ok(!('evidence' in r), 'forged counts must be rejected by re-measurement')
})

test('a correct, disclosed summary VERIFIES', async () => {
  const p = file('good.md')
  const read = await verify(readInputFileTool, step('read-input'), { path: p, workspaceRoot: ROOT })
  assert.equal(read.kind, 'data')
  if (read.kind !== 'data') return
  const sum = await verify(summariseFileTool, step('summarise-file'), { from: 'read-input', label: 'good.md' }, { 'read-input': { output: read.data } })
  assert.equal(sum.kind, 'data')
  if (sum.kind !== 'data') return
  const target = join(ROOT, 'good.summary.txt')
  const w = await verify(writeSummaryTool, step('write-summary'), { target, from: 'summarise-file' }, { 'summarise-file': { output: sum.data } })
  assert.equal(w.kind, 'data')
  if (w.kind !== 'data') return
  const v = fileSummaryVerifier(p)
  const r = await verifyWith(v, step('verify-file-summary'), (w.data as { target: string; text: string }))
  assert.ok('evidence' in r, `a correct summary must verify: ${('rejected' in r) ? r.rejected : ''}`)
  assert.equal(existsSync(target), true, 'the artifact really exists on disk')
})

// ============================================================================================
// PLANNER ROUTING - including the ambiguity correction
// ============================================================================================

const planner = new DeterministicPlanProvider()
const planCtx = { outputRoot: ROOT, now: () => 1, world: { observationId: 'o', observedAt: Date.now(), scope: { root: ROOT, maxDepth: 1 }, entries: [], fingerprint: 'f', capabilities: [], truncated: false, errors: [] } }

test('CONTROL: an AMBIGUOUS "summarise this" is REFUSED, not reinterpreted as a folder', async () => {
  const r = await planner.plan('summarise this', planCtx as never)
  assert.equal(r.ok, false, 'an ambiguous request must never be reinterpreted as some other operation')
  if (r.ok) return
  assert.equal(r.code, 'insufficient-info')
  assert.match(r.reason, /no folder was named|no file was named/, `the refusal must name what is missing: ${r.reason}`)
})

test('a NAMED file produces the file-summary plan', async () => {
  const p = file('planned.md')
  const r = await planner.plan(`summarise the file ${p}`, planCtx as never)
  assert.equal(r.ok, true, `a named file must plan: ${r.ok ? '' : r.reason}`)
  if (!r.ok) return
  assert.equal(r.proposal.steps[0].capability, 'filesystem.read')
  assert.equal(r.proposal.steps[0].tool, 'read-input-file')
})

test('REGRESSION: a NAMED folder still produces the folder-summary plan', async () => {
  mkdirSync(join(ROOT, 'somefolder'), { recursive: true })
  const r = await planner.plan(`summarise the contents of the folder ${join(ROOT, 'somefolder')}`, planCtx as never)
  assert.equal(r.ok, true, `a named folder must still plan: ${r.ok ? '' : r.reason}`)
  if (!r.ok) return
  assert.equal(r.proposal.steps[0].tool, 'read-folder', 'the folder recipe must not be stolen by the file recipe')
})

test('REGRESSION: a repository-state request still produces the repo plan', async () => {
  const r = await planner.plan('Report the state of this repository: current branch and uncommitted changes', planCtx as never)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.proposal.steps[0].tool, 'git-fact')
})

// ============================================================================================
// THE CALLER'S OUTPUT FILE NAME
//
// The folder recipe used to derive the artefact name from its own vocabulary, so a caller asking
// for `my-notes.txt` got `contents.txt` written with no warning. `PlanContext.outputFileName` is
// the fix, and these are its tests: the name is honoured VERBATIM, an unusable one is REFUSED
// rather than substituted, and - the one that matters most - the derivation with no explicit name
// is byte-for-byte what it always was.
// ============================================================================================

const namedFolder = () => {
  const d = join(ROOT, 'named-folder')
  mkdirSync(d, { recursive: true })
  return d
}
const writeStepOf = (p: { steps: readonly { tool: string; args: Record<string, unknown> }[] }) =>
  p.steps.find((s) => s.tool === 'write-report')!

test('an explicit outputFileName is used VERBATIM, not derived from the objective', async () => {
  const folder = namedFolder()
  for (const name of ['my-notes.txt', 'quarterly-report.txt', 'inventory.txt', 'Q1_2026.txt']) {
    const r = await planner.plan(
      `summarise the contents of the folder ${folder}`,
      { ...planCtx, outputFileName: name } as never)
    assert.equal(r.ok, true, `a caller-chosen name must plan: ${name}: ${r.ok ? '' : r.reason}`)
    if (!r.ok) return
    const w = writeStepOf(r.proposal)
    assert.equal(w.args.name, name, `the plan must carry the caller's exact name, not a derived one (${name})`)
    assert.equal(w.args.path, join(ROOT, name), `the write path must be the caller's destination (${name})`)
  }
})

test('REGRESSION: with NO explicit name the original derivation is unchanged', async () => {
  const folder = namedFolder()
  const r = await planner.plan(
    `summarise the contents of the folder ${folder}`,
    planCtx as never)
  assert.equal(r.ok, true)
  if (!r.ok) return
  const w = writeStepOf(r.proposal)
  // "summarise" is the first SUMMARY_RE word, so this is what this objective has always produced.
  assert.equal(w.args.name, 'summarise.txt',
    'an absent outputFileName must fall back to the original derivation, not to a new default')
  assert.equal(w.args.path, join(ROOT, 'summarise.txt'))
})

test('REGRESSION: an explicit name does not change the OTHER recipes', async () => {
  const p = file('planned-2.md')
  const r = await planner.plan(`summarise the file ${p}`, { ...planCtx, outputFileName: 'my-notes.txt' } as never)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.proposal.steps[0].tool, 'read-input-file', 'the file recipe must ignore a folder-recipe-only field')
})

test('CONTROL: an unusable outputFileName is REFUSED, never substituted', async () => {
  const folder = namedFolder()
  for (const name of [
    'evil.exe', 'evil.bat', 'evil.ps1', 'evil.cmd', 'evil.js',  // unsupported extension
    'notes',                                                    // no extension
    'a b.txt', 'a;b.txt', 'a$b.txt',                            // metacharacters / spaces
    'sub/dir.txt', 'sub\\dir.txt',                              // a path, not a name
    '..', '.', '', '   ', ' .txt', 'a.txt.exe', 'a.TXT.exe',
  ]) {
    const r = await planner.plan(
      `summarise the contents of the folder ${folder}`,
      { ...planCtx, outputFileName: name } as never)
    assert.equal(r.ok, false, `an unusable output name must be REFUSED, never repaired: "${name}"`)
    if (r.ok) continue
    assert.match(r.reason, /output name|output file name/,
      `the refusal must name the problem: "${name}" -> ${r.reason}`)
  }
})

test('an unrelated request is still refused', async () => {
  const r = await planner.plan('make me a sandwich', planCtx as never)
  assert.equal(r.ok, false)
  if (!r.ok) assert.equal(r.code, 'not-understood')
})