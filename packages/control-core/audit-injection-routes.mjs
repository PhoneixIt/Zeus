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

/** Every call that can change the machine's state. */
const PRIMITIVES = [
  { re: /\bWin\.SendInput\s*\(/g, kind: 'SendInput', acts: 'hardware input' },
  { re: /\bHooks\.SendProbe\s*\(/g, kind: 'SendProbe', acts: 'instrument self-test' },
  { re: /\bWin\.PostMessage\s*\(/g, kind: 'PostMessage', acts: 'direct window message' },
  { re: /\bUia\.Invoke\s*\(/g, kind: 'Uia.Invoke', acts: 'UI Automation invoke (no input event)' },
  { re: /\bUia\.SetValue\s*\(/g, kind: 'Uia.SetValue', acts: 'UI Automation value write' },
  { re: /\bUia\.Focus\s*\(/g, kind: 'Uia.Focus', acts: 'UI Automation focus change' },
]

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

console.log('  --- every primitive, and every route that reaches it ---')
for (const r of rows) {
  const via = r.route ?? (r.routes.join(', ') || '(none found)')
  const tag = r.status === 'governed' ? 'governed'
    : r.status === 'UNGOVERNED' ? '*** UNGOVERNED ***'
      : r.status
  console.log(`  ${r.kind.padEnd(14)} ${via.padEnd(34)} ${tag}`)
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
if (ungoverned.length) {
  problems.push(`${ungoverned.length} route(s) can change this machine but are NOT in InjectionRoutes: ${ungoverned.map((r) => r.route).join(', ')}`)
}
if (declaredAbsent.length) problems.push(`InjectionRoutes names routes that do not exist: ${declaredAbsent.join(', ')}`)
if (declaredUnreached.length) problems.push(`InjectionRoutes claims routes that reach no injection primitive: ${declaredUnreached.join(', ')}`)
if (permissionAbsent.length) problems.push(`PermissionRoutes names routes that do not exist: ${permissionAbsent.join(', ')} - a permission-granting route cannot be silently ungated`)
if (permissionThatInjects.length) problems.push(`PermissionRoutes names routes that DO inject (${permissionThatInjects.join(', ')}); they belong in InjectionRoutes`)
if (undeclaredGranters.length) problems.push(`route(s) call VsEdit.Grant( and so hand out injection authority but are declared nowhere: ${undeclaredGranters.join(', ')}`)
for (const k of actionKinds) {
  if (!(reach.get(k)?.size)) problems.push(`primitive ${k} is called but no route reaches it - the audit cannot see it`)
}

console.log(problems.length === 0
  ? '=== PASS: every action that can change this machine passes through the declared gate ==='
  : `=== FAIL ===\n${problems.map((p) => '  - ' + p).join('\n')}`)

process.exit(problems.length ? 1 : 0)