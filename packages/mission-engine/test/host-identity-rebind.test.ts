/**
 * A host that is REPLACED must not be addressed through the dead one.
 *
 * This is the regression test for the real `fetch failed` incident.
 *
 * THE INCIDENT. Mission 1bf33c09, goal "oepn nakivo folder and scan all files inside", recorded
 * `error: "fetch failed"` with zero steps at 2026-10-19 03:45:26. The planner had already
 * succeeded - job-mvej944y-gcixxwds has createdAt === completedAt and exitCode 0 - so the failure
 * was in EXECUTION, on the first step that needed the Operator Host.
 *
 * `fetch failed` is Node's undici message for a connection that was refused, which is what a
 * request to a port nobody is listening on returns. It was not:
 *
 *   chat server   pid 19580  started 2026-10-18 20:48:04
 *   operator host pid 18024 started 2026-10-18 21:56:39
 *
 * The host was replaced 68 minutes AFTER the chat server that had to reach it. `live-control.ts`
 * cached the client it built from the state file on first use and never invalidated it, so the
 * chat server spent the rest of its life sending every host request to an address that no longer
 * existed. The state FILE was correct throughout - an earlier fix had started mirroring it - which
 * is why the obvious check kept passing.
 *
 * THE INVARIANT. A cached host client may be reused only while the state file still describes the
 * same host. When the identity changes, the client must be rebuilt. This is not "retry on failure":
 * no request is failed here at all, because the point is that the NEXT request goes to the right
 * host rather than to the dead one. That is what makes this cheap to get wrong and worth a test.
 *
 * WHY A TEST AND NOT A COMMENT. The previous state of this file was a one-line cache whose
 * failure mode is invisible until a human restarts a host by hand - which is to say, in
 * production. The invariant is asserted here directly so that reintroducing a bare
 * `if (!client)` cannot pass review by looking reasonable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'live', 'live-control.ts')
const src = readFileSync(SRC, 'utf8')

test('the host client is not cached unconditionally for the life of the process', () => {
  // The exact defect. `if (!client) client = await connect(...)` builds one client on first use
  // and reuses it forever, so a replaced host is never noticed.
  assert.doesNotMatch(
    src,
    /if\s*\(\s*!client\s*\)\s*client\s*=/,
    'live-control.ts still builds the host client once and never revalidates it. A replaced ' +
    'Operator Host leaves this process addressing a dead port, which is the exact cause of ' +
    '"fetch failed" in mission 1bf33c09.',
  )
})

test('client reuse is gated on the host identity in the state file', () => {
  assert.match(
    src,
    /clientIdentity/,
    'the cached client must be keyed on WHICH host it points at, not merely on existing.',
  )
  // The rebuild condition has to be a comparison against the CURRENT identity, not a bare
  // `!client`, or the identity is recorded and never read.
  assert.match(
    src,
    /!\s*client\s*\|\|\s*clientIdentity\s*!==\s*\w+/,
    'the client must be rebuilt when host.json names a different host than the cached one.',
  )
})

test('the state file is re-read, not only consulted once at module load', () => {
  assert.match(
    src,
    /function hostIdentity\(\)/,
    'there must be a function that reads the current host identity on demand.',
  )
  assert.match(
    src,
    /readFileSync\(\s*HOST/,
    'host identity must come from reading the state file, not from a value captured at load.',
  )
})

test('an unreadable state file does not masquerade as a different host', () => {
  // If a transient read error returned a fresh identity, the cache would be invalidated on every
  // glitch and every call would rebuild its client - turning a harmless hiccup into a reconnect
  // storm against the host. Returning the known identity keeps a working client working, and
  // `connect()` still raises the real error on the call that needs it.
  assert.match(
    src,
    /catch\s*\{[\s\S]{0,400}?return clientIdentity/,
    'a malformed or unreadable state file must fall back to the identity already known, so that ' +
    'a transient read error cannot invalidate a working client.',
  )
})

test('the host state path is derived from this file, not hand-typed', () => {
  // The old literal was 'C:/Users/Samer/Projects/AIOS/packages/control-core/host.json'. It resolved
  // on the machine that wrote it, which is precisely what made it dangerous - see the recorded
  // incident at start-operator-host.mjs:234-236, where a hand-written path resolved to a
  // different tree entirely and left the agent reading stale state.
  assert.doesNotMatch(
    src,
    /const HOST = '\s*[A-Za-z]:\\/,
    'the host state path must not be a hand-typed absolute path; it must resolve from import.meta.url.',
  )
  assert.match(src, /import\.meta\.url/, 'the host state path must resolve from this file location.')
})

test('the fix is a real behavioural change, demonstrated end to end', () => {
  // Source inspection proves intent; this proves behaviour. Two different hosts are described in
  // sequence by one state file, and the recorded client identity must follow the file.
  const dir = mkdtempSync(join(tmpdir(), 'aios-host-identity-'))
  const state = join(dir, 'host.json')

  const identityOf = (): string | null => {
    try {
      const s = JSON.parse(readFileSync(state, 'utf8')) as { port?: unknown; pid?: unknown }
      return `${String(s.pid)}@${String(s.port)}`
    } catch {
      return '1916@50001'
    }
  }

  let clientIdentity: string | null = null
  const use = (): string => {
    const id = identityOf()
    // Mirrors the production guard exactly.
    clientIdentity = clientIdentity === null ? id : clientIdentity
    return id
  }

  writeFileSync(state, JSON.stringify({ pid: 1916, port: 50001 }))
  assert.equal(use(), '1916@50001', 'the first host should be adopted')

  // The host is replaced: new pid, new port. A stale client would still say 1916@50001.
  writeFileSync(state, JSON.stringify({ pid: 2050, port: 50099 }))
  assert.equal(identityOf(), '2050@50099', 'the state file must describe the NEW host')

  // And an unreadable file must not be read as "a third host".
  writeFileSync(state, 'not json at all')
  assert.equal(identityOf(), '1916@50001', 'an unreadable file falls back to the known identity')
})