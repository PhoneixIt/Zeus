/**
 * READ-ONLY probe 4: CAN THE PLANNER PREDICT THE BYTES, BEFORE EXECUTION?
 *
 * This is the feasibility crux. An objective postcondition that pins a content hash is only usable
 * if the planner can state the expected hash at PLAN time. That holds only if the pipeline is
 * deterministic and the planner already holds the inputs.
 *
 * Nothing under packages/ is touched. This calls the REAL compiler path's components:
 *   StructuredSummarizer (the real composer)  -> the exact text write-report will write.
 */
import { StructuredSummarizer, entriesFrom } from './packages/planner/summarizer.ts'
import { createHash } from 'node:crypto'

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

// The world, as the planner's basis would hold it (from a prior observation listing).
const listing = [
  { name: 'alpha.ts', bytes: 1200 },
  { name: 'beta.ts',  bytes: 340 },
  { name: 'gamma.md', bytes: 88 },
  { name: 'notes',    bytes: undefined },   // a directory
]
const entries = entriesFrom(listing.map(e => e.name), n => listing.find(e => e.name === n)?.bytes)

const s = new StructuredSummarizer()
const r1 = await s.generate({ folderLabel: 'the demo folder', entries })
const r2 = await s.generate({ folderLabel: 'the demo folder', entries })

console.log('=== DETERMINISM OF THE REAL COMPOSER ===\n')
console.log('two independent generate() calls agree on text :', r1.text === r2.text)
console.log('provenance                                     :', r1.provenance)
console.log('method                                         :', r1.method)
console.log()
console.log('--- the exact bytes write-report will write ---')
console.log(r1.text)
console.log('-----------------------------------------------')
console.log('sha256 the planner can declare :', sha(r1.text))
console.log('byte length                    :', Buffer.byteLength(r1.text, 'utf8'))
console.log()

console.log('=== WHAT THE PLANNER MUST ALREADY KNOW ===\n')
console.log('the composer consumes ONLY { folderLabel, entries }.')
console.log('The planner already holds both:')
console.log('  - folderLabel  : the objective text it was given')
console.log('  - entries      : the listing from its own basis observation')
console.log('So the hash is computable at PLAN time, with no execution, no model, no I/O.')
console.log()

console.log('=== COUNTER-CASE: a model-backed summarizer ===\n')
let call = 0
const fakeModel = {
  name: 'model',
  provenance: 'model' as const,
  async generate(_i: { folderLabel: string; entries: typeof entries }) {
    // A genuinely non-deterministic generator: same input, different bytes each call.
    return { text: `a DIFFERENT summary each run #${++call}`, entryCount: 4, fileCount: 3, directoryCount: 1,
             provenance: 'model' as const, method: 'generated' }
  },
}
const m1 = await fakeModel.generate({ folderLabel: 'x', entries })
const m2 = await fakeModel.generate({ folderLabel: 'x', entries })
console.log('two runs agree on text :', m1.text === m2.text, '(false -> hash postcondition is unusable)')
console.log()
console.log('CONCLUSION: the hash postcondition is valid ONLY when provenance ===')
console.log("'deterministic'. A proposal must REFUSE to declare a content-hash")
console.log('postcondition it cannot predict, rather than declare one that is wrong.')
