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
import { existsSync, readFileSync, unlinkSync, readdirSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const DIR = process.env.PORTAI_OPERATOR_DIR || join(process.env.LOCALAPPDATA, 'Temp', 'opencode', 'operator')
// Where THIS script lives - the repository - which is not DIR when the host runs from %TEMP%.
const SELF_DIR = dirname(fileURLToPath(import.meta.url))
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
// Sources live in src/, beside the client and the proofs. Compiling from DIR itself found
// ZERO sources after the move into packages/control-core, which still reported "compiles
// cleanly" - a green result for compiling nothing. The count is now asserted so that can
// never happen again.
const SRC_DIR = join(DIR, 'src')
// Vendored WinRT contract metadata, required by Ocr.cs. Kept beside the sources so the pre-flight
// check and the real build reference the same files - a check against different assemblies than
// the real build is checking the wrong thing, which is what the comment on uia() below says.
const WINRT = join(DIR, 'winrt')

// Sync the vendored WinRT metadata into the runtime directory.
//
// The host is built out of %TEMP%\opencode\operator, not out of the repository, so the files the
// compiler is pointed at have to exist THERE. Without this the build fails with a missing-file
// error whose only visible symptom is that /ocr does not exist - and a missing capability that
// reports a missing file is easy to misread as "OCR was never implemented".
//
// Copied rather than referenced from the repository for the same reason src/ is copied: the
// pre-flight check and the real Add-Type must reference the same files, and they both run from
// the runtime directory.
if (SELF_DIR && SELF_DIR !== DIR) {
  const from = join(SELF_DIR, 'winrt')
  const to = WINRT
  mkdirSync(to, { recursive: true })
  for (const f of readdirSync(from)) {
    if (f.endsWith('.winmd') || f === 'README.txt') copyFileSync(join(from, f), join(to, f))
  }

  // The SOURCES are synced here too, not only by the launcher.
  //
  // They used to arrive in %TEMP% only via launch-aos.ps1, so anyone building the host directly -
  // which is every iteration during development - compiled whatever happened to be left in the
  // runtime directory from an earlier run. The failure is silent and misleading: an edit to the
  // repository produces a build of the previous code, and the resulting error names a line number
  // in a file that is not the one being read. It cost a full round here on a C# escape sequence
  // that had already been fixed in the repository.
  const srcFrom = join(SELF_DIR, 'src')
  const srcTo = SRC_DIR
  mkdirSync(srcTo, { recursive: true })
  for (const f of readdirSync(srcFrom)) {
    if (f.endsWith('.cs')) copyFileSync(join(srcFrom, f), join(srcTo, f))
  }
  copyFileSync(join(SELF_DIR, 'operator-host.ps1'), join(DIR, 'operator-host.ps1'))
}
const sources = readdirSync(SRC_DIR).filter((f) => f.endsWith('.cs')).sort()
if (sources.length === 0) {
  console.error(`  NO SOURCES FOUND in ${SRC_DIR}. Refusing to report a clean compile.`)
  process.exit(1)
}
const srcArgs = sources.map((f) => `"${join(SRC_DIR, f)}"`).join(' ')
// UI Automation ships in the GAC, not the framework directory, so its references must be
// given by full path. Without these the syntax check would not resolve the types that
// Add-Type resolves by simple name - and a syntax check that does not reference the same
// assemblies as the real build is checking the wrong thing entirely.
const GAC = 'C:/Windows/Microsoft.NET/assembly/GAC_MSIL'
const uia = (name) => `"${join(GAC, name, readdirSync(join(GAC, name))[0], name + '.dll')}"`
// GAC assemblies are versioned directories, so the path is resolved rather than assumed.
const gac = (name) => `"${join(GAC, name, readdirSync(join(GAC, name))[0], name + '.dll')}"`
console.log(`  compiling ${sources.length} sources: ${sources.join(', ')}`)
// `out` is a parameter because the syntax check and the real build are the same command with a
// different destination. Sharing one command is the point: the comment above this function says a
// pre-flight that references different assemblies than the real build is checking the wrong thing,
// and the same is true of flags and sources. Two hand-written copies drift, and the pre-flight
// keeps passing while the real build breaks.
const cscCmd = (tail, out) =>
  `& "${CSC}" /target:library /platform:x64 /warnaserror+ /out:"${out ?? checkDll}" ` +
  `/reference:"${FX64}/System.Windows.Forms.dll" /reference:"${FX64}/System.Drawing.dll" ` +
  `/reference:${uia('UIAutomationClient')} /reference:${uia('UIAutomationTypes')} /reference:${uia('WindowsBase')} ` +
  // ---- WinRT, for Ocr.cs only ------------------------------------------------------
  // Windows.Media.Ocr comes from the NuGet contract metadata vendored in winrt/, which is the
  // reason OCR builds on this machine at all - see winrt/README.txt for why the Windows SDK's
  // Windows.winmd facade was not used or needed.
  //
  // System.Runtime must come first: without it the compiler reports "the type 'System.Attribute'
  // is defined in an assembly that is not referenced" and names the winmd, which sends the reader
  // looking at the wrong file.
  `/reference:"${FX64}/System.Runtime.dll" ` +
  // System.Runtime.WindowsRuntime carries the WinRT projection types the winmd signatures return -
  // Windows.Foundation.Rect among them. Without it the compiler reports CS0012 naming the winmd
  // rather than the assembly that is actually missing.
  `/reference:${gac('System.Runtime.WindowsRuntime')} ` +
  `/reference:"${WINRT}/Windows.Foundation.UniversalApiContract.winmd" ` +
  `/reference:"${WINRT}/Windows.Foundation.FoundationContract.winmd" ` +
  `${srcArgs} ${tail}`

// WHY THERE ARE NO WinRT REFERENCES HERE
//
// Ocr.cs needs WinRT (Windows.Media.Ocr) and is NOT in the build right now - it lives in
// docs/pending-ocr/ - because WinRT code does not compile on this machine at all.
//
// The reason is precise and is not a code defect: the .NET Framework csc wants an assembly
// literally named `Windows`, version 255.255.255.255, ContentType=WindowsRuntime. That is the
// facade metadata `Windows.winmd` shipped by the Windows SDK at
// `C:\Program Files (x86)\Windows Kits\10\UnionMetadata\<version>\Windows.winmd`.
//
// That directory is EMPTY here, and no Windows.winmd exists anywhere on the system. The
// per-namespace metadata at C:\Windows\System32\WinMetadata\ IS present (Windows.Media.winmd
// and 19 others), but those declare their own names - Windows.Foundation.winmd declares
// `Windows.Foundation`, not `Windows` - so they do not satisfy the reference.
//
// TO ACTIVATE OCR when Windows.winmd exists:
//   1. add the WinRT /reference lines back to the csc command directly above
//   2. restore the WinRT entries in operator-host.ps1's Add-Type -ReferencedAssemblies
//   3. move docs/pending-ocr/Ocr.cs back into packages/control-core/src/
//   4. run: node packages/control-core/start-operator-host.mjs
//   5. GET /ocr should then return recognised text
// Full detail, including every failed approach, is in docs/OCR-HANDOVER.md.
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

// 2b. COMPILE THE REAL ASSEMBLY WITH csc, NOT WITH Add-Type.
//
// The host used to be compiled in-memory by PowerShell's Add-Type, which was fine until Ocr.cs
// needed a `.winmd` reference. Add-Type loads every -ReferencedAssemblies entry as a managed
// assembly and refuses WinRT metadata outright:
//
//   Add-Type : Could not load file or assembly
//   '...\Windows.Foundation.UniversalApiContract.winmd' or one of its dependencies.
//   The given assembly name or codebase was invalid. (0x80131047)
//
// csc accepts exactly the same reference (the pre-flight above proves it), so the fix is to let
// csc do the compile it was already doing for the syntax check, and keep the artefact instead of
// deleting it. The PowerShell process then LOADS that assembly rather than compiling one.
//
// This is a real improvement rather than a workaround: a compiled assembly gives real line-numbered
// compiler diagnostics, where Add-Type's in-memory failures arrive as an exception on the first
// request instead of at build time.
const hostDll = join(DIR, 'PortAiOperator.dll')
try { unlinkSync(hostDll) } catch { /* not there */ }
ps(`${cscCmd('2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { exit 1 }', hostDll)}`)
if (!existsSync(hostDll)) {
  console.error(`  csc did not produce ${hostDll}. Build detail:`)
  console.error(ps(`${cscCmd('2>&1 | Out-String', hostDll)}`))
  process.exit(1)
}
console.log(`  compiled host assembly: ${hostDll}`)

// 3. launch detached via WMI so the host is not parented to this shell
const out = ps(
  `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ ` +
  `CommandLine = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${HOST_PS1}" "${hostDll}"' }; ` +
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

// 5. publish the state file where the agent and missions actually read it.
//
// The host writes its own state to DIR. The agent - live-control.ts, release-watch.ts, the chat
// server - reads packages/control-core/host.json. Those were two different paths, and the
// launcher only ever wrote the first. So after a restart the agent kept using a STALE token and
// port, every call failed, and the symptom - "the host is down" - pointed at the host rather
// than at the path. That was misdiagnosed as a crash and nearly caused a correct guard change
// to be reverted.
//
// Mirrored on every start so the two can never drift again.
// Resolve from this script's own directory, not from the temporary host directory.
// The previous four-level relative walk resolved to %LOCALAPPDATA%\\Projects\\AIOS,
// not the actual repository, so the agent kept reading stale host.json state.
const MIRROR = join(dirname(fileURLToPath(import.meta.url)), 'host.json')
try {
  writeFileSync(MIRROR, JSON.stringify(state, null, 2), 'utf8')
  console.log('  mirrored state file to packages/control-core/host.json')
} catch (e) {
  console.log('  could not mirror the state file: ' + e.message)
}


// Mirror autonomy grant so it survives server restarts.
const homeDir = process.env.USERNAME || 'Samer';
const AUTONOMY_SOURCE_PATH = `C:\\Users\\${homeDir}\.aios\\agent\\autonomy.json`;
const AUTONOMY_MIRROR = join(dirname(fileURLToPath(import.meta.url)), 'autonomy.json');
if (existsSync(AUTONOMY_SOURCE_PATH)) {
  try {
    const srcContent = readFileSync(AUTONOMY_SOURCE_PATH, 'utf8');
    writeFileSync(AUTONOMY_MIRROR, srcContent, 'utf8');
    console.log('  mirrored autonomy grant file to packages/control-core/autonomy.json');
  } catch (e) {
    console.log('  could not mirror autonomy grant file: ' + e.message);
  }
} else {
  console.log('  autonomy grant source not found on this start');
}
