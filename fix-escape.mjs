import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'packages/control-core/src/OperatorHost.cs'
const src = readFileSync(FILE, 'utf8')
const lines = src.split(/\r?\n/)

// Only the C# string literals that build JSON. The COMMENT lines legitimately contain
// `\\"` as text and must not be touched.
const TARGETS = [833, 866]
let fixed = 0
for (const n of TARGETS) {
  const i = n - 1
  const before = lines[i]
  if (!before.includes('\\"')) { console.log('line ' + n + ': no doubled backslash, skipping'); continue }
  lines[i] = before.replace(/\\"/g, '\\"')
  // Verify: after the fix the source should contain \" (single backslash + quote)
  const after = lines[i]
  const stillBad = /\\\\"/.test(after)
  console.log('line ' + n + ' fixed=' + !stillBad)
  console.log('  ' + after.trim().slice(0, 100))
  if (stillBad) { console.log('  STILL BAD'); process.exit(1) }
  fixed++
}

writeFileSync(FILE, lines.join('\n'), 'utf8')
console.log('fixed ' + fixed + ' line(s)')

// Re-verify the whole file: no doubled backslash remains inside a Json("...") call.
const out = readFileSync(FILE, 'utf8')
const jsonLines = out.split(/\r?\n/).filter((l) => l.includes('return Json("'))
let bad = 0
for (const l of jsonLines) {
  if (/\\\\"/.test(l)) { bad++; console.log('STILL BAD: ' + l.trim().slice(0, 90)) }
}
console.log(bad === 0 ? 'clean: no doubled backslashes inside any Json() literal' : bad + ' remain')