/**
 * THE TERMINAL COMMAND POLICY.
 *
 * WHAT THIS IS NOT
 *
 * This is not a sandbox. It is not a jail. A process spawned here runs as the user, with the
 * user's token, and it is not contained by anything in this file. It can read files outside the
 * workspace, open network connections, spawn its own children, and modify system state it can
 * reach. No claim below should be read as saying otherwise.
 *
 * The four things below are four DIFFERENT boundaries, and conflating them is how "we set the
 * working directory" comes to be reported as "sandboxed":
 *
 *   1. EXECUTABLE ALLOWLIST   real. Enforced in this process, before spawn. Only a named set of
 *                             absolute paths may be launched, so a PATH entry cannot substitute a
 *                             different program for an approved one.
 *
 *   2. ARGV / PATH VALIDATION real. Enforced here, before spawn. Arguments that name paths are
 *                             resolved (through realpath, so junctions and 8.3 short names do not
 *                             slip past) and must land inside the workspace.
 *
 *   3. WORKING DIRECTORY      real, and WEAK ON ITS OWN. `cwd` genuinely controls where relative
 *                             paths resolve. It does not restrict anything else, and a program that
 *                             wants to read C:\ does not have to try hard. Calling this
 *                             "confinement" overstates it; it is a default, not a boundary.
 *
 *   4. OS-LEVEL ISOLATION     ABSENT. There is no Job Object, no AppContainer, no restricted
 *                             token, no container. Nothing here prevents a permitted program from
 *                             touching anything the user can touch.
 *
 * The capability is built so that item 4 being absent is survivable: the allowlist is small, every
 * program on it is one we chose knowing what it does, and anything outside it is refused rather
 * than sandboxed-and-hoped-for.
 *
 * WHY AN ALLOWLIST AND NOT A BLACKLIST
 *
 * A blacklist of dangerous commands cannot be complete, and its incompleteness is invisible -
 * `rm -rf` is listed and `git clean -fdx` is not, and nothing reports the gap. An allowlist is
 * small enough to read in full, and its incompleteness is the safe direction: an unlisted program
 * does not run, and the refusal names what was asked for.
 *
 * WHY SHELLS ARE REFUSED RATHER THAN SANDBOXED
 *
 * `cmd.exe /c` and `powershell -c` take a STRING and re-parse it, which means the argv this policy
 * validated is not the argv that runs. Any allowlist in front of a shell is a suggestion. So no
 * shell is reachable, and there is no command-string path into the system at all.
 */

import { realpathSync, existsSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import type { DeclaredEffect } from '../../governance/approval.ts'

/**
 * The outcome of classifying a requested command.
 *
 * `consequential` carries a FULL effect including a target, because the approval key is built from
 * this value. A consequence the policy cannot name a target for is not authorisable, so the
 * policy refuses instead of asking a human to approve an unspecified action.
 */
export type Verdict =
  | { readonly kind: 'allow'; readonly note: string }
  | { readonly kind: 'consequential'; readonly effect: DeclaredEffect; readonly note: string }
  | { readonly kind: 'blocked'; readonly reason: string; readonly needsHuman: boolean }

const block = (reason: string, needsHuman = false): Verdict => ({ kind: 'blocked', reason, needsHuman })

// ============================================================ 1. the executable allowlist

/**
 * A permitted program.
 *
 * `abs` is REQUIRED and must be absolute. Matching on a bare name would let a PATH entry decide
 * which program actually runs, which is exactly the substitution the allowlist exists to prevent.
 */
export interface AllowedProgram {
  readonly abs: string
  /** Basename, for messages. */
  readonly name: string
  /**
   * Classifies the arguments. Returning `undefined` means "this program is allowed but these
   * arguments are not understood", which is refused rather than permitted - an unparsed argument
   * list is not a safe argument list.
   */
  readonly classify: (argv: readonly string[], ctx: PolicyContext) => Verdict | undefined
}

export interface PolicyContext {
  /** The only directory tree paths may resolve into. */
  readonly workspace: string
  /** The workspace with junctions/symlinks resolved, for comparison. */
  readonly workspaceReal: string
}

function realOrSelf(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/**
 * Whether a path resolves inside the workspace.
 *
 * Resolution goes through `realpathSync` on both sides, because a textual prefix test is defeated
 * by a junction, a symlink, or an 8.3 short name - `C:\PROGRA~1` is not textually inside a root
 * that contains `C:\Program Files`, but it is the same place.
 */
export function insideWorkspace(ctx: PolicyContext, candidate: string): boolean {
  const abs = isAbsolute(candidate) ? candidate : resolve(ctx.workspace, candidate)
  if (abs.includes(`..${sep}`) || abs.endsWith(`${sep}..`)) return false
  const real = realOrSelf(abs)
  const root = ctx.workspaceReal.endsWith(sep) ? ctx.workspaceReal : ctx.workspaceReal + sep
  if (real !== ctx.workspaceReal && !real.startsWith(root)) return false
  // Resolve the PARENT too, so a not-yet-created output path cannot sit under a junctioned parent.
  const parent = realOrSelf(resolve(real, '..'))
  const parentRoot = ctx.workspaceReal.endsWith(sep) ? ctx.workspaceReal : ctx.workspaceReal + sep
  return parent === ctx.workspaceReal || parent.startsWith(parentRoot)
}

/**
 * Refuses any argument that even looks like a traversal, before resolution.
 *
 * Belt to the braces of `insideWorkspace`. A raw `..` in a path argument is worth refusing
 * outright rather than normalising, because normalising is what silently turns an escape attempt
 * into a valid-looking in-workspace path.
 */
function rejectTraversal(arg: string): string | undefined {
  const parts = arg.replace(/[\\/]+/g, '/').split('/')
  if (parts.includes('..')) return `the argument "${arg}" contains a ".." path segment`
  if (/^[A-Za-z]:/.test(arg) && !isAbsolute(arg.replace(/\//g, sep))) {
    return `the argument "${arg}" is an unresolvable drive-relative path`
  }
  return undefined
}

// ============================================================ refused programs

/**
 * Refused outright, with the reason, because each of these converts a validated argument list back
 * into a string it will re-parse, or can prompt, or can install.
 *
 * Kept as an explicit list rather than a pattern so a new dangerous program is refused by default:
 * it is simply not on the allowlist, and this list exists to explain the refusal to a human.
 */
export const REFUSED_PROGRAMS: Readonly<Record<string, string>> = {
  'cmd.exe': 'cmd re-parses its argument as a command string, so the argv this policy validated would not be the argv that runs',
  'powershell.exe': 'PowerShell re-parses its argument as a script, which defeats argument validation',
  'pwsh.exe': 'PowerShell re-parses its argument as a script, which defeats argument validation',
  'bash.exe': 'a shell re-parses its arguments, which defeats argument validation',
  'sh.exe': 'a shell re-parses its arguments, which defeats argument validation',
  'wsl.exe': 'starts a Linux environment whose filesystem and process rules are entirely outside this policy',
  'mshta.exe': 'executes script from a string, which defeats argument validation',
  'wscript.exe': 'executes script files and can be driven to network activity',
  'cscript.exe': 'executes script files and can be driven to network activity',
  'rundll32.exe': 'loads and runs arbitrary exported functions',
  'reg.exe': 'modifies the registry',
  'sc.exe': 'creates or modifies system services',
  'net.exe': 'manages shares, users and network resources',
  'netsh.exe': 'reconfigures networking and firewall rules',
  'takeown.exe': 'changes file ownership',
  'icacls.exe': 'changes file permissions',
  'attrib.exe': 'changes file attributes',
  'cipher.exe': 'can encrypt or wipe data outside the workspace',
  'bcdedit.exe': 'modifies boot configuration',
  'schtasks.exe': 'creates scheduled tasks that outlive the mission',
  'ssh.exe': 'can prompt for a passphrase or password and would hold the mission open',
  'sftp.exe': 'can prompt for a credential',
  'scp.exe': 'can prompt for a credential',
  'plink.exe': 'can prompt for a credential',
  'sudo.exe': 'prompts for elevation',
  'runas.exe': 'prompts for a credential',
  'gpg.exe': 'prompts for a passphrase',
  'curl.exe': 'performs network egress, which this policy does not restrict',
  'wget.exe': 'performs network egress, which this policy does not restrict',
  'winget.exe': 'installs software, which changes the machine beyond the workspace and runs vendor install scripts',
  'choco.exe': 'installs software, which changes the machine beyond the workspace and runs vendor install scripts',
  'scoop.ps1': 'installs software, which changes the machine beyond the workspace and runs vendor install scripts',
  'npm.exe': 'runs install scripts, which execute arbitrary downloaded code',
  'pip.exe': 'installs packages and runs their build steps',
  'taskkill.exe': 'terminates processes outside the workspace',
}

// ============================================================ the git consequence table

/**
 * git subcommands that DESTROY work. Classified as `delete` because that is what they do to the
 * user's repository, and `recoverable: false` is the honest answer for `reset --hard` and `clean`.
 */
const GIT_DESTRUCTIVE: Readonly<Record<string, string>> = {
  'clean': 'deletes untracked files and directories',
  'reset': 'moves HEAD, discarding commits and uncommitted changes',
  'checkout': 'overwrites the working tree, discarding local changes',
  'restore': 'overwrites working-tree files with other content',
  'switch': 'overwrites the working tree, discarding local changes',
  'branch': 'with -D deletes a branch and its unmerged work',
  'stash': 'with drop/clear discards stashed work',
  'filter-branch': 'rewrites history, invalidating every existing clone',
  'gc': 'with --prune can make unreachable objects unrecoverable',
}

/** git subcommands that SEND data to a remote. */
const GIT_SENDS: Readonly<Record<string, string>> = {
  'push': 'sends commits to a remote',
  'fetch': 'writes remote content into the local object store',
  'pull': 'merges remote content into the working tree',
  'submodule': 'can fetch and execute code from a remote',
  'remote': 'can add or change a remote, redirecting where a later push goes',
}

// ============================================================ the allowlist itself

/**
 * node: run a script from inside the workspace.
 *
 * `node -e` and `node -p` are REFUSED. They take a string of code, which is precisely the
 * command-string problem the shells are refused for; allowing them would make the allowlist
 * meaningless while appearing to honour it.
 *
 * The script is a workspace file, so running it is running workspace content. That is the intended
 * capability - it is also why it is classified `consequential` and gated: the mission authors the
 * script, and a human authorises the run. See `LIMITATIONS` for what that does and does not mean.
 */
function classifyNode(argv: readonly string[], ctx: PolicyContext): Verdict | undefined {
  if (argv.length === 0) return block('node needs a script path')
  const script = argv[0]
  if (script === '-e' || script === '--eval' || script === '-p' || script === '--print' || script === '-') {
    return block(
      `refused: "node ${script}" takes code as a STRING, which is the same command-string problem ` +
      `the shells are refused for - the argv validated here would not be the code that runs. ` +
      `Write the code to a script file inside the workspace and run that instead.`,
    )
  }
  if (script === '--version' || script === '-v') return { kind: 'allow', note: 'reporting the version' }
  if (!insideWorkspace(ctx, script)) {
    return block(`refused: the script "${script}" resolves outside the workspace ${ctx.workspace}`)
  }
  if (!existsSync(resolve(ctx.workspace, script))) {
    return block(`refused: the script "${script}" does not exist`)
  }
  // A script IS workspace-authored code, so running it is gated like any other consequential act.
  return {
    kind: 'consequential',
    effect: {
      kind: 'install',
      target: resolve(ctx.workspace, script),
      reason: `execute the workspace script ${script} (workspace-authored code, run as the user)`,
      irreversible: true,
    },
    note: 'runs workspace-authored code as the user; no OS isolation is applied to it or its children',
  }
}

/**
 * git: read-only subcommands are allowed outright; anything that destroys work or talks to a
 * remote is consequential and gated.
 *
 * Flags are scanned for the path-bearing ones, because a subcommand check alone would let
 * `git -C C:\somewhere-else status` read a repository outside the workspace. That is why this is
 * argv-shaped data rather than a name test.
 */
function classifyGit(argv: readonly string[], ctx: PolicyContext): Verdict | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const traversal = rejectTraversal(a)
    if (traversal) return block(`refused: ${traversal}`)

    if (a === '-C' || a === '--git-dir' || a === '--work-tree' || a === '--namespace') {
      const next = argv[i + 1]
      if (next === undefined) return block(`refused: ${a} was given no value`)
      if (!insideWorkspace(ctx, next)) {
        return block(`refused: ${a} "${next}" points outside the workspace ${ctx.workspace}`)
      }
      i++
      continue
    }
    // Everything after `--` is a pathspec and must be in the workspace.
    if (a === '--') {
      for (const p of argv.slice(i + 1)) {
        if (!insideWorkspace(ctx, p)) {
          return block(`refused: the pathspec "${p}" resolves outside the workspace ${ctx.workspace}`)
        }
      }
      break
    }
    // A bare leading path argument, as in `git diff some\file`.
    if (!a.startsWith('-') && i === 0 && !GIT_READONLY.has(a.toLowerCase())) {
      if (!insideWorkspace(ctx, a)) {
        return block(`refused: the path argument "${a}" resolves outside the workspace ${ctx.workspace}`)
      }
    }
  }

  const sub = argv.find((a) => !a.startsWith('-'))?.toLowerCase()
  if (sub === undefined) return block('git needs a subcommand')

  if (GIT_SENDS[sub]) {
    return {
      kind: 'consequential',
      effect: {
        kind: 'external-send',
        target: sub,
        reason: `git ${sub} ${GIT_SENDS[sub]}`,
        irreversible: true,
      },
      note: GIT_SENDS[sub],
    }
  }
  if (GIT_DESTRUCTIVE[sub]) {
    return {
      kind: 'consequential',
      effect: {
        kind: 'delete',
        target: sub,
        reason: `git ${sub} ${GIT_DESTRUCTIVE[sub]}`,
        irreversible: true,
      },
      note: GIT_DESTRUCTIVE[sub],
    }
  }
  if (GIT_READONLY.has(sub)) return { kind: 'allow', note: `read-only: git ${sub}` }
  return block(
    `refused: "git ${sub}" is not on the read-only list and is not classified as a known ` +
    `consequence, so refusing it is the safe answer. Add it deliberately rather than by pattern.`,
  )
}

/** git subcommands that only read. Measured to be non-interactive and local. */
const GIT_READONLY = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree',
  'blame', 'describe', 'cat-file', 'shortlog', 'name-rev', 'for-each-ref', 'check-ignore',
])

/**
 * The allowlist. Absolute paths only.
 *
 * Every entry was checked to exist on this machine. A program absent here is not an error to work
 * around - it is a capability that is not available, and the refusal says so.
 */
export function buildAllowlist(systemRoot: string, programFiles: string): readonly AllowedProgram[] {
  return [
    { abs: `${programFiles}\\nodejs\\node.exe`, name: 'node.exe', classify: classifyNode },
    { abs: `${programFiles}\\Git\\cmd\\git.exe`, name: 'git.exe', classify: classifyGit },
    // Present only to be explained. Listed so the refusal has a reason to give.
    { abs: `${systemRoot}\\System32\\cmd.exe`, name: 'cmd.exe', classify: () => block(REFUSED_PROGRAMS['cmd.exe']) },
  ]
}

/**
 * Classifies a requested command.
 *
 * Order matters: the refusal table is consulted before the allowlist, so a shell cannot be reached
 * even by being added to the allowlist later by mistake.
 */
export function classify(
  absExe: string,
  argv: readonly string[],
  allowlist: readonly AllowedProgram[],
  ctx: PolicyContext,
): Verdict {
  const base = absExe.split(/[\\/]/).pop() ?? absExe
  const refusal = REFUSED_PROGRAMS[base.toLowerCase()]
  if (refusal) {
    return block(`refused: "${base}" is not permitted - ${refusal}`)
  }

  const program = allowlist.find((p) => p.abs.toLowerCase() === absExe.toLowerCase())
  if (!program) {
    return block(
      `refused: "${absExe}" is not on the executable allowlist. Nothing outside the allowlist ` +
      `runs, and no shell is reachable, so there is no command-string path into the machine.`,
    )
  }

  // Every argument, not just the ones we know are paths: an unparsed argument is not a safe one.
  for (const a of argv) {
    const traversal = rejectTraversal(a)
    if (traversal) return block(`refused: ${traversal}`)
  }

  const verdict = program.classify(argv, ctx)
  if (verdict === undefined) {
    return block(`refused: the arguments for "${program.name}" were not understood, and an unparsed argument list is not a safe one`)
  }
  return verdict
}

// ============================================================ runtime output classification

/**
 * Patterns that mean a process is asking a human for something.
 *
 * A heuristic, and used as one: it can only turn a `failed` into a `needs-human`, so it can never
 * make an unauthorised action look authorised. Getting it wrong costs a clearer error message. That
 * asymmetry is the reason a heuristic is acceptable here at all.
 */
const CREDENTIAL_PROMPT = [
  /password\s*:/i,
  /passphrase/i,
  /enter.*otp|one-?time (code|password)/i,
  /verification code/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /press any key/i,
  /are you sure you want to continue/i,
  /username\s*:/i,
  /two-factor|2fa/i,
]

/** Whether captured output looks like a request for human input. */
export function looksLikeCredentialPrompt(stdout: string, stderr: string): string | undefined {
  const text = `${stdout}\n${stderr}`
  for (const re of CREDENTIAL_PROMPT) {
    if (re.test(text)) return `the process output matches a human-input pattern (${re.source})`
  }
  return undefined
}

// ============================================================ environment policy

/**
 * The variables a spawned process receives.
 *
 * MEASURED, not assumed. On this machine a child launched with exactly `{PATH, SystemRoot, TEMP}`
 * received eleven variables: these three plus `HOMEDRIVE, HOMEPATH, LOGONSERVER, SYSTEMDRIVE,
 * USERDOMAIN, USERNAME, USERPROFILE, WINDIR`. The extra eight are injected by the Windows loader
 * and are not under this policy's control - the parent cannot suppress them by narrowing `env`.
 *
 * So this is a real reduction (an `AWS_SECRET_ACCESS_KEY` or a bearer token in the parent's
 * environment does NOT reach the child - measured) and it is NOT a closed set. Reporting it as
 * either "the environment is sanitised" or "the environment is inherited" would be wrong in both
 * directions.
 */
export const ENV_ALLOWLIST = ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'SystemDrive', 'COMSPEC'] as const

export function buildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const k of ENV_ALLOWLIST) {
    const v = source[k]
    if (typeof v === 'string' && v.length > 0) out[k] = v
  }
  return out
}

/**
 * WHAT THIS POLICY DOES NOT DO. Read this before calling any of the above a sandbox.
 *
 * NOT RESTRICTED, because nothing here can restrict it:
 *   - reading or writing any file the user can reach, anywhere on any drive
 *   - network egress, outbound or inbound
 *   - spawning child processes, at any depth; those children are not re-validated and do not
 *     inherit the allowlist's intent
 *   - the registry, services, scheduled tasks, WMI, DCOM, or any other Windows control surface
 *   - loading DLLs, which means executing code this policy has never seen
 *   - writing to its own working directory, including deleting what is there
 *
 * GENUINELY ENFORCED, and the whole of it:
 *   - which program starts, by absolute path
 *   - which arguments it is given, for path-bearing arguments
 *   - how long it may run, and that its process tree is reaped on timeout
 *   - which environment variables it starts with
 *
 * RESIDUAL RISK, stated plainly: a permitted program that is allowed to run arbitrary workspace
 * code (`node script.js`) can do anything the user can. The allowlist restricts WHICH program is
 * chosen; it does not restrict WHAT that program then does. That is the honest boundary, and it
 * is why running a script is classified consequential and requires authorisation rather than
 * treated as routine.
 */
export const LIMITATIONS = [
  'No OS-level isolation: no Job Object, AppContainer, restricted token, or container.',
  'A permitted process runs as the user and is not contained by this policy.',
  'Child processes are not individually validated and are not governed by the allowlist.',
  'Network access is not restricted; no permitted program is a network client by design, but nothing stops one from becoming one.',
  'Environment is reduced, not sealed: the Windows loader adds eight variables that the parent cannot suppress.',
  'The allowlist bounds which program runs, not what that program may then do.',
] as const
