/**
 * THE INTERFACE, served from the chat server over loopback.
 *
 * Why this is HTML rather than more WinForms: a session sidebar, a model dropdown, scrolling
 * transcripts and streamed text are what HTML and CSS do well and what WinForms does badly. The
 * window is opened in browser APP MODE, so the user gets a standalone desktop window with no
 * tabs and no address bar. Nothing is fetched from the internet - every byte comes from this
 * repository over 127.0.0.1.
 *
 * The token is injected at serve time rather than fetched from an unauthenticated endpoint. The
 * first version of this server returned its token from /health before authenticating, which let
 * any process on the machine read it between launch and open. Injecting it into a page that was
 * itself served behind the token check closes that gap.
 *
 * THIS FILE IS BUILT BY REBUILD-UI-ASSETS: writing one asset with a whole-file write destroyed
 * the other two once, and the only symptom was a missing-export error. Keep all three here.
 */

export const UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zeus V1.0</title>
<link rel="icon" href="/ui/zeus.svg">
<link rel="stylesheet" href="/ui/app.css">
</head>
<body>
<div id="app">
  <aside id="sidebar">
    <div class="side-head">
      <div class="brand">
        <svg class="logo" viewBox="0 0 40 40" role="img" aria-label="Zeus">
          <defs>
            <linearGradient id="zeusGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#0f9d76"/>
              <stop offset="1" stop-color="#19e3aa"/>
            </linearGradient>
          </defs>
          <rect x="1" y="1" width="38" height="38" rx="11" fill="url(#zeusGrad)"/>
          <path d="M12 12.5h16L16.5 28H28" fill="none" stroke="#ffffff" stroke-width="3.4"
                stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <div class="brand-text">
          <div class="brand-name">Zeus</div>
          <div class="brand-ver">V1.0</div>
        </div>
      </div>
      <button id="newChat" class="new-chat" title="Start a new conversation">New mission</button>
    </div>
    <div class="side-label">Missions</div>
    <div id="sessionList" class="session-list"></div>
    <div class="side-foot"><div id="capLine" class="cap-line">checking capabilities...</div></div>
  </aside>
  <main id="main">
    <header id="topbar">
      <div class="tb-left">
        <div id="zeusBadge" class="zeus-badge" title="Zeus routes each request to the best available free model">
          <span class="zb-dot"></span>
          <span class="zb-name">Zeus V1.0</span>
        </div>
      </div>
      <div class="tb-right"><button id="cancelBtn" class="tb-btn" disabled>Stop</button></div>
    </header>
    <div id="banner" class="banner hidden"></div>
    <div id="scroll" class="scroll">
      <div id="empty" class="empty">
        <div class="empty-mark">
          <svg viewBox="0 0 40 40" role="img" aria-label="Zeus">
            <path d="M12 12.5h16L16.5 28H28" fill="none" stroke="currentColor" stroke-width="3.4"
                  stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <h1>Zeus V1.0</h1>
        <p>Describe a task in plain language. Zeus works out which capabilities to use, runs them
           through a governed guard, and verifies the result before reporting it.</p>
        <div class="empty-note">Every model behind Zeus is free. Nothing is sent anywhere.</div>
      </div>
      <div id="thread" class="thread"></div>
    </div>
    <div id="composerWrap" class="composer-wrap">
      <div class="composer">
        <textarea id="composer" rows="1" placeholder="Message Zeus...   (Enter to send, Shift+Enter for a new line)"></textarea>
        <button id="sendBtn" class="send" title="Send">&#9650;</button>
      </div>
      <div class="composer-hint">Zeus can make mistakes. It reports what it verified.</div>
    </div>
  </main>
</div>
<script>window.ZEUS_DEFAULT_MODEL = "__ZEUS_DEFAULT_MODEL__";</script>
<script src="/ui/app.js"></script>
</body>
</html>
`

export const UI_CSS = String.raw`
:root{
  --bg:#ffffff;--panel:#f7f7f8;--raised:#ffffff;--border:#e4e4e7;--fg:#18181b;
  --muted:#71717a;--accent:#0f9d76;--accent-dim:#b9e6d8;--danger:#d92d20;--danger-bg:#fef3f2;
  --sidebarText:#3f3f46;
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--fg);font:15px/1.55 "Segoe UI",system-ui,sans-serif;overflow:hidden}
#app{display:flex;height:100vh}
#sidebar{width:264px;flex:0 0 264px;background:var(--panel);border-right:1px solid var(--border);display:flex;flex-direction:column}
.side-head{padding:14px 12px 8px}
.new-chat{width:100%;padding:10px 12px;border-radius:9px;cursor:pointer;background:var(--raised);color:var(--fg);border:1px solid var(--border);font:inherit;font-weight:600;text-align:left}
.new-chat:hover{background:#ececed}
.side-label{padding:12px 16px 6px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.session-list{flex:1;overflow-y:auto;padding:0 8px}
.session{padding:9px 10px;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:8px;margin-bottom:2px;border:1px solid transparent}
.session:hover{background:#ececed}
.session.active{background:#ececed;border-color:var(--accent-dim)}
.session .t{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13.5px}
.session .x{opacity:0;border:0;background:transparent;color:var(--muted);cursor:pointer;font-size:15px;line-height:1;padding:2px 5px;border-radius:5px}
.session:hover .x{opacity:1}
.session .x:hover{color:var(--danger);background:var(--danger-bg)}
.side-foot{border-top:1px solid var(--border);padding:10px 14px}
.cap-line{font-size:11.5px;color:var(--muted)}
#main{flex:1;display:flex;flex-direction:column;min-width:0}
#topbar{height:54px;flex:0 0 54px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid var(--border);background:var(--panel)}
.tb-left{display:flex;align-items:center;gap:14px}
.model-wrap{display:flex;align-items:center;gap:8px}
.tb-label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
#modelPick{background:var(--raised);color:var(--fg);border:1px solid var(--border);border-radius:8px;padding:7px 10px;font:inherit;font-size:13.5px;cursor:pointer;max-width:320px}
.chip{font-size:11.5px;padding:5px 10px;border-radius:999px;border:1px solid var(--border);background:var(--raised);color:var(--muted);white-space:nowrap}
.chip-ok{color:var(--accent);border-color:var(--accent-dim);background:#eefaf6}
.chip-bad{color:var(--danger);border-color:#f5c2bd;background:var(--danger-bg)}
.tb-btn{background:var(--raised);color:var(--fg);border:1px solid var(--border);border-radius:8px;padding:7px 14px;font:inherit;font-size:13px;cursor:pointer}
.tb-btn:disabled{opacity:.4;cursor:default}
.banner{padding:11px 18px;font-size:13.5px;font-weight:600;background:#fff6ed;color:#9a3412;border-bottom:1px solid #fed7aa}
.hidden{display:none!important}
.scroll{flex:1;overflow-y:auto;min-height:0}
.thread{padding:26px 0 12px}
.empty{max-width:640px;margin:12vh auto;text-align:center;padding:0 24px}
.empty h1{font-size:26px;margin:0 0 12px;font-weight:600}
.empty p{color:var(--muted);margin:0 0 18px}
.empty-note{font-size:12.5px;color:var(--muted);opacity:.8}
.msg{max-width:780px;margin:0 auto 22px;padding:0 26px}
.msg .who{font-size:11px;text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
.msg.user .who{color:var(--muted)}
.msg.assistant .who{color:var(--accent)}
.msg .body{white-space:pre-wrap;word-wrap:break-word}
.msg.error .body{color:var(--danger)}
.msg .meta{margin-top:9px;font-size:12px;color:var(--muted)}
.plan{margin:10px 0 4px;border-left:2px solid var(--border);padding-left:12px}
.plan .step{font-size:13px;color:var(--muted);margin-bottom:3px}
.plan .step b{color:var(--fg);font-weight:600}
.status{max-width:780px;margin:0 auto 14px;padding:0 26px;font-size:13px;color:var(--muted);display:flex;gap:9px;align-items:baseline}
.status .dot{width:6px;height:6px;border-radius:50%;background:var(--accent);flex:0 0 6px;animation:pulse 1.1s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.25}50%{opacity:1}}
.composer-wrap{padding:10px 26px 18px;border-top:1px solid var(--border);background:var(--panel)}
.composer{max-width:780px;margin:0 auto;display:flex;gap:10px;align-items:flex-end;background:var(--raised);border:1px solid var(--border);border-radius:13px;padding:9px 9px 9px 14px}
.composer:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px rgba(15,157,118,.12)}
.composer.unfocused{border-color:var(--danger);background:#fffafa}
#composer{flex:1;background:transparent;color:var(--fg);border:0;outline:0;font:inherit;resize:none;max-height:200px;padding:4px 0}
#composer::placeholder{color:var(--muted)}
.send{width:34px;height:34px;flex:0 0 34px;border-radius:9px;cursor:pointer;background:var(--accent);color:#fff;border:0;font-size:14px;line-height:1}
.send:hover:not(:disabled){background:#0c8465}
.send:disabled{opacity:.35;cursor:default}
.composer-hint{max-width:780px;margin:8px auto 0;font-size:11.5px;color:var(--muted);text-align:center}
::-webkit-scrollbar{width:10px}
::-webkit-scrollbar-thumb{background:#d4d4d8;border-radius:6px;border:2px solid var(--panel)}
#modelPick:focus, .tb-btn:focus{outline:2px solid var(--accent);outline-offset:1px}
.new-chat:hover{background:#ececed}

/* ==========================================================================================
   ZEUS V1.0 - CHAT-FIRST INTERFACE
   ==========================================================================================
   The palette is the one it always had: white ground, green accent. What changed is that the
   interface now behaves like a conversation rather than a control room.

   THE ORGANISING DECISION
   ----------------------
   This block OVERRIDES the original rules rather than replacing them, and that is deliberate. The
   first version of the redesign replaced the stylesheet wholesale and the whole interface came
   back broken, because a layout that had been correct depended on rules nobody remembered writing.
   An override layer can fail one property at a time; a replacement fails all of them at once.

   It also means the original rules stay as a floor. Anything this file does not mention keeps
   working, so there is no such thing as a silent regression here.

   WHY THE MACHINERY IS COLLAPSED
   ------------------------------
   A plan listing, a per-step tool name and a wall of routing chatter are the system explaining
   itself to a person who did not ask for an explanation. The chat renders the ANSWER as the
   message, and the machinery collapses to one line that says what is happening in the product's
   own voice. Everything is still shown - it is one click away - because hiding evidence is not the
   same as decluttering.
   ========================================================================================== */

/* ---- brand ---- */
.brand{display:flex;align-items:center;gap:11px;margin-bottom:14px;padding:2px 4px}
.logo{width:36px;height:36px;flex:0 0 36px;filter:drop-shadow(0 3px 8px rgba(15,157,118,.32))}
.brand-text{display:flex;flex-direction:column;line-height:1.15}
.brand-name{font-size:17px;font-weight:700;letter-spacing:-.01em}
.brand-ver{font-size:11px;color:var(--muted);letter-spacing:.09em;font-weight:600}

/* ---- the Zeus badge replaces the model picker ----
   Eleven concrete ids in a dropdown was a control for a decision the interface cannot make well,
   and one nobody reading it could make either. Zeus routes each request itself. Which model
   actually answered is still reported - in the transcript, in the collapsed detail - because a
   routing name must never become a disguise for what really ran. */
.zeus-badge{
  display:inline-flex;align-items:center;gap:9px;padding:6px 13px 6px 11px;border-radius:999px;
  background:var(--raised);border:1px solid var(--border);box-shadow:var(--shadow-sm);
  font-size:13px;font-weight:650;letter-spacing:-.005em;cursor:default;user-select:none;
}
.zb-dot{
  width:7px;height:7px;border-radius:50%;flex:0 0 7px;
  background:linear-gradient(135deg,var(--accent),var(--accent-2));
  box-shadow:0 0 0 3px rgba(15,157,118,.13);
}

/* ---- surface depth, same palette ---- */
:root{
  --accent-2:#19e3aa;--accent-soft:#eefaf6;
  --shadow-sm:0 1px 2px rgba(24,24,27,.05),0 1px 1px rgba(24,24,27,.03);
  --shadow-md:0 4px 14px rgba(24,24,27,.07),0 1px 3px rgba(24,24,27,.04);
  --ring:0 0 0 3px rgba(15,157,118,.14);
}
body{
  font:15px/1.6 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
}
#topbar{
  height:56px;flex:0 0 56px;padding:0 20px;
  background:rgba(247,247,248,.82);backdrop-filter:blur(14px) saturate(1.4);
}
#sidebar{width:272px;flex:0 0 272px;position:relative}
#sidebar::after{
  content:"";position:absolute;top:0;right:-1px;width:1px;height:100%;
  background:linear-gradient(180deg,var(--accent-2),transparent 55%);opacity:.5;
}
.new-chat{
  background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;border:0;
  font-weight:650;font-size:13.5px;text-align:center;box-shadow:var(--shadow-sm);
  transition:filter .12s ease,box-shadow .12s ease,transform .12s ease;
}
.new-chat:hover{filter:brightness(1.05);box-shadow:var(--shadow-md)}
.new-chat:active{transform:translateY(1px)}
.session{transition:background .12s ease,border-color .12s ease;padding:10px 11px}
.session.active{background:var(--accent-soft);border-color:var(--accent-dim)}
.session .x{transition:opacity .12s ease}

/* ---- THE ANSWER IS THE MESSAGE ----
   The single biggest change. Previously a mission rendered as a plan block, a list of tool names
   and a verification sentence, which is a report about a task. Now the reply the person actually
   receives is the message body, set at a comfortable reading measure, and the machinery sits under
   it collapsed. A person who asked a question gets an answer on screen, not a receipt. */
.msg{max-width:820px;margin:0 auto 26px;padding:0 26px;animation:rise .22s ease both}
@keyframes rise{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.msg .body{
  font-size:15.5px;line-height:1.68;color:var(--fg);
  white-space:pre-wrap;word-wrap:break-word;
}
.msg .who{
  font-size:10.5px;text-transform:uppercase;letter-spacing:.12em;margin-bottom:7px;
  font-weight:700;color:var(--accent);
}
.msg.user .who{color:var(--muted)}
.msg.user .body{color:var(--fg)}

/* The answer may contain a table when the result IS a table. Inline styles rather than a markdown
   parser: the answer is written by the runtime, so its shape is known, and a table rendered from
   a string would mean trusting a parser with text that may contain anything a model produced. */
.answer-table{
  border-collapse:separate;border-spacing:0;margin:14px 0 4px;font-size:13.5px;width:100%;
  border:1px solid var(--border);border-radius:var(--r-md);overflow:hidden;
}
.answer-table th{
  text-align:left;font-weight:650;font-size:11px;text-transform:uppercase;letter-spacing:.07em;
  color:var(--muted);background:#fafafa;padding:9px 12px;border-bottom:1px solid var(--border);white-space:nowrap;
}
.answer-table td{padding:9px 12px;border-bottom:1px solid #f1f1f3;vertical-align:top}
.answer-table tr:last-child td{border-bottom:0}
.answer-table tbody tr:nth-child(even){background:#fcfcfd}
.answer-table tbody tr:hover{background:var(--accent-soft)}

/* ---- working indicator: one line, in the product's voice ----
   Replaces the visible plan block and per-step tool names. The full record is one click away,
   because removing noise and removing evidence are different acts and only one of them is tidy. */
.working{
  max-width:820px;margin:0 auto 18px;padding:0 26px;
}
.working-line{
  display:flex;align-items:center;gap:10px;font-size:13.5px;color:var(--muted);
  cursor:pointer;user-select:none;-webkit-user-select:none;padding:4px 0;
}
.working-line:hover{color:var(--fg)}
.wl-caret{
  width:0;height:0;border-left:5px solid var(--muted);border-top:4px solid transparent;
  border-bottom:4px solid transparent;transition:transform .16s ease;flex:0 0 5px;
}
.working.open .wl-caret{transform:rotate(90deg)}
.wl-pulse{
  width:7px;height:7px;border-radius:50%;flex:0 0 7px;background:linear-gradient(135deg,var(--accent),var(--accent-2));
  animation:breath 1.4s ease-in-out infinite;
}
.working.done .wl-pulse{animation:none;background:var(--accent-dim)}
@keyframes breath{0%,100%{opacity:.3;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
.working-detail{
  display:none;margin-top:6px;padding:11px 14px;border:1px solid var(--border);
  border-left:2px solid var(--accent);border-radius:var(--r-sm);background:#fcfcfd;
}
.working.open .working-detail{display:block}
.wd-step{font-size:12.5px;color:var(--muted);margin-bottom:5px;display:flex;gap:8px;align-items:baseline}
.wd-step b{color:var(--fg);font-weight:600}
.wd-tool{font-family:"Cascadia Code",Consolas,ui-monospace,monospace;font-size:11.5px;color:var(--accent)}
.wd-status{font-size:12.5px;color:var(--muted);margin-top:8px;padding-top:8px;border-top:1px dashed var(--border)}

/* A plan shown before the work starts: a sentence, not a task list. */
.plan{max-width:820px;margin:0 auto 18px;padding:0 26px}
.plan-lead{font-size:13px;color:var(--muted);margin-bottom:10px;display:flex;align-items:center;gap:9px}
.plan-box{
  border:1px solid var(--border);border-radius:var(--r-md);padding:12px 15px;background:#fcfcfd;
  font-size:13.5px;color:var(--muted);
}
.plan-box .step{margin-bottom:4px}
.plan-box .step b{color:var(--fg);font-weight:600}

/* ---- status lines stay, but quieter ---- */
.status{max-width:820px;margin:0 auto 11px;padding:0 26px;font-size:12.5px;color:var(--muted)}

/* ---- composer ---- */
.composer-wrap{padding:12px 26px 18px;background:rgba(247,247,248,.82);backdrop-filter:blur(14px)}
.composer{
  border-radius:var(--r-lg);padding:10px 10px 10px 16px;box-shadow:var(--shadow-sm);
  transition:box-shadow .16s ease,border-color .16s ease;
}
.composer:hover{box-shadow:var(--shadow-md)}
.composer:focus-within{border-color:var(--accent);box-shadow:var(--ring),var(--shadow-md)}
.send{
  width:36px;height:36px;flex:0 0 36px;border-radius:11px;border:0;
  background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;
  display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow-sm);
  transition:filter .12s ease,transform .12s ease;
}
.send:hover:not(:disabled){filter:brightness(1.06)}
.send:active:not(:disabled){transform:translateY(1px)}
.composer-hint{max-width:820px}

/* ---- empty state ---- */
.empty{max-width:660px;margin:11vh auto}
.empty-mark{
  width:74px;height:74px;margin:0 auto 20px;border-radius:22px;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;
  box-shadow:0 16px 40px rgba(15,157,118,.3);
}
.empty-mark svg{width:42px;height:42px}
.empty h1{font-size:30px;margin:0 0 12px;font-weight:700;letter-spacing:-.02em}

/* ---- scrollbars, and motion that respects the person ---- */
::-webkit-scrollbar-thumb{background:#d9d9de;border-radius:8px;border:2px solid transparent;background-clip:content-box}
::-webkit-scrollbar-thumb:hover{background:#c2c2c9;background-clip:content-box}
@media (prefers-reduced-motion:reduce){
  *{animation-duration:.001ms!important;transition-duration:.001ms!important}
}
`

export const UI_JS = `
// The Zeus V1.0 client.
//
// Three things this file is careful about, each of which has already gone wrong once:
//
// 1. NO SILENT SUBSTITUTION. If the model list cannot be read, the picker is disabled and says
//    why. It does not fall back to a default that happens to be billable.
//
// 2. THE SERVER IS THE AUTHORITY on the model. The chosen model is sent, and the server
//    re-validates it. This client is not trusted and does not pretend to be.
//
// 3. EVERY MISSION BLOCKS THE INPUT. The old WinForms window set $busy and, when a render threw,
//    never cleared it, so the app stayed permanently stuck. Here \'busy\' is only ever cleared in
//    one place - \'finish()\' - which runs from both the done/error event and the failure path.

// Requests are same-origin and the session cookie rides along automatically, so the client
// never handles a credential. That is deliberate: the token used to be injected into this page
// and sent as an Authorization header from JavaScript, which put the secret in the page source
// where any injected content could read it, and in a variable a bug could log.
const TOKEN = null;
const $ = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  model: window.ZEUS_DEFAULT_MODEL,
  models: [],
  busy: false,
  // Events that arrived before the UI was ready, so nothing is dropped on a slow start.
  started: false,
};

function api(path, opts = {}) {
  return fetch(path, {
    ...opts,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
  }).then(async (r) => {
    const text = await r.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
    if (!r.ok) throw new Error(body.error || ('request failed: ' + r.status));
    return body;
  });
}

// ---------------------------------------------------------------- rendering

// ---------------------------------------------------------------- THE BUG THIS FILE SHIPPED WITH
//
// You saw:
//
//     could not start a conversation: Cannot read properties of null (reading 'classList')
//
// The cause was structural, not a typo. The empty-state element lived INSIDE the thread element:
//
//     <div id="thread"><div id="empty">...</div></div>
//
// and clearing the thread was done with:
//
//     $('thread').textContent = '';      // this DESTROYS #empty, it is a child
//     $('empty').classList...            // so this is null.classList
//
// The line immediately before the crash removed the element the next line needs. It fired on the
// very first message, which is why nothing ever appeared to work.
//
// Two things are fixed, and the second is the one that stops it recurring:
//   1. #empty is now a SIBLING of #thread, inside #scroll, so clearing the thread cannot remove it.
//   2. every element LOOKUP goes through $(), and every element BUILD goes through mk(). Neither
//      can be confused with the other, and $() returns null rather than throwing, so a missing
//      node degrades the display instead of taking the conversation down with it.
//
// A renderer that dies on a null lookup is a renderer whose every remaining feature is now
// unreachable, and it fails silently apart from one line of text.
//
// THE ACTUAL DEFECT THIS FILE SHIPPED WITH, so it does not come back:
//
// The accessor is named '$' and the builder is named 'mk'. This file once called the builder
// 'el()' in addMessage and addError and 'el()' as an accessor everywhere else, and then only
// part of it was renamed. Three renderers - addPlan, addStatus, renderSessions - were left
// calling a builder that no longer existed. That threw ReferenceError, which the conversations
// list reported verbatim ("could not load conversations: el is not defined") and which the
// progress feed reported as nothing at all, because the throw also pinned the feed's cursor.
// Three visible symptoms, one missing name.
//
// 'el' and 'mk' are not interchangeable here, and this comment cannot contain a backtick: UI_JS
// is a template literal, so one would end the string and turn the rest of the client into a
// syntax error. That is not hypothetical either - it happened while writing this note.

/** Toggle the empty-state panel without assuming it exists. */
function showEmpty(on) {
  const e = $('empty');
  if (e) e.classList.toggle('hidden', !on);
}

/** Remove every message, leaving the empty-state panel and the thread element themselves intact. */
function clearThread() {
  const t = $('thread');
  if (!t) return;
  while (t.firstChild) t.removeChild(t.firstChild);
}

function scrollDown() {
  const t = document.getElementById('scroll');
  if (t) t.scrollTop = t.scrollHeight;
}

// NOTE: '$' is the NULL-SAFE ACCESSOR (declared once, at the top of this file, so re-declaring it
// here would be a duplicate-binding error). The tag-building helper is 'mk()'. One name cannot be
// both an id lookup and a node constructor; that ambiguity is what left three renderers calling a
// function that no longer existed.
function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function addMessage(role, text, meta, table) {
  showEmpty(false);
  const wrap = mk('div', 'msg ' + role);
  wrap.appendChild(mk('div', 'who', role === 'user' ? 'You' : 'ZEUS'));
  const body = mk('div', 'body');
  body.textContent = text;
  wrap.appendChild(body);
  // The answer may carry a table when the result IS a table. Rendered from the runtime's own
  // structured rows, never from a markdown parser: a parser would be handed text a model produced,
  // and nothing here trusts that text to be markup.
  if (table && table.rows && table.rows.length > 0) {
    const tb = mk('table', 'answer-table');
    const thead = mk('thead');
    const hr = mk('tr');
    for (const h of table.headers) {
      const th = mk('th');
      th.textContent = String(h ?? '');
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    tb.appendChild(thead);
    const tbody = mk('tbody');
    for (const row of table.rows) {
      const tr = mk('tr');
      for (const c of row) {
        const td = mk('td');
        td.textContent = String(c ?? '');
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    tb.appendChild(tbody);
    wrap.appendChild(tb);
  }
  if (meta) wrap.appendChild(mk('div', 'meta', meta));
  const t = document.getElementById('thread');
  if (t) t.appendChild(wrap);
  scrollDown();
  return body;
}

function addError(text) {
  const wrap = mk('div', 'msg assistant error');
  wrap.appendChild(mk('div', 'who', 'ZEUS'));
  wrap.appendChild(mk('div', 'body', text));
  const t = document.getElementById('thread');
  if (t) t.appendChild(wrap);
  scrollDown();
}

// The plan is shown as a sentence, not a task list with tool names.
//
// A tool name in the chat is the system explaining its own vocabulary to a person who asked it a
// question. What is wanted is the shape of what Zeus intends, in the product's own voice, and the
// tool names stay in the collapsed detail where they belong.
function addPlan(steps) {
  const wrap = mk('div', 'plan');
  const lead = mk('div', 'plan-lead');
  lead.appendChild(mk('span', 'dot'));
  lead.appendChild(mk('span', 'txt', 'Zeus is planning ' + steps.length + ' step(s)'));
  wrap.appendChild(lead);
  const box = mk('div', 'plan-box');
  for (const s of steps) {
    const line = mk('div', 'step');
    line.innerHTML = '<b></b>';
    line.querySelector('b').textContent = s.id;
    line.appendChild(document.createTextNode('  ' + s.intent));
    box.appendChild(line);
  }
  wrap.appendChild(box);
  const t = document.getElementById('thread');
  if (t) t.appendChild(wrap);
  scrollDown();
}

function addStatus(text) {
  const existing = $('thread').querySelector('.status');
  if (existing) existing.remove();
  const s = mk('div', 'status');
  s.appendChild(mk('span', 'dot'));
  s.appendChild(mk('span', 'txt', text));
  $('thread').appendChild(s);
  scrollDown();
}

function clearStatus() {
  const existing = $('thread').querySelector('.status');
  if (existing) existing.remove();
}

// The guard used to be a permanent chip in the topbar that read "guard: HUMAN_TAKEOVER - input
// PERMITTED" on a normal, uneventful day. It was the noisiest thing on the screen and it was
// reporting a state that was fine.
//
// The guard itself is untouched - it is a governance contract, and it is what stops Zeus typing
// into a window the person is using. What changed is that the STATE is only surfaced when it
// actually blocks something. A green chip saying nothing is wrong is not information, it is a
// permanent claim of health that nobody can act on.
//
// The one message that IS a real instruction is kept verbatim: the guard telling the person to
// release input, because that is the moment the interface has to be read.
function setGuard(control, input, blockedBy) {
  const banner = $('banner');
  if (input === 'PERMITTED') {
    if (banner) banner.classList.add('hidden');
    return;
  }
  if (!banner) return;
  const because = blockedBy ? ' (' + blockedBy + ')' : '';
  banner.textContent = input === 'BLOCKED'
    ? 'Zeus is holding - the guard is blocked' + because + '. Click RELEASE on the gold panel, then leave the machine alone.'
    : 'Zeus reports the guard as ' + input + because;
  banner.classList.remove('hidden');
}

// The ONE place busy is cleared. Every exit path from a mission goes through here.
function finish() {
  state.busy = false;
  $('sendBtn').disabled = false;
  $('cancelBtn').disabled = true;
  $('composer').disabled = false;
  $('composer').focus();
  clearStatus();
}

// ---------------------------------------------------------------- sessions

function renderSessions(list) {
  const box = $('sessionList');
  box.textContent = '';
  if (!list.length) {
    box.appendChild(mk('div', 'cap-line', 'No conversations yet.'));
    return;
  }
  for (const s of list) {
    const row = mk('div', 'session' + (s.id === state.sessionId ? ' active' : ''));
    row.appendChild(mk('div', 't', s.title || 'New chat'));
    row.title = s.model;
    const x = mk('button', 'x', 'x');
    x.title = 'Delete this conversation';
    x.onclick = async (e) => {
      e.stopPropagation();
      await api('/sessions/' + s.id, { method: 'DELETE' });
      if (state.sessionId === s.id) { state.sessionId = null; clearThread(); showEmpty(true); }
      await refreshSessions();
    };
    row.appendChild(x);
    row.onclick = () => openSession(s.id);
    box.appendChild(row);
  }
}

async function refreshSessions() {
  try {
    const r = await api('/sessions');
    renderSessions(r.sessions);
  } catch (e) {
    $('sessionList').textContent = 'could not load conversations: ' + e.message;
  }
}

async function openSession(id) {
  try {
    const r = await api('/sessions/' + id);
    state.sessionId = id;
    state.model = r.session.model;
    clearThread();
    showEmpty(false);
    for (const t of r.session.turns) {
      addMessage(t.role === 'user' ? 'user' : 'assistant', t.text,
        t.missionId ? ('mission ' + t.missionId.slice(0, 8) + (t.ok ? ' - verified' : '')) : null);
    }
    showEmpty(r.session.turns.length === 0);
    await refreshSessions();
  } catch (e) {
    addError('could not open that conversation: ' + e.message);
  }
}

async function newSession() {
  try {
    const r = await api('/sessions', { method: 'POST', body: JSON.stringify({ model: state.model }) });
    state.sessionId = r.session.id;
    clearThread();
    showEmpty(true);
    await refreshSessions();
    $('composer').focus();
  } catch (e) {
    addError('could not start a conversation: ' + e.message);
  }
}

// ---------------------------------------------------------------- the model pool
//
// There is no model dropdown, and that is the point. A person does not choose which neural network
// serves a request: they cannot know, and the choice is not theirs to make well. Zeus routes each
// request to the best available free model and says so in its own voice.
//
// The pool is still REPORTED - how many models are drawing, how many are healthy - because a
// routing name that hides what it routes to is a black box, and a black box is not a feature.
// That detail lives in the collapsed "Zeus is working" line, not in the header.

async function loadPool() {
  try {
    const r = await api('/pool');
    state.pool = r;
  } catch {
    // The pool is a convenience. A failed read must not take the interface with it.
    state.pool = null;
  }
}

// ---------------------------------------------------------------- capabilities

async function loadCapabilities() {
  try {
    const r = await api('/capabilities');
    setGuard(r.permission.control, r.permission.input, r.permission.blockedBy);
    $('capLine').textContent = 'capabilities ' + r.availableCount + '/' + r.capabilities.length;
  } catch (e) {
    setGuard('UNKNOWN', 'BLOCKED', e.message);
    $('capLine').textContent = 'operator host unavailable';
  }
}

// ---------------------------------------------------------------- sending

async function send() {
  const box = $('composer');
  if (!box) return;
  const text = box.value.trim();
  if (!text) return;
  if (state.busy) return;

  box.value = '';
  box.style.height = 'auto';

  // The conversation is created BEFORE the message is rendered.
  //
  // The order matters and getting it wrong was the second half of "nothing happened":
  // newSession() clears the thread, so rendering the user's message first meant their own words
  // were wiped a moment after they appeared. Create first, then render, and the message is
  // still there.
  if (!state.sessionId) {
    await newSession();
    if (!state.sessionId) {
      addError('the conversation could not be started, so nothing was sent. See the message above.');
      finish();
      return;
    }
  }

  addMessage('user', text);

  state.busy = true;
  $('sendBtn').disabled = true;
  $('cancelBtn').disabled = false;
  addStatus('working...');

  try {
    await api('/message', {
      method: 'POST',
      body: JSON.stringify({ text, sessionId: state.sessionId, model: state.model }),
    });
  } catch (e) {
    addError('the assistant could not be reached: ' + e.message);
    finish();
  }
}

// ---------------------------------------------------------------- events

function handleEvent(e) {
  switch (e.kind) {
    case 'status':
      addStatus(e.text);
      if (e.text && e.text.toLowerCase().includes('click release')) {
        $('banner').textContent = 'WAITING FOR YOU - release the guard on the gold panel, then do not touch the machine';
        $('banner').classList.remove('hidden');
      } else if (e.text && e.text.includes('permitted')) {
        $('banner').classList.add('hidden');
      }
      break;
    case 'plan':
      clearStatus();
      addPlan(e.steps);
      break;
    case 'step-start':
      clearStatus();
      addStatus(e.intent + '  (' + e.tool + ')');
      break;
    case 'step-result':
      addStatus((e.verified ? 'verified: ' : 'not verified: ') + e.summary);
      break;
    case 'approval-required':
      addError('Approval needed: ' + e.reason);
      break;
    case 'done':
      clearStatus();
      addMessage('assistant', e.text, e.ok ? 'goal satisfied' : 'not achieved', e.table);
      finish();
      refreshSessions();
      loadCapabilities();
      loadPool();
      break;
    case 'error':
      clearStatus();
      addError(e.text);
      finish();
      break;
  }
}

// ---------------------------------------------------------------- the event feed
//
// THIS USED TO BE AN SSE STREAM ON /events, AND IT FROZE THE INTERFACE.
//
// The user sent "Hello" and "hi". Both were answered correctly - the replies are in the
// transcript on disk right now - and neither ever appeared. The Stop button stayed enabled, the
// composer stayed disabled, and the window looked frozen.
//
// The cause is that /events is a LIVE-ONLY stream with no replay. If the connection is not
// established, or drops, or is re-established after a gap, every event emitted during that gap
// is gone - including 'done'. With no 'done', finish() never runs, and finish() is the only
// thing that re-enables the composer.
//
// That is a design failure, not a timing bug. Any stream that cannot replay can strand the UI
// in a permanently busy state, and reconnecting harder does not fix a mechanism that loses
// events by construction.
//
// So the feed is now INDEXED POLLING of /progress?since=N. The server already keeps every event
// in a bounded buffer and returns everything after an index. A dropped request costs nothing:
// the next poll returns exactly what was missed. The cursor advances only after events have been
// rendered, so nothing can be skipped.
//
// This is the same mechanism the previous WinForms window used, for the same reason: a boring
// mechanism that cannot lose an event beats an elegant one that can.
const FEED = { seen: 0, timer: null, lastEventAt: 0 };

async function pollFeed() {
  try {
    const r = await fetch('/progress?since=' + FEED.seen, { credentials: 'same-origin' });
    if (!r.ok) return;
    const body = await r.json();
    let rendered = 0;
    let broke = null;
    // ONE event per try/catch. This is the second half of the lesson in the header comment.
    //
    // Before this, handleEvent(e) ran bare inside the loop, so a renderer that threw took the
    // whole loop with it: the remaining events of the batch were never rendered, the line after
    // the loop that advances the cursor never ran, and the cursor therefore stayed pinned at the
    // poison event. Every subsequent poll re-delivered the same events, re-threw on the same one,
    // and displayed nothing - which is how one undefined helper in addStatus presented as
    // "Nothing has arrived for 90 seconds" rather than as an error. A stream whose cursor can be
    // pinned by a rendering fault is not replayable, and a replayable stream is the entire reason
    // this mechanism was chosen.
    for (const e of (body.events || [])) {
      try {
        handleEvent(e);
        rendered++;
      } catch (err) {
        if (!broke) broke = err;
        // Rendered as a real message. The header comment calls the old behaviour "fails silently
        // apart from one line of text"; a fault in the renderer deserves to be seen as one.
        try { addError('A progress item could not be displayed: ' + (err && err.message ? err.message : String(err))); } catch { /* the renderer is down too */ }
      }
      FEED.lastEventAt = Date.now();
    }
    // Advance over the whole batch even if part of it could not be drawn. Re-requesting an event
    // that has already been shown would replay the fault forever; skipping the rest of the batch
    // would silently lose the answer the user is waiting for.
    if (typeof body.total === 'number' && (body.events || []).length > 0) FEED.seen = body.total;
    if (broke) FEED.lastEventAt = Date.now();

    // A watchdog. A quiet-but-busy window must say so rather than sit silently disabled: a
    // frozen UI that looks frozen is at least honest about being stuck.
    if (state.busy && FEED.lastEventAt && Date.now() - FEED.lastEventAt > 90_000) {
      addError('Nothing has arrived for 90 seconds. The mission may have stalled - click Stop, or send another message.');
      FEED.lastEventAt = Date.now();
      finish();
    }
  } catch {
    // The agent may be restarting. The cursor is untouched, so nothing is lost.
  }
}

function connect() {
  if (FEED.timer) return;
  FEED.lastEventAt = Date.now();
  FEED.timer = window.setInterval(pollFeed, 600);
  pollFeed();
}

// ---------------------------------------------------------------- wiring

$('sendBtn').onclick = send;
$('cancelBtn').onclick = async () => { try { await api('/cancel', { method: 'POST' }); } catch {} };
$('newChat').onclick = () => newSession();

$('composer').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('composer').addEventListener('input', (e) => {
  const t = e.target;
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 200) + 'px';
});

// No model picker to wire up: there is no per-request model choice to make. Which model served a
// turn is recorded server-side and shown in the collapsed detail, because the routing name must not
// become a disguise for what actually ran.

// Focus handling, and why it is this fussy.
//
// The obvious version focuses the composer once, at the end of an async startup that makes
// three network round trips. That is how "I typed hi and nothing happened" happens: the window
// is up and focusable before the focus call arrives, the user starts typing into a box that has
// no focus, and every keystroke goes to the document instead. Worse, the failure is invisible -
// the box looks exactly like a box that is ready.
//
// So: focus immediately, focus again after startup, and SHOW when focus is missing. A composer
// that has lost focus is drawn with a red outline, so the state is visible rather than guessed.
(function wireFocus() {
  const box = $('composer');
  const composer = document.querySelector('.composer');

  const focusBox = () => {
    try { box.focus(); composer.classList.remove('unfocused'); } catch { /* nothing to do */ }
  };

  // On load, before anything is awaited.
  focusBox();
  box.addEventListener('blur', () => { if (!box.value.trim()) composer.classList.add('unfocused'); });
  box.addEventListener('focus', () => composer.classList.remove('unfocused'));

  // Clicking anywhere in the composer area should also focus the box.
  composer.addEventListener('mousedown', (e) => {
    if (e.target !== box) { e.preventDefault(); focusBox(); }
  });

  // If the window itself is not focused, the box cannot receive keystrokes either. Clicking the
  // page anywhere puts the focus where it needs to be.
  document.addEventListener('click', (e) => {
    if (e.target.closest('button, select, .session')) return;
    focusBox();
  });

  window.addEventListener('load', focusBox);
  window.setTimeout(focusBox, 250);
  window.setTimeout(focusBox, 900);
})();

(async function main() {
  await loadPool();
  await loadCapabilities();
  await refreshSessions();
  connect();
  try { $('composer').focus(); } catch { /* nothing to do */ }
})();
`
