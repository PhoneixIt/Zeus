/**
 * A DESTINATION MUST BE A FILE, AND THE FILE THE PERSON NAMED
 * ============================================================
 *
 * OBSERVED LIVE, and it is a false NEGATIVE - work that succeeded being reported as failure,
 * which is the opposite of the placeholder defect and just as corrosive. A user who has learned
 * that this system's failures are real has no way to tell a genuine failure from this one, so both
 * stop being believable.
 *
 * The goal was:
 *
 *     open notepad, type aios save proof, then save it to the desktop as aios-save-proof.txt
 *
 * What happened:
 *
 *     [step] Save the document in place with Ctrl+S, writing directly to the Desktop path
 *     [step] Read the file back from disk to confirm the text actually saved
 *     [done] 4 of 5 step(s) verified; 1 NOT verified. Objective verdict: unmet
 *     ok=false
 *
 * and the file was on the Desktop with the right content:
 *
 *     aios save proof
 *
 * The cause was the goal recovery in `inferReadPath`. The goal says "to the desktop", so the
 * folder-name branch matched - and returned the bare FOLDER:
 *
 *     C:\Users\Samer\Desktop
 *
 * That became the objective postcondition, declared as `artifact-exists C:\Users\Samer\Desktop`. A
 * directory was never going to satisfy a file postcondition, and the step that did the real work
 * returned `file-read-back` evidence naming a FILE, so the two could never match. The goal's
 * filename was sitting right there in the sentence and was never used.
 *
 * Two fixes, both asserted below: use the filename the goal names, and never return a directory
 * when what is wanted is a file.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CAPS = pathToFileURL(join(HERE, '..', 'live', 'agent', 'capabilities.ts')).href

const load = () => import(CAPS)

// ============================================================ the live case, verbatim

test('"to the desktop as aios-save-proof.txt" resolves to that exact file', async () => {
  const { inferReadPath } = await load()
  const goal = 'open notepad, type aios save proof, then save it to the desktop as aios-save-proof.txt'
  const got = inferReadPath(goal)
  assert.equal(got, join('C:\\Users\\Samer\\Desktop', 'aios-save-proof.txt'),
    'the folder AND the filename the goal named, and nothing else')
})

test('the recovered path is a FILE, never the folder it was found in', async () => {
  // The defect itself. A directory can never satisfy an artifact postcondition, so returning one
  // guarantees the mission reports failure no matter how well the work went.
  const { inferReadPath } = await load()
  for (const goal of [
    'open notepad, type aios save proof, then save it to the desktop as aios-save-proof.txt',
    'save it to my documents as quarterly-report.md',
    'write the notes.txt file to my Downloads',
  ]) {
    const got = inferReadPath(goal)
    assert.ok(got !== null, `expected a path for: ${goal}`)
    assert.ok(/\.[A-Za-z0-9]{1,8}$/.test(got as string),
      `a bare FOLDER was returned as a destination, which is the defect: ${got}`)
  }
})

// ============================================================ a sentence is not a filename

test('a multi-word filename is refused rather than guessed at', async () => {
  // "save it as quarterly report.txt" - which words are the filename is genuinely undecidable from
  // the sentence. Taking the last word produces a DIFFERENT file from the one asked for, which is
  // worse than producing none: a wrong name lands somewhere real and looks like success, and the
  // person only finds out when they cannot find their work. So the guess is refused and the caller
  // falls back to the output directory and says so.
  const { inferReadPath } = await load()
  assert.equal(inferReadPath('save it to my desktop as the quick brown fox jumps.txt'), null,
    'a truncated name must not be produced - "jumps.txt" is not what was asked for')
})

test('a sentence is not a filename', async () => {
  // Regression for a greedy character class that allowed spaces and matched the whole run
  // "then_save_it_to_the_desktop_as_aios-save-proof.txt" as one name. The destination did not
  // exist; the only reason it was caught was that the goal happened to be printed back out.
  const { inferReadPath } = await load()
  const got = inferReadPath('open notepad, type aios save proof, then save it to the desktop as aios-save-proof.txt')
  assert.equal(got, join('C:\\Users\\Samer\\Desktop', 'aios-save-proof.txt'))
  assert.ok(!(got as string).includes('then_'), 'the sentence must never become the filename')
})

test('"as <name>" wins over an unrelated dotted token earlier in the sentence', async () => {
  const { inferReadPath } = await load()
  const got = inferReadPath('using notes.txt, save it to my desktop as final-report.md')
  assert.equal(got, join('C:\\Users\\Samer\\Desktop', 'final-report.md'))
})

// ============================================================ no filename means no file

test('a folder with no filename in the goal yields nothing, not the folder', async () => {
  const { inferReadPath } = await load()
  // The safe outcome: the caller falls back to the agent output directory and says so. Inventing
  // a name would be guessing at where the person's work should live.
  assert.equal(inferReadPath('save a report to my Documents'), null)
  assert.equal(inferReadPath('write a summary to my desktop'), null)
  assert.equal(inferReadPath('put the results in my Downloads'), null)
})

test('a goal with no folder and no file yields nothing', async () => {
  const { inferReadPath } = await load()
  assert.equal(inferReadPath('data protection companies'), null)
  assert.equal(inferReadPath('what time is it'), null)
})

// ============================================================ it must still be a real file

test('a recovered destination passes the ordinary readable-path rules', async () => {
  const { inferReadPath, resolveReadablePath } = await load()
  const got = inferReadPath('save it to my documents as quarterly-report.md')
  assert.ok(got !== null)
  const r = resolveReadablePath(got as string)
  assert.ok(!('refused' in r), `a recovered destination must itself be readable: ${JSON.stringify(r)}`)
})

test('the folder match still folds singular and plural', async () => {
  const { inferReadPath } = await load()
  // "documents" vs the folder "Documents", and "document" reading as the same thing - the original
  // reason this branch exists.
  assert.equal(inferReadPath('save it to my documents as a.md'), join('C:\\Users\\Samer\\Documents', 'a.md'))
  assert.equal(inferReadPath('save it to my document as a.md'), join('C:\\Users\\Samer\\Documents', 'a.md'))
})