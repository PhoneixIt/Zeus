import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator, evidenceFingerprint } from './packages/agent/orchestrator.ts'

const DIR = mkdtempSync(join(tmpdir(), 'diag-fp-'))
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} })

const PASS_CMD = 'node -e "process.exit(0)"'
const FAIL_CMD = 'node -e "process.exit(3)"'

const baseTask = (over = {}) => ({
  id: 't', objective: 'do the thing', constraints: [],
  verifyCommand: PASS_CMD, maxReviewRounds: 6, timeoutMs: 20000,
  ...over,
})

const reviewer = () => ({
  name: 'scripted', model: 'scripted-reviewer', isIndependent: true,
  review: async () => ({
    verdict: 'request-changes', text: 'x\nVERDICT: request-changes',
    model: 'scripted-reviewer', independent: true, elapsedMs: 1,
  }),
})

const p = join(DIR, 'r.json')
const t1 = baseTask({ id: 'a', verifyCommand: PASS_CMD })
const t2 = baseTask({ id: 'b', verifyCommand: FAIL_CMD })

const o = new Orchestrator(p, p + '.lock', Orchestrator.emptyState('o', 'a', 'r'))
o.enqueue(t1)
o.enqueue(t2)

const r1 = await o.runCycle(t1, { model: 'm', reviewer: reviewer(), cwd: DIR })
const r2 = await o.runCycle(t2, { model: 'm', reviewer: reviewer(), cwd: DIR })

console.log('t1.verifyCommand :', t1.verifyCommand)
console.log('t2.verifyCommand :', t2.verifyCommand)
console.log()
console.log('rec a id        :', r1.record.id)
console.log('rec b id        :', r2.record.id)
console.log('rec a verifyOut :', JSON.stringify(r1.record.verificationOutput))
console.log('rec b verifyOut :', JSON.stringify(r2.record.verificationOutput))
console.log('a verificationPassed:', r1.record.verificationPassed)
console.log('b verificationPassed:', r2.record.verificationPassed)
console.log()
console.log('fp a :', r1.record.lastEvidenceFingerprint)
console.log('fp b :', r2.record.lastEvidenceFingerprint)
console.log('EQUAL:', r1.record.lastEvidenceFingerprint === r2.record.lastEvidenceFingerprint)
console.log()
console.log('same record object?', r1.record === r2.record)
console.log('all record ids in state:', o.snapshot().tasks.map(t => t.id))