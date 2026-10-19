import { readFileSync } from 'node:fs'
const s = readFileSync('packages/control-core/src/OperatorHost.cs', 'utf8')
const lines = s.split(/\r?\n/)
for (const n of [820, 822, 824, 833, 862, 864, 865, 866]) {
  const L = lines[n - 1] || ''
  const doubled = L.includes('\\"')
  console.log('line ' + n + '  doubledBackslash=' + doubled + '  ' + L.trim().slice(0, 90))
}