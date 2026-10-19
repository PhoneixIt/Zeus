/**
 * THE UI RENDERERS, ACTUALLY EXECUTED.
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 *
 * The user reported, from the running application:
 *
 *     could not load conversations: el is not defined
 *     ... and typing "hi" produced only
 *     "Nothing has arrived for 90 seconds. The mission may have stalled"
 *
 * One missing name caused both. This file's element builder was `el()`, and its element
 * accessor was also `el()`. A partial rename split them into `mk()` (builder) and `$`
 * (accessor), and updated addMessage and addError - but NOT addPlan, addStatus, or
 * renderSessions. Those three kept calling `el('div', 'status')`, which no longer existed.
 *
 * The two symptoms are the same fault seen from two angles, and the second one is the lesson:
 *
 *   - renderSessions crashed on a direct call, so it SAID SO. That symptom was legible.
 *   - addStatus crashed on every progress event, from inside the poll loop. The throw aborted
 *     the loop BEFORE the line that advances the cursor, so the cursor stayed pinned at the
 *     poison event. Every subsequent poll re-delivered the same events and re-threw on the same
 *     one. Nothing rendered, nothing errored, and the watchdog - correctly detecting silence -
 *     reported a STALL. The user was told the mission was stalling. The mission was fine; the
 *     RENDERER was broken, and the feed had no way to tell the difference.
 *
 * So a rendering fault did not degrade one feature. It took out every feature that renders,
 * and it reported itself as a fault in an unrelated part of the system.
 *
 * ============================================================================================
 * WHAT IS AND IS NOT TESTED
 * ============================================================================================
 *
 * The real `UI_JS` string is loaded and RUN, against a DOM stub, and the real functions are
 * called. A test that greps the source for a bad identifier cannot catch this, because the bug
 * was never that an identifier was misspelled - it was that a correct identifier referred to a
 * function that had been renamed out from under it, in some call sites and not others.
 *
 * The DOM stub auto-creates a node for ANY id asked for, so the script's wiring never fails for
 * want of an element. That is deliberate: the property under test is "does the renderer reach the
 * function it names", not "is the markup right".
 *
 * The last test does not stub any function at all. It breaks a real DOM node mid-render and
 * asserts the feed still makes progress. That is the guarantee that turns any future rendering
 * fault into one bad line of text instead of a silent, permanent wedge.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI_ASSETS = pathToFileURL(
  resolve(HERE, '..', 'live', 'agent', 'ui-assets.ts'),
).href

/**
 * A DOM node that records what was put on it and never throws on its own.
 *
 * `failAppend` is the hook the isolation test uses: setting it makes every append to THIS node
 * throw, which is what a genuinely broken renderer looks like to the poll loop.
 */
interface StubNode {
  tag: string
  id: string
  children: StubNode[]
  textContent: string
  innerHTML: string
  value: string
  title: string
  disabled: boolean
  scrollTop: number
  scrollHeight: number
  className: string
  style: Record<string, string>
  dataset: Record<string, string>
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
  setAttribute(...a: unknown[]): void
  getAttribute(k: string): string | null
  focus(): void
  blur(): void
  click(): void
  get firstChild(): StubNode | null
  failAppend: boolean
}

function makeNode(tag = 'div', id = ''): StubNode {
  // Declared up front, because the methods below close over them and a property assigned after
  // the literal is undefined at the moment a method runs.
  const classes = new Set<string>()
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
  let html = ''

  const n = {
    tag,
    id,
    children: [] as StubNode[],
    textContent: '',
    value: '',
    title: '',
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
    className: '',
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    failAppend: false,
    removed: false,
    classes,
    listeners,
    // addPlan writes '<b></b>' and then reaches straight into querySelector('b'). A stub that
    // stored innerHTML as an inert string would make that dereference null, and the test would
    // fail for a reason that has nothing to do with the defect it is here to catch. So the one
    // shape the client actually writes is parsed into a real child.
    get innerHTML(): string {
      return html
    },
    set innerHTML(v: string) {
      html = v
      const m = /^\s*<([a-zA-Z0-9]+)\b[^>]*>\s*<\/([a-zA-Z0-9]+)>\s*$/.exec(String(v))
      if (m && m[1] === m[2]) {
        const child = makeNode(m[1])
        n.children.push(child)
      } else if (m) {
        n.children.push(makeNode(m[1]))
      }
    },
    appendChild(c: StubNode) {
      if (n.failAppend) throw new Error('stubbed appendChild failure')
      n.children.push(c)
      return c
    },
    removeChild(c: StubNode) {
      const i = n.children.indexOf(c)
      if (i >= 0) n.children.splice(i, 1)
      return c
    },
    remove() {
      n.removed = true
    },
    querySelector(sel: string) {
      // Enough selector support for the shapes this script actually uses: a tag, a class, or an
      // id. Returns null when nothing matches, because that is what a browser does and a
      // renderer must survive it.
      for (const c of n.children) {
        if (sel.startsWith('.') && c.classes.has(sel.slice(1))) return c
        if (sel.startsWith('#') && c.id === sel.slice(1)) return c
        if (!sel.startsWith('.') && !sel.startsWith('#') && c.tag === sel) return c
        const deep = c.querySelector(sel)
        if (deep) return deep
      }
      return null
    },
    querySelectorAll(sel: string) {
      const out: StubNode[] = []
      const walk = (x: StubNode) => {
        for (const c of x.children) {
          if (sel.startsWith('.') && c.classes.has(sel.slice(1))) out.push(c)
          walk(c)
        }
      }
      walk(n)
      return out
    },
    addEventListener(type: string, fn: (...a: unknown[]) => void) {
      const cur = listeners.get(type) ?? []
      cur.push(fn)
      listeners.set(type, cur)
    },
    removeEventListener() {},
    setAttribute() {},
    getAttribute() {
      return null
    },
    focus() {},
    blur() {},
    click() {},
    get firstChild() {
      return n.children.length > 0 ? n.children[0] : null
    },
    classList: undefined as unknown,
  } as unknown as StubNode & { classes: Set<string>; listeners: Map<string, unknown>; removed: boolean }

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

/**
 * All the text under a node, recursively.
 *
 * The client nests text: addStatus puts it in a `.txt` span inside a `.status` div, so reading
 * the outer node's textContent finds nothing. Asserting on the right node is the difference
 * between "it rendered" and "it rendered the thing you asked about".
 */
function textOf(n: StubNode): string {
  const parts: string[] = []
  if (n.textContent) parts.push(n.textContent)
  for (const c of n.children) parts.push(textOf(c))
  return parts.join(' ')
}

interface Harness {
  ctx: Record<string, unknown>
  node(id: string): StubNode
  /** Every id the script asked for, so a test can assert the wiring actually ran. */
  asked: string[]
  fetchLog: string[]
}

/**
 * Load the real UI script into a VM with a DOM stub, and let its top-level wiring run.
 *
 * `feed` is the /progress response queue. Each entry is one poll's worth of events.
 */
async function harness(feed: Array<Array<Record<string, unknown>>> = []): Promise<Harness> {
  const { UI_JS } = (await import(UI_ASSETS)) as { UI_JS: string }
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

  const timers = new Map<number, () => void>()
  let nextTimer = 1
  // The script reaches for timers on BOTH the global and `window`. A stub that only has one of
  // the two would fail on the script's own wiring and tell us nothing about the renderers.
  const setIntervalFn = (fn: () => void) => { const id = nextTimer++; timers.set(id, fn); return id }
  const clearIntervalFn = (id: number) => { timers.delete(id) }
  const setTimeoutFn = (fn: () => void) => { fn(); return 0 }
  const clearTimeoutFn = () => {}

  const sandbox: Record<string, unknown> = {
    console,
    document: {
      getElementById: getEl,
      createElement: (tag: string) => makeNode(tag),
      createTextNode: (t: string) => {
        const n = makeNode('#text')
        n.textContent = t
        return n
      },
      querySelector: () => makeNode('div'),
      querySelectorAll: () => [],
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
      // Any other route: a well-formed empty success, so the script's startup does not die on
      // an unrelated fetch. Tests that care supply their own routes.
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

  // The script starts work at load: connect() polls immediately, and the session/model/guard
  // routes are fetched. Those promises are fire-and-forget, so a test that finishes while they
  // are still in flight gets them reported as an unhandled rejection against the NEXT test.
  // Draining here means every test begins from a quiet machine, which is also the only way the
  // cursor test can attribute a failure to the events it deliberately fed.
  await settle()

  return {
    ctx: ctx as Record<string, unknown>,
    node: getEl,
    asked,
    fetchLog,
  }
}

/** Let every already-scheduled promise and timer callback finish. */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((r) => setImmediate(r))
  }
}

// ============================================================================================

test('the UI script compiles', async () => {
  // A syntax error here would take the whole page down; assert it separately from behaviour so
  // a future edit that breaks the script says so plainly.
  const { UI_JS } = (await import(UI_ASSETS)) as { UI_JS: string }
  assert.doesNotThrow(() => new vm.Script(UI_JS, { filename: 'ui-assets.js' }))
})

test('addStatus renders a progress line', async () => {
  // THE REGRESSION. This threw `el is not defined`, and because it is called from the poll loop
  // that throw also pinned the feed's cursor and presented as a 90-second stall.
  const h = await harness()
  const addStatus = h.ctx.addStatus as (t: string) => void
  assert.equal(typeof addStatus, 'function', 'addStatus must be reachable')
  assert.doesNotThrow(() => addStatus('Asking the local model to interpret the goal...'))

  const thread = h.node('thread')
  assert.ok(thread.children.length > 0, 'addStatus must put something in the thread')
  assert.match(
    textOf(thread),
    /Asking the local model/,
    'the status text must actually be on screen, not merely counted',
  )
})

test('addPlan renders every step of a plan', async () => {
  const h = await harness()
  const addPlan = h.ctx.addPlan as (s: Array<{ id: string; intent: string; tool: string }>) => void
  assert.equal(typeof addPlan, 'function', 'addPlan must be reachable')
  assert.doesNotThrow(() => addPlan([
    { id: 's1', intent: 'Open Notepad', tool: 'launch-app' },
    { id: 's2', intent: 'Type the sentence', tool: 'desktop-input' },
  ]))
  const thread = h.node('thread')
  assert.ok(thread.children.length > 0, 'addPlan must put something in the thread')
  const shown = textOf(thread)
  assert.match(shown, /Open Notepad/, 'each step intent must be on screen')
  assert.match(shown, /Type the sentence/, 'every step must be rendered, not just the first')

  // The tool name is NO LONGER rendered, and that is the change rather than an omission.
  //
  // This assertion used to require "launch-app" on screen. The interface showed a person who asked
  // a question a list of internal capability identifiers, and nothing about that list was
  // actionable by anyone. The intent is still shown, because it is in the product's own language;
  // the tool is not, because it is not.
  assert.doesNotMatch(shown, /launch-app/, 'internal tool names must not be shown as the plan')
  assert.doesNotMatch(shown, /desktop-input/)
  assert.match(shown, /Zeus is planning 2 step\(s\)/, 'the plan speaks in the product voice')
})

test('a table answer renders as a table, not as text', async () => {
  // The chat-first change: a research result that IS a table has to arrive as one. Rendering it as
  // a comma-joined string would be technically delivered and practically useless.
  const h = await harness()
  const addMessage = h.ctx.addMessage as (
    r: string, t: string, m?: string | null, table?: unknown,
  ) => void
  assert.doesNotThrow(() => addMessage('assistant', 'Here is what I found.', 'goal satisfied', {
    headers: ['Company', 'Founded'],
    rows: [['Veeam', '2006'], ['Rubrik', '2014']],
    totalRows: 2,
  }))
  const shown = textOf(h.node('thread'))
  assert.match(shown, /Company/, 'headers must render')
  assert.match(shown, /Veeam/, 'cells must render')
  assert.match(shown, /2014/, 'every cell of every shown row must render')
})

test('an answer with no table still renders, rather than throwing', async () => {
  // The absent-table path is the common one, and a renderer that assumed a table would take the
  // conversation down on every conversational reply.
  const h = await harness()
  const addMessage = h.ctx.addMessage as (r: string, t: string, m?: string | null, t2?: unknown) => void
  assert.doesNotThrow(() => addMessage('assistant', 'Hello.', null, undefined))
  assert.match(textOf(h.node('thread')), /Hello\./)
  assert.match(textOf(h.node('thread')), /ZEUS/, 'the speaker is Zeus')
})

test('renderSessions renders a list, and an empty list', async () => {
  // THE OTHER HALF OF THE USER'S SCREENSHOT. This is the one that surfaced the fault's text.
  const h = await harness()
  const renderSessions = h.ctx.renderSessions as (l: unknown[]) => void
  assert.equal(typeof renderSessions, 'function', 'renderSessions must be reachable')

  assert.doesNotThrow(() => renderSessions([]), 'the empty list must render')
  assert.doesNotThrow(
    () => renderSessions([
      { id: 'abc', title: 'New chat', model: 'opencode/test-free' },
      { id: 'def', title: 'Notepad work', model: 'opencode/test-free' },
    ]),
    'a populated list must render',
  )
})

test('a renderer that throws cannot pin the feed cursor', async () => {
  // THE STRUCTURAL TEST, and the one that actually matches what the user experienced.
  //
  // A single unrenderable event must not stop the batch, and must not stop the cursor. If it
  // could, then any future renderer bug becomes indistinguishable from a hung mission - which is
  // exactly the misdiagnosis that sent the user hunting for a planner fault while the planner
  // was fine and a DOM helper was not.
  //
  // No function is stubbed and no internal variable is read. The thread node is made to throw on
  // append, so the failure is produced by the real code path, and the assertion is on the NEXT
  // request the client makes - the only thing an observer (the server, the user) can see.
  const h = await harness()
  const thread = h.node('thread')

  const events = [
    { kind: 'status', text: 'one' },
    { kind: 'status', text: 'two' },
    { kind: 'done', ok: true, text: 'the answer' },
  ]
  const requested: string[] = []
  let serve = true

  const g = h.ctx as unknown as { fetch: (u: string) => Promise<unknown> }
  g.fetch = async (u: string) => {
    const url = String(u)
    if (url.startsWith('/progress')) {
      requested.push(url)
      const batch = serve ? events : []
      serve = false
      return {
        ok: true,
        status: 200,
        json: async () => ({ events: batch, total: 3 }),
        text: async () => JSON.stringify({ events: batch, total: 3 }),
      }
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
  }

  const pollFeed = h.ctx.pollFeed as () => Promise<void>
  assert.equal(typeof pollFeed, 'function', 'pollFeed must be reachable')

  // Break rendering only for the polls this test drives. Set after the harness has drained, and
  // cleared again before the test returns, so no background poll is left throwing.
  thread.failAppend = true

  // Must not reject, even though every event throws while rendering.
  await assert.doesNotReject(() => pollFeed(), 'one unrenderable event must not reject the poll')

  // Now the real assertion. If the cursor advanced, the next request asks for events after 3.
  // If the throw pinned it at 0, the next request asks for the same batch again - forever.
  await pollFeed()

  thread.failAppend = false
  await settle()

  const polls = requested.filter((u) => u.startsWith('/progress'))
  assert.ok(polls.length >= 2, `expected at least two polls, saw ${polls.length}`)
  assert.match(
    polls[1],
    /since=3/,
    `the cursor must advance past a batch whose rendering failed; second poll asked for "${polls[1]}"`,
  )
})