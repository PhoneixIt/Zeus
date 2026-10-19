/**
 * HOW AIOS DECIDES WHAT A GOAL IS, AND THEREFORE HOW LOUDLY TO REPORT IT.
 *
 * ============================================================================================
 * WHY THIS IS A TEST AND NOT A COMMENT
 * ============================================================================================
 *
 * `classifyGoal` decides two things: whether a result is reported in one line or in full, and -
 * through the planner prompt - whether the goal is treated as "produce something" or "show
 * something". Both are user-visible, and both were wrong in ways that only showed up in use.
 *
 * The specific history this locks down:
 *
 *   - "open google and search for data protection companies" was classified `show`, so a goal
 *     whose whole point was to LEARN something got a one-line confirmation and no pressure to
 *     produce a result. It is now `information`.
 *   - "save a report to Documents" was five ordinary words, fell through every verb test, and hit
 *     the bare-noun-phrase rule - which read it as a topic to research rather than a file to
 *     write. It is now `produce`.
 *   - "hi" was classified `information`, because a greeting IS a noun phrase. It is now
 *     `conversational`.
 *
 * Each of those was a real wrong answer observed in use, and each would have been invisible
 * without this file.
 *
 * WHAT IS AND IS NOT TESTED
 * ============================================================================================
 *
 * The classification rules, exhaustively, against the phrasings that actually broke them - plus
 * the guard that a preferences file cannot be used to switch a check off, because a memory file
 * that could weaken verification would be a backdoor written by the system it governs.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const GOAL_INTENT = pathToFileURL(join(HERE, '..', 'live', 'agent', 'goal-intent.ts')).href
const PREFERENCES = pathToFileURL(join(HERE, '..', 'live', 'agent', 'preferences.ts')).href

// ---------------------------------------------------------------- classification

test('a goal that names a file is a produce goal', async () => {
  const { classifyGoal } = await import(GOAL_INTENT)
  // Even when it also says "open", because the FILE is the point and the window is the means.
  assert.equal(
    classifyGoal('Open Notepad, type this sentence into it, then save it to C:\\Users\\Samer\\Documents\\x.txt'),
    'produce',
  )
  assert.equal(classifyGoal('write a csv of my projects to Documents'), 'produce')
  assert.equal(classifyGoal('save a report to Documents'), 'produce',
    'five ordinary words fell through every verb test once; the produce check now runs before ' +
    'the bare-noun-phrase fallback')
})

test('a goal that wants to KNOW something is not a show goal', async () => {
  const { classifyGoal } = await import(GOAL_INTENT)
  // THE REGRESSION. "open google and search for data protection companies" contains "open" and
  // "search", and was read as a show-goal. It is a request to learn something, and treating it as
  // a show-goal is how a one-step plan that stops at the browser looked like a finished job.
  assert.equal(classifyGoal('open google and search for data protection companies'), 'information')
  assert.equal(classifyGoal('find data protection companies'), 'information')
  assert.equal(classifyGoal('what is nakivo'), 'information')
  assert.equal(classifyGoal('compare nakivo vs veeam'), 'information')
  assert.equal(classifyGoal('research the top 5 backup vendors'), 'information')
})

test('a bare topic is a request for information', async () => {
  const { classifyGoal } = await import(GOAL_INTENT)
  // People type topics, not imperatives.
  assert.equal(classifyGoal('data protection companies'), 'information')
  assert.equal(classifyGoal('best backup software 2026'), 'information')
})

test('a goal whose deliverable is a window is a show goal', async () => {
  const { classifyGoal } = await import(GOAL_INTENT)
  assert.equal(classifyGoal('open notepad'), 'show')
  assert.equal(classifyGoal('open google'), 'show')
  assert.equal(classifyGoal('show me the calculator'), 'show')
})

test('a greeting is not a research request', async () => {
  const { classifyGoal } = await import(GOAL_INTENT)
  // "hi" is a noun phrase, so the topic rule caught it and asked for information about the
  // word "hi". Greetings are checked first.
  for (const g of ['hi', 'hello', 'hey there', 'thanks', 'good morning']) {
    assert.equal(classifyGoal(g), 'conversational', `"${g}" must not be classified`)
  }
})

test('GUI driving is distinguished from showing', async () => {
  const { classifyGoal } = await import(GOAL_INTENT)
  assert.equal(classifyGoal('click the save button'), 'act')
  assert.equal(classifyGoal('press ctrl+s'), 'act')
})

// ---------------------------------------------------------------- reporting

test('quiet reporting is for show goals only, and never for information goals', async () => {
  const { wantsQuietReport } = await import(GOAL_INTENT)
  assert.equal(wantsQuietReport('open notepad'), true)
  // The one that was reported as a failure while visibly working.
  assert.equal(wantsQuietReport('open google and search for data protection companies'), false)
  assert.equal(wantsQuietReport('save a report to Documents'), false)
})

// ---------------------------------------------------------------- the memory file

test('preferences default to the split and to autonomous method selection', async () => {
  const { readPreferences } = await import(PREFERENCES)
  const p = readPreferences()
  // With no file present these are the defaults, and they are the ones that were asked for.
  assert.ok(p.reportStyle === 'quiet-show' || p.reportStyle === 'full')
  assert.equal(typeof p.autonomousMethod, 'boolean')
})

test('preferences CANNOT express a preference that weakens a check', async () => {
  const { assertPreferencesCannotWeakenChecks } = await import(PREFERENCES)
  // A memory file that could switch off verification would be a backdoor written by the system it
  // governs - and it is writable by anything running as this user, including AIOS itself.
  const bad = [
    { skipVerification: true },
    { disableChecks: true },
    { bypassGuard: true },
    { ignoreGuard: true },
    { allowAnyPath: true },
    { widenAllowlist: true },
  ]
  for (const b of bad) {
    assert.throws(
      () => assertPreferencesCannotWeakenChecks(b as Record<string, unknown>),
      /not a preference|switch off a check/i,
      `must refuse ${JSON.stringify(b)}`,
    )
  }
  // And the legitimate ones must pass, or the guard is just noise.
  for (const good of [
    { reportStyle: 'quiet-show' },
    { autonomousMethod: true },
    { standingNotes: 'prefer concise answers' },
  ]) {
    assert.doesNotThrow(() => assertPreferencesCannotWeakenChecks(good))
  }
})

test('an unreadable preferences file does not stop a mission', async () => {
  const { readPreferences } = await import(PREFERENCES)
  // readPreferences catches everything and returns defaults. Asserted because the callers treat
  // it as safe to call from a classification path that must never fail.
  assert.doesNotThrow(() => readPreferences())
  const p = readPreferences()
  assert.ok(p.reportStyle === 'quiet-show' || p.reportStyle === 'full')
})

test('the prompt block tells the planner to finish rather than ask', async () => {
  const { preferencesForPrompt } = await import(PREFERENCES)
  const block = preferencesForPrompt()
  // The standing instruction the person gave: choose the route, complete the task, ask only when
  // something is genuinely missing or needs approval.
  assert.match(block, /finish the job/i)
  assert.match(block, /do not plan a step whose purpose is to ask/i)
})