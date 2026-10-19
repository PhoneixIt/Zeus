/**
 * CHAT SESSIONS.
 *
 * ============================================================================================
 * WHY THIS IS SEPARATE FROM THE MISSION STORE
 * ============================================================================================
 *
 * A "session" is a conversation. A "mission" is a governed execution with evidence. They are
 * different things with different lifetimes, and the user's instruction was explicit: separate
 * conversations, SHARED mission history. So a session holds only what a conversation is - the
 * transcript and the model it was talking to - and every mission ever run stays in the one
 * place it already lives.
 *
 * That is also why this is plain files rather than a table in the durable store. A UI feature
 * should not force a schema migration on the component that has to survive crashes, and putting
 * it in its own folder makes it trivially reversible: delete `sessions/` and nothing else is
 * affected.
 *
 * ============================================================================================
 * WHY THE WRITE IS ATOMIC
 * ============================================================================================
 *
 * A session is appended to after every turn, and the process can die between turns. Writing in
 * place with `writeFileSync` would truncate a good transcript to nothing if it died mid-write,
 * and a chat log that loses its history on a crash is worse than one that admits the last turn
 * was not saved.
 *
 * So every write goes to a temporary file in the SAME directory and is renamed over the target.
 * `rename` within a directory is atomic on Windows and on POSIX filesystems, so a reader sees
 * either the whole previous file or the whole new one - never a half-written one.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** `~/.aios/agent/sessions` - beside missions/ and conversations.jsonl, never inside them. */
export const SESSIONS_DIR = join(homedir(), '.aios', 'agent', 'sessions')

/** The model used when a session does not name one. Must be a FREE model. */
export const DEFAULT_FREE_MODEL = 'opencode/longcat-2.5-preview-free'

export interface SessionTurn {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly at: number
  readonly missionId?: string
  readonly ok?: boolean
}

export interface ChatSession {
  readonly id: string
  /** First user message, trimmed. Never empty - it falls back to a placeholder. */
  title: string
  /** A model id. Only ever a free model; validated at the route, not trusted from the client. */
  model: string
  readonly createdAt: number
  updatedAt: number
  turns: SessionTurn[]
}

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true })
}

function sessionPath(id: string): string {
  // An id comes from the client on some routes. Never let it escape the directory.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error(`invalid session id: ${id}`)
  return join(SESSIONS_DIR, `${id}.json`)
}

/** Write via a temp file in the same directory + rename, so a crash cannot truncate a session. */
function writeAtomic(path: string, contents: string): void {
  ensureDir()
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, contents, 'utf8')
    renameSync(tmp, path)
  } catch (e) {
    // A failed rename must not leave the temp file behind to be mistaken for a session.
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* nothing further to do */ }
    throw e
  }
}

/** Every session, newest first. A corrupt file is reported, never silently skipped. */
export function listSessions(): { sessions: ChatSession[]; unreadable: string[] } {
  if (!existsSync(SESSIONS_DIR)) return { sessions: [], unreadable: [] }
  const unreadable: string[] = []
  const out: ChatSession[] = []
  for (const f of readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith('.json')) continue
    try {
      const s = JSON.parse(readFileSync(join(SESSIONS_DIR, f), 'utf8')) as ChatSession
      if (s && typeof s.id === 'string' && Array.isArray(s.turns)) out.push(s)
      else unreadable.push(f)
    } catch {
      unreadable.push(f)
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt)
  return { sessions: out, unreadable }
}

export function readSession(id: string): ChatSession | null {
  const p = sessionPath(id)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as ChatSession
  } catch {
    return null
  }
}

export function createSession(opts: { title?: string; model?: string } = {}): ChatSession {
  ensureDir()
  const now = Date.now()
  const s: ChatSession = {
    id: randomUUID(),
    title: (opts.title ?? '').trim() || 'New chat',
    model: opts.model ?? DEFAULT_FREE_MODEL,
    createdAt: now,
    updatedAt: now,
    turns: [],
  }
  writeAtomic(sessionPath(s.id), JSON.stringify(s, null, 2))
  return s
}

/**
 * Append a turn and persist.
 *
 * Returns the updated session, or null if the session no longer exists - a deleted session is
 * not resurrected by a late-arriving turn from a mission that was already running.
 */
export function appendTurn(id: string, turn: SessionTurn): ChatSession | null {
  const s = readSession(id)
  if (!s) return null
  s.turns.push(turn)
  s.updatedAt = turn.at
  // The title is the first thing the user said, which is what a sidebar should show.
  //
  // BUT only while the session still carries the placeholder. A session created with an
  // explicit title keeps it: an earlier version renamed unconditionally, so creating a session
  // called "durability check" and then sending it a message silently renamed it, and the name the
  // caller asked for was gone with no way to recover it.
  if (turn.role === 'user' && s.turns.filter((t) => t.role === 'user').length === 1) {
    const t = turn.text.trim()
    if (t && (s.title === 'New chat' || s.title === '')) {
      s.title = t.length > 60 ? `${t.slice(0, 60)}...` : t
    }
  }
  writeAtomic(sessionPath(id), JSON.stringify(s, null, 2))
  return s
}

export function setSessionModel(id: string, model: string): ChatSession | null {
  const s = readSession(id)
  if (!s) return null
  s.model = model
  s.updatedAt = Date.now()
  writeAtomic(sessionPath(id), JSON.stringify(s, null, 2))
  return s
}

export function deleteSession(id: string): boolean {
  const p = sessionPath(id)
  if (!existsSync(p)) return false
  unlinkSync(p)
  return true
}

/** Sessions, as the sidebar needs them: id, title, model, when - and NOT the whole transcript. */
export function sessionSummaries(): Array<Pick<ChatSession, 'id' | 'title' | 'model' | 'createdAt' | 'updatedAt'>> {
  return listSessions().sessions.map((s) => ({
    id: s.id, title: s.title, model: s.model, createdAt: s.createdAt, updatedAt: s.updatedAt,
  }))
}