#!/usr/bin/env node
/**
 * LIVE READINESS CHECK for Missions B and C.
 *
 * ============================================================================================
 * WHAT THIS DOES, AND WHAT IT REFUSES TO DO
 * ============================================================================================
 *
 * Mission B (research + visible browser navigation) and Mission C (an authorised, reversible
 * laptop action with independent verification) both need the real operator host and a real
 * desktop. Neither can be honestly demonstrated on a machine where the host is not running.
 *
 * This script answers ONE question: "are the prerequisites for the live demonstration present
 * right now?" It is read-only:
 *
 *   • it does not start, stop, arm, or reconfigure the operator host;
 *   • it does not click, type, navigate, or launch a browser;
 *   • it does not change permissions or autonomy;
 *   • it does not spend money or call a paid service.
 *
 * Exiting 0 means READY TO ATTEMPT. It does NOT mean the missions have passed. The live
 * demonstration still has to be run and evidenced (docs/MISSIONS-B-C-READINESS.md).
 *
 * Usage:
 *   node scripts/live-readiness.mjs
 *   node scripts/live-readiness.mjs --json
 *
 * Environment:
 *   PORTAI_OPERATOR_DIR  override the operator state directory (same variable operator-client uses)
 */

import { existsSync, readFileSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { connect } from '../packages/control-core/operator-client.mjs'

const asJson = process.argv.includes('--json')

/** fetch() hides the useful part of a loopback failure in `cause`; surface it. */
function why(e) {
  if (!(e instanceof Error)) return String(e)
  const cause = e.cause
  if (cause && typeof cause === 'object') {
    const c = /** @type {{ code?: string, address?: string, port?: number, message?: string }} */ (cause)
    const parts = [c.code, c.address && c.port ? `${c.address}:${c.port}` : null, c.message]
      .filter(Boolean)
    if (parts.length > 0) return `${e.message}: ${parts.join(' ')}`
  }
  return e.message
}

const checks = []
function record(name, ok, detail, required = true) {
  checks.push({ name, ok, detail, required })
}
function pass(name, detail) { record(name, true, detail) }
function fail(name, detail) { record(name, false, detail) }
function pending(name, detail) { record(name, false, detail, false) }

// ---------------------------------------------------------------------------------------------
// 1. Runtime
// ---------------------------------------------------------------------------------------------
const major = Number(process.versions.node.split('.')[0])
if (major >= 22) pass('node', `v${process.versions.node} (>= 22 required)`)
else fail('node', `v${process.versions.node}; the repository requires >= 22`)

if (process.platform === 'win32') pass('platform', `win32 ${os.release()}`)
else fail('platform', `${process.platform}; the operator host is Windows-only today`)

// ---------------------------------------------------------------------------------------------
// 2. Machine capacity. $0 and one laptop: these are measured, never assumed.
// ---------------------------------------------------------------------------------------------
const totalGb = os.totalmem() / 1024 ** 3
const freeGb = os.freemem() / 1024 ** 3
if (freeGb >= 1) pass('memory', `${freeGb.toFixed(1)} GB free of ${totalGb.toFixed(1)} GB`)
else fail('memory', `${freeGb.toFixed(2)} GB free of ${totalGb.toFixed(1)} GB; a mission may be starved`)

try {
  const st = statfsSync(process.cwd())
  const freeDiskGb = (st.bavail * st.bsize) / 1024 ** 3
  if (freeDiskGb >= 5) pass('disk', `${freeDiskGb.toFixed(1)} GB free`)
  else fail('disk', `${freeDiskGb.toFixed(1)} GB free; evidence and browser profiles need room`)
} catch (e) {
  pending('disk', `could not measure: ${why(e)}`)
}

// ---------------------------------------------------------------------------------------------
// 3. Operator host: a real process answering on loopback, with the real token.
// ---------------------------------------------------------------------------------------------
let client = null
const stateDir = process.env.PORTAI_OPERATOR_DIR
  || join(process.env.LOCALAPPDATA || '/tmp', 'Temp', 'opencode', 'operator')
const statePath = join(stateDir, 'host.json')

if (!existsSync(statePath)) {
  fail('operator-host-state', `no state file at ${statePath}. Start it with: npm run control:up`)
} else {
  pass('operator-host-state', statePath)
  try {
    client = await connect({ statePath })
  } catch (e) {
    fail('operator-host-connect', why(e))
  }
}

let observation = null
if (client) {
  try {
    const ping = await client.ping()
    pass('operator-host-ping', `pid ${ping.pid}, session ${ping.session}, screen ${ping.screenWidth}x${ping.screenHeight}`)
  } catch (e) {
    fail('operator-host-ping', why(e))
  }

  try {
    const windows = await client.windows()
    const list = Array.isArray(windows) ? windows : (windows.windows ?? [])
    pass('operator-host-windows', `${list.length} window(s) visible`)
  } catch (e) {
    fail('operator-host-windows', why(e))
  }

  try {
    const r = await client.raw('/observe')
    observation = r.body
    if (r.body?.ok === false) fail('operator-host-observe', `refused: ${r.body.error ?? 'unknown'}`)
    else pass('operator-host-observe', `state ${r.body.state}, input ${r.body.inputPermission}, mayInject ${r.body.mayInject}`)
    if (r.body?.emergencyLatched) {
      fail('emergency-stop', 'the emergency stop is LATCHED; clear it deliberately before any live run')
    } else {
      pass('emergency-stop', 'not latched')
    }
    if (r.body?.takeoverPending) {
      fail('human-takeover', 'a human takeover is pending; finish or clear it before a live run')
    } else {
      pass('human-takeover', 'no pending takeover')
    }
  } catch (e) {
    fail('operator-host-observe', why(e))
  }
}

// ---------------------------------------------------------------------------------------------
// 4. The dependencies the demonstrations actually use.
// ---------------------------------------------------------------------------------------------
const browserCandidates = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]
const browser = browserCandidates.find((p) => existsSync(p))
if (browser) pass('browser', browser)
else fail('browser', 'no Edge/Chrome executable found at a standard path; Mission B needs a browser')

// PowerShell is how the window and the host launcher are started.
const ps = [
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
].find((p) => existsSync(p))
if (ps) pass('powershell', ps)
else fail('powershell', 'no PowerShell found; the launcher cannot run')

// ---------------------------------------------------------------------------------------------
// 5. Explicitly outside this check
// ---------------------------------------------------------------------------------------------
pending('free-model-call', 'not exercised here: a hosted free-model call is optional and quota-limited')
pending('mission-b-live', 'has not been run; run the procedure in docs/MISSIONS-B-C-READINESS.md')
pending('mission-c-live', 'has not been run; run the procedure in docs/MISSIONS-B-C-READINESS.md')

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------
const failedRequired = checks.filter((c) => c.required && !c.ok)
const ready = failedRequired.length === 0

if (asJson) {
  console.log(JSON.stringify({ ready, checks }, null, 2))
} else {
  console.log('AIOS live-demo readiness')
  console.log('========================')
  for (const c of checks) {
    const mark = c.ok ? 'PASS' : (c.required ? 'FAIL' : 'PENDING')
    console.log(`  ${mark.padEnd(7)} ${c.name.padEnd(24)} ${c.detail}`)
  }
  console.log('')
  console.log(ready
    ? 'READY TO ATTEMPT. This is not a demonstration result: run Missions B and C and record the evidence.'
    : 'NOT READY. The FAIL lines above are the shortest path to a live attempt.')
  if (failedRequired.some((c) => c.name === 'operator-host-ping')) {
    console.log('The operator state file exists but nothing answered on its port, so it is stale.')
    console.log('Start the host deliberately with `npm run control:up`; this check never starts it for you.')
  }
}

process.exit(ready ? 0 : 1)
