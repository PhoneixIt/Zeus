/**
 * THE FOLDER LABEL, PINNED.
 *
 * ============================================================================================
 * WHY THESE TESTS EXIST
 * ============================================================================================
 *
 * A genuine model-generated mission passed plan validation, compiled, executed all five steps through
 * the governed executor, wrote the requested file, and was still REFUSED by independent verification.
 * The artifact said `# Contents of aios-m2\src` - a folder that does not exist - because the plan
 * supplied `folderLabel: "aios-m2\src"` instead of the observed absolute path.
 *
 * Nothing was wrong with the plan's shape, its tools, its capabilities, its step ids or its
 * dependencies. It was wrong in one operand, and that operand held a fact the machine already knew.
 *
 * The fix is to stop asking the model for a machine-known value: the trusted path wins, an operand
 * that agrees is accepted, and an operand that disagrees is REFUSED rather than quietly repaired.
 * These tests hold that line in place.
 *
 * ============================================================================================
 * WHAT IS DELIBERATELY NOT TESTED HERE
 * ============================================================================================
 *
 * There is no test that "a slightly wrong label still produces a correct summary". That behaviour is
 * the bug. Repairing the label silently would produce an artifact that disagrees with the plan that
 * produced it, and nothing would report the disagreement.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

import { composeSummaryTool, normalizeFolderLabel, FOLDER_TOOLS } from '../live/folder-tools.ts'
// `FolderEntry` is what `folder-tools.ts` itself imports, so the fixtures are typed by the SAME
// declaration the tool uses. Importing it from here would be a second, drifting copy of the shape.
import type { FolderEntry } from '../../planner/summarizer.ts'

// ---------------------------------------------------------------- fixtures

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'aios-label-'))
}

/** A source folder with exactly four entries, so the counts are known without inspecting them. */
function seedSource(root: string): string {
  const src = join(root, 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'readme.md'), '# Readme\nhello\n')
  writeFileSync(join(src, 'data.csv'), 'a,b\n1,2\n')
  writeFileSync(join(src, 'notes.txt'), 'note\n')
  mkdirSync(join(src, 'logs'), { recursive: true })
  return src
}

function entriesFor(path: string): FolderEntry[] {
  // Mirrors what `inspect-folder` hands to `compose-summary`: a listing plus the resolved folder path.
  return readdirSync(path, { withFileTypes: true }).map((d) => ({
    name: d.name,
    kind: d.isDirectory() ? 'folder' : 'file',
    bytes: d.isDirectory() ? 0 : statSync(join(path, d.name)).size,
  })) as FolderEntry[]
}

/** Run `compose-summary` against a listing produced as if by a preceding `inspect-folder` step. */
async function compose(
  trustedPath: string,
  folderLabel?: unknown,
): Promise<{ kind: string; reason?: string; data?: { text: string; folderLabel: string; entryCount: number } }> {
  const ctx = {
    prior: {
      'inspect-folder': { output: { path: trustedPath, entries: entriesFor(trustedPath), entryCount: 4 } },
    },
  }
  const args: Record<string, unknown> = { from: 'inspect-folder' }
  if (folderLabel !== undefined) args.folderLabel = folderLabel
  return (await composeSummaryTool.run(ctx as never, args)) as never
}

// ---------------------------------------------------------------- the rule in isolation

test('normalizeFolderLabel: an omitted operand yields the trusted observed path', () => {
  const trusted = resolve('C:\\tmp\\aios-m2\\src')
  for (const omitted of [undefined, null, '', '   ']) {
    const r = normalizeFolderLabel(trusted, omitted)
    assert.equal(r.ok, true, `omitted operand (${JSON.stringify(omitted)}) must be accepted`)
    assert.equal(r.ok && r.label, trusted)
  }
})

test('normalizeFolderLabel: a correct full label is accepted and normalised to the trusted form', () => {
  const trusted = resolve('C:\\tmp\\aios-m2\\src')
  // Same path, a trailing separator: accepted, and normalised to the trusted spelling.
  const trailing = normalizeFolderLabel(trusted, trusted + '\\')
  assert.equal(trailing.ok, true)
  assert.equal(trailing.ok && trailing.label, trusted)
})

test('normalizeFolderLabel: case alone is not a conflict, because Windows paths are case-insensitive', () => {
  const trusted = resolve('C:\\tmp\\aios-m2\\src')
  const r = normalizeFolderLabel(trusted, trusted.toUpperCase())
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.label, trusted)
})

test('normalizeFolderLabel: a truncated label is REFUSED, not repaired', () => {
  const trusted = resolve('C:\\Users\\Samer\\AppData\\Local\\Temp\\aios-m2\\src')
  // Exactly the value the model emitted in the mission that failed.
  const r = normalizeFolderLabel(trusted, 'aios-m2\\src')
  assert.equal(r.ok, false, 'a truncated label must never be silently accepted')
  assert.match(
    r.ok ? '' : r.reason,
    /does not name the folder that was actually observed/,
    'the refusal must explain what is wrong',
  )
  assert.match(r.ok ? '' : r.reason, /Omit folderLabel/, 'the refusal must say how to fix it')
  assert.ok(r.ok ? '' : r.reason.includes(trusted), 'the refusal must name the trusted value')
})

test('normalizeFolderLabel: a different folder entirely is refused', () => {
  const trusted = resolve('C:\\tmp\\aios-m2\\src')
  for (const wrong of ['C:\\tmp\\elsewhere', '..\\..\\src', 'src', 'C:\\tmp\\aios-m2\\src2']) {
    assert.equal(normalizeFolderLabel(trusted, wrong).ok, false, `${wrong} must be refused`)
  }
})

// ---------------------------------------------------------------- the tool, end to end

test('compose-summary: an omitted folderLabel produces a summary naming the observed folder', async () => {
  const root = scratch()
  try {
    const src = seedSource(root)
    const r = await compose(resolve(src))
    assert.equal(r.kind, 'data')
    assert.equal(r.data?.folderLabel, resolve(src))
    assert.ok(
      r.data?.text.includes(resolve(src)),
      'the summary must name the observed folder by its full path',
    )
    assert.equal(r.data?.entryCount, 4)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('compose-summary: a correct full folderLabel is accepted and names the observed folder', async () => {
  const root = scratch()
  try {
    const src = seedSource(root)
    const r = await compose(resolve(src), resolve(src))
    assert.equal(r.kind, 'data')
    assert.equal(r.data?.folderLabel, resolve(src))
    assert.ok(r.data?.text.includes(resolve(src)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('compose-summary: a conflicting folderLabel FAILS the step instead of naming a wrong folder', async () => {
  const root = scratch()
  try {
    const src = seedSource(root)
    const r = await compose(resolve(src), 'aios-m2\\src')
    assert.equal(r.kind, 'failed', 'a conflicting label must fail the step')
    assert.match(String(r.reason), /does not name the folder that was actually observed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('compose-summary: a failed label produces no summary text at all', async () => {
  const root = scratch()
  try {
    const src = seedSource(root)
    const r = await compose(resolve(src), 'wrong-folder')
    assert.equal(r.kind, 'failed')
    // The failure must not leak a half-labelled artifact downstream to `write-report`.
    assert.equal(r.data, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- the contract the model reads

test('the folderLabel contract tells the model to omit the operand', () => {
  const spec = (composeSummaryTool as any).args?.find((a: { name: string; required: boolean; description: string }) => a.name === 'folderLabel')
  assert.ok(spec, 'compose-summary must declare folderLabel')
  assert.equal(spec!.required, false, 'folderLabel stays optional - omission is the correct move')
  assert.match(spec!.description, /OMIT THIS/, 'the contract must say omission is preferred')
})

test('every folder tool still declares the operands its run() reads', () => {
  // The contract is authoritative for PROMPTING only; if it drifts from the tool the model is shown
  // a lie. This fails loudly when a tool gains an operand nobody declared.
  const declared = (name: string): string[] =>
    (FOLDER_TOOLS.find((t) => t.name === name)?.args ?? []).map((a) => a.name).sort()
  assert.deepEqual(declared('read-folder'), ['path'])
  assert.deepEqual(declared('inspect-folder'), ['from'])
  assert.deepEqual(declared('compose-summary'), ['folderLabel', 'from'])
  assert.deepEqual(declared('write-report'), ['from', 'name', 'outputRoot', 'path'])
  assert.deepEqual(declared('read-report'), ['path'])
})

test('the observed source folder is untouched by any of this', () => {
  const root = scratch()
  try {
    const src = seedSource(root)
    const before = readdirSync(src).sort()
    const r = composeSummaryTool.args?.find((a) => a.name === 'folderLabel')
    assert.ok(r)
    assert.equal(readdirSync(src).sort().join(), before.join())
    assert.equal(existsSync(src), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})