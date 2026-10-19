/**
 * A REAL ChatGPT -> OpenCode ROUND TRIP, end to end.
 *
 * This is not a demonstration of the mailbox types. It claims a real task, runs the REAL
 * local OpenCode CLI against it in a real directory, writes the CLI's own JSON output to the
 * outbox, and then validates that result against the task's acceptance criterion from disk.
 *
 * If the CLI cannot run, or cannot be found, or the answer does not meet acceptance, this
 * FAILS. It does not print a reassuring summary of a thing that did not happen.
 *
 * Usage:  node --experimental-strip-types --no-warnings packages/agent/handoff-roundtrip.ts
 */

import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  claimTask, verifyResult, readResult, writeTask, initMailbox,
  type HandoffTask, type HandoffResult,
} from './handoff.ts'
import { runTask, DEFAULT_OPENCODE_CLI } from './opencode-adapter.ts'

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!ok) failed++
}

const MAILBOX = mkdtempSync(join(tmpdir(), 'aios-handoff-'))
const WORK = mkdtempSync(join(tmpdir(), 'aios-handoff-work-'))

try {
  console.log('=== 1. the mailbox and the task ===')
  initMailbox(MAILBOX)
  // A real, bounded task with a checkable acceptance criterion. The work: write a file whose
  // content is stated exactly, so acceptance is "that file exists and says exactly this".
  const EXPECTED = 'roundtrip-ok\n'
  const targetFile = join(WORK, 'handoff-proof.txt')
  const task: HandoffTask = {
    id: 'roundtrip-1',
    correlationId: 'roundtrip-corr-1',
    request:
      `Create a file named "handoff-proof.txt" in this directory whose entire contents are ` +
      `exactly ${JSON.stringify(EXPECTED)} - no other text, no commentary. Then report the ` +
      `exact bytes you wrote.`,
    cwd: WORK,
    acceptance: `the file handoff-proof.txt exists and contains exactly ${JSON.stringify(EXPECTED)}`,
    timeoutMs: 240_000,
  }
  const p = writeTask(MAILBOX, task)
  check('the task was written to the inbox', existsSync(p), p)

  console.log('')
  console.log('=== 2. claimed atomically (single writer) ===')
  const claim = claimTask(MAILBOX)
  if ('error' in claim) { check('the task was claimed', false, claim.error); throw new Error('no claim') }
  check('the task was claimed', claim.task.id === task.id, claim.task.id)
  check('it left the inbox, so a second worker cannot take it', !existsSync(p))
  const second = claimTask(MAILBOX)
  check('a second claim finds nothing (single-writer enforced by the rename)', 'error' in second,
    'error' in second ? second.error : 'IT WAS CLAIMED TWICE')

  console.log('')
  console.log('=== 3. executed by the REAL OpenCode CLI ===')
  check('the CLI binary exists', existsSync(DEFAULT_OPENCODE_CLI), DEFAULT_OPENCODE_CLI)
  // autoApprove is deliberately NOT set: false by default, per the contract.
  // `cwd` is recorded by US, from the task we claimed, rather than read back off the run. The
  // run adapter does not return a cwd because it was given one; asking it would only echo our
  // own input back as if it were independent evidence. The validator checks the recorded cwd
  // against the task, which still catches a result filed under the wrong task.
  const run = await runTask({
    cwd: task.cwd,
    message: task.request,
    // A free model on the local provider, so the round trip costs nothing. The model is
    // NAMED here rather than discovered at run time: a handoff whose cost depends on whatever
    // the CLI decides to default to is not a handoff anyone can budget.
    model: 'opencode/space-bunny-free',
    timeoutMs: task.timeoutMs!,
    title: 'aios-handoff-roundtrip',
  })
  check('the CLI ran without a transport failure', !run.failure, run.failure ?? '')
  check('the CLI produced assistant text', run.text.trim().length > 0, `${run.text.trim().length} chars`)
  check('the CLI reported a session id', Boolean(run.sessionId), run.sessionId || '(none)')
  check('the run produced parseable events', run.events.length > 0, `${run.events.length} events, ${run.unparsedLines} unparsed`)
  console.log(`  --- the answer under test (first 220 chars) ---`)
  console.log(`  ${run.text.trim().slice(0, 220).replace(/\n/g, '\n  ')}`)

  console.log('')
  console.log('=== 4. the answer checked against acceptance, from the FILE ===')
  // The receiving side answers the acceptance question. It is derived from the filesystem,
  // not from the assistant's prose - so a confident claim cannot satisfy it on its own.
  const existsOnDisk = existsSync(targetFile)
  const actual = existsOnDisk ? (await import('node:fs')).readFileSync(targetFile, 'utf8') : ''
  const met = existsOnDisk && actual === EXPECTED
  const result: HandoffResult = {
    taskId: task.id,
    correlationId: task.correlationId,
    cwd: task.cwd,
    text: run.text,
    sessionId: run.sessionId,
    exitCode: run.exitCode,
    elapsedMs: run.elapsedMs,
    claimedAt: claim.claimedAt,
    finishedAt: Date.now(),
    selfReport: {
      met,
      evidence: existsOnDisk
        ? `handoff-proof.txt on disk contains ${JSON.stringify(actual.slice(0, 40))} (expected ${JSON.stringify(EXPECTED)})`
        : 'handoff-proof.txt does not exist on disk',
    },
  }
  const outPath = join(MAILBOX, 'outbox', `${task.id}.result.json`)
  mkdirSync(join(MAILBOX, 'outbox'), { recursive: true })
  writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8')
  check('the result was written to the outbox', existsSync(outPath), outPath)

  const readBack = readResult(MAILBOX, task.id)
  check('the result can be read back from disk', typeof readBack === 'string')
  const verdict = verifyResult(task, readBack!)
  console.log(`  verdict: ${verdict.verdict} - ${verdict.reason}`)
  check('the receiving side validates the result as accepted', verdict.verdict === 'accepted')
  // The physical proof, independent of both sides' claims.
  check('and the file really exists on disk with the exact expected content',
    existsOnDisk && actual === EXPECTED, JSON.stringify(actual))

  console.log('')
  console.log('=== 5. the validator rejects a bad result ===')
  const tampered = JSON.stringify({ ...result, selfReport: { met: true, evidence: '' } })
  const v2 = verifyResult(task, tampered)
  check('acceptance claimed with NO evidence is rejected', v2.verdict === 'rejected', v2.reason)
  const v3 = verifyResult(task, JSON.stringify({ ...result, taskId: 'someone-elses-task' }))
  check('a result for a different task is rejected', v3.verdict === 'rejected', v3.reason)
  const v4 = verifyResult(task, JSON.stringify({ ...result, exitCode: 1 }))
  check('a non-zero exit is rejected', v4.verdict === 'rejected', v4.reason)
  const v5 = verifyResult(task, JSON.stringify({ ...result, cwd: 'C:/somewhere/else' }))
  check('work done outside the requested directory is rejected', v5.verdict === 'rejected', v5.reason)
  const v6 = verifyResult(task, 'not json at all')
  check('a malformed result is rejected, not thrown', v6.verdict === 'rejected', v6.reason)
} finally {
  rmSync(MAILBOX, { recursive: true, force: true })
  rmSync(WORK, { recursive: true, force: true })
}

console.log('')
console.log(`=== ${failed === 0 ? 'PASS' : failed + ' FAILURE(S)'} ===`)
process.exit(failed ? 1 : 0)