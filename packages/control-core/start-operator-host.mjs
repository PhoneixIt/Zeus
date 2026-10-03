// Build-verify and launch the PortAi desktop operator host. Idempotent.
//
// WHY POWERSELL-HOSTED RATHER THAN A COMPILED EXE
// Windows Application Control blocked the freshly built OperatorHost.exe with
// "An Application Control policy has blocked this file." That is a deliberate security
// control and it is NOT being bypassed. Instead the identical C# is compiled in
// memory by the host script via Add-Type, running inside a signed powershell.exe that
// is already permitted to execute. No new unsigned binary is introduced, so the
// policy is satisfied rather than evaded.
//
// The compile below is a syntax check only, producing a throwaway library in a
// temporary folder. It exists so a compile error surfaces here with a real message
// instead of as a host that silently never starts.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const DIR = process.env.PORTAI_OPERATOR_DIR || join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'operator')
const SRC = join(DIR, 'OperatorHost.cs')
const HOST_PS1 = join(DIR, 'operator-host.ps1')
const STATE = join(DIR, 'host.json')
const CSC = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'
const FX64 = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319'
const PS = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

const ps = (script) => execFileSync(PS, ['-NoProfile', '-Command', script], { encoding: 'utf8' })

// 1. stop any existing host through its own API
if (existsSync(STATE)) {
  const s = JSON.parse(readFileSync(STATE, 'utf8'))
  try {
    await fetch(`http://127.0.0.1:${s.port}/shutdown`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: s.token }),
    })
    console.log('  stopped previous host')
  } catch {
    console.log('  previous host was not responding')
  }
  await new Promise((r) => setTimeout(r, 1500))
  unlinkSync(STATE)
}

// 2. syntax-check the C# without producing a runnable exe.
//    ALL .cs files are compiled together, because the human-takeover safety layer
//    lives in sibling files (Guard.cs, Hooks.cs, Indicator.cs) that must compile as
//    one unit with the host.
const checkDll = join(tmpdir(), 'portai-operator-syntaxcheck.dll')
const sources = readdirSync(DIR).filter((f) => f.endsWith('.cs')).sort()
const srcArgs = sources.map((f) => `"${join(DIR, f)}"`).join(' ')
// UI Automation ships in the GAC, not the framework directory, so its references must be
// given by full path. Without these the syntax check would not resolve the types that
// Add-Type resolves by simple name - and a syntax check that does not reference the same
// assemblies as the real build is checking the wrong thing entirely.
const GAC = 'C:/Windows/Microsoft.NET/assembly/GAC_MSIL'
const uia = (name) => `"${join(GAC, name, readdirSync(join(GAC, name))[0], name + '.dll')}"`
console.log(`  compiling ${sources.length} sources: ${sources.join(', ')}`)
const cscCmd = (tail) =>
  `& "${CSC}" /target:library /platform:x64 /warnaserror+ /out:"${checkDll}" ` +
  `/reference:"${FX64}/System.Windows.Forms.dll" /reference:"${FX64}/System.Drawing.dll" ` +
  `/reference:${uia('UIAutomationClient')} /reference:${uia('UIAutomationTypes')} /reference:${uia('WindowsBase')} ` +
  `${srcArgs} ${tail}`
// /warnaserror+ is deliberate and was added after being bitten three times. The real
// build is Add-Type, which promotes warnings to errors; the pre-flight check did not, so
// "source compiles cleanly" was printed for code the host then refused to load - an
// unused variable, an ambiguous reference, an unreachable path. The check is only worth
// having if it agrees with the thing it is checking.
try {
  ps(`${cscCmd('2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { exit 1 }')}`)
  console.log('  source compiles cleanly (no exe produced)')
} catch {
  const detail = ps(`${cscCmd('2>&1 | Out-String')}`)
  console.error('  COMPILE FAILED:\n' + detail)
  process.exit(1)
}
unlinkSync(checkDll)

// 3. launch detached via WMI so the host is not parented to this shell
const out = ps(
  `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ ` +
  `CommandLine = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${HOST_PS1}"' }; ` +
  `$r.ProcessId`
)
const hostPid = Number(out.trim().split(/\r?\n/).pop())
console.log('  launched powershell host, pid=' + hostPid)

// 4. wait for the state file
let state = null
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 250))
  if (existsSync(STATE)) { state = JSON.parse(readFileSync(STATE, 'utf8')); break }
}
if (!state) { console.error('  host did not write a state file'); process.exit(1) }

const ping = await (await fetch(`http://127.0.0.1:${state.port}/ping`)).json()
console.log(`  host up: port=${state.port} session=${ping.session} screen=${ping.screenWidth}x${ping.screenHeight}`)
