/**
 * STRUCTURAL AUDIT: is every injection route actually governed?
 *
 * WHY THIS EXISTS
 *
 * Governance in this control core used to be a convention. Each route that could inject
 * remembered to call `Guard.MayInject()` near the top of its own block. Two did not:
 *
 *   /scaninput   SendInput with dwExtraInfo = 0
 *   /wmchar      PostMessage(WM_CHAR)
 *
 * Nothing failed. No test went red, no request was refused, and there was no symptom to notice.
 * They were found by reading the dispatch table, which is exactly the situation where a
 * convention is worse than useless: it looks like a boundary and is not one.
 *
 * There is now a single gate at the dispatch head, driven by the `InjectionRoutes` table, so a
 * route cannot be live-and-ungated. But a table plus a gate is only as good as the claim that
 * the table is COMPLETE, and completeness is the one thing a reader cannot check by looking at
 * the table. So this parses the source instead.
 *
 * THE ANALYSIS IS TRANSITIVE, AND THAT MATTERS
 *
 * The first version of this audit reported `SendInput` at four sites as UNGOVERNED, because
 * those calls live in the `Click()` and `MoveAbsolute()` helper methods rather than inside a
 * route block - so brace nesting could not connect them to a route. It simultaneously reported
 * `/click`, `/type`, `/scroll`, `/key`, `/move`, `/click-absolute` and `/vstype` as "declared
 * but injecting nothing", which was false: they inject through those helpers.
 *
 * Both halves of that output were wrong in opposite directions and would have been acted on.
 * So the audit now resolves helper methods: a helper that contains a primitive is itself an
 * injection site, and every route that calls it inherits that status.
 *
 * THE DEFAULT IS DENIAL
 *
 * A route that reaches an injection primitive - directly or through a helper - and is NOT in
 * `InjectionRoutes` is reported UNGOVERNED. Adding an injecting route without declaring it
 * fails this audit; the previous arrangement failed silently.
 *
 * Run: node packages/control-core/audit-injection-routes.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Every call that can change the machine's state.
 *
 * THE COMMENT USED TO BE A CLAIM THAT WAS FALSE. It said "every call that can change the machine's
 * state" above a list containing only INPUT-INJECTION primitives. Window management was not in it,
 * and that omission is why `/show`, `/restore` and `/focus` were reported as governed for years:
 * they reach no injection primitive, so this audit had nothing to say about them, and a passing audit
 * was read as "everything is gated" when what it actually meant was "everything that injects is gated".
 *
 * A human watching the screen lose focus is affected by machine state exactly as much as one watching
 * a keystroke arrive. Both belong here.
 */
const PRIMITIVES = [
  // ---- input into the machine
  { re: /\bWin\.SendInput\s*\(/g, kind: 'SendInput', acts: 'hardware input' },
  { re: /\bHooks\.SendProbe\s*\(/g, kind: 'SendProbe', acts: 'instrument self-test' },
  { re: /\bWin\.PostMessage\s*\(/g, kind: 'PostMessage', acts: 'direct window message' },
  { re: /\bUia\.Invoke\s*\(/g, kind: 'Uia.Invoke', acts: 'UI Automation invoke (no input event)' },
  { re: /\bUia\.SetValue\s*\(/g, kind: 'Uia.SetValue', acts: 'UI Automation value write' },
  { re: /\bUia\.Focus\s*\(/g, kind: 'Uia.Focus', acts: 'UI Automation focus change' },
  // ---- WINDOW AND DESKTOP STATE (added M14). No input is emitted; the machine still changes.
  { re: /\bWin\.ShowWindow\s*\(/g, kind: 'ShowWindow', acts: 'window show/hide/minimise/maximise/restore' },
  { re: /\bWin\.SetForegroundWindow\s*\(/g, kind: 'SetForegroundWindow', acts: 'steal the foreground window' },
  { re: /\bWin\.BringWindowToTop\s*\(/g, kind: 'BringWindowToTop', acts: 'raise a window in the Z order' },
  { re: /\bWin\.SetActiveWindow\s*\(/g, kind: 'SetActiveWindow', acts: 'change the active window' },
  { re: /\bWin\.SetFocus\s*\(/g, kind: 'SetFocus', acts: 'move keyboard focus within a window' },
  { re: /\bWin\.SwitchToThisWindow\s*\(/g, kind: 'SwitchToThisWindow', acts: 'force the foreground window' },
  { re: /\bWin\.SetWindowPos\s*\(/g, kind: 'SetWindowPos', acts: 'move, resize or restack a window' },

  // ---- MUTATING HELPERS. These are the ones that hid `/focus`.
  //
  // `/focus` calls `Win.Focus(...)`, not `SetForegroundWindow(...)`, and `Win.Focus` is a wrapper that
  // does ShowWindow(SW_RESTORE) + BringWindowToTop + SetForegroundWindow + SetActiveWindow in a retry
  // loop. A route audit that only matches the leaf P/Invoke declarations therefore sees a route that
  // steals the foreground window as reaching nothing at all.
  //
  // The original audit solved exactly this for `Uia.*` by resolving helper bodies; this is the same
  // problem one layer over, and it was found by the audit's own stale-gap check rather than by reading.
  { re: /\bWin\.Focus\s*\(/g, kind: 'Win.Focus', acts: 'raise, restore and steal the foreground window' },
  { re: /\bWin\.FocusChild\s*\(/g, kind: 'Win.FocusChild', acts: 'focus a specific child control' },
]

/**
 * Calls that LOOK like machine mutation but are not, and must never be reported as such.
 *
 * This is the other half of widening the audit. A check that flags everything is as useless as one
 * that flags nothing, and `/guifocus` is the proof: it takes an `hwnd` and is filed next to `/focus`,
 * and it calls `GetWindowThreadProcessId`, `GuiFocusOfThread`, `Title` and `Cls` - all pure reads. An
 * earlier defect note listed `/guifocus` as ungated. That note was WRONG, and it was wrong because
 * nobody checked what the route did.
 *
 * `FocusChild` is here for the same reason and is a genuinely useful contrast: it is named "Focus",
 * looks mutating, and IS mutating - so it is deliberately absent from this list.
 */
const READ_ONLY = [
  { re: /\bWin\.GetWindowThreadProcessId\s*\(/g, kind: 'GetWindowThreadProcessId', acts: 'read: window to process' },
  { re: /\bWin\.GuiFocusOfThread\s*\(/g, kind: 'GuiFocusOfThread', acts: 'read: focus state of a thread' },
  { re: /\bWin\.GetForegroundWindow\s*\(/g, kind: 'GetForegroundWindow', acts: 'read: current foreground window' },
  { re: /\bWin\.IsWindowVisible\s*\(/g, kind: 'IsWindowVisible', acts: 'read: visibility' },
  { re: /\bWin\.IsIconic\s*\(/g, kind: 'IsIconic', acts: 'read: minimised state' },
  { re: /\bWin\.GetWindowRect\s*\(/g, kind: 'GetWindowRect', acts: 'read: window rectangle' },
]

/**
 * DOCUMENTED GAPS: routes that change machine state and are NOT gated, each with the exact fix.
 *
 * This registry grants NOTHING. It does not add a route to `InjectionRoutes`, does not make any check
 * pass, and cannot cause the audit to exit 0. Its only job is to make a known, accepted defect
 * distinguishable from a NEW breach - see the exit-code contract below.
 *
 * The distinction is the whole point of the audit. Before it existed, a genuinely ungated route and
 * three acknowledged ungated routes produced the same result: green.
 */
const KNOWN_GAPS = {
  // ---------------------------------------------------------------------------------------
  // RESOLVED 2026-10-08 (M17). These three were real ungated breaches and are now GATED.
  //
  // They are kept here rather than deleted, because an entry naming a route that is now in
  // `InjectionRoutes` is not stale - it records what the breach WAS and what closed it, which is the
  // only thing that stops the same omission being reintroduced on a later edit.
  //
  // What was wrong: each verified only that the named hwnd belonged to the named pid. That is an
  // IDENTITY check - it proves the caller aimed where it said, not that the caller was ALLOWED to act.
  // So a window could be minimised, hidden or pulled to the foreground during a human takeover or an
  // latched emergency stop. `Verify()` is the same distinction: identity, not permission.
  //
  // The fix: all three are declared in `InjectionRoutes`, which the dispatch-head gate consults BEFORE
  // any route body runs. No per-route check was added - the central gate already runs first, and
  // re-adding per-route calls would recreate the "enforced by remembering" failure mode it exists to
  // remove.
  //
  // Proven live by test/prove-window-gate.mjs, which asserts the refusal cites the guard AND that the
  // window's real state is unchanged when read back from /windows rather than from the reply.
  // ---------------------------------------------------------------------------------------
  '/show': 'RESOLVED: was ungated - Win.ShowWindow minimize|maximize|restore|show|hide behind an identity check only. Now declared in InjectionRoutes.',
  '/restore': 'RESOLVED: was ungated - Win.ShowWindow(SW_RESTORE) behind an identity check only. Now declared in InjectionRoutes.',
  '/focus': 'RESOLVED: was ungated - Win.Focus/FocusChild (SetForegroundWindow + SetFocus) behind an identity check only. Now declared in InjectionRoutes. /guifocus was correctly left ungated: it only READS focus.',
}

// EXIT CODES. Kept distinct on purpose.
//   0 - the invariant holds
//   1 - the invariant does NOT hold, and every known cause is documented above
//   2 - the audit found an UNDOCUMENTED gap, or its own tables rotted. This is the alarm that matters:
//       it means something changed that nobody declared, and it is what stops the next route from
//       arriving ungated the way these three did.
const EXIT_INVARIANT_HOLDS = 0
const EXIT_DOCUMENTED_GAP = 1
const EXIT_UNDOCUMENTED_BREACH = 2

/** Emission into the input stream is not the same as acting on the human's world. */
const EMITTING = new Set(['SendProbe'])

// ---------------------------------------------------------------- brace matching

/** Returns the index of the line that closes the block opened at `from`. */
function blockEnd(src, from) {
  let depth = 0
  let opened = false
  for (let i = from; i < src.length; i++) {
    for (const ch of src[i]) {
      if (ch === '{') { depth++; opened = true }
      else if (ch === '}') depth--
    }
    if (opened && depth <= 0) return i
  }
  return src.length - 1
}

// ---------------------------------------------------------------- route groups

/**
 * Blanks out comments and string literals, preserving offsets.
 *
 * This is the fix for the whole audit going wrong. The routes build JSON by hand, so the source
 * is full of `{` and `}` inside string literals:
 *
 *     return Json("{\"ok\":false,\"refused\":true,\"error\":\"...\"}");
 *
 * Counting braces naively therefore counted those as blocks. The visible symptom was
 * `/restore` appearing one level deeper than the UIA group above it, which in turn made the UIA
 * group swallow `/vstype` - so four read-only routes were reported as reaching `SendInput` and
 * `/vstype` as reaching nothing. Five findings, all backwards, all caused by the parser rather
 * than by the code under audit.
 *
 * Comments are blanked for the same reason: this codebase explains itself in prose that
 * contains braces.
 */
function sanitize(src) {
  // A character ARRAY, not a string: strings are immutable in JS, and this needs to blank
  // regions in place while preserving offsets.
  const out = src.split('')
  let i = 0
  const blank = (from, to) => { for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ' }
  while (i < src.length) {
    // line comment
    if (src[i] === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      blank(i, nl < 0 ? src.length : nl)
      i = nl < 0 ? src.length : nl
      continue
    }
    // block comment
    if (src[i] === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2)
      blank(i, close < 0 ? src.length : close + 2)
      i = close < 0 ? src.length : close + 2
      continue
    }
    // verbatim string
    if (src[i] === '@' && src[i + 1] === '"') {
      let k = i + 2
      while (k < src.length) { if (src[k] === '"' && src[k + 1] === '"') k += 2; else if (src[k] === '"') break; else k++ }
      blank(i, Math.min(k + 1, src.length))
      i = k + 1
      continue
    }
    // regular string, with escapes
    if (src[i] === '"') {
      let k = i + 1
      while (k < src.length) { if (src[k] === '\\') k += 2; else if (src[k] === '"') break; else k++ }
      blank(i, Math.min(k + 1, src.length))
      i = k + 1
      continue
    }
    // char literal
    if (src[i] === "'") {
      let k = i + 1
      while (k < src.length) { if (src[k] === '\\') k += 2; else if (src[k] === "'") break; else k++ }
      blank(i, Math.min(k + 1, src.length))
      i = k + 1
      continue
    }
    i++
  }
  return out.join('')
}

const HOST_RAW = readFileSync(join(HERE, 'src', 'OperatorHost.cs'), 'utf8').split(/\r?\n/)
const HOOKS_RAW = readFileSync(join(HERE, 'src', 'Hooks.cs'), 'utf8').split(/\r?\n/)
const HOST = sanitize(HOST_RAW.join('\n')).split(/\r?\n/)
const HOOKS = sanitize(HOOKS_RAW.join('\n')).split(/\r?\n/)

/** Brace nesting depth immediately before `line`, counting braces outside strings and comments. */
function depthAt(line) {
  let d = 0
  for (let i = 0; i < line; i++) {
    for (const ch of HOST[i]) {
      if (ch === '{') d++
      else if (ch === '}') d--
    }
  }
  return d
}

/**
 * Every `if (path == "/...")` guard, with the routes it names and the block it introduces.
 *
 * Handles the compound form (`if (path == "/a" || path == "/b" || ...)`) because those gates are
 * how several routes share one authorisation check, and misreading them is how `/type` and
 * `/key` first appeared ungated when they are not.
 */
function routeGroups() {
  const groups = []
  for (let i = 0; i < HOST.length; i++) {
    // Route NAMES are read from the raw source, because sanitizing blanks the string literals
    // that hold them. Structure (depth, braces, primitives) is read from the sanitized source,
    // so a `SendInput` mentioned in a comment is never mistaken for a call site.
    if (!/if\s*\(\s*path\s*==\s*"\/[^"]+"/.test(HOST_RAW[i])) continue
    let cond = HOST_RAW[i]
    let j = i
    while (!cond.includes(')') && j + 1 < HOST_RAW.length && j - i < 6) cond += ' ' + HOST_RAW[++j]
    const routes = [...cond.matchAll(/path\s*==\s*"\/([^"]+)"/g)].map((x) => '/' + x[1])
    if (!routes.length) continue
    groups.push({ routes, start: i, depth: depthAt(i), end: blockEnd(HOST, i) })
  }
  groups.sort((a, b) => a.start - b.start)

  // EXTENTS BY SEQUENCE, AT THE SAME BRACE DEPTH.
  //
  // The routes form a dispatch chain: `if (path == "/a") { ... } if (path == "/b") { ... }`.
  // Two obvious ways to find where each block ends are both wrong here.
  //
  // Brace matching: the UIA group's braces do not balance the way a naive walk assumes, so its
  // block ran past its own routes and swallowed `/vstype`. Four read-only routes were then
  // reported as reaching `SendInput`, and `/vstype` as reaching nothing - five findings, all
  // backwards.
  //
  // Plain sequence: the compound gate at `/click || /type || /scroll || /key || /move`
  // contains inner `if (path == "/type")` checks, so its extent was truncated by its own first
  // nested dispatch, and `/click`, `/scroll` and `/move` appeared to inject nothing.
  //
  // So: a route's block ends where the NEXT route begins AT THE SAME BRACE DEPTH. A nested
  // route check is part of its parent's body, which is exactly what it is.
  for (let i = 0; i < groups.length; i++) {
    let end = groups[groups.length - 1].end
    for (let k = i + 1; k < groups.length; k++) {
      if (groups[k].depth <= groups[i].depth) { end = groups[k].start - 1; break }
    }
    groups[i].end = Math.max(end, groups[i].start)
  }
  return groups
}

const groups = routeGroups()

// ---------------------------------------------------------------- helper methods

/**
 * Indexes methods that contain an injection primitive, across both files.
 *
 * A route that calls one of these injects, even though the `SendInput` text lives several
 * hundred lines away in a helper. Without this the audit cannot see the routes that work
 * exactly this way - which is most of them.
 *
 * Reachability through helpers is TRANSITIVE, because the helpers call each other:
 * `/click-absolute` calls `Click`, `Click` calls `Mouse`, and `Mouse` is where `SendInput`
 * actually is. One level of lookup reported `/click-absolute` as reaching nothing.
 *
 * `Handle` is excluded deliberately. It is the dispatcher: its body contains every route
 * inline, so treating it as a helper made every route in the file "reach" every primitive,
 * which is how the first version of this audit reported 41 phantom violations.
 */
function injectionHelpers() {
  const helpers = new Map()
  const exclude = new Set(['Handle', 'Main', 'Json', 'ScreenPng', 'Esc', 'Pn', 'P2', 'Qs', 'QsStr'])

  const scan = (src, qualifier) => {
    for (let i = 0; i < src.length; i++) {
      const sig = /^\s*(?:public |private |internal |static |unsafe )*[\w<>\[\]\.]+\s+(\w+)\s*\(/.exec(src[i])
      if (!sig) continue
      const name = sig[1]
      if (exclude.has(name)) continue
      if (['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'return', 'new'].includes(name)) continue

      let openLine = i
      while (openLine < src.length && !src[openLine].includes('{')) openLine++
      if (openLine >= src.length) continue
      // A signature continued onto following lines is not a declaration we can trust.
      if (openLine - i > 3) continue
      const end = blockEnd(src, openLine)
      const body = src.slice(openLine, end + 1).join('\n')
      const kinds = PRIMITIVES.filter((p) => { p.re.lastIndex = 0; return p.re.test(body) }).map((p) => p.kind)
      if (kinds.length) helpers.set(qualifier + name, { name: qualifier + name, line: i + 1, kinds, body })
    }
  }

  scan(HOST, '')
  scan(HOOKS, 'Hooks.')
  return helpers
}

const helpers = injectionHelpers()

/** Transitive closure: which primitives does calling `helper` eventually reach? */
function helperPrimitives(name, seen = new Set()) {
  if (seen.has(name)) return new Set()
  seen.add(name)
  const h = helpers.get(name)
  if (!h) return new Set()
  const out = new Set(h.kinds)
  // Follow helper -> helper edges.
  for (const other of helpers.values()) {
    if (other.name === name) continue
    const called = new RegExp(`\\b${other.name.replace('.', '\\.')}\\s*\\(`).test(h.body)
    if (!called) continue
    for (const k of helperPrimitives(other.name, seen)) out.add(k)
  }
  return out
}

// ---------------------------------------------------------------- the declared table

function declaredTable(name) {
  const at = HOST_RAW.findIndex((l) => l.includes(`${name} = new HashSet`))
  if (at < 0) return null
  const set = new Set()
  for (let i = at; i < HOST_RAW.length; i++) {
    if (HOST_RAW[i].trim() === '};') break
    const m = /"(\/[^"]+)"/.exec(HOST_RAW[i])
    if (m) set.add(m[1])
  }
  return set
}

const injectionRoutes = declaredTable('InjectionRoutes')
const permissionRoutes = declaredTable('PermissionRoutes') ?? new Set()
const selfTestRoutes = declaredTable('SelfTestRoutes')
if (!injectionRoutes) {
  console.error('FAIL: InjectionRoutes table not found')
  process.exit(1)
}

// ---------------------------------------------------------------- reachability

/** The routes that can reach each injection primitive, directly or via a helper. */
function routesReaching() {
  const reach = new Map()   // kind -> Set<route>
  const note = (kind, route) => {
    if (!reach.has(kind)) reach.set(kind, new Set())
    reach.get(kind).add(route)
  }

  // Direct: a primitive textually inside a route block.
  for (let i = 0; i < HOST.length; i++) {
    for (const p of PRIMITIVES) {
      p.re.lastIndex = 0
      if (!p.re.test(HOST[i])) continue
      let best = null
      for (const g of groups) {
        if (i < g.start || i > g.end) continue
        if (!best || g.start > best.start) best = g
      }
      if (best) for (const r of best.routes) note(p.kind, r)
    }
  }

  // Transitive: a route block that calls a helper which reaches a primitive, however deep.
  for (const g of groups) {
    const body = HOST.slice(g.start, g.end + 1).join('\n')
    for (const h of helpers.values()) {
      const called = new RegExp(`\\b${h.name.replace('.', '\\.')}\\s*\\(`).test(body)
      if (!called) continue
      for (const k of helperPrimitives(h.name)) for (const r of g.routes) note(k, r)
    }
  }

  return reach
}

const reach = routesReaching()

/**
 * Routes that GRANT authority, found by what they call rather than by what they contain.
 *
 * Checking `PermissionRoutes` for internal consistency is not enough: dropping a route from
 * the table cannot be detected by inspecting the table, because the route is simply no longer
 * listed. That is exactly what the third negative control did - `/vstype` was removed from
 * `PermissionRoutes` and the audit still passed, meaning a route that HANDS OUT the
 * authorization `/type` physically depends on could have been silently ungated.
 *
 * So the signal comes from the code instead. `VsEdit.Grant(` is the act of minting an
 * authorization; any route that reaches it is a permission-granting route and must be declared.
 */
function permissionGrantingRoutes() {
  const out = new Set()
  for (let i = 0; i < HOST.length; i++) {
    if (!/\bVsEdit\.Grant\s*\(/.test(HOST[i])) continue
    let best = null
    for (const g of groups) {
      if (i < g.start || i > g.end) continue
      if (!best || g.start > best.start) best = g
    }
    if (best) for (const r of best.routes) out.add(r)
  }
  return out
}

const granters = permissionGrantingRoutes()

// The self-test lives in Hooks.cs and is reached only from Report(), which only HTTP routes
// call. It is emission, not action, and is reported for completeness rather than gated.
const probeInHooks = (() => {
  // Hooks.SendProbe is private and reached only from Report(), which only HTTP routes call.
  // It is a real injection of F24, and deliberately NOT gated.
  return HOOKS.some((l) => /static void SendProbe\s*\(/.test(l))
})()

// ---------------------------------------------------------------- report

const allKinds = [...new Set([...reach.keys(), ...(probeInHooks ? ['SendProbe'] : [])])]
const actionKinds = allKinds.filter((k) => !EMITTING.has(k))

console.log('=== INJECTION ROUTE AUDIT ===')
console.log(`  source              src/OperatorHost.cs + src/Hooks.cs`)
console.log(`  declared injection ${injectionRoutes.size} route(s)`)
console.log(`  declared authority  ${permissionRoutes.size} route(s) (grant permission without injecting)`)
console.log(`  injection helpers   ${helpers.size} (${[...helpers.keys()].join(', ') || 'none'})`)
console.log('')

const rows = []
for (const kind of allKinds.sort()) {
  const routes = [...(reach.get(kind) ?? [])].sort()
  if (EMITTING.has(kind)) {
    rows.push({ kind, routes, status: 'instrumentation (must NOT be gated)' })
    continue
  }
  for (const r of routes) {
    rows.push({ kind, route: r, status: injectionRoutes.has(r) ? 'governed' : 'UNGOVERNED' })
  }
}

const WINDOW_KINDS = new Set([
  'ShowWindow', 'SetForegroundWindow', 'BringWindowToTop', 'SetActiveWindow',
  'SetFocus', 'SwitchToThisWindow', 'SetWindowPos', 'Win.Focus', 'Win.FocusChild',
])

console.log('  --- every primitive, and every route that reaches it ---')
for (const r of rows) {
  const via = r.route ?? (r.routes.join(', ') || '(none found)')
  const tag = r.status === 'governed' ? 'governed'
    : r.status === 'UNGOVERNED' ? '*** UNGOVERNED ***'
      : r.status
  console.log(`  ${r.kind.padEnd(20)} ${via.padEnd(30)} ${tag}`)
}
console.log('')

// ---------------------------------------------------------------- the widened section
//
// A separate section, because the distinction that was missing is not "gated or not" but
// "changes the machine" versus "injects input". Conflating them is what hid these routes: they are
// ungated, and for years the audit said nothing at all, which reads the same as "fine".
const windowRows = rows.filter((r) => WINDOW_KINDS.has(r.kind))

// Dedupe BY ROUTE. `/focus` reaches both Win.Focus and Win.FocusChild, and without this it was listed
// twice - which overstates the count of defects and, worse, makes a single route look like two
// unrelated problems. The count a reader trusts has to count routes, not call sites.
const ungovernedByRoute = new Map()
for (const r of windowRows) {
  if (r.status !== 'UNGOVERNED') continue
  if (!ungovernedByRoute.has(r.route)) ungovernedByRoute.set(r.route, [])
  ungovernedByRoute.get(r.route).push(r.kind)
}
const windowUngoverned = [...ungovernedByRoute.entries()].map(([route, kinds]) => ({ route, kinds }))
const readRows = (() => {
  const out = []
  for (const ro of READ_ONLY) {
    const lines = HOST.map((l, i) => (ro.re.test(l) ? i : -1)).filter((i) => i >= 0)
    if (!lines.length) continue
    const routes = new Set()
    for (const i of lines) for (const g of groups) {
      if (i >= g.start && i <= g.end) for (const r of g.routes) routes.add(r)
    }
    out.push({ kind: ro.kind, routes: [...routes].sort() })
  }
  return out
})()

console.log('  --- machine state changed WITHOUT input injection (the M14 widening) ---')
if (!windowRows.length) console.log('  (none found - if this is wrong, the audit is not seeing the source)')
for (const r of windowRows) {
  const via = r.route ?? (r.routes.join(', ') || '(none found)')
  const known = KNOWN_GAPS[r.route]
  const tag = r.status === 'governed' ? 'governed'
    : known ? '*** UNGOVERNED - DOCUMENTED GAP ***'
      : '*** UNGOVERNED - UNDOCUMENTED BREACH ***'
  console.log(`  ${r.kind.padEnd(20)} ${via.padEnd(30)} ${tag}`)
}
console.log('')
for (const [route, kinds] of ungovernedByRoute) {
  const known = KNOWN_GAPS[route]
  console.log(`  ${route.padEnd(20)} via ${kinds.join(', ')}`)
  if (known) console.log(`  ${''.padEnd(20)}      fix: ${known}`)
}
console.log('')

console.log('  --- reads that must NOT be reported as mutation (discrimination control) ---')
for (const r of readRows) {
  const via = r.routes.join(', ') || '(none found)'
  console.log(`  ${r.kind.padEnd(20)} ${via.padEnd(30)} read-only, correctly NOT gated`)
}
console.log('')

// ---------------------------------------------------------------- table integrity

const allRoutes = new Set(groups.flatMap((g) => g.routes))
const declaredAbsent = [...injectionRoutes].filter((r) => !allRoutes.has(r))
const declaredUnreached = [...injectionRoutes].filter(
  (r) => !actionKinds.some((k) => (reach.get(k) ?? new Set()).has(r)),
)
const selfTestAbsent = selfTestRoutes ? [...selfTestRoutes].filter((r) => !allRoutes.has(r)) : []

console.log('  --- table integrity ---')
console.log(`  declared, and is a route        ${declaredAbsent.length ? 'NO: ' + declaredAbsent.join(', ') : 'yes'}`)
console.log(`  declared, and reaches injection${declaredUnreached.length ? 'NO: ' + declaredUnreached.join(', ') : ' yes'}`)
console.log(`  self-test routes that vanished  ${selfTestAbsent.length ? 'YES: ' + selfTestAbsent.join(', ') : 'none'}`)

// PermissionRoutes membership has to be verified too, or a permission-granting route can be
// dropped from the table without the audit noticing - which is exactly what the third negative
// control did when this check was missing. Dropping /vstype still passed the audit, so a route
// that HANDS OUT the authorization /type depends on could have been silently ungated.
const permissionAbsent = [...permissionRoutes].filter((r) => !allRoutes.has(r))
// A permission route must NOT inject. If one does, it belongs in InjectionRoutes and the
// distinction has rotted.
const permissionThatInjects = [...permissionRoutes].filter(
  (r) => actionKinds.some((k) => (reach.get(k) ?? new Set()).has(r)),
)
// And an injecting route must not be hiding in the permission table, which would still be gated
// but would be mislabelled in every report.
const injectionMisfiled = [...permissionRoutes].filter((r) => injectionRoutes.has(r))

console.log(`  authority routes that vanished  ${permissionAbsent.length ? 'YES: ' + permissionAbsent.join(', ') : 'none'}`)
console.log(`  authority routes that inject   ${permissionThatInjects.length ? 'YES: ' + permissionThatInjects.join(', ') : 'none'}`)
console.log(`  routes in both tables           ${injectionMisfiled.length ? 'YES: ' + injectionMisfiled.join(', ') : 'none'}`)
const undeclaredGranters = [...granters].filter((r) => !permissionRoutes.has(r) && !injectionRoutes.has(r))
console.log(`  grants authority, undeclared    ${undeclaredGranters.length ? 'YES: ' + undeclaredGranters.join(', ') : 'none'}`)
console.log('')

const problems = []
const ungoverned = rows.filter((r) => r.status === 'UNGOVERNED')
const ungovernedRoutes = [...new Set(ungoverned.map((r) => r.route))].sort()
if (ungovernedRoutes.length) {
  problems.push(`${ungovernedRoutes.length} route(s) can change this machine but are NOT in InjectionRoutes: ${ungovernedRoutes.join(', ')}`)
}
if (declaredAbsent.length) problems.push(`InjectionRoutes names routes that do not exist: ${declaredAbsent.join(', ')}`)
if (declaredUnreached.length) problems.push(`InjectionRoutes claims routes that reach no injection primitive: ${declaredUnreached.join(', ')}`)
if (permissionAbsent.length) problems.push(`PermissionRoutes names routes that do not exist: ${permissionAbsent.join(', ')} - a permission-granting route cannot be silently ungated`)
if (permissionThatInjects.length) problems.push(`PermissionRoutes names routes that DO inject (${permissionThatInjects.join(', ')}); they belong in InjectionRoutes`)
if (undeclaredGranters.length) problems.push(`route(s) call VsEdit.Grant( and so hand out injection authority but are declared nowhere: ${undeclaredGranters.join(', ')}`)
for (const k of actionKinds) {
  if (!(reach.get(k)?.size)) problems.push(`primitive ${k} is called but no route reaches it - the audit cannot see it`)
}

// Every ungated machine-mutating route, split by whether anyone has written down why.
const undocumentedBreaches = windowUngoverned.filter((r) => !KNOWN_GAPS[r.route])
const documentedGaps = windowUngoverned.filter((r) => KNOWN_GAPS[r.route])

// A stale entry in KNOWN_GAPS is itself a defect: it would let a route be fixed, or deleted, and keep
// reporting a gap that no longer exists - training the reader to ignore the section.
const staleGaps = Object.keys(KNOWN_GAPS).filter(
  (r) => !windowUngoverned.some((u) => u.route === r) && !injectionRoutes.has(r),
)

for (const p of problems) console.log('  - ' + p)
for (const d of documentedGaps) console.log(`  - DOCUMENTED GAP: ${d.route} changes machine state without a gate (via ${d.kinds.join(', ')}). ${KNOWN_GAPS[d.route]}`)

if (staleGaps.length) {
  console.log(`  - KNOWN_GAPS lists routes that are no longer ungated: ${staleGaps.join(', ')}`)
}

if (problems.length === 0 && undocumentedBreaches.length === 0 && documentedGaps.length === 0) {
  console.log('=== PASS: every action that can change the real machine state passes through the declared gate ===')
  process.exit(EXIT_INVARIANT_HOLDS)
}

if (undocumentedBreaches.length) {
  console.log('')
  console.log('=== ALARM: UNDOCUMENTED MACHINE-STATE BREACH ===')
  console.log('  A route changes the machine and is neither gated nor recorded as a known gap.')
  console.log('  This is the case the previous audit could not express at all. Declaring the route in')
  console.log('  InjectionRoutes (with MayInject() at the dispatch head) fixes it; recording it in')
  console.log('  KNOWN_GAPS records the defect honestly. Silently doing nothing is what let /show,')
  console.log('  /restore and /focus arrive ungated.')
  process.exit(EXIT_UNDOCUMENTED_BREACH)
}

console.log('')
console.log('=== INVARIANT DOES NOT YET HOLD - and the audit can now prove it ===')
console.log(`  ${documentedGaps.length} route(s) change real machine state without passing a gate:`)
for (const d of documentedGaps) console.log(`    ${d.route.padEnd(12)} ${KNOWN_GAPS[d.route]}`)
console.log('')
console.log('  The stronger invariant - every action capable of changing the real machine state passes')
console.log('  through the applicable declared gate - is FALSE today. It was previously untestable,')
console.log('  because the audit only asked whether a route reached an injection primitive.')
console.log('')
console.log('  Fixing this requires changing packages/control-core/src/OperatorHost.cs, which this')
console.log('  project does not modify without an ADR and a human decision. See docs/decisions/0003.')
process.exit(EXIT_DOCUMENTED_GAP)