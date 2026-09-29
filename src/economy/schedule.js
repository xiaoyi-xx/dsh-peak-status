/**
 * Host-side peak schedule — the only place the economy gate asks "is this a
 * peak instant?".
 *
 * The browser half has its own richer `compute()` for the chip (next
 * transition, progress bar, day verdict). This module deliberately answers
 * only the question the gate needs, in the same terms: Beijing 09:00–12:00 and
 * 14:00–18:00 on ordinary Monday–Friday workdays, statutory holidays and
 * weekends valley all day. `scripts/test-economy.mjs` cross-checks the two
 * against each other so they cannot drift apart.
 *
 * Beijing is UTC+8 all year, so a wall reading converts to an instant with
 * plain arithmetic — no DST branch is reachable.
 *
 * @module dsh-peak-status/economy/schedule
 */

/** Pricing zone. DeepSeek states peak windows in Beijing time. */
export const SCHEDULE_ZONE = 'Asia/Shanghai'

const MINUTES_PER_DAY = 1440
/** Beijing's fixed offset from UTC. */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: SCHEDULE_ZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

/** `09:00` → 540; anything that is not a valid clock reading → null. */
export const parseHHMM = (value) => {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/**
 * Beijing wall reading at one instant.
 * @param now - epoch milliseconds.
 * @returns `{ y, mo, d, minutes, weekday }` with ISO weekday 1=Mon … 7=Sun.
 */
export const beijingWall = (now) => {
  const parts = {}
  for (const part of formatter.formatToParts(new Date(now))) parts[part.type] = part.value
  const y = Number(parts.year)
  const mo = Number(parts.month)
  const d = Number(parts.day)
  // Some ICU builds report midnight as hour "24"; fold it back.
  const minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute)
  const weekday = ((new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7) + 1
  return { y, mo, d, minutes, weekday }
}

/** One Beijing calendar day plus `delta` days. */
export const addDays = (day, delta) => {
  const shifted = new Date(Date.UTC(day.y, day.mo - 1, day.d + delta))
  return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() }
}

/**
 * The instant at which a Beijing wall reading happens.
 * @param day - `{ y, mo, d }`.
 * @param minutes - minutes past Beijing midnight.
 * @returns epoch milliseconds.
 */
export const beijingInstant = (day, minutes) =>
  Date.UTC(day.y, day.mo - 1, day.d) + minutes * 60000 - BEIJING_OFFSET_MS

const isoDay = (y, mo, d) => `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/** The fallback schedule: the exact windows the official pricing page states. */
export const DEFAULT_WINDOWS = [
  { id: 'peak-am', pauseAt: '09:00', resumeAt: '12:00' },
  { id: 'peak-pm', pauseAt: '14:00', resumeAt: '18:00' },
]

/**
 * Normalize one configured window.
 * @returns a window with numeric boundaries, or null when it is unusable.
 */
const normalizeWindow = (entry, index) => {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
  const pauseAt = parseHHMM(entry.pauseAt)
  const resumeAt = parseHHMM(entry.resumeAt)
  if (pauseAt === null || resumeAt === null || pauseAt === resumeAt) return null
  const days = Array.isArray(entry.days) ? entry.days.filter((day) => Number.isInteger(day) && day >= 1 && day <= 7) : []
  return {
    id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `window-${index}`,
    pauseAt,
    resumeAt,
    days,
  }
}

/**
 * Create the schedule reader.
 *
 * @param options.getConfig - returns the live economy config (see index.js).
 * @param options.isRestDay - `(wall) => boolean`, the statutory-holiday overlay.
 * @returns `{ stateAt }`.
 */
export const createSchedule = ({ getConfig, isRestDay = () => false }) => {
  // The configured windows arrive as "HH:MM" strings (they are also handed to
  // the browser verbatim); the reader compares minutes, so they are parsed
  // once per config object and reused.
  let parsedFrom = null
  let parsedWindows = null
  const windowsOf = (config) => {
    if (parsedFrom === config && parsedWindows !== null) return parsedWindows
    parsedFrom = config
    parsedWindows = config.windows.map(normalizeWindow).filter((window) => window !== null)
    return parsedWindows
  }

  /**
   * The schedule state at one instant.
   *
   * `PAUSED` carries the `resumeAt` instant, so a held request knows exactly
   * how long to wait; `WARN` carries the upcoming window start.
   *
   * @param now - epoch milliseconds.
   * @returns `{ state, reason, resumeAt?, minutesUntilResume?, startsAt?, minutesUntil?, window? }`.
   */
  const stateAt = (now) => {
    const config = getConfig()
    if (config.enabled !== true) return { state: 'NORMAL', reason: 'disabled' }

    const wall = beijingWall(now)
    const windows = windowsOf(config)
    const activeDays = config.activeDays

    // A statutory holiday is valley from midnight to midnight, so it releases
    // an already-open window too, not merely the ones starting today.
    if (isRestDay(wall) === true) return { state: 'NORMAL', reason: 'holiday' }

    for (const window of windows) {
      const days = window.days.length > 0 ? window.days : activeDays
      if (days.includes(wall.weekday) === false) continue
      const crossesMidnight = window.pauseAt > window.resumeAt
      const inWindow = crossesMidnight
        ? wall.minutes >= window.pauseAt || wall.minutes < window.resumeAt
        : wall.minutes >= window.pauseAt && wall.minutes < window.resumeAt
      if (!inWindow) continue
      // A crossing window's evening half resumes tomorrow, its morning half today.
      const resumedOn = crossesMidnight && wall.minutes >= window.pauseAt ? addDays(wall, 1) : { y: wall.y, mo: wall.mo, d: wall.d }
      const resumeAt = beijingInstant(resumedOn, window.resumeAt)
      return {
        state: 'PAUSED',
        reason: 'in-window',
        window,
        resumeAt,
        minutesUntilResume: Math.ceil((resumeAt - now) / 60000),
      }
    }

    // Checked after the windows, so one that started yesterday still wins.
    if (activeDays.includes(wall.weekday) === false) return { state: 'NORMAL', reason: 'weekday-off' }

    let best = null
    for (let delta = 0; delta <= 8; delta += 1) {
      const day = addDays(wall, delta)
      if (isRestDay(day) === true) continue
      const weekday = ((new Date(Date.UTC(day.y, day.mo - 1, day.d)).getUTCDay() + 6) % 7) + 1
      for (const window of windows) {
        const days = window.days.length > 0 ? window.days : activeDays
        if (days.includes(weekday) === false) continue
        const at = beijingInstant(day, window.pauseAt)
        if (at < now) continue
        if (best === null || at < best.at) best = { at, window }
      }
      // Nothing later can beat an already-found candidate on an earlier day.
      if (best !== null && delta > 0) break
    }

    if (best !== null) {
      const minutesUntil = Math.ceil((best.at - now) / 60000)
      if (minutesUntil <= config.warnMinutes) {
        return { state: 'WARN', reason: 'approaching', window: best.window, startsAt: best.at, minutesUntil }
      }
    }

    return { state: 'NORMAL', reason: 'no-window' }
  }

  return { stateAt }
}

/** Exported for the tests' cross-check against the browser half. */
export const scheduleInternals = { isoDay, MINUTES_PER_DAY }
