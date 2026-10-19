/**
 * A READ-BACK MUST PROVE WHAT WAS WRITTEN
 * ========================================
 *
 * THE DEFECT, AS OBSERVED
 * ----------------------
 * A real end-to-end mission reported:
 *
 *     a2-s4  read-file   verified=true   "exact match on read-file"
 *     a2-s4 = file-read-back  C:\Users\Samer\Documents\Zeus-Browser-Proof.txt
 *
 * That file was 0 bytes. An earlier attempt had opened the same path in an editor, and
 * `launch-app` pre-creates its target empty; the write was then relocated to the agent output
 * directory, leaving the requested path as an empty stub. The read-back pointed at the stub,
 * "verified" it, and produced the evidence kind that satisfies `artifact-read-back`.
 *
 * The cause was one line in the read-file verifier:
 *
 *     const claimed = String(d.text ?? '')
 *     if (claimed.length > 0 && now !== claimed) { REJECT }
 *
 * An empty file yields `text: ''`, so the guard was skipped entirely, and "the file exists and is
 * readable" was the whole of the claim. A read-back had become an existence check wearing the
 * costume of a content check.
 *
 * WHAT AN EMPTY FILE IS NOT
 * ------------------------
 * This is deliberately NOT "empty files are always invalid". "Create an empty file as a
 * placeholder" is a real objective, and a zero-byte file is the correct deliverable for it. The
 * question is never "is this file empty" but "was an empty file what was asked for" - and only the
 * step that declared the expectation may answer it.
 *
 * The three ways an expectation is established, in the order they are trusted:
 *
 *   1. `expectEmpty: true` on the step - the only declaration that can make emptiness correct.
 *   2. `expectChars: 0` - the same statement as a number.
 *   3. `expectText` / a preceding producing step - non-empty by construction, so an empty result
 *      contradicts them.
 *
 * `validatePlan` supplies (3) automatically: a read-back that follows a write inherits what that
 * write was going to contain, because the same plan said so moments earlier. That is a stated
 * expectation, not an inference about intent.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CAPS = pathToFileURL(join(HERE, '..', 'live', 'agent', 'capabilities.ts')).href
const AGENT = pathToFileURL(join(HERE, '..', 'live', 'agent', 'agent.ts')).href

const loadCaps = () => import(CAPS)
const loadAgent = () => import(AGENT)

// The scratch directory must sit INSIDE a folder a mission may read. `resolveReadablePath` refuses
// paths outside Documents/Desktop/Downloads/AGENT_OUT, and that refusal is correct - so the tests
// use the agent output directory, which is the same writable root a real mission uses.
const scratch = () => mkdtempSync(join(process.env.USERPROFILE ?? '', '.aios', 'agent', 'out', 'readback-'))
const cleanup = (dir: string, ...names: string[]) => {
  for (const n of names) rmSync(join(dir, n), { force: true })
  rmSync(dir, { recursive: true, force: true })
}

/** Verify a read-file step against a real file, exactly as the executor does. */
async function verifyRead(step: Record<string, unknown>, filePath: string, toolText?: string) {
  const { resolveCapability } = await loadCaps()
  const cap = resolveCapability('read-file')
  assert.ok(cap, 'read-file must resolve')
  const data = toolText === undefined ? undefined : { path: filePath, chars: toolText.length, text: toolText }
  return cap.verifier.verify(step as never, {} as never, data)
}

// ============================================================================================
// 1. NON-EMPTY EXPECTED FILE WITH MATCHING CONTENT PASSES
// ============================================================================================

test('1. a non-empty file with matching content verifies', async () => {
  const dir = scratch()
  const p = join(dir, 'report.txt')
  const content = 'Fact 1: the page title reads Example Domain.\nFact 2: body text about IANA.\n'
  writeFileSync(p, content, 'utf8')
  try {
    const r = await verifyRead({ id: 's1', tool: 'read-file', args: { path: p, expectChars: content.length } }, p, content)
    assert.ok(!('rejected' in r), `a matching read-back must verify: ${JSON.stringify(r)}`)
    assert.equal((r as { evidence: { kind: string; path: string } }).evidence.kind, 'file-read-back')
  } finally { cleanup(dir) }
})

// ============================================================================================
// 2. ZERO-BYTE FILE FAILS WHEN NON-EMPTY CONTENT IS EXPECTED
// ============================================================================================

test('2. a 0-byte file FAILS a read-back that expected content', async () => {
  const dir = scratch()
  const p = join(dir, 'report.txt')
  writeFileSync(p, '', 'utf8')
  try {
    // Both ways a plan can declare that content was expected.
    const withChars = await verifyRead({ id: 's1', tool: 'read-file', args: { path: p, expectChars: 120 } }, p, '')
    assert.ok('rejected' in withChars, 'expectChars must be honoured against an empty file')
    assert.match(String((withChars as { rejected: string }).rejected), /0 bytes/i)

    const withText = await verifyRead(
      { id: 's1', tool: 'read-file', args: { path: p, expectText: 'Fact 1' } }, p, '')
    assert.ok('rejected' in withText, 'expectText must be honoured against an empty file')

    // And with NO declaration at all - the case that passed live.
    const bare = await verifyRead({ id: 's1', tool: 'read-file', args: { path: p } }, p, '')
    assert.ok('rejected' in bare,
      'a read-back of an empty file with nothing declared must not report file-read-back')
    assert.match(String((bare as { rejected: string }).rejected), /expectEmpty/,
      'and the refusal must say how to declare an empty file the legitimate way')
  } finally { cleanup(dir) }
})

// ============================================================================================
// 3. A MISSING FILE FAILS
// ============================================================================================

test('3. a missing file fails', async () => {
  const dir = scratch()
  const p = join(dir, 'nope.txt')
  try {
    // The tool returned a result for a path - so the file existed when it was read. It is gone now,
    // which is the case the re-read exists to catch.
    const vanished = await verifyRead(
      { id: 's1', tool: 'read-file', args: { path: p, expectChars: 10 } }, p, 'it was here a moment ago')
    assert.ok('rejected' in vanished, 'a file that has since disappeared cannot verify')
    assert.match(String((vanished as { rejected: string }).rejected), /does not exist/i)

    // And a tool that reported nothing at all is refused before anything is read, because there is
    // no claim to check. A different reason, and a correct one.
    const noResult = await verifyRead({ id: 's1', tool: 'read-file', args: { path: p, expectChars: 10 } }, p, undefined)
    assert.ok('rejected' in noResult)
    assert.match(String((noResult as { rejected: string }).rejected), /recorded no path/i)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ============================================================================================
// 4. A DIFFERENT FILE WITH THE SAME BASENAME CANNOT SATISFY THE REQUESTED PATH
// ============================================================================================

test('4. a different file with the same basename cannot satisfy the requested path', async () => {
  const dir = scratch()
  const wanted = join(dir, 'Documents', 'report.txt')
  const impostor = join(dir, 'Downloads', 'report.txt')
  mkdirSafe(join(dir, 'Documents'))
  mkdirSafe(join(dir, 'Downloads'))
  writeFileSync(wanted, 'the real one', 'utf8')
  writeFileSync(impostor, 'a different file entirely', 'utf8')
  try {
    // The step declares the path it wants; the read-back is of a same-named file elsewhere.
    const r = await verifyRead(
      { id: 's1', tool: 'read-file', args: { path: wanted, expectedPath: wanted } },
      impostor, 'a different file entirely')
    assert.ok('rejected' in r, 'reading a same-named file elsewhere must not verify')
    assert.match(String((r as { rejected: string }).rejected), /cannot prove that one arrived/i)
    assert.match(String((r as { rejected: string }).rejected), /share a basename/i)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

function mkdirSafe(d: string) {
  mkdirSync(d, { recursive: true })
}

// ============================================================================================
// 5. MISMATCHED CONTENT FAILS
// ============================================================================================

test('5. a mismatched content read-back fails', async () => {
  const dir = scratch()
  const p = join(dir, 'report.txt')
  writeFileSync(p, 'the file changed since it was read', 'utf8')
  try {
    // The tool reported one content; the file now holds another.
    const stale = await verifyRead({ id: 's1', tool: 'read-file', args: { path: p, expectChars: 5 } }, p, 'original content')
    assert.ok('rejected' in stale, 'a file that changed after the read is not verified')
    assert.match(String((stale as { rejected: string }).rejected), /changed after it was read/i)

    // And the declared expectation is compared, not merely present.
    const wrongText = await verifyRead(
      { id: 's1', tool: 'read-file', args: { path: p, expectText: 'something that is not in this file' } }, p,
      'the file changed since it was read')
    assert.ok('rejected' in wrongText, 'expectText must be compared against the actual content')
  } finally { cleanup(dir) }
})

// ============================================================================================
// 6. A LEGITIMATELY EMPTY FILE PASSES ONLY WHEN EXPLICITLY REQUESTED
// ============================================================================================

test('6. an explicitly empty file verifies, because emptiness was the request', async () => {
  const dir = scratch()
  const p = join(dir, 'placeholder.txt')
  writeFileSync(p, '', 'utf8')
  try {
    const declared = await verifyRead(
      { id: 's1', tool: 'read-file', args: { path: p, expectEmpty: true } }, p, '')
    assert.ok(!('rejected' in declared),
      `"create an empty file" is a real objective and a 0-byte file satisfies it: ${JSON.stringify(declared)}`)

    const asNumber = await verifyRead(
      { id: 's1', tool: 'read-file', args: { path: p, expectChars: 0 } }, p, '')
    assert.ok(!('rejected' in asNumber), 'expectChars: 0 is the same statement as a number')
  } finally { cleanup(dir) }
})

test('6b. and the exemption cannot be used to wave through a MISSING file', async () => {
  const dir = scratch()
  const p = join(dir, 'gone.txt')
  try {
    const r = await verifyRead({ id: 's1', tool: 'read-file', args: { path: p, expectEmpty: true } }, p, undefined)
    assert.ok('rejected' in r, 'expectEmpty says an empty file is wanted, not that absence is fine')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ============================================================================================
// 7. A SUBSTITUTED WRITE CANNOT SATISFY THE ORIGINAL DESTINATION
// ============================================================================================

test('7. validatePlan gives a read-back the expectation from the write it follows', async () => {
  const { validatePlan } = await loadAgent()
  const REQUESTED = 'C:\\Users\\Samer\\Documents\\Zeus-Browser-Proof.txt'
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [
      { id: 's3', intent: 'Write the report', tool: 'write-file', args: { path: REQUESTED, content: 'Fact 1: Example Domain.\nFact 2: IANA.\nFact 3: More information link.\n' } },
      { id: 's4', intent: 'Read it back', tool: 'read-file', args: { path: REQUESTED } },
    ],
  }, 'write the report to my Documents folder and read it back')

  const read = v.steps.find((s: { id: string }) => s.id === 's4')
  assert.ok(read, 'the read-back step must survive validation')
  // The write was relocated, so the read-back follows it and declares where it is looking.
  assert.equal(String(read?.args.expectedPath ?? ''), String(read?.args.path ?? ''),
    'expectedPath must equal the path the read-back will actually open')
  assert.ok(!String(read?.args.path ?? '').startsWith('C:\\Users\\Samer\\Documents'),
    'and the read-back must follow the write, not the refused destination')
  // And it now states what it expects to find, so it can fail for the right reason.
  assert.ok(Number(read?.args.expectChars ?? 0) > 0, 'the expectation must be carried across from the write')
  assert.ok(String(read?.args.expectText ?? '').includes('Example Domain'))
})

test('7b. a read-back with no producing step at all is REFUSED', async () => {
  // This was weaker when written: it asserted only that the read-back named its own path. Now that
  // a read-back is attached to a DELIVERABLE, a plan that reads a file nothing wrote has no
  // deliverable to attach to, and the honest response is to refuse it before execution rather than
  // to verify a file whose provenance nothing in the plan accounts for.
  const { validatePlan } = await loadAgent()
  const p = 'C:\\Users\\Samer\\Documents\\some-existing-note.txt'
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [{ id: 's1', intent: 'Read the note', tool: 'read-file', args: { path: p } }],
  }, 'read the note')
  assert.equal(v.deliverables.length, 0, 'nothing was written, so there is no deliverable')
  assert.ok(v.refusals.some((r: string) => /cannot say which file it is proving/i.test(r)),
    `a read-back with nothing to prove must be refused: ${JSON.stringify(v.refusals)}`)
})

// ============================================================================================
// 8. THE EXISTING PROTECTIONS ARE INTACT
// ============================================================================================

test('8. destination-honesty still records a person-named destination', async () => {
  const { validatePlan } = await loadAgent()
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [{ id: 's3', intent: 'Create the report', tool: 'write-file', args: { path: 'C:\\Users\\Samer\\Documents\\AIOS-Desktop-Mission-Report.txt', content: 'x' } }],
  }, 'create the report in my Documents folder')
  assert.equal(v.substitutions.length, 1, 'the substitution must still be recorded')
  assert.equal(v.substitutions[0].requested, 'C:\\Users\\Samer\\Documents\\AIOS-Desktop-Mission-Report.txt')
})

test('8b. an adopted EDITOR document is still refused on a browser launch', async () => {
  const { adoptedWindowRefusal } = await import(pathToFileURL(join(HERE, '..', 'live', 'agent', 'window-identity.ts')).href)
  assert.ok(adoptedWindowRefusal(true, 'AIOS-TEST-BLANK.txt - Notepad', 'notepad', { navigatingUrl: true }),
    'the unsaved-document refusal must survive the browser exemption')
  assert.equal(adoptedWindowRefusal(true, 'Example Domain - Google Chrome', 'chrome', { navigatingUrl: true }), null,
    'and the browser exemption must still work')
})

test('8c. a headless-only plan for a visible goal is still refused', async () => {
  const { validatePlan } = await loadAgent()
  const goal = 'open a browser on my screen and navigate to https://example.com'
  const v = validatePlan({
    reply: '', model: 'test',
    steps: [{ id: 's1', intent: 'Research', tool: 'web-research', args: { url: 'https://example.com', objective: goal, pages: 1 } }],
  }, goal)
  assert.ok(v.refusals.some((r: string) => /headless research/i.test(r)),
    'fixing read-back must not weaken the visible-interaction refusal')
})

// ============================================================================================
// THE ZERO-BYTE FILE THAT CAUSED THIS
// ============================================================================================

test('the exact live shape: a 0-byte stub at the requested path no longer verifies', async () => {
  // The mission recorded a2-s4 read-file verified=true against
  // C:\Users\Samer\Documents\Zeus-Browser-Proof.txt, which was 0 bytes.
  const dir = scratch()
  const stub = join(dir, 'Zeus-Browser-Proof.txt')
  writeFileSync(stub, '', 'utf8')
  try {
    const { validatePlan } = await loadAgent()
    const v = validatePlan({
      reply: '', model: 'test',
      steps: [
        { id: 's3', intent: 'Write the report', tool: 'write-file', args: { path: 'C:\\Users\\Samer\\Documents\\Zeus-Browser-Proof.txt', content: 'Fact 1\nFact 2\nFact 3\n' } },
        { id: 's4', intent: 'Read it back', tool: 'read-file', args: { path: 'C:\\Users\\Samer\\Documents\\Zeus-Browser-Proof.txt' } },
      ],
    }, 'write the report to Documents and read it back')
    const read = v.steps.find((s: { id: string }) => s.id === 's4')
    assert.ok(read, 'the read-back survives validation')
    const r = await verifyRead(
      { id: 's4', tool: 'read-file', args: read?.args ?? {} },
      read?.args.path as string, '')
    assert.ok('rejected' in r,
      'this is the case that reported "exact match on read-file" over an empty file')
  } finally { cleanup(dir) }
})