/**
 * RUN THE M8 PROOF AS ONE COMMAND.
 *
 * It starts the adversarial peer, waits for the peer to say it is listening, runs the mission against
 * it, and then stops the peer - in that order, and on every exit path including a failure or a Ctrl-C.
 *
 * WHY THIS EXISTS
 *
 * The first version of this proof was: start the peer by hand in one terminal, run the mission in
 * another. That works exactly once and cannot be reproduced by anyone else, and a proof that only runs
 * when someone remembered to leave a server up is not a proof - it is a recollection. The peer being
 * a SEPARATE PROCESS is the property under test, and it stays a separate process here; only the
 * bookkeeping of starting and stopping it is automated.
 *
 * IT FAILS LOUDLY IF THE PEER NEVER ARRIVES
 *
 * A harness that proceeds without its peer would produce a run in which every scenario fails to
 * connect and the failures look like refusals. So the wait is bounded, and if the peer is not up the
 * runner exits non-zero with the peer's own output, rather than letting the mission report anything.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const PORT = process.env.AIOS_PEER_PORT ?? '8791'
const NODE_FLAGS = ['--experimental-strip-types', '--no-warnings']

const peer = spawn(
  process.execPath,
  [...NODE_FLAGS, join(REPO, 'packages', 'model', 'adversarial-peer.ts'), PORT],
  { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] },
)

let peerSaidReady = false
let peerOutput = ''
peer.stdout.on('data', (d) => {
  peerOutput += String(d)
  if (!peerSaidReady && peerOutput.includes('listening')) peerSaidReady = true
})
peer.stderr.on('data', (d) => { peerOutput += String(d) })

/** Always stop the peer, whatever happened. A stray listener on a fixed port is its own defect. */
let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  try { peer.kill() } catch { /* already gone, which is the desired state */ }
}
for (const signal of ['SIGINT', 'SIGTERM', 'exit']) {
  process.on(signal, () => { cleanup(); if (signal !== 'exit') process.exit(130) })
}

// ---- bounded wait for the peer
const DEADLINE_MS = 15_000
const started = Date.now()
while (!peerSaidReady && Date.now() - started < DEADLINE_MS) {
  if (peer.exitCode !== null) break
  await new Promise((r) => setTimeout(r, 100))
}

if (!peerSaidReady) {
  console.error('')
  console.error('HARNESS ERROR: the adversarial peer never reported that it was listening.')
  console.error('Without it every scenario would fail to connect, and a connection failure is not a refusal.')
  console.error('The peer said:')
  console.error(peerOutput.trim() || '  (nothing - it exited without output)')
  cleanup()
  process.exit(2)
}

console.log(`[runner] adversarial peer is up on 127.0.0.1:${PORT} (pid ${peer.pid})`)

// ---- run the mission
const mission = spawn(
  process.execPath,
  [...NODE_FLAGS, join(HERE, 'run-model-mission.ts')],
  { cwd: REPO, stdio: 'inherit', env: { ...process.env, AIOS_PEER_PORT: PORT } },
)

mission.on('exit', (code, signal) => {
  cleanup()
  if (signal) {
    console.error(`[runner] the mission was terminated by ${signal}`)
    process.exit(130)
  }
  console.log(`[runner] mission exited ${code}; peer stopped`)
  process.exit(code ?? 1)
})