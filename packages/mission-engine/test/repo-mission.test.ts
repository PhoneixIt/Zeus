/**
 * M20 CONTROLS - the repository mission's tools and its verifier.
 *
 * =============================================================================
 * WHY THESE EXIST
 * =============================================================================
 *
 * The live harness `run-repo-mission.ts` demonstrates the loop. This file exists because a
 * demonstration that has never been shown to FAIL is not evidence.
 *
 * The verifier is the component that matters most here. It is the only thing standing between "a
 * tool wrote a file" and "the report is true". So each of its rejections gets a control that
 * PROVES the rejection fires - and every one of them was produced by handing the verifier a
 * deliberately corrupted report, not by reading the code and asserting it looks right.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { repoReportVerifier } from '../live/run-repo-mission.ts'
import type { Step } from '../state.ts'

const tmp = mkdtempSync(join(tmpdir(), 'aios-m20-'))

const GOOD = [
  '# AIOS repository report',
  '',
  '- branch: master',
  '- uncommitted tracked changes: 4',
  '- uncommitted untracked files: 3',
  '- uncommitted total (tracked + untracked): 7',
  '- tracked TypeScript source files: 81',
  '',
].join('\n')

function write(name: string, body: string): string {
  const p = join(tmp, name)
  writeFileSync(p, body, 'utf8')
  return p
}

async function verifyReport(path: string, stepId = 's7'): Promise<{ ok: boolean; why: string }> {
  const v = repoReportVerifier()
  const step = { id: stepId, mode: 'filesystem', capability: 'filesystem.read' } as unknown as Step
  const r = await v.verify(step, {} as never, { target: path })
  return 'evidence' in r ? { ok: true, why: 'verified' } : { ok: false, why: r.rejected }
}

// ============================================================================================
// THE POSITIVE CASE, so the negatives below mean something
// ============================================================================================

test('a correct report IS accepted', async () => {
  const r = await verifyReport(write('good.md', GOOD))
  assert.equal(r.ok, true, `a correct report was rejected: ${r.why}`)
})

// ============================================================================================
// THE NEGATIVE CONTROLS - each one MUST be rejected
// ============================================================================================

test('CONTROL: an absent report is rejected', async () => {
  const r = await verifyReport(join(tmp, 'never-written.md'))
  assert.equal(r.ok, false, 'a report that was never written must not verify')
})

test('CONTROL: an INCOMPLETE report is rejected - a missing fact is not a pass', async () => {
  // The single most dangerous failure: a truncated report that still "looks like a report".
  const incomplete = GOOD.replace('- tracked TypeScript source files: 81\n', '')
  const r = await verifyReport(write('incomplete.md', incomplete))
  assert.equal(r.ok, false, 'a report missing a fact was accepted')
  assert.match(r.why, /missing the fact/, `the refusal must say WHICH fact: ${r.why}`)
})

test('CONTROL: an ALTERED report is rejected - the arithmetic must still hold', async () => {
  // A plausible lie: every field is present, every field looks right, and the total no longer
  // equals its parts. This is the report a tool would produce if it counted only tracked changes
  // and then wrote a total that included untracked ones.
  const inconsistent = GOOD
    .replace('uncommitted tracked changes: 4', 'uncommitted tracked changes: 9')
  const r = await verifyReport(write('inconsistent.md', inconsistent))
  assert.equal(r.ok, false, 'an internally inconsistent report was accepted')
  assert.match(r.why, /inconsistent report/, `the refusal must name the inconsistency: ${r.why}`)
})

test('CONTROL: a non-numeric count is rejected', async () => {
  const bad = GOOD.replace('tracked TypeScript source files: 81', 'tracked TypeScript source files: many')
  const r = await verifyReport(write('nonnumeric.md', bad))
  assert.equal(r.ok, false, 'a non-numeric count was accepted')
  assert.match(r.why, /non-negative integer/, r.why)
})

test('CONTROL: a NEGATIVE count is rejected', async () => {
  const bad = GOOD.replace('tracked TypeScript source files: 81', 'tracked TypeScript source files: -1')
  const r = await verifyReport(write('negative.md', bad))
  assert.equal(r.ok, false, 'a negative count was accepted')
})

test('CONTROL: an empty branch is rejected', async () => {
  const bad = GOOD.replace('- branch: master', '- branch: ')
  const r = await verifyReport(write('nobranch.md', bad))
  assert.equal(r.ok, false, 'an empty branch was accepted')
})

test('CONTROL: prose with no facts at all is rejected', async () => {
  const r = await verifyReport(write('prose.md', '# Report\n\nEverything looks fine to me.\n'))
  assert.equal(r.ok, false, 'a report containing no parsable facts was accepted')
})

// ============================================================================================
// THE PARSER ITSELF - the defect this file found
// ============================================================================================

test('CONTROL: the fact parser accepts a key containing UPPERCASE letters', async () => {
  // This is not hypothetical. The first version of the parser used `[a-z ()+]+`, which silently
  // matched NOTHING on the key "tracked TypeScript source files". The verifier then reported "the
  // report contains no parsable facts" about a report that was entirely correct - a control
  // crying wolf, which is how a control gets deleted instead of fixed.
  const r = await verifyReport(write('uppercase.md', GOOD))
  assert.equal(r.ok, true, `the parser rejected a key with an uppercase letter: ${r.why}`)
  assert.ok(GOOD.includes('tracked TypeScript source files'), 'the fixture must contain the key')
})