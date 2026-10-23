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

/**
 * RETENTION POLICY - stated once, here, so it is not re-invented per caller.
 *
 * A conversation store that grows forever is a slow leak of everything a person ever typed,
 * including the things they typed by mistake. The policy is deliberately blunt:
 *
 *   • at most 500 conversations are kept;
 *   • a conversation untouched for 90 days is removed;
 *   • pruning runs once at chat-server startup and can be run explicitly (`pruneSessions`).
 *
 * It is a POLICY, not a guarantee of secrecy: deletion removes the session file, but filesystem
 * snapshots are outside this program's control. Nothing here claims otherwise.
 */
export const SESSION_RETENTION = { maxSessions: 500, maxAgeDays: 90 } as const

/**
 * Secrets are not something a chat transcript needs in order to be useful, and a transcript is
 * exactly the kind of file that gets copied into a bug report. Redact the obvious credential
 * shapes BEFORE the turn is written, not when it is displayed - a secret that reached disk has
 * already leaked.
 *
 * This is a narrow, documented pattern set: it cannot catch a secret pasted in a shape nobody
 * anticipated, and it does not pretend to. It only removes the forms that are both common and
 * unambiguously credentials.
 */
export function redactSecrets(text: string): string {
  return text
    // OpenAI/OpenRouter/Anthropic-style keys and generic sk-… tokens.
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, 'sk-[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]')
    // "Authorization: Bearer <token>" and the bare header forms.
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, '$1[REDACTED]')
    // password=… / api_key: … / token: … etc. Keep the label so the turn still reads honestly.
    .replace(/(\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, '$1[REDACTED]')
}

/** True when an id can only ever name a file in the sessions directory. */
export function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id)
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
  if (!isValidSessionId(id)) throw new Error(`invalid session id: ${id}`)
  return join(SESSIONS_DIR, `${id}.json`)
}

/**
 * Write a turn and REPORT what happened, rather than throwing into a caller that has already
 * told the user the message was accepted.
 *
 * `appendTurn` still throws (a caller that ignores the result must not silently lose data);
 * this wrapper exists for the chat path, whose honest options are "saved" or "tell the person
 * it was not saved". It never returns ok:true for a write that did not happen.
 */
export function recordTurn(
  id: string,
  turn: SessionTurn,
): { ok: true; session: ChatSession } | { ok: false; error: string } {
  try {
    const session = appendTurn(id, turn)
    if (!session) return { ok: false, error: `session ${id} no longer exists; the turn was not saved` }
    return { ok: true, session }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
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
  // Redact BEFORE writing. The transcript is a file on disk the moment this returns.
  const safeText = redactSecrets(turn.text)
  const safeTurn: SessionTurn = { ...turn, text: safeText }
  s.turns.push(safeTurn)
  s.updatedAt = turn.at
  // The title is the first thing the user said, which is what a sidebar should show.
  //
  // BUT only while the session still carries the placeholder. A session created with an
  // explicit title keeps it: an earlier version renamed unconditionally, so creating a session
  // called "durability check" and then sending it a message silently renamed it, and the name the
  // caller asked for was gone with no way to recover it.
  if (turn.role === 'user' && s.turns.filter((t) => t.role === 'user').length === 1) {
    const t = safeText.trim()
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

/**
 * Apply the retention policy above. Returns what it did rather than doing it silently.
 *
 * `now` is injectable so a test can prove the age rule without waiting 90 days or forging an
 * mtime. A session that cannot be deleted is named in `errors`; the caller decides how loud to
 * be about it.
 */
export function pruneSessions(opts: {
  now?: number
  maxSessions?: number
  maxAgeDays?: number
} = {}): { deleted: number; kept: number; errors: string[] } {
  const now = opts.now ?? Date.now()
  const maxSessions = opts.maxSessions ?? SESSION_RETENTION.maxSessions
  const maxAgeDays = opts.maxAgeDays ?? SESSION_RETENTION.maxAgeDays
  const errors: string[] = []
  const { sessions } = listSessions()
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000
  let deleted = 0
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i]
    const tooOld = typeof s.updatedAt === 'number' && s.updatedAt < cutoff
    const overCount = i >= maxSessions
    if (!tooOld && !overCount) continue
    try {
      deleteSession(s.id)
      deleted++
    } catch (e) {
      errors.push(`${s.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { deleted, kept: sessions.length - deleted, errors }
}