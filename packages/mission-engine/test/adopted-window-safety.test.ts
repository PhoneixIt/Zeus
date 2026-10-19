/**
 * AIOS MUST NOT TYPE INTO A DOCUMENT IT WAS NOT ASKED TO CHANGE
 * =============================================================
 *
 * OBSERVED LIVE, and it is the most consequential defect found so far.
 *
 * The goal "open notepad and type hello world from aios" produced two steps that both verified:
 *
 *     s1  launch-app    -> a real Notepad window, verified
 *     s2  desktop-input -> verified: "re-read hwnd ... and found the typed text at the caret"
 *
 * Both were honest. Notepad had launched, the window existed, the host owned the right process,
 * the guard permitted input, the keystrokes were sent, and the verifier found the text by reading
 * the window back from the OS.
 *
 * And the text was in the WRONG DOCUMENT. It was in a different Notepad window, one showing
 * `AIOS-TEST-BLANK.txt` - a document this mission was never given and which may have held unsaved
 * work - while the window the launch reported sat empty at "0 characters".
 *
 * Windows 11 Notepad is single-instance: a second launch activates the window that is already open
 * instead of creating one. The launch response looks identical either way, so nothing downstream
 * could tell the two cases apart.
 *
 * WHY THIS MATTERS MORE THAN A FAILED MISSION
 * -------------------------------------------
 * A mission that fails costs the user a retry. A mission that silently edits someone's unsaved
 * document costs them work, and it reports success while doing it. Every check passed. That is the
 * clearest demonstration so far that "all steps verified" is not a sufficient claim about a
 * mission - verification proves the steps did what they said, and here what they said was not what
 * the person wanted.
 *
 * The fix refuses at the LAUNCH rather than at the typing step: by the time a keystroke is due,
 * the rest of the plan has already been built around a window that is not the one it should be.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WIN = pathToFileURL(join(HERE, '..', 'live', 'agent', 'window-identity.ts')).href

const load = () => import(WIN)

// ============================================================ the live case

test('an ADOPTED window showing a named document is refused', async () => {
  const { adoptedWindowRefusal } = await load()
  // The exact window observed holding the text that was not supposed to be in it.
  const refusal = adoptedWindowRefusal(true, 'AIOS-TEST-BLANK.txt - Notepad', 'notepad')
  assert.ok(refusal, 'this must be refused: the document is named and may be unsaved')
  assert.match(refusal, /AIOS-TEST-BLANK\.txt/, 'the refusal must NAME the document')
  assert.match(refusal, /will not type into a document it was not asked to change/i)
  // A refusal the person cannot act on is just an obstacle.
  assert.match(refusal, /Close that notepad window|names the file/i, 'the refusal must say what to do')
})

test('a CREATED window showing a document is fine - that is what was asked for', async () => {
  // Not a refusal case. Launching Notepad ON a file creates that window; refusing it would break
  // every "open X and edit it" task, which is the capability working correctly.
  const { adoptedWindowRefusal } = await load()
  assert.equal(adoptedWindowRefusal(false, 'notes.txt - Notepad', 'notepad'), null)
})

test('an ADOPTED window with nothing in it is allowed', async () => {
  // Someone who says "open notepad" with an empty notepad open is asking for exactly this, and
  // there is nothing in an empty buffer to lose.
  const { adoptedWindowRefusal } = await load()
  assert.equal(adoptedWindowRefusal(true, 'Untitled - Notepad', 'notepad'), null)
})

test('an ADOPTED window showing a modified empty buffer is still allowed', async () => {
  const { adoptedWindowRefusal } = await load()
  assert.equal(adoptedWindowRefusal(true, '*Untitled - Notepad', 'notepad'), null)
})

// ============================================================ the negatives

test('a window with no document part at all is not treated as a document', async () => {
  const { adoptedWindowRefusal } = await load()
  assert.equal(adoptedWindowRefusal(true, 'Notepad', 'notepad'), null)
})

test('a genuinely unsaved document IS refused', async () => {
  // "Untitled" is the platform's label for an empty buffer. A person who typed something into it
  // has named it, and it is still their work - the exemption is for emptiness, not for the word.
  const { adoptedWindowRefusal } = await load()
  assert.ok(adoptedWindowRefusal(true, 'Untitled1 - Notepad', 'notepad'), 'a named buffer is a document')
  assert.ok(adoptedWindowRefusal(true, 'meeting-notes - Notepad', 'notepad'))
})

test('the app is named in the refusal, not just the document', async () => {
  const { adoptedWindowRefusal } = await load()
  const refusal = adoptedWindowRefusal(true, 'budget.xlsx - Excel', 'excel')
  assert.ok(refusal && refusal.includes('excel'), 'the person needs to know which window to close')
})

// ============================================================ the title arithmetic behind it

test('only the LAST separator splits the title', async () => {
  const { windowTitleSegments } = await load()
  // A document whose own name contains the separator must survive intact, or the refusal would
  // name a document the person never had.
  const s = windowTitleSegments('Q3 - final - budget.xlsx - Excel')
  assert.equal(s.app, 'Excel')
  assert.equal(s.document, 'Q3 - final - budget.xlsx')
})

test('an unsuffixed title is all application and no document', async () => {
  const { windowTitleSegments } = await load()
  assert.deepEqual(windowTitleSegments('Notepad'), { document: '', app: 'Notepad' })
})

test('a modified-document asterisk does not become part of the document name', async () => {
  const { windowTitleSegments } = await load()
  const s = windowTitleSegments('*notes.txt - Notepad')
  assert.equal(s.document, 'notes.txt')
  assert.equal(s.app, 'Notepad')
})