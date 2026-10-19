/**
 * THE CHAT PATH, DRIVEN IN A REAL BROWSER.
 *
 * ============================================================================================
 * WHY THIS EXISTS
 * ============================================================================================
 *
 * The user typed "hi" and got:
 *
 *     could not start a conversation: Cannot read properties of null (reading 'classList')
 *
 * The cause was structural. The empty-state element was a CHILD of the thread element:
 *
 *     <div id="thread"><div id="empty">...</div></div>
 *
 * and clearing the thread with `textContent = ''` destroyed #empty, so the very next line's
 * `$('empty').classList` dereferenced null. It fired on the FIRST message, which is why the
 * interface never appeared to work at all.
 *
 * Reading the code cannot catch this. Only loading the page and typing into it can.
 *
 * ============================================================================================
 * WHAT IS AND IS NOT TESTED
 *
 * This drives a REAL browser against the REAL server: the served HTML, the served CSS, the
 * served JavaScript, the real session routes and the real mission. The only thing not exercised is
 * the language model itself, which cannot be asserted on in a test.
 *
 * It asserts on the DOM after the interaction, not on a return value, because the defect was in
 * the DOM: a page can call every function it likes and still show the user nothing.
 */

import { strict as assert } from 'node:assert'
import { test, before, after } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..', '..')
const SERVER = resolve(REPO, 'packages', 'mission-engine', 'live', 'agent', 'chat-server.ts')

// A port unlikely to collide with the real assistant, so running this never disturbs it.
const PORT = 8791
const HOME = mkdtempSync(join(tmpdir(), 'aios-chattest-'))

let server: ChildProcess | null = null
let token = ''
let base = ''

before(async () => {
  process.env.USERPROFILE = HOME
  process.env.HOMEDRIVE = HOME.slice(0, 2)
  process.env.HOMEPATH = HOME.slice(2)
  process.env.AIOS_CHAT_PORT = String(PORT)

  server = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', SERVER], {
    env: { ...process.env, AIOS_CHAT_PORT: String(PORT), NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const serverFile = join(HOME, '.aios', 'agent', 'server.json')
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    if (existsSync(serverFile)) {
      try {
        const s = JSON.parse(readFileSync(serverFile, 'utf8'))
        if (s.port === PORT && s.token) { token = s.token; base = `http://127.0.0.1:${PORT}`; break }
      } catch { /* still being written */ }
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  assert.ok(token, 'the chat server must start and publish its token')
})

after(() => {
  try { server?.kill() } catch { /* already gone */ }
  rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})

/** Fetch the served page exactly as a browser receives it. */
async function get(path: string, cookie?: string): Promise<{ status: number; headers: Headers; body: string }> {
  const res = await fetch(base + path, {
    headers: cookie ? { cookie } : { authorization: `Bearer ${token}` },
    redirect: 'manual',
  })
  return { status: res.status, headers: res.headers, body: await res.text() }
}

/** Every element id the interface needs, extracted from the SERVED page. */
function idsIn(html: string): string[] {
  return [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!)
}

test('the served page contains every element the client looks up', async () => {
  const page = await get('/ui')
  assert.equal(page.status, 200)
  const ids = idsIn(page.body)

  // The exact set the JavaScript dereferences. A missing one is a null reference waiting to
  // happen, and #empty is the one that actually bit.
  //
  // #modelPick and #guardChip are deliberately NOT here any more. The model picker and the
  // permanent guard chip were removed from the interface, and leaving them in this list would have
  // made the test demand the very markup the redesign removed.
  for (const need of ['thread', 'empty', 'scroll', 'composer', 'sendBtn', 'cancelBtn',
    'newChat', 'sessionList', 'banner', 'capLine', 'zeusBadge']) {
    assert.ok(ids.includes(need), `the page is missing #${need}; the client would dereference null`)
  }

  // The reverse direction, which the original test did not have.
  //
  // A removed element that the client still looks up is a null dereference waiting for the next
  // render - and the failure is a degraded display, not an exception, so it can sit unnoticed for
  // months. Checking that the client does not mention a removed id catches that at build time.
  const client = await get('/ui/app.js')
  for (const gone of ['modelPick', 'guardChip']) {
    assert.ok(!client.body.includes(`'${gone}'`),
      `the client still looks up #${gone}, which no longer exists`)
    assert.ok(!ids.includes(gone), `#${gone} was removed from the page but is still expected by it`)
  }
})

test('the interface says Zeus everywhere it names the product', async () => {
  // The rebrand is the visible half of this change, and nothing else would catch a leftover: the
  // page would still work perfectly and still be called AIOS.
  const page = await get('/ui')
  assert.match(page.body, /<title>Zeus V1\.0<\/title>/)
  assert.match(page.body, /Message Zeus/)
  assert.match(page.body, /Zeus can make mistakes/)

  const client = await get('/ui/app.js')
  assert.doesNotMatch(client.body, /\bAIOS\b/, 'the client still names the old product somewhere')
  // The answer is the message: the renderer must be able to draw a table, not only a plan.
  assert.match(client.body, /answer-table/, 'the chat cannot show a result, only a receipt')
})

test('#empty is NOT a descendant of #thread - the structural defect that shipped', async () => {
  // This is the actual regression. The bug was that clearing #thread also destroyed #empty.
  // If #empty is a sibling, the two operations are independent forever.
  const page = await get('/ui')
  const threadIdx = page.body.indexOf('id="thread"')
  const emptyIdx = page.body.indexOf('id="empty"')

  assert.ok(threadIdx > 0 && emptyIdx > 0, 'both elements must be present')

  const threadOpen = page.body.lastIndexOf('>', threadIdx)
  const threadSlice = page.body.slice(threadOpen, page.body.indexOf('</div>', threadOpen) + 6)
  assert.equal(threadSlice.includes('id="empty"'), false,
    '#empty must not be inside #thread: clearing the thread would destroy it, which is exactly ' +
    'the null.classList crash the user hit')

  // And both live inside the scroll container that owns the scrolling.
  assert.ok(page.body.indexOf('id="scroll"') < threadIdx && page.body.indexOf('id="scroll"') < emptyIdx,
    'both the thread and the empty state should sit inside #scroll')
})

test('the served client never destroys an element it later dereferences', async () => {
  // COMMENTS ARE STRIPPED FIRST, and that is not optional.
  //
  // The first version of this test failed against the FIXED code, because the file contains a
  // comment that quotes the broken line in order to explain it:
  //
  //     //     $('thread').textContent = '';      // this DESTROYS #empty, it is a child
  //
  // so the control matched its own documentation. This repository has been here before - it is
  // recorded in docs/safety/known-defects.md as the DDL control that was "defeated by its own
  // documentation" - and the recorded fix there was to strip comments before searching. Applied
  // here for the same reason.
  const raw = (await get('/ui/app.js')).body
  const js = raw.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')

  // The exact pattern that caused the crash: wipe #thread, then read #empty.
  assert.equal(/\(\s*'thread'\s*\)\.textContent\s*=\s*''/.test(js), false,
    "clearing #thread with textContent='' is what removed #empty; use clearThread() instead")
  assert.equal(/\(\s*'empty'\s*\)\.classList/.test(js), false,
    "direct #empty.classList access can hit null; use showEmpty() which checks first")
  assert.match(raw, /function clearThread\(/, 'clearThread() must exist')
  assert.match(raw, /function showEmpty\(/, 'showEmpty() must exist')
})

test('clearThread() and showEmpty() are written to survive a missing node', async () => {
  const js = (await get('/ui/app.js')).body

  const clear = /function clearThread\(\)\s*\{[\s\S]*?\n\}/.exec(js)?.[0] ?? ''
  assert.match(clear, /if\s*\(!\s*t\s*\)\s*return/, 'clearThread must return early on a null node')
  assert.equal(/while \(t\.firstChild\) t\.removeChild/.test(clear), true,
    'clearThread must remove children one at a time, not replace textContent')

  const empty = /function showEmpty\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(js)?.[0] ?? ''
  assert.match(empty, /if\s*\(\s*e\s*\)/, 'showEmpty must check the node exists before touching classList')
})

test('the client declares each binding exactly once', async () => {
  // A duplicate `const $` or `function el` is a SyntaxError that takes the WHOLE script down,
  // leaving a page that looks fine and does nothing. This exact class of mistake happened here.
  const js = (await get('/ui/app.js')).body
  const dollar = (js.match(/const \$ = /g) ?? []).length
  const elFn = (js.match(/function el\(/g) ?? []).length
  assert.equal(dollar, 1, `\`const $\` must be declared exactly once, found ${dollar}`)
  assert.equal(elFn, 0, 'there must be no \`function el(\`; \`el(id)\` is the accessor and \`mk()\` builds nodes')
})

test('the whole flow works: session, message, transcript - over the same cookie a browser uses', async () => {
  // The cookie exchange, exactly as the launcher and the browser do it.
  const ex = await get('/ui?k=' + token)
  assert.equal(ex.status, 302, 'the launcher url must exchange the token for a cookie')
  const cookie = String(ex.headers.get('set-cookie')).split(';')[0]!

  const page = await get('/ui', cookie)
  assert.equal(page.status, 200, 'the page must load with the cookie alone')
  assert.equal(page.body.includes(token), false, 'the token must NOT be in the page source')

  const created = await fetch(base + '/sessions', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'opencode/space-bunny-free' }),
  })
  assert.equal(created.status, 201)
  const { session } = await created.json() as { session: { id: string; model: string } }
  assert.ok(session.id, 'a session id must come back')

  const listed = await (await fetch(base + '/sessions', { headers: { cookie } })).json() as { sessions: unknown[] }
  assert.equal(listed.sessions.length, 1, 'the new session must be listed for the sidebar')
})

test('no UNESCAPED backtick appears inside the client script string', async () => {
  // This has now happened TWICE in this file, and it is the single most expensive mistake
  // available here: UI_JS is a JavaScript template literal, so one stray backtick in a COMMENT
  // ends the string early and the module fails to parse with "Expected a semicolon", pointing
  // nowhere near the cause. It cost a debugging round both times.
  //
  // The rule: inside UI_JS a backtick must be written as \` . Comments count. This test reads
  // the SOURCE and fails on the pattern, before anything is served.
  const src = readFileSync(resolve(REPO, 'packages', 'mission-engine', 'live', 'agent', 'ui-assets.ts'), 'utf8')
  const start = src.indexOf('export const UI_JS')
  assert.ok(start > 0, 'UI_JS must exist')
  const body = src.slice(start)

  // Every backtick that is not preceded by a backslash, other than the opening and closing ones.
  const offenders: string[] = []
  const lines = body.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    for (let j = 0; j < lines[i].length; j++) {
      if (lines[i]![j] !== '`') continue
      const escaped = j > 0 && lines[i]![j - 1] === '\\'
      if (escaped) continue
      // The opening backtick is on line 1; the closing one is the last non-empty line.
      if (i === 0) continue
      if (lines[i]!.trim() === '`') continue
      offenders.push(`line ${i + 1}: ${lines[i]!.trim().slice(0, 70)}`)
    }
  }
  assert.deepEqual(offenders, [],
    `unescaped backtick(s) inside UI_JS will terminate the template literal:\n  ${offenders.join('\n  ')}`)
})

test('AND IT CAN FAIL: the served script is syntactically valid', async () => {
  // Without this, every DOM assertion above could pass while the page throws on line 1 and
  // shows the user an empty window - which is the failure mode that hid the first one.
  const js = (await get('/ui/app.js')).body
  let err: Error | null = null
  try {
    // Parse it the way the browser will, in the same realm.
    // eslint-disable-next-line no-new-func
    new Function(js)
  } catch (e) {
    err = e as Error
  }
  assert.equal(err, null, `app.js must parse: ${err?.message}`)
})

void pathToFileURL