// ===========================================================================================
// The terminal allowlist must read the EXECUTABLE, not the last path segment.
//
// WHY THIS TEST EXISTS
//
// `commandAllowed` resolved the executable with `text.split(/[\\/]/).pop()`. That is correct
// for a fully-qualified command (`C:\Program Files\nodejs\node.exe`) and wrong for an
// allowlisted command that takes a PATH ARGUMENT:
//
//     "dir C:\Users\Samer\Documents\note.txt"
//       -> ["dir C:", "Users", "Samer", "Documents", "note.txt"]
//       -> pop() -> "note.txt"      <- the allowlist was asked about the FILENAME
//
// So `dir` was allowlisted and `dir <any path>` was refused, and the refusal named the filename
// as the problem. The same held for `type`, `where`, `tree`, `more` and `findstr` - which is to
// say, most of the commands the allowlist exists to permit. A real mission hit this: its final
// verification step used `dir C:\...\AIOS-E2E-PROOF.txt` and failed on a filename.
//
// THE PROPERTY THAT MATTERS MOST
//
// The dangerous half of this fix is that it must not widen the allowlist. The cases below are
// split into what must be ALLOWED and what must stay DENIED, and the DENIED set is the point:
// a fix for "the check reads the wrong token" is exactly the kind of change that could quietly
// become "the check reads no token at all". `rm -rf`, `del`, `curl`, `format` and `calc` are
// asserted refused on every run, so a future edit that generalises the token logic without
// thinking about it fails here rather than on someone's machine.
// ===========================================================================================
import test from 'node:test'
import assert from 'node:assert/strict'
import { commandAllowed } from '../live/agent/capabilities.ts'

const ALLOWED: Array<[string, string]> = [
  ['a bare command', 'dir'],
  ['a command with a PATH ARGUMENT', 'dir C:\\Users\\Samer\\Documents\\note.txt'],
  ['a quoted command with a path argument', 'dir "C:\\Users\\Samer\\Documents\\my notes.txt"'],
  ['type with a path', 'type C:\\Windows\\System32\\drivers\\etc\\hosts'],
  ['where with a name', 'where node'],
  ['tree with a path', 'tree C:\\Users\\Samer\\Documents'],
  ['a flag, not a path', 'node --version'],
  ['a fully-qualified executable', 'C:\\Program Files\\nodejs\\node.exe --version'],
  ['a quoted fully-qualified executable', '"C:\\Program Files\\nodejs\\node.exe" --version'],
  ['an unquoted path containing spaces', 'C:\\Program Files\\nodejs\\node.exe --version'],
  ['git with a subcommand', 'git status'],
]

const DENIED: Array<[string, string]> = [
  ['a destructive delete', 'rm -rf C:\\'],
  ['windows del', 'del C:\\Windows\\System32\\config'],
  ['a network fetcher', 'curl http://evil.test'],
  ['an encoded powershell', 'powershell -enc AAAA'],
  ['a formatter', 'format c:'],
  ['an arbitrary program', 'calc'],
  ['an empty string', ''],
  ['a bare backslash path with no command', 'C:\\'],
]

test('allowlisted commands are allowed even when they take a path argument', () => {
  for (const [what, cmd] of ALLOWED) {
    assert.equal(commandAllowed(cmd), true, `${what}: "${cmd}" should be allowed`)
  }
})

test('everything not on the allowlist stays refused, including through a path argument', () => {
  for (const [what, cmd] of DENIED) {
    assert.equal(commandAllowed(cmd), false, `${what}: "${cmd}" must be refused`)
  }
})

// The control. A test that cannot fail proves nothing, so this asserts that the very defect
// being fixed - reading the wrong token - is what the allowlist now avoids, by checking a case
// whose correct answer differs from what the old expression produced.
test('CONTROL: the token checked is the command, not the trailing path segment', () => {
  const cmd = 'dir C:\\Users\\Samer\\Documents\\secret.txt'
  // What the old implementation computed, restated so the regression cannot return unnoticed.
  const oldToken = cmd.trim().split(/[\\/]/).pop() ?? ''
  assert.equal(oldToken, 'secret.txt', 'the old expression really did select the filename')
  assert.equal(commandAllowed(cmd), true, 'and the current implementation still allows the command')
})

test('an executable name is matched case-insensitively and with or without .exe', () => {
  assert.equal(commandAllowed('DIR'), true)
  assert.equal(commandAllowed('dir.exe C:\\Users\\Samer'), true)
  assert.equal(commandAllowed('NoDe.js'), false, 'a near miss on the name is still a refusal')
})