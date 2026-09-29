/**
 * The economy half of dsh-peak-status, assembled.
 *
 * One object owns everything the feature needs on the host: the per-chat
 * switch store, the schedule reader, the request gate, the goal freezer and
 * the status payload the browser chip reads. `src/index.js` only mounts it and
 * registers its route, so the holiday feature stays readable next door.
 *
 * @module dsh-peak-status/economy/host
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { createGate } from './gate.js'
import { createGoalFreezer } from './goals.js'
import { createEconomyHandler } from './routes.js'
import { createSchedule, DEFAULT_WINDOWS, parseHHMM } from './schedule.js'
import { createSessionStore } from './sessions.js'

/** How often the schedule, the freeze and every parked call are reconciled. */
const DEFAULT_TICK_MS = 30_000

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** `[[9, 12], [14, 18]]` → the spelled-out window form. */
const toWindow = (entry, index) => {
  if (Array.isArray(entry) && entry.length >= 2) {
    const [from, to] = entry
    const pauseAt = typeof from === 'string' ? from : `${String(Math.trunc(from)).padStart(2, '0')}:00`
    const resumeAt = typeof to === 'string' ? to : `${String(Math.trunc(to)).padStart(2, '0')}:00`
    if (parseHHMM(pauseAt) === null || parseHHMM(resumeAt) === null) return null
    return { id: `window-${index}`, pauseAt, resumeAt, days: [] }
  }
  if (!isRecord(entry)) return null
  if (parseHHMM(entry.pauseAt) === null || parseHHMM(entry.resumeAt) === null) return null
  const days = Array.isArray(entry.days) ? entry.days.filter((day) => Number.isInteger(day) && day >= 1 && day <= 7) : []
  return {
    id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `window-${index}`,
    pauseAt: entry.pauseAt,
    resumeAt: entry.resumeAt,
    days,
  }
}

/**
 * Merge the loader's `economy` block over the defaults and make it total.
 *
 * @param raw - the plugin row's `config` block (the `economy` sub-object, or
 *   the block itself when it carries no `economy` key).
 * @returns a config `createSchedule` and the store can always consume.
 */
export const normalizeEconomyConfig = (raw = {}) => {
  const outer = isRecord(raw) ? raw : {}
  const source = isRecord(outer.economy) ? outer.economy : outer
  const windows = Array.isArray(source.windows)
    ? source.windows.map(toWindow).filter((window) => window !== null)
    : DEFAULT_WINDOWS.map((window) => ({ ...window, days: [] }))
  const activeDays = Array.isArray(source.activeDays)
    ? source.activeDays.filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
    : [1, 2, 3, 4, 5]
  return {
    // The master switch only gates the feature; each chat's own switch is the
    // real control, so this defaults on.
    enabled: source.enabled !== false,
    windows: windows.length > 0 ? windows : DEFAULT_WINDOWS.map((window) => ({ ...window, days: [] })),
    activeDays: activeDays.length > 0 ? activeDays : [1, 2, 3, 4, 5],
    warnMinutes: Number.isFinite(source.warnMinutes) && source.warnMinutes >= 0 ? source.warnMinutes : 5,
    // Only DeepSeek's own route has peak pricing; holding others saves nothing.
    routeFilter: source.routeFilter === 'all' ? 'all' : 'deepseek-official',
    // A chat with no record follows this.
    defaultEnabled: source.defaultEnabled === true,
    tickMs: Number.isFinite(source.tickMs) && source.tickMs >= 5000 ? source.tickMs : DEFAULT_TICK_MS,
  }
}

/**
 * Build the economy host.
 *
 * @param options.ctx - host plugin context.
 * @param options.config - a {@link normalizeEconomyConfig} result.
 * @param options.isRestDay - `(wall) => boolean`; the statutory-holiday overlay.
 * @param options.report - structured log sink.
 * @param options.home - DSH home directory (defaults to `$DSH_HOME` or `~/.dsh`).
 * @returns the host handle: `{ handler, statusFor, releaseAll, config }`.
 */
export const createEconomyHost = ({ ctx, config, isRestDay, report = () => {}, home }) => {
  const root = home !== undefined && home !== null && home.length > 0
    ? home
    : (process.env.DSH_HOME !== undefined && process.env.DSH_HOME.length > 0
      ? process.env.DSH_HOME
      : join(homedir(), '.dsh'))

  const store = createSessionStore({
    filePath: join(root, 'peak-status-economy-sessions.json'),
    report,
    getDefault: () => config.defaultEnabled,
  })
  const freezer = createGoalFreezer({
    ctx,
    filePath: join(root, 'peak-status-economy-paused.json'),
    report,
    isEnabled: (sessionId) => store.isEnabled(sessionId),
  })
  const schedule = createSchedule({ getConfig: () => config, isRestDay })
  const gate = createGate({
    ctx,
    getConfig: () => config,
    getState: schedule.stateAt,
    isEnabled: (sessionId) => store.isEnabled(sessionId),
    report,
  })

  /** Bring the freeze and every parked call back in line with the switches. */
  const reconcile = () => {
    freezer.sync(schedule.stateAt(Date.now()).state === 'PAUSED')
    gate.revalidate()
  }

  // A restart must not leave a chat frozen forever.
  freezer.reconcile()

  /**
   * Read one chat's state, for the header chip and the dormant bar.
   * @param sessionId - the chat the browser is showing, or null.
   */
  const statusFor = (sessionId) => {
    const now = Date.now()
    const state = schedule.stateAt(now)
    const id = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null
    return {
      ok: true,
      now: now,
      sessionId: id,
      sessionEnabled: id === null ? false : store.isEnabled(id),
      masterEnabled: config.enabled === true,
      defaultEnabled: config.defaultEnabled === true,
      // The chat's agent is parked right now — this, not merely "peak", is
      // what the dormant indicator is about.
      dormant: id === null ? false : gate.pending.includes(id),
      state: {
        name: state.state,
        reason: state.reason,
        resumeAt: state.resumeAt === undefined ? null : state.resumeAt,
        minutesUntilResume: state.minutesUntilResume === undefined ? null : state.minutesUntilResume,
        startsAt: state.startsAt === undefined ? null : state.startsAt,
        minutesUntil: state.minutesUntil === undefined ? null : state.minutesUntil,
      },
      pending: gate.pending,
      pendingCount: gate.pendingCount,
      pausedGoals: freezer.pausedCount,
      windows: config.windows.map((window) => ({ id: window.id, pauseAt: window.pauseAt, resumeAt: window.resumeAt, days: window.days })),
      activeDays: config.activeDays,
      routeFilter: config.routeFilter,
    }
  }

  const handler = createEconomyHandler({
    ctx,
    report,
    status: statusFor,
    toggle: (sessionId) => {
      const next = store.toggle(sessionId)
      reconcile()
      return next === null ? null : next.enabled
    },
    set: (sessionId, enabled) => {
      const next = store.set(sessionId, enabled)
      reconcile()
      return next === null ? null : next.enabled
    },
  })

  return {
    config,
    handler,
    statusFor,
    /** Mount the request gate; returns a disposer. */
    install() {
      return gate.install()
    },
    /** Start the reconciliation tick; returns a disposer. */
    start() {
      const id = setInterval(reconcile, config.tickMs)
      // Reconcile once at startup too, so a chat already in peak when the host
      // booted is frozen without waiting a tick.
      reconcile()
      return () => clearInterval(id)
    },
    /** Never leave a chat frozen because the plugin went away. */
    releaseAll() {
      freezer.releaseAll()
      gate.releaseAll('unload')
    },
    report,
  }
}

export { createEconomyHandler } from './routes.js'
