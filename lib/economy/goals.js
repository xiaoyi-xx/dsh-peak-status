/**
 * Goal freeze — the visible half of "paused", per chat.
 *
 * The gate stops the spend; freezing the goal stops the churn and makes the
 * chat read as paused rather than busy. Only chats whose economy mode is on
 * are touched, and only goals that are `active`: a goal the user paused by
 * hand is never resumed here.
 *
 * `sync` reconciles a *desired set* on every tick rather than acting once at
 * a window boundary. That is what makes turning the switch off mid-peak take
 * effect immediately, and what keeps the record honest when a goal finishes
 * on its own.
 *
 * @module dsh-peak-status/economy/goals
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const ACTIVE = 'active'
const PAUSED = 'paused'

/**
 * Create the freezer.
 *
 * @param options.ctx - host plugin context (`agents` / `goals` services).
 * @param options.filePath - JSON record path, or null to stay in memory.
 * @param options.report - structured log sink.
 * @param options.isEnabled - `(sessionId) => boolean`, the per-chat switch.
 * @returns the freezer handle.
 */
export const createGoalFreezer = ({ ctx, filePath = null, report = () => {}, isEnabled = () => false } = {}) => {
  /** goalId → { revision, at } — only goals this plugin paused. */
  let record = new Map()

  const services = () => ({ agents: ctx.get('agents'), goals: ctx.get('goals') })

  const persist = () => {
    if (filePath === null) return
    try {
      if (record.size === 0) {
        try {
          unlinkSync(filePath)
        } catch {
          // already gone
        }
        return
      }
      mkdirSync(dirname(filePath), { recursive: true })
      const temporary = `${filePath}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: 1, paused: [...record.entries()].map(([goalId, entry]) => ({ goalId, revision: entry.revision })) }, null, 2))
      renameSync(temporary, filePath)
    } catch (error) {
      report('goal record persist failed', { message: String((error && error.message) || error) })
    }
  }

  /** Walk every live agent, tolerating agents the registry no longer owns. */
  const forEachGoal = (visit) => {
    const { agents, goals } = services()
    if (!agents || !goals || typeof agents.list !== 'function') return false
    for (const agent of agents.list()) {
      let goal
      try {
        goal = goals.get(agent)
      } catch {
        continue // not the registry's live instance
      }
      if (goal) visit(agent, goal)
    }
    return true
  }

  /** Resume one recorded goal by identity, whatever agent currently owns it. */
  const resumeRecorded = (goalId, revision) => {
    const { goals } = services()
    if (!goals) return false
    let done = false
    forEachGoal((agent, goal) => {
      if (done || goal.id !== goalId) return
      // A revision we did not pause means the goal moved on without us:
      // drop the record instead of overriding whatever the user did.
      if (goal.phase !== PAUSED || goal.revision !== revision) return
      goals.resume(agent, { id: goalId, revision: goal.revision })
      done = true
    })
    return done
  }

  /** Pause every goal whose chat has economy mode on. */
  const collectDesired = () => {
    const desired = new Map()
    const available = forEachGoal((agent, goal) => {
      if (goal.phase !== ACTIVE) return
      if (!isEnabled(agent.id)) return
      desired.set(goal.id, { agent, revision: goal.revision })
    })
    return available ? desired : null
  }

  return {
    /**
     * Reconcile the freeze with the current world.
     * @param active - whether the schedule is currently peak.
     * @returns a summary of what changed.
     */
    sync(active) {
      const desired = active ? collectDesired() : new Map()
      if (desired === null) {
        report('goal sync skipped', { reason: 'agents/goals services unavailable' })
        return { paused: 0, resumed: 0, held: record.size }
      }

      const { goals } = services()
      let paused = 0
      let resumed = 0

      // Release first: a chat that just left peak (or was switched off) must
      // not stay frozen while new pauses are computed.
      for (const [goalId, entry] of [...record]) {
        if (desired.has(goalId)) continue
        record.delete(goalId)
        try {
          if (resumeRecorded(goalId, entry.revision)) resumed += 1
        } catch (error) {
          report('goal resume failed', { goalId, message: String((error && error.message) || error) })
        }
      }

      for (const [goalId, entry] of desired) {
        if (record.has(goalId)) continue
        try {
          goals.pause(entry.agent, { id: goalId, revision: entry.revision })
          record.set(goalId, { revision: entry.revision, at: Date.now() })
          paused += 1
        } catch (error) {
          report('goal pause failed', { goalId, message: String((error && error.message) || error) })
        }
      }

      if (paused > 0 || resumed > 0) persist()
      if (paused > 0) report('goals paused', { count: paused })
      if (resumed > 0) report('goals resumed', { count: resumed })
      return { paused, resumed, held: record.size }
    },
    /** Resume everything this plugin paused (unload path, fail-open). */
    releaseAll() {
      let resumed = 0
      for (const [goalId, entry] of [...record]) {
        try {
          if (resumeRecorded(goalId, entry.revision)) resumed += 1
        } catch (error) {
          report('goal release failed', { goalId, message: String((error && error.message) || error) })
        }
      }
      record = new Map()
      persist()
      if (resumed > 0) report('goals released', { count: resumed })
      return { resumed }
    },
    /**
     * Resume goals a previous process paused. Called once at startup: a
     * restart must not leave a chat frozen forever.
     * @returns `{ resumed }`.
     */
    reconcile() {
      if (filePath === null) return { resumed: 0 }
      let stored
      try {
        stored = JSON.parse(readFileSync(filePath, 'utf8'))
      } catch {
        return { resumed: 0 }
      }
      if (!Array.isArray(stored?.paused) || stored.paused.length === 0) return { resumed: 0 }

      let resumed = 0
      for (const entry of stored.paused) {
        if (!entry || typeof entry.goalId !== 'string') continue
        try {
          if (resumeRecorded(entry.goalId, entry.revision)) resumed += 1
        } catch (error) {
          report('goal reconcile failed', { goalId: entry.goalId, message: String((error && error.message) || error) })
        }
      }
      try {
        unlinkSync(filePath)
      } catch {
        // already gone
      }
      report('reconciled goals paused by a previous run', { resumed })
      return { resumed }
    },
    get pausedCount() {
      return record.size
    },
    get pausedGoalIds() {
      return [...record.keys()]
    },
  }
}
