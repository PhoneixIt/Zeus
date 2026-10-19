/**
 * WHY A SPREADSHEET'S ROWS ARE ASKED FOR AS AN ARRAY, NOT A STRING
 * ============================================================================================
 *
 * Observed on this machine, repeatedly, and it cost more missions than any other single defect:
 * a plan for a spreadsheet step arrived as invalid JSON and was thrown away.
 *
 *     "rows":"Veeam,2006,"Backup, disaster recovery","Enterprise\nAcme,2000,"Cloud","SMB"
 *
 * The model quotes CSV fields the way CSV requires. Inside a JSON string, that quote is
 * indistinguishable from a JSON delimiter - both grammars accept it - so the document cannot be
 * parsed and the plan is lost. A plan that was correct in every particular, including the data,
 * produced the message "the model replied without proposing any executable step".
 *
 * Parser repairs were tried and did not close it, because the ambiguity is genuine rather than
 * a bug in any particular repair. The fix has to be to stop asking for the unrepresentable
 * thing: rows as an array of arrays gives every cell its own JSON string, so no cell ever has to
 * carry a comma or a quote inside a delimited string. The ambiguity simply does not arise.
 *
 * The string form is still ACCEPTED, because plans written before this existed will keep
 * arriving as one. Both are asserted below - and the string case is asserted to produce the same
 * shape, so accepting it is not a second, untested path.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CAPS = pathToFileURL(join(HERE, '..', 'live', 'agent', 'capabilities.ts')).href
const AGENT = pathToFileURL(join(HERE, '..', 'live', 'agent', 'agent.ts')).href

test('rows as an array of arrays produces a rectangular sheet', async () => {
  const { resolveCapability, AGENT_OUT } = await import(CAPS)
  const cap = resolveCapability('spreadsheet')
  assert.ok(cap)
  // A fresh name: `spreadsheet` refuses to overwrite an existing file, so a fixed path is not
  // re-runnable. See artifact-integrity.test.ts for the incident that made the refusal necessary.
  const path = join(AGENT_OUT as unknown as string, `ui-sheet-array-${randomUUID()}.csv`)
  try {
    const r = await cap.tool.run({}, {
      path,
      headers: 'Company,Founded',
      rows: [['Veeam', '2006'], ['Commvault', '1996'], ['Rubrik', '2014']],
    })
    assert.equal(r.kind, 'data', `the array form must be accepted: ${JSON.stringify(r)}`)
    const text = readFileSync(path, 'utf8')
    assert.match(text, /Veeam,2006/)
    assert.match(text, /Rubrik,2014/)
    // Every line the same width: that is what the verifier checks, and what a table has to be.
    const widths = new Set(text.trim().split(/\r?\n/).map((l) => l.split(',').length))
    assert.equal(widths.size, 1, `rows are not rectangular: ${[...widths].join(',')}`)
  } finally {
    rmSync(path, { force: true })
  }
})

test('a cell containing a comma survives as ONE column when given as an array element', async () => {
  // The whole reason for the array form. A comma inside a cell is unexpressible in a
  // comma-separated string without quoting, and quoting is what broke the JSON.
  const { resolveCapability, AGENT_OUT } = await import(CAPS)
  const cap = resolveCapability('spreadsheet')
  // A fresh name. `spreadsheet` now refuses to overwrite - the change that stopped a finished
  // 407-row inventory being destroyed by a later mission - so a fixed path fails on the second run
  // of this suite. The refusal is correct, so the test names a new file.
  const path = join(AGENT_OUT as unknown as string, `ui-sheet-comma-${randomUUID()}.csv`)
  try {
    const r = await cap.tool.run({}, {
      path,
      headers: 'Company,Focus',
      rows: [['Acme', 'backup, disaster recovery, cloud']],
    })
    assert.equal(r.kind, 'data', `an array-valued cell must be written: ${JSON.stringify(r)}`)
    const v = await cap.verifier.verify(
      { id: 's1', intent: 'x', tool: 'spreadsheet', args: {} } as never,
      {} as never,
      (r as { data: unknown }).data,
    )
    assert.ok('evidence' in v, `the written sheet must verify: ${JSON.stringify(v)}`)
  } finally {
    rmSync(path, { force: true })
  }
})

test('the string form still works, so an older plan is not silently dropped', async () => {
  const { resolveCapability, AGENT_OUT } = await import(CAPS)
  const cap = resolveCapability('spreadsheet')
  // A FRESH name. `spreadsheet` now refuses to overwrite - that is the change that stopped a
  // finished 407-row inventory being destroyed by a later mission - and these tests previously
  // wrote fixed paths, so a second run of the suite legitimately found them taken. The refusal is
  // correct behaviour, so the test names a new file rather than the guard being weakened.
  const path = join(AGENT_OUT as unknown as string, `ui-sheet-string-${randomUUID()}.csv`)
  try {
    const r = await cap.tool.run({}, {
      path,
      headers: 'Company,Founded',
      rows: 'Veeam,2006\nCommvault,1996',
    })
    assert.equal(r.kind, 'data', `the string form must write: ${JSON.stringify(r)}`)
    const text = readFileSync(path, 'utf8')
    assert.match(text, /Veeam,2006/)
    assert.match(text, /Commvault,1996/)
  } finally {
    rmSync(path, { force: true })
  }
})

test('a ragged array is padded rather than rejected', async () => {
  // A model counting columns across an array of arrays is not reliable either, and the repair is
  // the same one the string form gets: pad, and say so.
  const { resolveCapability, AGENT_OUT } = await import(CAPS)
  const cap = resolveCapability('spreadsheet')
  const path = join(AGENT_OUT as unknown as string, `ui-sheet-ragged-${randomUUID()}.csv`)
  try {
    const r = await cap.tool.run({}, {
      path,
      headers: 'Company,Founded,Focus',
      rows: [['Veeam', '2006'], ['Commvault']],
    })
    assert.equal(r.kind, 'data', `a ragged array must be padded and written: ${JSON.stringify(r)}`)
    assert.match(String(r.summary), /padded/i, `the padding must be reported: ${r.summary}`)
    const text = readFileSync(path, 'utf8')
    const widths = new Set(text.trim().split(/\r?\n/).map((l) => l.split(',').length))
    assert.equal(widths.size, 1, `the sheet must be rectangular: ${[...widths].join('/')} columns`)
  } finally {
    rmSync(path, { force: true })
  }
})

test('the plan validator does not refuse an array-valued rows argument', async () => {
  // The required-argument check stringifies operands, so an array passes incidentally. Asserted
  // so the array form is a supported input rather than something that happens to work.
  const { validatePlan } = await import(AGENT)
  const v = validatePlan({
    reply: '',
    model: 'test',
    steps: [{
      id: 's1',
      intent: 'write the list',
      tool: 'spreadsheet',
      args: { path: 'out.csv', headers: 'Company,Founded', rows: [['Veeam', '2006']] },
    }],
  }, 'a list of companies')
  assert.equal(v.refusals.length, 0, `an array rows argument must not be refused: ${v.refusals.join('; ')}`)
})