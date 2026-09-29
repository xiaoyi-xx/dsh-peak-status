/**
 * Per-chat economy-mode switches.
 *
 * A session id is durable (sessions are append-only JSONL and survive a
 * restart), so the switch can simply be a map from session id to a boolean in
 * one small file. `getDefault()` supplies the answer for a chat that has never
 * been touched, which is what makes "every new chat starts in economy mode"
 * expressible without writing a record per chat.
 *
 * @module dsh-peak-status/economy/sessions
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * Create the store.
 *
 * @param options.filePath - JSON path, or null to stay in memory.
 * @param options.report - structured log sink.
 * @param options.getDefault - returns the default state for an unrecorded chat.
 * @returns the store handle.
 */
export const createSessionStore = ({ filePath = null, report = () => {}, getDefault = () => false } = {}) => {
  /** session id → { enabled: boolean, at: number } */
  let entries = {}

  const persist = () => {
    if (filePath === null) return
    try {
      mkdirSync(dirname(filePath), { recursive: true })
      const temporary = `${filePath}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: 1, sessions: entries }, null, 2))
      renameSync(temporary, filePath)
    } catch (error) {
      report('session store persist failed', { message: String((error && error.message) || error) })
    }
  }

  const load = () => {
    if (filePath === null) return
    let stored
    try {
      stored = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch {
      return
    }
    const body = isRecord(stored?.sessions) ? stored.sessions : null
    if (body === null) return
    const next = {}
    for (const [id, value] of Object.entries(body)) {
      if (!isRecord(value) || typeof value.enabled !== 'boolean') continue
      next[id] = { enabled: value.enabled, at: typeof value.at === 'number' ? value.at : 0 }
    }
    entries = next
    report('session store loaded', { sessions: Object.keys(entries).length })
  }

  const usable = (sessionId) => typeof sessionId === 'string' && sessionId.length > 0

  /**
   * Whether economy mode is on for one chat.
   * @param sessionId - the session identity carried by `llm/stream`.
   * @returns true when the chat should be held during a peak window.
   */
  const isEnabled = (sessionId) => {
    if (!usable(sessionId)) return false
    const entry = entries[sessionId]
    if (entry === undefined) return getDefault() === true
    return entry.enabled === true
  }

  /**
   * Write an explicit switch state.
   * @param sessionId - target chat.
   * @param enabled - desired state.
   * @returns the stored state, or null when the id is unusable.
   */
  const set = (sessionId, enabled) => {
    if (!usable(sessionId)) return null
    const next = { enabled: enabled === true, at: Date.now() }
    entries = { ...entries, [sessionId]: next }
    persist()
    report('economy mode set', { sessionId, enabled: next.enabled })
    return next
  }

  load()

  return {
    isEnabled,
    set,
    /**
     * Flip one chat's switch.
     * @param sessionId - target chat.
     * @returns the new state, or null when the id is unusable.
     */
    toggle: (sessionId) => (usable(sessionId) ? set(sessionId, !isEnabled(sessionId)) : null),
    /** Every recorded switch, for diagnostics. */
    snapshot: () => ({ default: getDefault() === true, sessions: entries }),
    /** Resolve every chat the caller knows about to its effective state. */
    effective(ids) {
      const out = {}
      for (const id of ids ?? []) out[id] = isEnabled(id)
      return out
    },
  }
}
