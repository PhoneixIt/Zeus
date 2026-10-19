import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Orchestrator } from './packages/agent/orchestrator.ts'

const DIR = mkdtempSync(join(tmpdir(), 'diag-resume-'))
process.on('exit', () => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} })

const PASS_CMD = 'node -e "process.exit(0)"'
const baseTask = (over = {}) => ({
  id: 't', objective: 'do the thing', constraints: [],
  verifyCommand: PASS_CMD, maxReviewRounds: 4, timeoutMs: 20000,
  ...over,
})
const script = (sequence) => {
  let i = 0
  return {
    name: 'scripted', model: 'scripted-reviewer', isIndependent: true,
    review: async () => {
      const s = sequence[Math.min(i++, sequence.length - 1)]
      return { verdict: s.verdict, text: s.text, model: 'scripted-reviewer', independent: true, elapsedMs: 1 }
    },
  }
}

const task = baseTask()
const statePath = join(DIR, 'r8.json')

const first = new Orchestrator(statePath, statePath + '.lock', Orchestrator.emptyState('o', 'a', 'r'))
first.enqueue(task)
await first.runCycle(task, {
  model: 'm', reviewer: script([{ text: 'First finding about nulls.', verdict: 'request-changes' }]), cwd: DIR,
})
console.log('--- after first cycle (pre-crash) ---')
console.log(first.snapshot().tasks[0].rounds.map(r => `round=${r.round} role=${r.role}`))

const second = Orchestrator.loadOrCreate(statePath, statePath + '.lock2', { objective: 'o', architecture: 'a', rationale: 'r' })
console.log('\nresumed:', second.resumed)
const rec0 = second.orch.snapshot().tasks[0]
console.log('surviving rounds:', rec0.rounds.map(r => `round=${r.round} role=${r.role}`))

const r2 = await second.orch.runCycle(task, {
  model: 'm', reviewer: script([{ text: 'VERDICT: approve', verdict: 'approve' }]), cwd: DIR,
})

console.log('\n--- after resumed cycle ---')
r2.record.rounds.forEach((r, i) => {
  console.log(`  rounds[${i}]  round=${r.round}  role=${r.role}`)
})
console.log('\nstatus:', r2.record.status)
console.log('rounds[0].round =', r2.record.rounds[0].round, '(test asserts this === 2)')
console.log('rounds.length =', r2.record.rounds.length)