/**
 * SESSIONS AND THE FREE-MODEL RULE.
 *
 * ============================================================================================
 * WHY THESE TESTS EXIST
 * ============================================================================================
 *
 * Sessions are new state on disk that the user did not have before, and the free-model rule is
 * the mechanism the $0 constraint is enforced through. Both are easy to get subtly wrong in a
 * way no other test would notice, so each rule below has a control that fails if it is removed.
 *
 * The rule that matters most is the LAST one: a paid model must be impossible to select, at
 * every layer, no matter what a client sends. A picker that quietly offers 111 billable models
 * beside 10 free ones is a spending mechanism, and the project has no budget for one.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')

/**
 * A module specifier for a dynamic import on Windows.
 *
 * A bare `C:\...` path is rejected by the ESM loader with ERR_UNSUPPORTED_ESM_URL_SCHEME - a
 * confusing error for what is really just a missing `file://`. `pathToFileURL` is the correct
 * conversion and is not a Windows-only workaround.
 */
function modUrl(...parts: string[]): string {
  return pathToFileURL(resolve(REPO, ...parts)).href
}

// ------------------------------------------------------------------ the free-model rule

const models = await import(modUrl('packages', 'mission-engine', 'live', 'agent', 'models.ts'))

test('a model is free only in the opencode namespace AND with a -free suffix', () => {
  assert.equal(models.isFreeModel('opencode/space-bunny-free'), true)
  assert.equal(models.isFreeModel('opencode/longcat-2.5-preview-free'), true)

  // The real paid models this machine reports. Every one must be refused.
  for (const paid of ['openai/gpt-4o', 'openai/gpt-5.6-pro', 'openai/gpt-4.1-mini']) {
    assert.equal(models.isFreeModel(paid), false, `${paid} is billable and must never be selectable`)
  }
  // Near-misses that a sloppy check would wave through.
  assert.equal(models.isFreeModel('openai/some-model-free'), false,
    'a free-looking suffix in a paid namespace must be refused')
  assert.equal(models.isFreeModel('opencode/gpt-4o'), false,
    'the free namespace alone must not be enough')
  assert.equal(models.isFreeModel(''), false)
  assert.equal(models.isFreeModel('opencode/space-bunny'), false)
  assert.equal(models.isFreeModel('opencode/nested/path-model-free'), false,
    'the namespace must be the first path segment only')
})

test('the model list this machine reports contains free models, and they are all classified free', async () => {
  // A REAL call to the REAL CLI. If the CLI moves or disappears this fails loudly rather than
  // letting a picker silently show nothing.
  //
  // The CLI reads its configuration from the USER PROFILE, so it must see the REAL one. This
  // file redirects USERPROFILE to a scratch directory for the session tests below, and running
  // this under that redirect made the CLI hang until the 20s timeout - which looked like a
  // product failure and was entirely the test's own doing. The real profile is restored here
  // explicitly rather than by luck of ordering.
  for (const [k, v] of Object.entries(REAL_HOME)) process.env[k] = v
  try {
    const list = await models.freeModels({ force: true })
    assert.ok(list.length > 0, 'the CLI must report at least one free model on this machine')
    for (const m of list) {
      assert.equal(m.free, true, `${m.id} was returned as free but is not classified free`)
      assert.equal(models.isFreeModel(m.id), true, `${m.id} came back from the free path but does not pass isFreeModel`)
    }
    assert.equal(list.some((m: { id: string }) => m.id.startsWith('openai/')), false,
      'a billable model reached the free list')
  } finally {
    process.env.USERPROFILE = HOME
    process.env.HOMEDRIVE = HOME.slice(0, 2)
    process.env.HOMEPATH = HOME.slice(2)
  }
})

test('AND IT CAN FAIL: a missing CLI is an error, never a silent fallback to a paid model', async () => {
  await assert.rejects(
    () => models.freeModels({ force: true, cliPath: join(tmpdir(), 'definitely-not-here.exe') }),
    /not at/,
    'a missing CLI must throw. Falling back to a billable model would spend money silently.',
  )
})

// ------------------------------------------------------------------ sessions

/**
 * The REAL user profile, captured BEFORE anything here redirects it.
 *
 * This matters in both directions. `sessions.ts` must be imported with a scratch home so it does
 * not write into the user's real session folder. But the OpenCode CLI reads its configuration
 * from the REAL user profile, so the model-listing test has to put it back. Capturing the real
 * values at module scope is the only point at which they are still real - reading them from
 * inside a test, after the redirect, captures the scratch values and quietly restores nothing.
 */
const REAL_HOME: Record<string, string> = {}
for (const k of ['USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']) {
  const v = process.env[k]
  // Only keys that were ACTUALLY set. Restoring an absent key as '' does not restore it - it
  // invents an empty value, and the OpenCode CLI reads HOMEDRIVE/HOMEPATH when locating its own
  // configuration. Inventing an empty home is how "no free models" gets reported.
  if (typeof v === 'string' && v.length > 0) REAL_HOME[k] = v
}

/**
 * sessions.ts resolves SESSIONS_DIR from the home directory at MODULE LOAD, so the home must be
 * redirected before it is imported. Node caches ES modules, so this must happen first.
 */
const HOME = mkdtempSync(join(tmpdir(), 'aios-sessions-'))
process.env.USERPROFILE = HOME
process.env.HOMEDRIVE = HOME.slice(0, 2)
process.env.HOMEPATH = HOME.slice(2)
process.on('exit', () => {
  try { rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* best effort */ }
})

const sessions = await import(modUrl('packages', 'mission-engine', 'live', 'agent', 'sessions.ts'))

function scratch(t: { after: (fn: () => void) => void }): void {
  const id = Math.random().toString(36).slice(2)
  t.after(() => { try { sessions.deleteSession(id) } catch { /* may not exist */ } })
  void id
}

test('a new session exists, is listed, and survives being read back', () => {
  const s = sessions.createSession()
  assert.ok(s.id, 'a session must have an id')
  assert.equal(s.turns.length, 0)
  assert.equal(s.model, sessions.DEFAULT_FREE_MODEL, 'the default model must be a free one')

  const { sessions: list } = sessions.listSessions()
  assert.ok(list.some((x: { id: string }) => x.id === s.id), 'a created session must be listed')
  assert.ok(sessions.readSession(s.id), 'a created session must be readable')
  sessions.deleteSession(s.id)
})

test('a turn is appended, and the title becomes what the user actually said', () => {
  const s = sessions.createSession()
  assert.equal(s.title, 'New chat', 'an empty session shows a placeholder, not a blank row')

  sessions.appendTurn(s.id, { role: 'user', text: 'list the open windows on this desktop', at: Date.now() })
  const after = sessions.readSession(s.id)!
  assert.equal(after.turns.length, 1)
  assert.equal(after.title, 'list the open windows on this desktop',
    'the sidebar must show the first thing the user said')

  // A second user turn must NOT overwrite the title.
  sessions.appendTurn(s.id, { role: 'assistant', text: 'Here they are.', at: Date.now() })
  sessions.appendTurn(s.id, { role: 'user', text: 'now type into notepad', at: Date.now() })
  assert.equal(sessions.readSession(s.id)!.title, 'list the open windows on this desktop')
  assert.equal(sessions.readSession(s.id)!.turns.length, 3)
  sessions.deleteSession(s.id)
})

test('a deleted session does not come back when a late turn arrives', () => {
  // A mission can still be running when the user deletes its conversation. The transcript must
  // not resurrect a session the user threw away.
  const s = sessions.createSession()
  sessions.deleteSession(s.id)
  const r = sessions.appendTurn(s.id, { role: 'assistant', text: 'too late', at: Date.now() })
  assert.equal(r, null, 'a turn for a deleted session must be dropped, not recreate it')
  assert.equal(sessions.readSession(s.id), null)
})

test('a session id cannot escape the sessions directory', () => {
  // The id arrives from the client on GET /sessions/:id and DELETE. A path traversal here would
  // delete or read arbitrary files, so it is refused rather than sanitised-and-hoped.
  for (const bad of ['../../secrets', '..\\..\\secrets', 'a/b', 'a\\b', '', 'x'.repeat(200)]) {
    assert.throws(() => sessions.readSession(bad), /invalid session id|ENOENT|not found/i,
      `"${bad}" must not be accepted as a session id`)
  }
})

test('the model on a session is changed through one function', () => {
  const s = sessions.createSession()
  const updated = sessions.setSessionModel(s.id, 'opencode/space-bunny-free')!
  assert.equal(updated.model, 'opencode/space-bunny-free')
  assert.equal(sessions.readSession(s.id)!.model, 'opencode/space-bunny-free')
  sessions.deleteSession(s.id)
})

// ------------------------------------------------------------------ durability

test('a session survives being written and read back from disk (no temp files left behind)', () => {
  const s = sessions.createSession({ title: 'durability check' })
  sessions.appendTurn(s.id, { role: 'user', text: 'remember this', at: Date.now() })

  const files = readdirSync(sessions.SESSIONS_DIR)
  const strays = files.filter((f) => f.includes('.tmp'))
  assert.deepEqual(strays, [], `an atomic write left temp files behind: ${strays.join(', ')}`)

  const onDisk = JSON.parse(readFileSync(join(sessions.SESSIONS_DIR, `${s.id}.json`), 'utf8')) as { title: string }
  assert.equal(onDisk.title, 'durability check')
  sessions.deleteSession(s.id)
})

test('a corrupt session file is reported, not silently hidden', () => {
  // Silently skipping a corrupt file would make a user's conversation disappear with no trace,
  // and "where did my chat go" with no answer is the worst possible failure here.
  const id = 'corrupt-check-1'
  const p = join(sessions.SESSIONS_DIR, `${id}.json`)
  writeFileSync(sessions.SESSIONS_DIR && p, '{ this is not json', 'utf8')
  const { sessions: list, unreadable } = sessions.listSessions()
  assert.ok(unreadable.includes(`${id}.json`), 'a corrupt file must be named in `unreadable`')
  assert.equal(list.some((s: { id: string }) => s.id === id), false, 'a corrupt file must not be presented as a session')
  rmSync(p, { force: true })
})

test('AND IT CAN FAIL: a real session really does hit the disk', () => {
  // Without this, the tests above could all pass against a module that silently did nothing -
  // an in-memory stub would satisfy every assertion above.
  const s = sessions.createSession({ title: 'proof of disk' })
  assert.ok(existsSync(join(sessions.SESSIONS_DIR, `${s.id}.json`)),
    'the session file must exist on disk, not only in memory')
  sessions.deleteSession(s.id)
  assert.equal(existsSync(join(sessions.SESSIONS_DIR, `${s.id}.json`)), false,
    'deleting must remove the file, not just hide it from the listing')
})

void scratch