import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_ROOT, MISSIONS_DIR, CONVERSATIONS_PATH } from './agent.ts'

/** Unique job ID (v4-style, no need for crypto import). */
function makeJobId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substr(2, 8)
  return `job-${timestamp}-${random}`
}

/** Append a job record to the missions directory, reusing the existing mission JSON format. */
export function recordJob(
  userObjective: string,
  sessionId: string,
  plan: { reply: string; steps: { id: string; intent: string; tool: string }[] },
  result: { exitCode: number | null; text: string; stderr: string },
  verified: boolean,
  changedFiles: string[],
  blockers: string[]
): string {
  const jobId = makeJobId()
  const createdAt = Date.now()
  const completedAt = verified ? createdAt : null

  const jobRecord = {
    jobId,
    userObjective,
    sessionId,
    plan,
    result,
    verified,
    changedFiles,
    blockers,
    createdAt,
    completedAt,
  }

  // Persist alongside existing missions; the mission engine already reads this directory.
  const target = join(MISSIONS_DIR, `${jobId}.json`)
  // Do not overwrite an existing record.
  if (existsSync(target)) {
    // Append a timestamp suffix to avoid collision.
    const base = jobId
    const suffix = Date.now().toString(36).substr(0, 4)
    const named = `${base}-${suffix}`
    const target2 = join(MISSIONS_DIR, `${named}.json`)
    writeFileSync(target2, JSON.stringify(jobRecord, null, 2), 'utf8')
    return named
  }
  writeFileSync(target, JSON.stringify(jobRecord, null, 2), 'utf8')
  return jobId
}