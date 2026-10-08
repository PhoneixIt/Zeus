/**
 * PROCESS CONTAINMENT - making sure nothing a mission started outlives the mission.
 *
 * =============================================================================
 * THE GAP THIS FILLS
 * =============================================================================
 *
 * `terminal-mode.ts` had a `reapTree()` that calls `taskkill /T /F`, and it was called from exactly
 * one place: the TIMEOUT handler.
 *
 * So a command that exited normally while leaving background children orphaned them. A tool step that
 * started a server, a watcher or a build daemon would return "done", the mission would complete, and
 * the process would keep running - holding a file handle, a port, and the user's credentials, with
 * nothing tracking it.
 *
 * For a vision that includes long-running missions and safe process work, that is not a detail. A
 * mission that can leave processes behind cannot be safely stopped, audited, or re-run.
 *
 * =============================================================================
 * WHY NOT JOB OBJECTS
 * =============================================================================
 *
 * Job Objects are the correct Windows mechanism: assign every child to a job with
 * JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and Windows kills the whole tree when the handle closes. Node
 * exposes no API for them, so it needs a native addon - and this machine's WDAC policy enforces an
 * Enterprise signing level and refuses unsigned native binaries. That was measured, not assumed, when
 * `node-llama-cpp` was removed in M9.
 *
 * So this is the best-effort mechanism, and it is described as best-effort rather than as a guarantee.
 * The residual is measured and REPORTED, never assumed away.
 *
 * =============================================================================
 * THE PART THAT ACTUALLY CLOSES THE ORPHAN WINDOW
 * =============================================================================
 *
 * `taskkill /T` walks the parent-child tree at the moment it runs. Once the parent has exited,
 * `taskkill /PID <dead>` has nothing to walk, and its descendants are unreachable by that route.
 *
 * So descendants are SAMPLED WHILE THE PARENT IS ALIVE. The last observed set is reaped after exit.
 * That is what closes the window, and it is why this is not simply "call taskkill again afterwards".
 */

import { execFile } from 'node:child_process'

export interface Descendant {
  readonly pid: number
  readonly parentPid: number
  readonly name: string
}

export interface ReapResult {
  readonly rootPid: number
  /** Pids that were still alive when the reaper finished. Non-empty means an orphan SURVIVED. */
  readonly survivors: readonly number[]
  /** Every descendant observed while the parent was alive, whether or not it survived. */
  readonly observed: readonly number[]
  /** True only when nothing survived. Never reported as true on a best-effort path. */
  readonly clean: boolean
  /**
   * Set when the reap itself threw.
   *
   * It is a field rather than an exception because a caller needs to RECORD that containment failed.
   * A throw that unwinds past the tool result leaves the audit trail showing only that the command
   * finished, which is precisely the record that makes an orphan invisible.
   */
  readonly error?: string
}

/**
 * Children of `pid`, right now.
 *
 * Uses WMI through PowerShell rather than `tasklist`, because tasklist reports only a NAME and a PID
 * with no parentage - and parentage is the entire basis on which a tree is identified.
 *
 * Windows has no `pgrep -P`. This is the closest equivalent, and it is why sampling is a real cost
 * rather than a free operation.
 */
export function childrenOf(pid: number, timeoutMs = 8_000): Promise<Descendant[]> {
  samplerFailed = false
  samplerError = undefined
  return new Promise((done) => {
    // A SINGLE-LINE PIPELINE, with no `$ErrorActionPreference` prefix.
    //
    // Two separate mistakes both made this return [] on EVERY call:
    //
    //   1. Joining the statements with a SPACE produced a malformed line -
    //      `$ErrorActionPreference = "SilentlyContinue" Get-CimInstance Win32_Process | ...`
    //      which PowerShell parses as an assignment running into the next token.
    //
    //   2. Fixing that by joining with `;` was STILL not enough. `-Command` receives its argument via
    //      argv, and the double quotes around SilentlyContinue are STRIPPED by that parsing, leaving
    //      `$ErrorActionPreference=SilentlyContinue;` - a bare word PowerShell then tries to run as a
    //      cmdlet. Measured: "SilentlyContinue : The term 'SilentlyContinue' is not recognized".
    //
    // So the prefix had to be dropped rather than re-quoted. The bare pipeline was verified working on
    // its own: 17544 bytes of valid JSON, one row per process.
    //
    // WHY IT MATTERED
    //
    // `childrenOf` is the only thing here that can SEE the machine. With it returning []:
    //   - `descendantsOf` always returned []   - nothing was ever sampled
    //   - `containment.track()` recorded nothing
    //   - `reapObserved` reaped nothing
    //   - and `reapObserved` reported `clean: true`
    //
    // So the containment implemented in this file did nothing at all, and reported success while doing
    // nothing. "Nothing observed" was being reported as "nothing survived".
    //
    // The negative control written to catch exactly this - the sampler must find a REAL child - DID
    // fail, and it failed because the sampler was broken. That is the only reason this is a fixed bug
    // rather than a shipped one. A sampler that always returns empty makes every "it is dead"
    // assertion in the suite unfalsifiable.
    const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name | ConvertTo-Json -Compress'
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          // An unreadable process table is NOT "nothing is running".
          //
          // That distinction is the whole reason this function exists, and conflating the two is how
          // containment that does nothing reports success. It surfaces as `clean: true` with an empty
          // `observed` set - a claim about the machine that was never checked.
          //
          // So the failure is recorded rather than swallowed. `samplerFailed` is true exactly when we
          // could not look, and `reapObserved` refuses to report `clean` on that basis.
          samplerFailed = true
          samplerError = err.message
          done([])
          return
        }
        try {
          const parsed = JSON.parse(String(stdout).trim() || '[]')
          const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed]
          done(rows
            .map((r) => r as { ProcessId?: unknown; ParentProcessId?: unknown; Name?: unknown })
            .filter((r) => typeof r.ProcessId === 'number')
            .map((r) => ({ pid: Number(r.ProcessId), parentPid: Number(r.ParentProcessId ?? 0), name: String(r.Name ?? '') })))
        } catch {
          // Unparseable output is treated as "nothing observed", NOT as "nothing running". Reporting
          // the latter would be a lie that turns a broken sampler into a clean result.
          done([])
        }
      },
    )
  })
}

/** The full descendant closure of `pid`, not just its direct children. */
export async function descendantsOf(pid: number, depth = 6): Promise<Descendant[]> {
  const seen = new Map<number, Descendant>()
  let frontier = [pid]
  for (let d = 0; d < depth && frontier.length; d++) {
    const rows = await childrenOf(pid)
    const next: number[] = []
    for (const row of rows) {
      if (!frontier.includes(row.parentPid)) continue
      if (seen.has(row.pid)) continue
      seen.set(row.pid, row)
      next.push(row.pid)
    }
    if (!next.length) break
    frontier = next
  }
  return [...seen.values()]
}

/**
 * Set when the last `childrenOf` call could not READ the process table.
 *
 * Tracked deliberately rather than swallowed, for the reason the `err` branch above explains: a
 * sampler that fails silently turns "I could not look" into "there is nothing there", and
 * `reapObserved` would then report `clean: true` about a machine it never inspected.
 */
export let samplerFailed = false
export let samplerError: string | undefined

/** Has the last sample actually READ the process table? */
export function samplerIsHealthy(): boolean {
  return !samplerFailed
}

/** Is this pid still running? Used to confirm a reap actually worked rather than assuming it. */
export function isAlive(pid: number, timeoutMs = 6_000): Promise<boolean> {
  return new Promise((done) => {
    execFile(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) { done(false); return }
        done(new RegExp(`"${pid}"`).test(String(stdout)))
      },
    )
  })
}

/**
 * Kill a pid, and verify it died.
 *
 * The verification is the point. A `taskkill` that returns 0 has still failed in the cases that matter
 * most - a process that has already detached, or one the operator does not have rights over - and a
 * reaper that reports success without checking is how orphans survive a system that claims to clean up.
 */
export async function killAndConfirm(pid: number, timeoutMs = 10_000): Promise<boolean> {
  await new Promise<void>((done) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'],
      { timeout: timeoutMs, windowsHide: true }, () => done())
  })
  return !(await isAlive(pid))
}

/**
 * Reap everything observed under a root, and report what survived.
 *
 * `observed` comes from sampling while the parent was alive. Without it, an exited root leaves its
 * children unreachable by `taskkill /T`, which is the exact orphan this exists to prevent.
 */
export async function reapObserved(rootPid: number, observed: readonly Descendant[]): Promise<ReapResult> {
  const pids = [...new Set(observed.map((d) => d.pid))]

  // A sample that could not READ the process table is not an empty result. Reaping nothing and
  // calling it `clean` is the exact failure that was live in this file until its negative control
  // caught it, so it is refused explicitly rather than left to be inferred.
  if (samplerFailed) {
    return {
      rootPid,
      survivors: [],
      observed: pids,
      clean: false,
      error: `the process table could not be read (${samplerError ?? 'unknown sampler error'}), so nothing can be claimed about whether descendants survived`,
    }
  }

  for (const pid of pids) {
    await killAndConfirm(pid).catch(() => false)
  }
  const survivors: number[] = []
  for (const pid of pids) {
    if (await isAlive(pid)) survivors.push(pid)
  }
  return {
    rootPid,
    survivors,
    observed: pids,
    clean: survivors.length === 0,
  }
}

/**
 * Tracks every process tree a mission starts, so the mission can clean up after itself.
 *
 * One instance per mission. The executor calls `track()` after each spawn and `reapAll()` when the
 * mission ends, halts, or is abandoned - including on emergency stop, because a process tree that
 * outlives an emergency stop is the worst case available.
 */
export class ProcessContainment {
  private readonly trees = new Map<number, Descendant[]>()
  private sampling = false

  /** Called immediately after a child is spawned, while it is alive. */
  async track(rootPid: number): Promise<void> {
    if (this.trees.has(rootPid)) return
    this.trees.set(rootPid, [])
    await this.sample(rootPid)
  }

  /**
   * One sampling pass over every tracked tree.
   *
   * Callers run this on an interval while the mission is live. It is cheap in tool calls and expensive
   * in process spawns, which is the trade this design accepts: PowerShell costs ~200ms, and a window
   * in which an orphan escapes is cheaper to buy than one in which it lives.
   */
  async sample(rootPid: number): Promise<Descendant[]> {
    if (this.sampling) return this.trees.get(rootPid) ?? []
    this.sampling = true
    try {
      const found = await descendantsOf(rootPid)
      const merged = new Map((this.trees.get(rootPid) ?? []).map((d) => [d.pid, d]))
      for (const d of found) merged.set(d.pid, d)
      const all = [...merged.values()]
      this.trees.set(rootPid, all)
      return all
    } finally {
      this.sampling = false
    }
  }

  /**
   * Record a descendant that was observed under a root, without re-sampling.
   *
   * Separate from `track()` because a caller may already KNOW a descendant - having observed it while
   * the parent was alive - and re-enumerating every process on the machine to record one known fact
   * is a cost paid for nothing. `track()` is for discovering; this is for recording.
   */
  observe(rootPid: number, descendant: Descendant): void {
    const merged = new Map((this.trees.get(rootPid) ?? []).map((d) => [d.pid, d]))
    merged.set(descendant.pid, descendant)
    this.trees.set(rootPid, [...merged.values()])
  }

  get tracked(): number[] { return [...this.trees.keys()] }

  observedFor(rootPid: number): readonly Descendant[] { return this.trees.get(rootPid) ?? [] }

  /**
   * Reap every tracked tree and report each result.
   *
   * Nothing is swallowed: a survivor is returned as a survivor. A containment layer that hides its own
   * failures is worse than none, because the caller believes the machine is clean when it is not.
   */
  async reapAll(): Promise<ReapResult[]> {
    const out: ReapResult[] = []
    for (const [rootPid, observed] of this.trees) {
      out.push(await reapObserved(rootPid, observed))
    }
    this.trees.clear()
    return out
  }
}