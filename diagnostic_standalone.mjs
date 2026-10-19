/**
 * Standalone diagnostic mission execution.
 * 
 * This script runs the mission outside the test framework, with full control
 * over workspace setup. It uses the new diagnostic workspace to avoid the
 * collision issue that blocks the test framework version.
 * 
 * Key: the WORKSPACE in diagnostic-filesystem-mode.ts uses a Date.now()-suffix,
 * so each Node.js process gets a fresh workspace. The cleanup within the test
 * framework doesn't affect this because it's a separate process each time.
 * 
 * But we need to ensure the workspace is actually fresh. Let's clean it manually.
 */

import { execute } from './packages/mission-engine/executor.ts'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeProbeTool } from './packages/mission-engine/test/diagnostic-filesystem-mode.ts'
import { router } from './packages/mission-engine/test/fakes.ts'
import type { Mission, Step } from './packages/mission-engine/state.ts'
import type { Evidence } from './packages/mission-engine/executor.ts'

async function main() {
  // ---- STEP 1: Ensure a fresh workspace ----
  // The diagnostic workspace uses Date.now() suffix, evaluated at module import.
  // Since this is a new Node.js process, the workspace should be fresh.
  // But let's also manually verify and clean.
  
  const ws = join(tmpdir(), `aios-fs-probe-diagnostic-${Date.now()}`)
  console.log('Fresh workspace:', ws)
  
  // Check if workspace already has files from prior runs in this environment
  // (happens when running multiple invocations in the same %TEMP% directory)
  if (require) {
    // We're in a context where require exists - check for prior artifacts
    try {
      const fs = require('node:fs')
      const priorFiles = fs.readdirSync(ws).filter(f => f.startsWith('nodeversion-'))
      if (priorFiles.length > 0) {
        console.log('Found prior files in workspace, cleaning...')
        priorFiles.forEach(f => {
          fs.unlinkSync(join(ws, f))
        })
      }
    } catch {}
  }

  // ---- STEP 2: Define the mission ----
  const step = (id: string, over: Partial<Step> = {}): Step => ({
    id, intent: `do ${id}`, mode: 'cli', rationale: 'test', status: 'pending', tool: id, ...over,
  })

  const mission = (plan: Step[]): Mission => ({
    id: 'm1', objective: 'check node version and write to file', constraints: [], state: 'executing',
    plan, history: [], pendingApprovals: [], startedAt: 0,
  })

  // ---- STEP 3: Capture Node version ----
  const nodeVersion = process.version
  console.log('Node version:', nodeVersion)

  // ---- STEP 4: Create the mission plan ----
  // The step writes the node version to a file using write-probe-file
  const plan = [
    step('nodeversion', {
      intent: 'check node version and write to file',
      mode: 'filesystem',
      tool: 'write-probe-file',
      args: {
        rel: `nodeversion-${Date.now().toString(36).slice(-6)}`,
        body: nodeVersion,
      },
    }),
  ]

  const fm = mission(plan)

  // ---- STEP 5: Execute the mission ----
  const deps = {
    tools: router({ 'write-probe-file': writeProbeTool }),
    verifier: {
      verifies: (step: Step) => step.mode === 'filesystem',
      async verify(step: Step, _ctx: any, toolData: unknown): Promise<{ evidence: Evidence } | { rejected: string }> {
        const claimed = toolData as { path?: string; bytes?: number } | undefined
        if (!claimed?.path) return { rejected: 'the tool named no path, so there is nothing to verify' }
        
        // Use fs directly for independent verification (different from the tool's write path)
        import('node:fs').then(fs => {
          try {
            const st = fs.statSync(claimed.path)
            if (!st.isFile()) return { rejected: `"${claimed.path}" exists but is not a regular file` }
            if (st.size === 0) return { rejected: `"${claimed.path}" exists but is empty` }
            const body = fs.readFileSync(claimed.path, 'utf8')
            if (body.trim().length === 0) return { rejected: `"${claimed.path}" exists and has non-zero size but no readable content` }
            return {
              evidence: {
                kind: 'file-exists',
                path: claimed.path,
                bytes: st.size,
                note: `read here; first 40 bytes ${JSON.stringify(body.slice(0, 40))}`,
              },
            }
          } catch {
            return { rejected: `went and looked for "${claimed.path}"; it is not there` }
          }
        })
      },
    } as any,
    control: {
      observe: async () => ({
        screen: { width: 1920, height: 1088, session: 1 },
        windows: [{ hwnd: 1000, pid: 100, title: 'Notepad', visible: true, rect: { x: 0, y: 0, w: 800, h: 600 } }],
        foreground: { hwnd: 1000, pid: 100, title: 'Notepad', visible: true, foreground: true },
        permission: { control: 'ARMED', input: 'PERMITTED', blockedBy: null, infrastructureHealthy: true },
        warnings: [],
        screenCapture: Buffer.alloc(0),
      }),
      permission: async () => ({ control: 'ARMED', input: 'PERMITTED', blockedBy: null, infrastructureHealthy: true }),
      emergencyStop: async () => false,
    },
    config: {
      maxAttempts: 3,
      now: () => Date.now(),
    },
  }

  console.log('=== executing mission ===')
  const result = await execute(fm, deps)
  const { mission, record, events } = result

  console.log('=== mission result ===')
  console.log('Mission ID:', mission.id)
  console.log('Mission state:', mission.state)
  console.log('Complete:', record.complete)
  console.log('Final state:', record.finalState)
  console.log('Objective verdict kind:', record.verified?.[Object.keys(record.verified)[0]]?.kind || 'n/a')
  console.log('')

  // ---- STEP 6: Report the evidence ----
  console.log('=== persisted record ===')
  console.log('record.path would be:', record.missionId)
  console.log('record complete:', record.complete)
  console.log('record finalState:', record.finalState)
  
  // Check the mission plan results
  const planResults = mission.plan.map((s) => ({
    id: s.id,
    status: s.status,
    result: s.result,
  }))
  console.log('Plan results:', JSON.stringify(planResults, null, 2))

  // ---- STEP 7: Historical record check ----
  console.log('')
  console.log('=== historical record check ===')
  console.log('00fb6c67 preserved: needs git/file check')
}

main().catch(err => {
  console.error('Mission failed:', err)
  process.exit(1)
})