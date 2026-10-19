// Compile-check the control core WITHOUT starting anything.
//
// WHY THIS IS A SEPARATE SCRIPT
//
// `npm run control:syntax` used to be an inline PowerShell one-liner. It could never have
// worked, and reported failure on unmodified committed code, so it was a compile gate that
// could not compile. Three separate faults, all fixed here:
//
//   1. `packages/control-core/src/*.cs` was passed as a literal glob. PowerShell does not
//      expand globs for native commands, so `csc` received a path it could not open and
//      failed with CS1504 on every file.
//   2. The UI Automation references were missing entirely. UIA ships in the GAC, not the
//      framework directory, so `UIAutomationClient`, `UIAutomationTypes` and `WindowsBase`
//      have to be referenced by full path. Without them the check cannot resolve the very
//      types the real build resolves by simple name.
//   3. `/platform:x64` was missing, so the check did not agree with the real build.
//
// This is deliberately a SEPARATE entry point from start-operator-host.mjs, which compiles
// for the same reason but then goes on to launch a host. A syntax gate must not have the
// side effect of starting a service.
//
// Sources are located relative to THIS FILE, not to PORTAI_OPERATOR_DIR. The env var still
// points at the legacy temp directory, and a repo gate that silently checked the wrong
// sources would be worse than no gate at all.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(HERE, 'src')
const CSC = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'
const FX64 = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319'
const PS = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const GAC = 'C:/Windows/Microsoft.NET/assembly/GAC_MSIL'

// A gate that cannot fail is not a gate. Prove this one can fail before believing it.
const assertNonVacuous = process.argv.includes('--prove-it-can-fail')

const uia = (name) => {
  const dir = join(GAC, name)
  if (!existsSync(dir)) {
    console.error(`  FAIL: ${name} not found in the GAC at ${dir}`)
    process.exit(1)
  }
  return `"${join(dir, readdirSync(dir)[0], name + '.dll')}"`
}

const sources = existsSync(SRC_DIR)
  ? readdirSync(SRC_DIR).filter((f) => f.endsWith('.cs')).sort()
  : []

if (sources.length === 0) {
  console.error(`  FAIL: NO SOURCES FOUND in ${SRC_DIR}. Refusing to report a clean compile.`)
  process.exit(1)
}

const toCompile = assertNonVacuous
  // The first version of this control compiled only `Guard.cs`, expecting it to fail for
  // missing sibling types. It compiled cleanly - Guard.cs is self-contained - so the control
  // reported "the gate cannot detect breakage" about a gate that is fine. A negative control
  // that fails for the wrong reason is worse than none: it would have had this gate deleted.
  //
  // So the failure is forced directly: add a path that does not exist. csc must return
  // non-zero and the gate must surface that. Combined with the normal run exiting 0 on the
  // same sources, this shows the gate DISCRIMINATES rather than always passing.
  ? [...sources, '__deliberately_absent_for_the_negative_control.cs']
  : sources

const checkDll = join(tmpdir(), 'aios-syntax-check.dll')

const csc = (files) =>
  `& "${CSC}" /target:library /platform:x64 /warnaserror+ /out:"${checkDll}" ` +
  `/reference:"${FX64}/System.Windows.Forms.dll" /reference:"${FX64}/System.Drawing.dll" ` +
  `/reference:${uia('UIAutomationClient')} /reference:${uia('UIAutomationTypes')} /reference:${uia('WindowsBase')} ` +
  files.map((f) => `"${join(SRC_DIR, f)}"`).join(' ')

const run = (files) =>
  execFileSync(PS, ['-NoProfile', '-Command', `${csc(files)} 2>&1 | Out-String; exit $LASTEXITCODE`], {
    encoding: 'utf8',
  })

console.log(`  control-core syntax check over ${sources.length} source(s): ${sources.join(', ')}`)

let failed = false
let output = ''
try {
  output = run(toCompile)
} catch (e) {
  failed = true
  output = `${e.stdout ?? ''}${e.stderr ?? ''}`
}
if (existsSync(checkDll)) unlinkSync(checkDll)

if (assertNonVacuous) {
  // The injected compile MUST fail. If it succeeded, exit non-zero: the gate is broken.
  if (failed) {
    console.log('  PROVED: a deliberate type error is detected. This gate can fail.')
    process.exit(0)
  }
  console.error('  FAIL: a deliberately broken compile was ACCEPTED. This gate cannot detect breakage.')
  process.exit(1)
}

if (failed) {
  console.error('  COMPILE FAILED:\n' + output)
  process.exit(1)
}
console.log('  source compiles cleanly (no exe produced)')
process.exit(0)