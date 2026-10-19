import { evidenceFingerprint, normalizedFindings } from './packages/agent/orchestrator.ts'

const PASS_CMD = 'node -e "process.exit(0)"'
const FAIL_CMD = 'node -e "process.exit(3)"'

const objective = 'do the thing'
const constraints = []

function block(cmd, exitCode, out) {
  return `VERIFICATION COMMAND: ${cmd}\nEXIT CODE: ${exitCode}\nOUTPUT:\n${out}`
}

const notes = 'NOTES-SAME'
const findings = []

const e1 = block(PASS_CMD, 0, '')
const e2 = block(FAIL_CMD, 3, '')

console.log('--- raw evidence differs? ---')
console.log('e1 ===e2 :', e1 === e2)

const f1 = evidenceFingerprint({ objective, constraints, evidence: e1, notes, findings })
const f2 = evidenceFingerprint({ objective, constraints, evidence: e2, notes, findings })

console.log('--- fingerprints ---')
console.log('f1:', f1)
console.log('f2:', f2)
console.log('equal:', f1 === f2)

console.log('--- normalized evidence ---')
console.log('n1:', JSON.stringify(normalizedFindings(e1)))
console.log('n2:', JSON.stringify(normalizedFindings(e2)))