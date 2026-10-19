/**
 * WHY THIS FILE EXISTS
 * ============================================================================================
 *
 * The desktop shortcut opened Windows Media Player instead of the AIOS Assistant.
 *
 * `launch-aos.ps1` invoked the harness with PowerShell's call operator on a `.ts` file:
 *
 *     $cmd = "& 'C:\...\run-aios-chat.ts' 60599 <token>"
 *     Start-Process powershell -ArgumentList ..., "-Command", $cmd -WindowStyle Hidden
 *
 * PowerShell cannot execute TypeScript. Given a `.ts` path, `&` hands it to the Windows shell,
 * which resolves it through the file association. On this machine:
 *
 *     > cmd /c assoc .ts
 *     .ts=WMP11.AssocFile.TTS
 *
 * `.ts` is also the extension for an MPEG transport stream, so Windows Media Player opened.
 * The AIOS Assistant never started, and because the launcher was itself started with
 * `-WindowStyle Hidden`, the failure was invisible. The user saw only a media player.
 *
 * These controls pin the fix. Each asserts something that must stay true, and each can fail:
 * the "and it can fail" control proves it.
 *
 * A shell assertion here is deliberate. This defect is entirely about how a command line is
 * interpreted by the OS, so no amount of reading the harness can detect it. The only honest
 * evidence is either a file-association lookup, as below, or running the thing.
 *
 * This is a REAL Windows integration control: it queries the live shell association table for
 * this machine. It is not mocked.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// test/ -> control-core/ -> packages/ -> repo root. launch-aos.ps1 sits at the repo root.
const REPO = resolve(HERE, '..', '..', '..')
const LAUNCHER = join(REPO, 'launch-aos.ps1')

/**
 * The launcher WITHOUT its comments.
 *
 * This is not tidiness, it is correctness, and the repo has already been bitten by exactly
 * this: `docs/safety/known-defects.md` (M15, durable-layer defect 5) records a DDL control
 * that searched the raw SQL for `succeeded`/`authorised`, failed, and was found to be
 * defeated by its own documentation - the comment explaining why those columns are absent
 * contained the forbidden words. The fix was to strip comments before searching.
 *
 * The same thing happens here: the launcher documents the defect it fixed, so a search for
 * the defect's text finds the documentation. A control beaten by its own comment gets fixed,
 * not deleted - but only once it is understood.
 *
 * Limitation, stated rather than smoothed over: a naive strip also removes a `#` inside a
 * PowerShell string literal. That is acceptable here because the two things being searched
 * for - an `&` call on a `.ts` path, and a long hex token - are not things a legitimate
 * string literal in this launcher would contain. A change that put one there would need a
 * real parser, and this test would say so rather than silently pass.
 */
const launcher = (): string =>
  readFileSync(LAUNCHER, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|\s)#.*$/, '$1'))
    .join('\n')

// ------------------------------------------------------------------------------ the association

/** The OS's own answer to "what opens a .ts file". This is the fact the defect turned on. */
function tsAssociation(): string {
  const out = execFileSync('cmd.exe', ['/c', 'assoc .ts'], { encoding: 'utf8' })
  const m = out.match(/\.ts=(\S+)/)
  return m ? m[1]! : ''
}

// ------------------------------------------------------------------------------ 1. the cause

test('.ts is associated with a MEDIA PLAYER on this machine - the documented cause', () => {
  const assoc = tsAssociation()
  assert.ok(assoc, 'the shell must report an association for .ts, or this control proves nothing')
  assert.match(
    assoc,
    /WMP|MediaPlayer|WindowsMedia/i,
    `this control exists because .ts resolved to a media player. If the association is now ` +
    `${assoc}, this defect class may be gone by another route - re-measure before deleting. ` +
    `It is deliberately NOT removed automatically.`,
  )
})

// ------------------------------------------------------------------------------ 2. the fix

test('the launcher does NOT hand a .ts file to PowerShell', () => {
  assert.ok(existsSync(LAUNCHER), `launcher missing at ${LAUNCHER}`)
  const src = launcher()

  // The exact shape of the original defect: `&` immediately followed by a quoted .ts path.
  const bad = src.match(/&\s*['"`][^'"`]*\.ts['"`]/g)
  assert.equal(
    bad,
    null,
    `the launcher invokes a .ts file with PowerShell's call operator: ${bad?.join(', ')}\n` +
    `PowerShell cannot execute TypeScript; it hands the path to the shell, the shell resolves ` +
    `.ts -> ${tsAssociation()}, and Media Player opens instead of the app. ` +
    `Run the harness through \`node --experimental-strip-types\`.`,
  )
})

test('the launcher starts the harness through node with --experimental-strip-types', () => {
  const src = launcher()
  assert.match(src, /--experimental-strip-types/,
    'every harness in package.json is run this way; the launcher is the one that was not')
  assert.match(src, /node/i,
    'the launcher must start node, not PowerShell, so the .ts association never applies')
})

test('the launcher records what it started, so a failure is no longer invisible', () => {
  const src = launcher()
  assert.match(src, /launcher\.log|\.log/,
    'the original launcher ran hidden and threw its error away; it must leave a record')
  assert.doesNotMatch(src, /-WindowStyle",?\s*"?Hidden"?\s*,?\s*"-Command"/,
    'do not reintroduce a hidden PowerShell whose -Command failure nobody can see')
})

test('the launcher passes no stale port/token arguments', () => {
  // run-aios-chat.ts calls startServer(), which defaults to 8777 and reads the token from
  // ~/.aios/agent/server.json. process.argv is never read. The old script passed 60599 and a
  // hardcoded token; they were inert, and a hardcoded token in a launcher is a trap.
  const src = launcher()
  assert.doesNotMatch(src, /\b\d{4,5}\b(?=[^\n]*60599)/, 'the dead 60599 argument is back')
  assert.doesNotMatch(src, /[0-9a-f]{24,}/i,
    'a long hex literal in the launcher is a hardcoded token, which nothing reads')
})

// ------------------------------------------------------------------------------ 3. the shortcut

test('a desktop launcher shortcut exists and launches powershell on launch-aos.ps1', () => {
  // WHY THIS SCANS INSTEAD OF NAMING ONE FILE
  //
  // This test used to hardcode 'AIOS Assistant.lnk'. The user then deleted that icon and kept
  // 'Zeus.lnk' instead, which is a perfectly reasonable thing to do with an icon on your own
  // desktop. Hardcoding the filename meant the test reported a defect where there was none, and
  // the only two ways to make it green were to re-create an icon the user had just deleted or to
  // weaken the assertion. Neither is the test's job.
  //
  // What is actually being protected is unchanged and stated in the original comment: the user's
  // entry point must exist, and it must run the launcher rather than a media file. So the test
  // now looks for every AIOS launcher icon on the desktop, fails if there are NONE (still not a
  // skip-and-report-success), and checks that every one it finds is wired correctly.
  //
  // The name is matched loosely on purpose: 'Zeus' shares no substring with 'AIOS Assistant', so
  // recognition is by what the shortcut POINTS AT, which is the thing under test anyway.
  const desktop = join(process.env.USERPROFILE ?? '', 'Desktop')
  const candidates = existsSync(desktop)
    ? readdirSync(desktop).filter((f) => f.toLowerCase().endsWith('.lnk'))
    : []

  const pointingAtLauncher: string[] = []
  for (const f of candidates) {
    const ps = readShortcut(join(desktop, f))
    if (/launch-aos\.ps1/i.test(`${ps.Arguments} ${ps.TargetPath}`)) pointingAtLauncher.push(f)
  }

  assert.ok(
    pointingAtLauncher.length > 0,
    `no desktop icon launches launch-aos.ps1. The user's entry point is gone: ${desktop} has ` +
    `${candidates.length} shortcut(s) and none of them run the launcher. Found: ${candidates.join(', ') || '(none)'}`,
  )

  for (const f of pointingAtLauncher) {
    const ps = readShortcut(join(desktop, f))
    assert.match(ps.TargetPath, /powershell/i,
      `${f} must invoke powershell, got ${ps.TargetPath}`)
    assert.match(ps.Arguments, /launch-aos\.ps1/i,
      `${f} must run launch-aos.ps1, got ${ps.Arguments}`)
    assert.doesNotMatch(`${ps.TargetPath} ${ps.Arguments}`, /\.(ts|mp4|mp3|wmv|avi)\b/i,
      `${f} must not point at a media or script-stream file`)
  }
})

function readShortcut(path: string): { TargetPath: string; Arguments: string } {
  const ps = [
    '$w = New-Object -ComObject WScript.Shell',
    `$s = $w.CreateShortcut('${path.replace(/'/g, "''")}')`,
    'Write-Output $s.TargetPath',
    'Write-Output "::"',
    'Write-Output $s.Arguments',
  ].join('; ')
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { encoding: 'utf8' },
  )
  const [target, args] = out.split(/\r?\n::\r?\n/)
  return { TargetPath: (target ?? '').trim(), Arguments: (args ?? '').trim() }
}

// ------------------------------------------------------------------------------ 4. can it fail?

test('AND IT CAN FAIL: a launcher that reintroduces the defect is rejected', () => {
  // The positive control. Without this, a broken regex above would make every control pass
  // while testing nothing - which is the exact failure class this repository exists to catch.
  const reintroduced = `$cmd = "& 'C:\\\\Users\\\\Samer\\\\Projects\\\\AIOS\\\\run-aios-chat.ts' 60599 abc"`
  assert.match(
    reintroduced,
    /&\s*['"`][^'"`]*\.ts['"`]/,
    'the detector must match the ORIGINAL defect text, or control 2 is vacuous',
  )
})

test('AND IT CAN FAIL: the association lookup really queries the shell', () => {
  const assoc = tsAssociation()
  assert.match(assoc, /^WMP11\.AssocFile\.TTS$/i,
    `expected the Windows Media Player association, got "${assoc}". ` +
    `If this fails the association changed and control 1 is measuring the wrong thing.`)
})