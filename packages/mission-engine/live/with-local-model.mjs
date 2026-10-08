/**
 * RUN THE M9 PROOF AS ONE COMMAND.
 *
 * Starts the local model server (a Python subprocess holding the weights), waits for it to report that
 * it is listening, runs the mission against it, then stops it - in that order, on every exit path.
 *
 * WHY A RUNNER AND NOT TWO TERMINALS
 *
 * Because a proof that only runs when someone remembered to leave a server up is a recollection, not a
 * proof. M8's runner was written for exactly that reason and this one is the same shape.
 *
 * IT REFUSES TO PROCEED WITHOUT THE MODEL
 *
 * If the server never comes up, this exits non-zero rather than letting the mission run against
 * nothing. That distinction matters: a connection failure is not a refusal, and reporting one as the
 * other would turn an infrastructure problem into a governance finding.
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..', '..')
const PORT = process.env.AIOS_LOCAL_MODEL_PORT ?? '8792'
const NODE_FLAGS = ['--experimental-strip-types', '--no-warnings']
const MODEL_DIR = process.env.AIOS_MODEL_DIR ??
  `${process.env.LOCALAPPDATA ?? ''}\\AIOS\\models\\qwen2.5-0.5b-instruct`

if (!existsSync(join(MODEL_DIR, 'model.onnx'))) {
  console.error('')
  console.error(`HARNESS ERROR: no model at ${MODEL_DIR}`)
  console.error('Run this first:  python packages/model/local/fetch-model.py')
  console.error('')
  console.error('Refusing to start: an absent model would otherwise look like a model that cannot plan,')
  console.error('which is a completely different finding.')
  process.exit(2)
}

// CONSTRAINED GENERATION is opt-in and is started HERE, on the server, not per request. The server
// builds a vocabulary index at load time, which costs real seconds, so paying it on every run would
// make the unconstrained baseline - the thing M10 is measured against - slower for no reason.
  //
  // A server started WITHOUT --grammar answers an x-grammar request with HTTP 400 rather than quietly
  // ignoring it. A harness that silently measures the wrong thing is worse than no harness.
  const GRAMMAR = process.env.AIOS_MODEL_GRAMMAR === '1'
  const serverArgs = [
    join(REPO, 'packages', 'model', 'local', 'server.py'),
    '--port', PORT, '--model-dir', MODEL_DIR,
  ]
  if (GRAMMAR) serverArgs.push('--grammar')

  const server = spawn('python', serverArgs, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] })

let ready = false
let serverOutput = ''
server.stdout.on('data', (d) => {
  const s = String(d)
  serverOutput += s
  process.stdout.write(s)
  if (s.includes('listening')) ready = true
})
server.stderr.on('data', (d) => { serverOutput += String(d); process.stderr.write(String(d)) })

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  try { server.kill() } catch { /* already gone */ }
}
for (const signal of ['SIGINT', 'SIGTERM', 'exit']) {
  process.on(signal, () => { cleanup(); if (signal !== 'exit') process.exit(130) })
}

// The model has to be read off disk and initialised. Generous, because a cold start on a spinning or
// encrypted disk is genuinely slow - but still bounded, because an unbounded wait is indistinguishable
// from a hang.
const DEADLINE_MS = 300_000
const started = Date.now()
while (!ready && Date.now() - started < DEADLINE_MS) {
  if (server.exitCode !== null) break
  await new Promise((r) => setTimeout(r, 200))
}

if (!ready) {
  console.error('')
  console.error('HARNESS ERROR: the local model server never reported that it was listening.')
  console.error('The server said:')
  console.error(serverOutput.trim() || '  (nothing - it exited without output)')
  console.error(`  its exit code was ${server.exitCode}`)
  cleanup()
  process.exit(2)
}

console.log(`[runner] local model is up on 127.0.0.1:${PORT} (pid ${server.pid})`)
  console.log(`[runner] constrained generation: ${
    GRAMMAR ? 'ON  (a structural grammar masks the logits)' : 'off  (unconstrained - this is the M9 baseline)'
  }`)

/**
 * Run one harness as a child and resolve with its exit code.
 *
 * Sequential, and deliberately so. Two harnesses running at once would each get a share of the same
 * CPU, and the latency figures both of them report would then describe contention rather than the
 * model. Measuring and stress-testing are different jobs and this command does the first one honestly.
 */
function runHarness(file) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [...NODE_FLAGS, join(HERE, file)],
      { cwd: REPO, stdio: 'inherit', env: { ...process.env, AIOS_LOCAL_MODEL_PORT: PORT } },
    )
    child.on('exit', (code, signal) => resolve(signal ? 130 : (code ?? 1)))
  })
}

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null

// The order matters. The mission runs FIRST and alone, so its latency numbers describe a model with
// the machine to itself; the adversarial suite then loads the same warm model.
const stages = [
  ['run-local-model-mission.ts', 'the real mission'],
  ['run-local-model-adversarial.ts', 'the adversarial suite'],
].filter(([file]) => only === null || file.includes(only))

let exitCode = 0
for (const [file, label] of stages) {
  console.log('')
  console.log('#'.repeat(78))
  console.log(`# [runner] ${label}: ${file}`)
  console.log('#'.repeat(78))
  const code = await runHarness(file)
  if (code !== 0) {
    exitCode = code
    console.log(`[runner] ${label} exited ${code}; stopping rather than reporting a partial run as a pass`)
    break
  }
}

cleanup()
console.log(`[runner] local model stopped; exit ${exitCode}`)
process.exit(exitCode)