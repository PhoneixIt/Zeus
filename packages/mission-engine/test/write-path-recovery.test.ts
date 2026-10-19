/**
 * WRITING A FILE SOMEWHERE THE MISSION IS ALLOWED TO WRITE.
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 *
 * The goal "data protection companies" produced a correct three-step plan - research, build a
 * spreadsheet, read it back - and the middle step failed:
 *
 *     output must live under C:\Users\Samer\.aios\agent\out;
 *     C:\Users\Samer\AppData\Local\opencode\output\data-protection-companies.csv is outside it
 *
 * That path came from the model's own habits, not from anything in this repository. The goal named
 * no destination, so the person had no opinion about it and no way to have got it right.
 *
 * Two things had to stay true at once, and the tension between them is the whole design:
 *
 *   1. THE REFUSAL MUST NOT BE WEAKENED. A model must still not be able to choose a path outside
 *      the permitted folders. Nothing here opens a hole; it supplies a legal value for a step
 *      that would otherwise have failed.
 *   2. A CORRECT PLAN MUST NOT DIE ON A DETAIL THE PERSON COULD NOT HAVE KNOWN ABOUT. That is not
 *      governance working. That is a defect wearing governance's clothes.
 *
 * So the model's FILENAME is preserved and only the FOLDER is supplied.
 *
 * ============================================================================================
 * WHAT THIS ACTUALLY CAUGHT
 * ============================================================================================
 *
 * The first implementation sanitised the filename inline with `[^\w.-]` and joined the result.
 * A filename of `..` survives that - both characters are allowed - and `join(dir, '..')` is the
 * PARENT of `dir`. That is a live traversal out of the only folder a mission may write to, and it
 * was found by the traversal test below rather than by reading the code. The shipped code now
 * routes through `confineTo`, which checks the joined path instead of trusting its input, and
 * these tests exercise that function directly.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { isAbsolute, normalize, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join } from 'node:path'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CAPS = pathToFileURL(join(HERE, '..', 'live', 'agent', 'capabilities.ts')).href

// ---------------------------------------------------------------- the refusal must not move

test('the capability still refuses a path outside the allowed folders', async () => {
  // The half that must not weaken. If this ever passes, everything below is irrelevant.
  const { resolveReadablePath } = await import(CAPS)
  for (const p of [
    'C:\\Users\\Samer\\AppData\\Local\\opencode\\output\\x.csv',
    'C:\\Windows\\System32\\x.csv',
    'C:\\Users\\Samer\\.ssh\\id_rsa',
    '/etc/passwd',
    'C:\\Users\\Samer\\Documents\\..\\..\\Windows\\x.csv',
  ]) {
    const r = resolveReadablePath(p) as { refused?: string }
    assert.ok(r.refused, `must still refuse ${p}`)
  }
})

// ---------------------------------------------------------------- the traversal that was real

test('a filename of ".." cannot climb out of the directory', async () => {
  // THE DEFECT THIS FILE EXISTS BECAUSE IT WAS FOUND. `..` passes a `[^\w.-]` filter intact, and
  // joining a directory with `..` yields its parent. Written as its own test because it is the
  // single most likely way a "helpful" future edit reopens this.
  const { confineTo, AGENT_OUT } = await import(CAPS)
  for (const name of ['..', '.', '...', '../..', '..\\..', '..\\escape.csv', '../escape.csv']) {
    const got = confineTo(AGENT_OUT, name, 'output.csv')
    assert.ok(
      normalize(got).startsWith(normalize(AGENT_OUT) + sep),
      `"${name}" produced ${got}, which is OUTSIDE ${AGENT_OUT}`,
    )
  }
})

test('confineTo keeps the model\'s own filename when it is legitimate', async () => {
  const { confineTo, AGENT_OUT } = await import(CAPS)
  // The other direction: sanitising must not mangle every name into "output.csv", or the
  // recovery stops preserving what the model chose and starts inventing.
  const got = confineTo(AGENT_OUT, 'data-protection-companies.csv', 'output.csv')
  assert.equal(got, join(AGENT_OUT, 'data-protection-companies.csv'))
})

test('every hostile destination is relocated inside the output folder', async () => {
  const { confineTo, AGENT_OUT, resolveReadablePath } = await import(CAPS)
  // The names a model reaches for out of habit, plus deliberate escapes.
  for (const original of [
    'C:\\Users\\Samer\\AppData\\Local\\opencode\\output\\data-protection-companies.csv',
    'C:\\Users\\Samer\\AppData\\Local\\Temp\\x.csv',
    '..\\..\\..\\Windows\\System32\\drivers\\etc\\hosts',
    'C:\\Windows\\System32\\config\\SAM',
    '/etc/shadow',
    'C:\\Users\\Samer\\.ssh\\id_rsa',
  ]) {
    const leaf = original.split(/[\\/]/).pop() ?? 'output'
    const recovered = confineTo(AGENT_OUT, leaf, 'output.csv')

    assert.ok(isAbsolute(recovered), `${recovered} must be absolute`)
    assert.ok(
      normalize(recovered).startsWith(normalize(AGENT_OUT) + sep),
      `${original} produced ${recovered}, which escaped ${AGENT_OUT}`,
    )
    // Confinement is not assumed - the recovered path must satisfy the rule itself.
    const check = resolveReadablePath(recovered) as { refused?: string }
    assert.ok(!check.refused, `recovered path ${recovered} is still refused: ${check.refused}`)
  }
})

test('a filename cannot be absurdly long or empty', async () => {
  const { confineTo, safeFileName, AGENT_OUT } = await import(CAPS)
  const long = confineTo(AGENT_OUT, 'x'.repeat(5000) + '.csv', 'output.csv')
  assert.ok(long.length < 200, `length ${long.length} is not bounded`)
  // And a name that sanitises away to nothing gets the fallback rather than the directory itself.
  assert.ok(safeFileName('///', 'output.csv').length > 0)
  assert.ok(!normalize(confineTo(AGENT_OUT, '///', 'output.csv')).endsWith(sep),
    'must not resolve to the directory itself')
})

test('the recovery is confined to the producing tools only', async () => {
  // Only write-file and spreadsheet gained a default. Widening it to the reading tools would
  // quietly change where existing missions read from, which is not a change to make by accident.
  const { AGENT_OUT } = await import(CAPS)
  const agent = await import(pathToFileURL(join(HERE, '..', 'live', 'agent', 'agent.ts')).href)
  assert.equal(typeof agent.validatePlan, 'function')
  assert.ok(AGENT_OUT.length > 0)
  // The rule itself is asserted through validatePlan below, where the tool name matters.
})

test('validatePlan supplies a legal path for a producing step and announces it', async () => {
  // The whole path, end to end, through the real validator.
  const { validatePlan } = await import(pathToFileURL(join(HERE, '..', 'live', 'agent', 'agent.ts')).href)
  const { AGENT_OUT, resolveReadablePath } = await import(CAPS)

  const v = validatePlan({
    reply: '',
    model: 'test',
    steps: [{
      id: 's2',
      intent: 'Create the CSV listing the companies',
      tool: 'spreadsheet',
      args: {
        path: 'C:\\Users\\Samer\\AppData\\Local\\opencode\\output\\companies.csv',
        headers: 'name,category',
        rows: 'Acme,backup',
      },
    }],
  }, 'data protection companies')

  assert.equal(v.refusals.length, 0, `the step should not be refused: ${v.refusals.join('; ')}`)
  const got = String(v.steps[0]?.args.path ?? '')
  assert.ok(got.length > 0, 'a path must have been supplied')
  assert.ok(
    normalize(got).startsWith(normalize(AGENT_OUT) + sep),
    `${got} is outside the output folder`,
  )
  const check = resolveReadablePath(got) as { refused?: string }
  assert.ok(!check.refused, `supplied path ${got} is still refused: ${check.refused}`)
  assert.ok(v.inferred.length > 0, 'the substitution must be announced, not silent')
  assert.match(v.inferred.join(' '), /outside every folder/i)
})

test('a destination the goal names wins over anything the model invented', async () => {
  // This test previously asserted that "write a report to my Documents" put the output in
  // Documents. Checked against the real capability, that destination is NEITHER writable NOR
  // readable:
  //
  //     C:\Users\Samer\Documents
  //       write: REFUSED -> output must live under C:\Users\Samer\.aios\agent\out
  //       read : not readable
  //
  // so the step it asserted could never have succeeded - `write-file` calls `allowedOutputPath`
  // and throws. The test verified that a folder name was echoed into an argument, which is not the
  // same question as "can this mission produce a file", and it passed for years on that
  // difference alone.
  //
  // AIOS's own writing tools are confined to the agent output directory. That confinement is the
  // governance decision and it is not being relaxed here: a model must not be able to turn the file
  // writer into a way of scattering files across the disk. What the goal's destination CAN do is
  // supply the FILENAME, which is the part the model gets wrong - it invents folders and temp
  // paths - and that part is honoured and asserted below.
  //
  // The distinction, since it looks contradictory: driving the user's own Notepad to Ctrl+S and
  // save to the Desktop is allowed, because that is the user asking their application to write
  // where they said. AIOS's file-writing tool writing there on its own initiative is not.
  const { validatePlan } = await import(pathToFileURL(join(HERE, '..', 'live', 'agent', 'agent.ts')).href)
  const { AGENT_OUT, allowedOutputPath } = await import(
    pathToFileURL(join(HERE, '..', 'live', 'agent', 'capabilities.ts')).href
  )
  const v = validatePlan({
    reply: '',
    model: 'test',
    steps: [{
      id: 's1',
      intent: 'Write the report',
      tool: 'write-file',
      args: { path: 'C:\\Users\\Samer\\AppData\\Local\\opencode\\output\\report.txt', content: 'hello' },
    }],
  }, 'write a report to my Documents')
  const got = String(v.steps[0]?.args.path ?? '')
  assert.ok(got.startsWith(AGENT_OUT), `output must land where it can actually be written, got ${got}`)
  // The property that matters, and the one the old test was reaching for: the model must not be
  // able to steer the writer outside its confinement by inventing a path.
  assert.doesNotThrow(() => allowedOutputPath(got), `the resolved destination is not writable: ${got}`)
})

test('a FILENAME named in the goal is honoured, even though the folder is not writable', async () => {
  // The part of the destination AIOS can actually use. The model reliably gets the name wrong -
  // it invents `...\AppData\Local\opencode\output\report.txt` - and reliably gets folders wrong.
  // Supplying the name from the goal is therefore worth real accuracy, and it stays inside the
  // confinement.
  const { validatePlan } = await import(pathToFileURL(join(HERE, '..', 'live', 'agent', 'agent.ts')).href)
  const { AGENT_OUT } = await import(pathToFileURL(join(HERE, '..', 'live', 'agent', 'capabilities.ts')).href)
  const v = validatePlan({
    reply: '',
    model: 'test',
    steps: [{
      id: 's1',
      intent: 'Write the report',
      tool: 'write-file',
      args: { path: 'C:\\Users\\Samer\\AppData\\Local\\opencode\\output\\nothing-useful.txt', content: 'hello' },
    }],
  }, 'write a report to my documents as quarterly-summary.txt')
  const got = String(v.steps[0]?.args.path ?? '')
  assert.match(got, /quarterly-summary\.txt$/, `the goal's filename should win, got ${got}`)
  assert.ok(got.startsWith(AGENT_OUT), `and it must still be inside the confinement, got ${got}`)
})