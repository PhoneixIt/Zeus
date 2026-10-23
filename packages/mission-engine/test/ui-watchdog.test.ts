/**
 * THE WATCHDOG AND THE APPROVAL GATE, ACTUALLY EXECUTED.
 *
 * ============================================================================================
 * WHY THIS EXISTS
 *
 * Two live demos - in the real product, against the real server - caught the interface lying
 * about a mission that was still running, and both lies came from the same 90-second watchdog:
 *
 *   1. The planner was silent for longer than 90s (normal on a local model: 90-115s per call).
 *      The watchdog fired, said "click Stop", and then called finish() - the ONE place that
 *      disables Stop. The next click on the disabled button was a no-op, the mission ran to its
 *      honest end, and the window had advised the only remedy it had just made impossible.
 *
 *   2. Same silence, but the mission was PAUSED on an authorisation card. When the card finally
 *      arrived, the window had already "finished": Stop stayed dead for a mission that was very
 *      much alive and waiting on its own gate, and the stall wording called a waiting human a
 *      stalled machine.
 *
 * Neither defect is visible by reading the source at speed: the watchdog looks like a sensible
 * "say something when the feed is quiet" guard. Only the executed behaviour - feed events, the
 * clock, the real functions - shows that it disabled the very button it told you to click.
 *
 * ============================================================================================
 * WHAT IS AND IS NOT TESTED
 *
 * The real UI_JS string is loaded and RUN against a DOM stub with a controllable clock, and the
 * real pollFeed()/handleEvent()/finish() are driven through the same fetch seam the page uses
 * (/progress?since=N). The assertions are on the DOM the person would see: the Stop button, the
 * mission pill, the thread text.
 *
 * NOT tested here: the server half of cancellation (chat-cancellation.test.ts and
 * chat-authorization.test.ts pin that /cancel really aborts the model child and the executor),
 * and the decision POSTs themselves (the approval card's channel behaviour is pinned in the
 * chat-ui and authorization suites). What is pinned here is the property both demos broke:
 * while a mission is running - thinking, or waiting on a human - the window must keep saying so
 * and must keep Stop working - AND its mirror, the other half of "not stuck": when a mission
 * ENDS badly (the error then done ok:false a failed or timed-out model call produces; the
 * server legs are in planner-prose-reply.test.ts), those terminal events must clear
 * the window - busy off, Stop gone, the composer back, the honest reason on screen.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI_ASSETS = pathToFileURL(resolve(HERE, '..', 'live', 'agent', 'ui-assets.ts')).href

// --------------------------------------------------------------------------- the DOM stub

interface StubNode {
  tag: string
  id: string
  children: StubNode[]
  textContent: string
  innerHTML: string
  value: string
  title: string
  hidden: boolean
  disabled: boolean
  scrollTop: number
  scrollHeight: number
  style: Record<string, string>
  dataset: Record<string, string>
  classes: Set<string>
  className: string
  classList: {
    add(c: string): void
    remove(c: string): void
    contains(c: string): boolean
    toggle(c: string, on?: boolean): void
  }
  appendChild(n: StubNode): StubNode
  removeChild(n: StubNode): StubNode
  remove(): void
  querySelector(sel: string): StubNode | null
  querySelectorAll(sel: string): StubNode[]
  addEventListener(...a: unknown[]): void
  removeEventListener(...a: unknown[]): void
  setAttribute(k: string, v: string): void
  getAttribute(k: string): string | null
  focus(): void
  blur(): void
  click(): void
  get firstChild(): StubNode | null
  get lastElementChild(): StubNode | null
}

/**
 * The selector support this script actually uses: a class, an id, a tag, and the compound
 * ".approval:not(.granted):not(.denied)" the watchdog's pending-card check depends on. A stub
 * that returned a node for ANY query would make that check always-true and the test would pass
 * against code that cries stall over a waiting human; a stub that matched nothing would make it
 * always-false and the test would fail against correct code. Matching what a browser matches is
 * the only honest option.
 */
function matchSel(n: StubNode, sel: string): boolean {
  if (sel.startsWith('.')) {
    const m = /^\.([A-Za-z0-9_-]+)((?::not\(\.[A-Za-z0-9_-]+\))*)$/.exec(sel)
    if (!m) return false
    if (!n.classes.has(m[1]!)) return false
    const negs = [...m[2]!.matchAll(/:not\(\.([A-Za-z0-9_-]+)\)/g)].map((x) => x[1]!)
    return negs.every((c) => !n.classes.has(c))
  }
  if (sel.startsWith('#')) return n.id === sel.slice(1)
  return n.tag === sel
}

function deepQuery(n: StubNode, sel: string): StubNode | null {
  for (const c of n.children) {
    if (matchSel(c, sel)) return c
    const hit = deepQuery(c, sel)
    if (hit) return hit
  }
  return null
}

function makeNode(tag = 'div', id = ''): StubNode {
  const classes = new Set<string>()
  let cls = ''
  let html = ''

  const n = {
    tag,
    id,
    children: [] as StubNode[],
    textContent: '',
    value: '',
    title: '',
    hidden: false,
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    classes,
    // mk() sets className as a string ('msg assistant approval'); a browser derives the class
    // list from it, so the stub must too or every class-based query silently never matches.
    get className(): string { return cls },
    set className(v: string) {
      cls = v
      classes.clear()
      for (const c of String(v).split(/\s+/)) if (c) classes.add(c)
    },
    get innerHTML(): string { return html },
    set innerHTML(v: string) {
      html = v
      const m = /^\s*<([a-zA-Z0-9]+)\b[^>]*>\s*<\/([a-zA-Z0-9]+)>\s*$/.exec(String(v))
      if (m && m[1] === m[2]) n.children.push(makeNode(m[1]!))
      else if (m) n.children.push(makeNode(m[1]!))
    },
    appendChild(c: StubNode) { n.children.push(c); return c },
    removeChild(c: StubNode) {
      const i = n.children.indexOf(c)
      if (i >= 0) n.children.splice(i, 1)
      return c
    },
    remove() {
      const parent = parents.get(n)
      if (parent) parent.removeChild(n)
    },
    querySelector(sel: string) { return deepQuery(n, sel) },
    querySelectorAll(sel: string) {
      const out: StubNode[] = []
      const walk = (x: StubNode) => {
        for (const c of x.children) {
          if (matchSel(c, sel)) out.push(c)
          walk(c)
        }
      }
      walk(n)
      return out
    },
    addEventListener(..._a: unknown[]) { /* the wiring must not fail for want of handlers */ },
    removeEventListener() {},
    setAttribute(k: string, v: string) { n.dataset[k] = v },
    getAttribute(k: string) { return k in n.dataset ? n.dataset[k]! : null },
    focus() {},
    blur() {},
    click() {},
    get firstChild(): StubNode | null { return n.children.length > 0 ? n.children[0]! : null },
    get lastElementChild(): StubNode | null {
      return n.children.length > 0 ? n.children[n.children.length - 1]! : null
    },
  } as unknown as StubNode & { children: StubNode[] }

  ;(n as unknown as { classList: StubNode['classList'] }).classList = {
    add: (c: string) => { classes.add(c) },
    remove: (c: string) => { classes.delete(c) },
    contains: (c: string) => classes.has(c),
    toggle: (c: string, on?: boolean) => {
      const want = on === undefined ? !classes.has(c) : on
      if (want) classes.add(c)
      else classes.delete(c)
    },
  }
  return n
}

/** Which stub node is whose parent, so remove() really detaches (querySelector must stop seeing it). */
const parents = new WeakMap<StubNode, StubNode>()

/** All the text under a node, recursively - the client nests text in .who/.body/.txt spans. */
function textOf(n: StubNode): string {
  const parts: string[] = []
  if (n.textContent) parts.push(n.textContent)
  for (const c of n.children) parts.push(textOf(c))
  return parts.join(' ')
}

// --------------------------------------------------------------------------- the clock

/**
 * A controllable clock. The watchdog's entire logic is "Date.now() - lastEventAt > 90s", and no
 * test can wait 90 seconds honestly; advancing a fake now() moves the same code through the same
 * states without mocking the code.
 */
const RealDate = Date
let fakeNow = RealDate.now()
class FakeClock extends RealDate {
  static override now(): number { return fakeNow }
}

// --------------------------------------------------------------------------- the harness

interface Harness {
  ctx: vm.Context
  node(id: string): StubNode
  fetchLog: string[]
}

/**
 * Load the real UI script into a VM with the DOM stub and the fake clock, and let its top-level
 * wiring run. `feed` is the /progress response queue - one entry per poll, each entry one
 * poll's worth of events; the script's startup consumes the first entry.
 */
async function harness(feed: Array<Array<Record<string, unknown>>> = []): Promise<Harness> {
  const { UI_JS } = (await import(UI_ASSETS)) as { UI_JS: string }
  fakeNow = RealDate.now()

  const root = makeNode('body', 'root')
  const byId = new Map<string, StubNode>()
  const asked: string[] = []
  const fetchLog: string[] = []
  const queue = feed.slice()

  const getEl = (id: string): StubNode => {
    asked.push(id)
    let n = byId.get(id)
    if (!n) { n = makeNode('div', id); byId.set(id, n) }
    return n
  }
  const track = (parent: StubNode, child: StubNode) => { parents.set(child, parent); return child }
  // Elements created through getElementById start detached (the real ones come from the served
  // markup); appendChild is the only thing that attaches them, so record parenthood there.
  const attachable = (n: StubNode): StubNode => {
    const orig = n.appendChild.bind(n)
    ;(n as unknown as { appendChild(c: StubNode): StubNode }).appendChild = (c: StubNode) => {
      track(n, c)
      return orig(c)
    }
    return n
  }
  for (const id of ['thread', 'empty', 'scroll', 'composer', 'composerWrap', 'sendBtn', 'cancelBtn',
    'newChat', 'sessionList', 'banner', 'capLine', 'zeusBadge', 'missionState']) attachable(getEl(id))
  // The real markup puts an id-less .composer area inside #composerWrap, and wireFocus() finds
  // it with document.querySelector('.composer'). The stub must carry that shape or the script
  // dies on its own wiring before any test can observe anything.
  const composerArea = makeNode('div')
  composerArea.className = 'composer'
  getEl('composerWrap').appendChild(composerArea)

  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const setIntervalFn = (fn: () => void) => { const id = nextTimer++; timers.set(id, fn); return id }
  const clearIntervalFn = (id: number) => { timers.delete(id) }
  const setTimeoutFn = (fn: () => void) => { fn(); return 0 }
  const clearTimeoutFn = () => {}

  // Document-level search across every element the script asked for: the real document would
  // find the card inside #thread; a stub that only searched <body>'s children would never see
  // it (the byId elements are not its children) and the watchdog's pending-card check would
  // always come up empty.
  const documentQuery = (sel: string): StubNode | null => {
    for (const n of byId.values()) {
      if (matchSel(n, sel)) return n
      const hit = deepQuery(n, sel)
      if (hit) return hit
    }
    return null
  }

  const sandbox: Record<string, unknown> = {
    console,
    Date: FakeClock,
    document: {
      getElementById: getEl,
      createElement: (tag: string) => makeNode(tag),
      createTextNode: (t: string) => { const n = makeNode('#text'); n.textContent = t; return n },
      querySelector: documentQuery,
      querySelectorAll: (sel: string) => {
        const out: StubNode[] = []
        for (const n of byId.values()) {
          if (matchSel(n, sel)) out.push(n)
          out.push(...n.querySelectorAll(sel))
        }
        return out
      },
      body: root,
      addEventListener: () => {},
      cookie: 'aios_token=test-token',
      documentElement: makeNode('html'),
    },
    window: {
      AIOS_DEFAULT_MODEL: 'opencode/test-free',
      setInterval: setIntervalFn,
      clearInterval: clearIntervalFn,
      setTimeout: setTimeoutFn,
      clearTimeout: clearTimeoutFn,
      addEventListener: () => {},
      location: { search: '', href: 'http://127.0.0.1:8777/ui' },
      document: null as unknown,
      getComputedStyle: () => ({ getPropertyValue: () => '' }),
      matchMedia: () => ({ matches: false, addEventListener: () => {} }),
      requestAnimationFrame: (fn: () => void) => fn(),
      fetch: undefined as unknown,
    },
    location: { search: '', href: 'http://127.0.0.1:8777/ui' },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    setInterval: setIntervalFn,
    clearInterval: clearIntervalFn,
    fetch: async (url: string) => {
      fetchLog.push(String(url))
      const u = String(url)
      if (u.startsWith('/progress')) {
        const events = queue.shift() ?? []
        return {
          ok: true,
          status: 200,
          json: async () => ({ events, total: events.length }),
          text: async () => JSON.stringify({ events, total: events.length }),
        }
      }
      // Any other route: a well-formed empty success, so startup does not die on an unrelated
      // fetch. Nothing in these tests depends on any other route answering.
      return {
        ok: true,
        status: 200,
        json: async () => ({ sessions: [], models: [], capabilities: [], guard: {} }),
        text: async () => '{"sessions":[],"models":[],"capabilities":[],"guard":{}}',
      }
    },
  }
  const ctx = vm.createContext(sandbox)
  new vm.Script(UI_JS, { filename: 'ui-assets.js' }).runInContext(ctx)
  await settle()

  return { ctx, node: getEl, fetchLog }
}

/** Let every already-scheduled promise and timer callback finish. */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r))
}

/** One poll cycle of the real feed, exactly as the 600ms interval would run it. */
async function tick(ctx: vm.Context): Promise<void> {
  await vm.runInContext('pollFeed()', ctx)
  await settle()
}

const APPROVAL_EVENT = {
  kind: 'approval-required',
  stepId: 's1',
  effectKind: 'external-send',
  target: 'git push',
  irreversible: true,
  reason: 'external-send on git push: git push sends commits to a remote (permanent)',
}

// ============================================================================================

test('the watchdog does not disable the Stop button it tells you to click', async () => {
  // THE LIVE DEFECT, first demo. The planner is silent (a normal 90s+ local model call), the
  // watchdog fires - and finish() disabled Stop while the message said "click Stop". The window
  // offered the one remedy it had just made impossible, over a mission still running.
  //
  // The setup is exactly the state both demos saw: a busy window, a feed quiet for two minutes.
  const h = await harness([[], [], []])
  vm.runInContext('state.busy = true', h.ctx)     // a mission is running
  fakeNow += 120_000                              // two minutes of planner silence

  await tick(h.ctx)

  assert.equal(h.node('cancelBtn').disabled, false,
    'the watchdog must keep Stop enabled: the mission is still running and the message names Stop')
  assert.equal(h.node('missionState').textContent, 'running',
    'the pill must keep saying running while the mission runs; silence is not death')
  assert.equal(vm.runInContext('state.busy', h.ctx), true,
    'the window is still busy - the server will 409 a second send, so the window must say so')

  const shown = textOf(h.node('thread'))
  assert.match(shown, /may still be working/,
    'the honest reading of silence: the model may still be working, not stalled')
  assert.doesNotMatch(shown, /may have stalled/,
    'the old wording called a working model call a stall')

  // And the warning says the honest thing ONCE, not once per 90 seconds down the thread.
  fakeNow += 120_000
  await tick(h.ctx)
  const occurrences = textOf(h.node('thread')).split('Nothing has arrived for 90 seconds').length - 1
  assert.equal(occurrences, 1, 'the same warning must not stack down the thread')
})

test('a live approval request re-asserts the running state so Stop works during the wait', async () => {
  // THE LIVE DEFECT, second demo. The card arrived at a window the watchdog had already
  // "finished" during a long silent planner call: Stop stayed dead for a mission that was alive
  // and paused on its own gate. A live approval-required event is SERVER PROOF the mission is
  // running, so the window must say running and re-enable Stop the moment it arrives.
  //
  // finish() here is the real function, called directly - the exact state the pre-fix watchdog
  // left behind before the card landed.
  const h = await harness([[], [APPROVAL_EVENT]])
  vm.runInContext('finish()', h.ctx)
  fakeNow += 5_000

  await tick(h.ctx)

  assert.equal(h.node('cancelBtn').disabled, false,
    'a live request proves the mission is running; Stop must work during the wait')
  assert.equal(h.node('sendBtn').disabled, true, 'a second send is refused server-side (409); say so here too')
  assert.equal(h.node('composer').disabled, true, 'the composer mirrors the running state')
  assert.equal(vm.runInContext('state.busy', h.ctx), true, 'the window is busy while the mission waits on the gate')
  assert.equal(h.node('missionState').textContent, 'running', 'the pill says running, because it is')

  const card = h.node('thread').querySelector('.approval:not(.granted):not(.denied)')
  assert.ok(card, 'the decision card itself must render')
  const shown = textOf(h.node('thread'))
  assert.match(shown, /AUTHORISATION REQUIRED/, 'the card names the gate in the product voice')
  assert.match(shown, /Approve once/, 'the approve button is on the card')
  assert.match(shown, /Refuse/, 'the refuse button is on the card')
})

test('the watchdog tells a waiting human the truth instead of crying stall', async () => {
  // The second half of the same fix: with a decision card still on screen, feed silence is the
  // EXPECTED state - the executor is halted on the gate and the person is the one holding it.
  // Calling that a stall was the lie; finishing on it was the consequence.
  const h = await harness([[], [APPROVAL_EVENT], []])

  await tick(h.ctx)                               // the card lands; the window re-asserts running
  fakeNow += 120_000                              // the person reads it for two minutes
  await tick(h.ctx)                               // the quiet tick, card still pending

  const shown = textOf(h.node('thread'))
  assert.match(shown, /Waiting for your decision/,
    'a pending decision is a wait, not a stall; the window must say which')
  assert.doesNotMatch(shown, /Nothing has arrived for 90 seconds/,
    'the stall warning must not fire over a pending decision')
  assert.equal(h.node('cancelBtn').disabled, false,
    'Stop stays live through the wait - the person must be able to halt a paused mission')
  assert.equal(vm.runInContext('state.busy', h.ctx), true,
    'the mission is still running server-side; the window does not pretend otherwise')

  // And the card is untouched: still pending, still with both decisions available.
  assert.ok(h.node('thread').querySelector('.approval:not(.granted):not(.denied)'),
    'the card must remain pending while the person decides')
})

test('the failure events END the window: error + done(ok false) clear busy and give the composer back', async () => {
  // The mirror of every test above, and the second half of the mandate this file now carries.
  // Above: silence must never fake death while a mission runs. Here: real death must not be
  // fake immortality. When the model path fails outright - every attempt dead, or the deadline
  // in planner-prose-reply.test.ts firing - the server sends `error`, then `done`
  // with ok:false. finish() runs from those events and from nothing else while busy, so this
  // pins the whole terminal sequence the person depends on: busy clears (the server has
  // released the mission; a second message is no longer refused on 409), Stop goes away with
  // the mission it belonged to, the composer accepts the next message, the pill carries the
  // server verdict, and the honest reason is on screen - not a silent dead window.
  //
  // (The server legs of the same contract - the deadline ending an unstopped call, and a
  // failing model path settling runGoal with these very events - are pinned in
  // planner-prose-reply.test.ts.)
  // The first slot is the load-time poll connect() makes (it consumes one batch before the
  // test's own tick); the terminal events go in the SECOND slot, on the tick under test.
  const h = await harness([[], [
    { kind: 'error', text: 'planner exceeded 300000ms and was terminated' },
    { kind: 'done', ok: false, text: 'the mission could not run: planner exceeded 300000ms and was terminated' },
    { kind: 'mission-state', state: 'failed' },
  ]])
  vm.runInContext('state.busy = true', h.ctx)     // exactly the state a running mission leaves

  await tick(h.ctx)

  assert.equal(vm.runInContext('state.busy', h.ctx), false,
    'done must clear busy - finish() is the ONE place that does, and nothing else may')
  assert.equal(h.node('sendBtn').disabled, false, 'the next message must be sendable')
  assert.equal(h.node('composer').disabled, false, 'the composer must accept typing again')
  assert.equal(h.node('cancelBtn').disabled, true, 'Stop goes away with the mission it belonged to')
  assert.equal(h.node('missionState').textContent, 'failed',
    'the pill carries the server verdict: a failed mission must not keep claiming running')

  const shown = textOf(h.node('thread'))
  assert.match(shown, /not achieved/, 'the outcome is reported as not achieved, not silently dropped')
  assert.match(shown, /planner exceeded 300000ms and was terminated/,
    'the honest reason for the failure must reach the screen')
})
