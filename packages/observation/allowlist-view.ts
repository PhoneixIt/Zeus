/**
 * A DATA-ONLY VIEW OF THE TERMINAL ALLOWLIST.
 *
 * This file exists so the observer can answer "would the policy permit this program?" without
 * importing `terminal-policy.ts` itself.
 *
 * WHY THE INDIRECTION, GIVEN IT COSTS A FILE
 *
 * `terminal-policy.ts` also exports `classify`, which builds a policy context, and `buildEnv`, which
 * reads the parent environment. Neither is dangerous, but a module that both answers questions about
 * programs and can decide what to run is one whose import graph makes "the observer cannot act"
 * harder to verify by reading.
 *
 * So the two tables are extracted here, and `terminal-policy.ts` imports THEM rather than the other
 * way round. The dependency points from the policy to the data, which is the direction that keeps the
 * observer at the passive end.
 *
 * There is exactly one copy of each table. A second copy would be a second thing to keep in step,
 * and a stale copy would make the observer describe a policy that no longer exists - the observer
 * would be confidently wrong, which is the failure mode that matters most here.
 */

/**
 * The programs the terminal policy refuses, and why.
 *
 * `as const` on the VALUE, not just the type. Without it, `REFUSED_PROGRAMS[name]` is typed
 * `string | undefined` only because of the annotation - and the moment a consumer destructures or
 * spreads the table, TypeScript can lose the index signature and the identifier stops existing at
 * runtime for a re-exported binding. That is exactly what happened: `terminal-policy.ts` re-exported
 * this name, and every consumer of the policy saw `REFUSED_PROGRAMS is not defined`.
 */
export const REFUSED_PROGRAMS = {
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
} as const satisfies Readonly<Record<string, string>>

/** The refusal reasons, for a caller that wants them as a list rather than a lookup. */
export type RefusedProgram = keyof typeof REFUSED_PROGRAMS

/**
 * The allowlist, as data: absolute paths only.
 *
 * `cmd.exe` is here on purpose. It is refused by `REFUSED_PROGRAMS`, and having it in the table is
 * what lets the ordering test prove the refusal table is consulted BEFORE the allowlist rather than
 * after it.
 */
export function buildAllowlist(systemRoot: string, programFiles: string): readonly { abs: string; name: string }[] {
  return [
    { abs: `${programFiles}\\nodejs\\node.exe`, name: 'node.exe' },
    { abs: `${programFiles}\\Git\\cmd\\git.exe`, name: 'git.exe' },
    { abs: `${systemRoot}\\System32\\cmd.exe`, name: 'cmd.exe' },
  ]
}

/**
 * The same refusal table, viewed as a lookup by runtime program name.
 *
 * `REFUSED_PROGRAMS` is `as const`, so its type is a fixed set of literal keys. That is deliberate -
 * it is what lets a compiler catch a misspelled program name - but it also means the table cannot be
 * indexed by a plain `string`, which is the only way either consumer actually uses it: given a path
 * off a live command line, look up the base name.
 *
 * Both `terminal-policy.ts` and `observation/local.ts` index this table with a runtime name, and both
 * were failing to typecheck for exactly this reason. Each was about to grow its own private view; this
 * is the single definition instead, so the two consumers cannot disagree about what is refused.
 *
 * It is the SAME OBJECT with a widened type - not a copy - so a name refused in one place is refused in
 * the other by construction rather than by two edits kept in step.
 */
export const REFUSED_BY_NAME: Readonly<Record<string, string>> = REFUSED_PROGRAMS
