/**
 * A REAL research-desk <-> OpenCode round trip, with a matched correlation id.
 *
 * This is not a demonstration of the mailbox types. It sends a bounded task through the local
 * OpenCode CLI, has the CLI's own work verified against the filesystem, files the result under
 * the SAME correlation id the request carried, and then has the receiving side re-check it.
 *
 * THE THING BEING PROVEN: an id survives the trip, and a result carrying the WRONG id is
 * refused. Without that second half, a correlation id is just a string both sides happen to
 * agree on - which is exactly the failure it exists to prevent.
 *
 * SCOPE, STATED PLAINLY: this is a file-based handoff driven by the local CLI. ChatGPT
 * screen automation is NOT demonstrated here and is reported as UNVERIFIED. No mechanism by
 * which ChatGPT posts into a live OpenCode session was found or used.
 */

import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { claimTask, verifyResult, writeTask, initMailbox, type HandoffTask, type HandoffResult } from './handoff.ts'
import { runTask, DEFAULT_OPENCODE_CLI } from './opencode-adapter.ts'
import { RESEARCH_ROOT, ensureDurableDirs } from '../mission-engine/live/research-app.ts'

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed++
}

const MAILBOX = mkdtempSync(join(tmpdir(), 'aios-desk-handoff-'))
const WORK = mkdtempSync(join(tmpdir(), 'aios-desk-work-'))

try {
  ensureDurableDirs()
  initMailbox(MAILBOX)

  // ONE id for the whole exchange: the request, the CLI's result, the durable artifact, and
  // the verification all carry it. Nothing downstream has to guess which run it is looking at.
  const correlationId = randomUUID()
  console.log(`  correlation id: ${correlationId}`)
  console.log('')

  const EXPECTED = 'desk-handoff-ok\n'
  const target = join(WORK, 'desk-proof.txt')

  console.log('=== 1. a bounded task, sent through the mailbox ===')
  const task: HandoffTask = {
    id: `desk-${correlationId.slice(0, 8)}`,
    correlationId,
    request:
      `Create a file named "desk-proof.txt" in this directory whose entire contents are exactly ` +
      `${JSON.stringify(EXPECTED)} - nothing else, no commentary. Then state the exact bytes you wrote.`,
    cwd: WORK,
    acceptance: `desk-proof.txt exists on disk and contains exactly ${JSON.stringify(EXPECTED)}`,
    timeoutMs: 240_000,
  }
  writeTask(MAILBOX, task)
  const claim = claimTask(MAILBOX)
  if ('error' in claim) { check('the task was claimed', false, claim.error); throw new Error('claim failed') }
  check('the task was claimed', claim.task.correlationId === correlationId, claim.task.id)

  console.log('')
  console.log('=== 2. executed by the REAL OpenCode CLI ===')
  check('the CLI exists', existsSync(DEFAULT_OPENCODE_CLI), DEFAULT_OPENCODE_CLI)
  const run = await runTask({
    cwd: task.cwd,
    message: task.request,
    model: 'opencode/space-bunny-free',
    timeoutMs: task.timeoutMs ?? 240_000,
    title: `desk-handoff-${correlationId.slice(0, 8)}`,
  })
  check('the CLI ran', !run.failure, run.failure ?? '')
  check('it produced a session id', Boolean(run.sessionId), run.sessionId || '(none)')
  check('it produced assistant text', run.text.trim().length > 0, `${run.text.trim().length} chars`)

  console.log('')
  console.log('=== 3. the answer checked against acceptance, from the FILESYSTEM ===')
  const onDisk = existsSync(target)
  const bytes = onDisk ? readFileSync(target, 'utf8') : ''
  const met = onDisk && bytes === EXPECTED
  console.log(`  ${target}: ${onDisk ? JSON.stringify(bytes) : 'MISSING'}`)

  // The artifact is filed in the app's DURABLE state, under the same correlation id - so a
  // later reader can join this handoff to the research runs by id alone.
  const artifact = join(RESEARCH_ROOT, 'runs', `${correlationId}.handoff.json`)
  writeFileSync(artifact, JSON.stringify({ correlationId, taskId: task.id, accepted: met, bytes }, null, 2), 'utf8')
  check('the artifact was filed in durable state under that id', existsSync(artifact), artifact)

  console.log('')
  console.log('=== 4. the result is verified, and the id must match ===')
  const result: HandoffResult = {
    taskId: task.id,
    correlationId,
    cwd: task.cwd,
    text: run.text,
    sessionId: run.sessionId,
    exitCode: run.exitCode,
    elapsedMs: run.elapsedMs,
    claimedAt: claim.claimedAt,
    finishedAt: Date.now(),
    selfReport: {
      met,
      evidence: onDisk ? `desk-proof.txt on disk contains ${JSON.stringify(bytes)}` : 'desk-proof.txt is not on disk',
    },
  }
  const outPath = join(MAILBOX, 'outbox', `${task.id}.result.json`)
  writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8')
  const verdict = verifyResult(task, readFileSync(outPath, 'utf8'))
  console.log(`  verdict: ${verdict.verdict} - ${verdict.reason}`)
  check('the result verifies as accepted', verdict.verdict === 'accepted')

  console.log('')
  console.log('=== 5. a result carrying the WRONG correlation id is refused ===')
  const wrong = JSON.stringify({ ...result, correlationId: randomUUID() })
  const v = verifyResult(task, wrong)
  console.log(`  ${v.verdict}: ${v.reason}`)
  check('a mismatched correlation id is rejected', v.verdict === 'rejected')
  check('and it is rejected on the correlation specifically', /correlation id mismatch/.test(v.reason))

  console.log('')
  console.log('=== 6. scope statement ===')
  console.log('  ChatGPT <-> OpenCode screen automation: UNVERIFIED - not demonstrated, no such path used.')
} finally {
  rmSync(MAILBOX, { recursive: true, force: true })
  rmSync(WORK, { recursive: true, force: true })
}

console.log('')
console.log(`=== ${failed === 0 ? 'PASS' : failed + ' FAILURE(S)'} ===`)
process.exit(failed ? 1 : 0)