/**
 * dsh-peak-status — host half.
 *
 * Serves the Chinese official work calendar (法定节假日 + 调休上班日) to the
 * browser half over a same-origin route. The browser cannot reach these
 * upstreams on its own — timor.tech sits behind a Cloudflare challenge and
 * jiejiariapi sends no CORS headers — so the host fetches, normalizes both
 * upstream shapes, caches the result in memory, and answers
 * `<prefix>/<year>`. Every failure stays soft: the client then falls back to
 * its own CORS-capable source and finally to the plain weekday/weekend rule.
 *
 * The plugin is still a real (non-no-op) host entry, which is also what keeps
 * the loader entry mounted: the client-modules scan only admits entries whose
 * host fiber is active.
 */

import { createGate } from './economy/gate.js'
import { createGoalFreezer } from './economy/goals.js'
import { createEconomyHost, normalizeEconomyConfig } from './economy/host.js'
import { ECONOMY_PREFIX, createEconomyHandler } from './economy/routes.js'
import { beijingInstant, beijingWall, createSchedule } from './economy/schedule.js'
import { createSessionStore } from './economy/sessions.js'

/** Same-origin prefix the browser half fetches: `<prefix>/<year>`. */
const ROUTE_PREFIX = '/dsh-peak-status/holiday'
/** Normalized payloads older than this are refetched; holidays rarely change. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
/** Per-upstream request budget. */
const FETCH_TIMEOUT_MS = 8000
/** Years the route answers for. */
const MIN_YEAR = 2000
const MAX_YEAR = 2100

/** year → { fetchedAt, source, days } — one shared cache for every browser. */
const cache = new Map()

/** Whether a value is a non-array object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** `20261001` or `2026-10-01` → `2026-10-01`; anything else → null. */
function toIsoDate(value) {
  if (typeof value === 'string') {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const text = String(Math.trunc(value))
  if (!/^\d{8}$/.test(text)) return null
  return text.slice(0, 4) + '-' + text.slice(4, 6) + '-' + text.slice(6, 8)
}

/**
 * jiejiariapi — `{ 'YYYY-MM-DD': { date, name, isOffDay } }`, listing only the
 * special days of the year (holiday rest days plus 调休 makeup workdays).
 * @param payload - parsed upstream body.
 * @returns normalized days keyed by date, or null when the shape does not match.
 */
function fromJiejiariapi(payload) {
  if (!isRecord(payload)) return null
  const days = {}
  let count = 0
  for (const key of Object.keys(payload)) {
    const row = payload[key]
    if (!isRecord(row) || typeof row.isOffDay !== 'boolean') continue
    const date = toIsoDate(row.date === undefined ? key : row.date)
    if (date === null) continue
    days[date] = { name: typeof row.name === 'string' ? row.name : '', off: row.isOffDay }
    count += 1
  }
  return count > 0 ? days : null
}

/**
 * apihubs — `{ code, data: { list: [ ... ] } }` over the whole year. Its
 * numbers are festival-coded rather than booleans: `holiday_recess === 1`
 * marks a day off and `holiday_overtime` is 10 on an ordinary day and any
 * other value (11/22/55/88 …) on a 调休 makeup workday. Verified against
 * jiejiariapi for 2026: both yield the same 33 rest days and 6 makeup days.
 * These rows carry no festival name, so the name arrives empty. A year whose
 * rows carry no marker at all is unpublished (every row is an ordinary
 * workday) and must not be mistaken for a holiday-free calendar.
 * @param payload - parsed upstream body.
 * @returns normalized days keyed by date, or null when no calendar is present.
 */
function fromApihubs(payload) {
  if (!isRecord(payload)) return null
  const data = isRecord(payload.data) ? payload.data : payload
  const list = Array.isArray(data.list) ? data.list : (Array.isArray(data) ? data : null)
  if (list === null) return null
  const days = {}
  let count = 0
  for (const row of list) {
    if (!isRecord(row)) continue
    const date = toIsoDate(row.date)
    if (date === null) continue
    const off = row.holiday_recess === 1
    const overtime = typeof row.holiday_overtime === 'number' && row.holiday_overtime !== 10
    if (!off && !overtime) continue
    days[date] = { name: '', off: off }
    count += 1
  }
  return count > 0 ? days : null
}

/** Upstream sources in preference order; each yields normalized days or null. */
const SOURCES = [
  {
    name: 'jiejiariapi',
    url: (year) => 'https://api.jiejiariapi.com/v1/holidays/' + year,
    normalize: fromJiejiariapi,
  },
  {
    name: 'apihubs',
    url: (year) => 'https://api.apihubs.cn/holiday/get?year=' + year + '&size=400',
    normalize: fromApihubs,
  },
]

/**
 * Fetch one JSON document with a hard time budget.
 * @param url - absolute upstream URL.
 * @returns the parsed body.
 */
async function requestJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  return await response.json()
}

/**
 * Cached load of one year, trying each upstream in order.
 * @param year - four-digit Gregorian year.
 * @returns `{ fetchedAt, source, days }`, or null when no source produced a calendar.
 */
async function loadYear(year) {
  const hit = cache.get(year)
  if (hit !== undefined && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit
  for (const source of SOURCES) {
    try {
      const days = source.normalize(await requestJson(source.url(year)))
      if (days === null) continue
      const entry = { fetchedAt: Date.now(), source: source.name, days: days }
      cache.set(year, entry)
      return entry
    } catch (error) {
      // Try the next upstream; a stale cache below still beats no answer at all.
    }
  }
  return hit === undefined ? null : hit
}

/**
 * Write one JSON response, owning the full response lifecycle.
 * @param res - server response.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Answer `<prefix>/<year>`.
 * @param req - incoming request.
 * @param res - server response.
 */
async function handleRequest(req, res) {
  const method = req.method === undefined ? 'GET' : req.method
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(res, 405, { error: 'method not allowed' })
    return
  }
  const pathname = new URL(req.url === undefined ? '/' : req.url, 'http://localhost').pathname
  const year = Number(pathname.slice(ROUTE_PREFIX.length + 1))
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    sendJson(res, 400, { error: 'year must be an integer in ' + MIN_YEAR + '..' + MAX_YEAR })
    return
  }
  const entry = await loadYear(year)
  if (entry === null) {
    sendJson(res, 502, { error: 'holiday calendar unavailable', year: year })
    return
  }
  sendJson(res, 200, { year: year, source: entry.source, fetchedAt: entry.fetchedAt, days: entry.days })
}

/** The host half needs the web server to own its routes. */
export const inject = ['webServer']

/** Structured log sink for the economy half. Failures are warnings. */
const economyReport = (tag, value) => {
  const detail = value === undefined ? '' : ' ' + JSON.stringify(value)
  if (/failed|unavailable|skipped/.test(tag)) console.warn('[dsh-peak-status] economy ' + tag + detail)
  else console.log('[dsh-peak-status] economy ' + tag + detail)
}

/**
 * Whether one Beijing calendar day is a statutory holiday.
 *
 * Reads the same cache the holiday route fills, so the chip the browser draws
 * and the instant the gate holds a request can never disagree. An unwarmed
 * year reads as "not a holiday", which is exactly the plain weekday rule the
 * browser half falls back to.
 *
 * @param day - `beijingWall()` result.
 * @returns true when the loaded calendar marks the day off.
 */
const isRestDay = (day) => {
  const entry = cache.get(day.y)
  if (entry === undefined) return false
  const key = String(day.y).padStart(4, '0') + '-' + String(day.mo).padStart(2, '0') + '-' + String(day.d).padStart(2, '0')
  const row = entry.days[key]
  return row !== undefined && row.off === true
}

/**
 * Fetch the near years up front. The gate decides synchronously, so the
 * calendar has to be in memory before a request arrives; the fetch itself is
 * fire-and-forget and a miss just leaves the weekday rule standing.
 */
const warmCalendar = () => {
  const year = beijingWall(Date.now()).y
  for (let value = year - 1; value <= year + 1; value += 1) void loadYear(value)
}

/**
 * Register the calendar route on the web server, mount the per-chat economy
 * gate, and serve its routes beside the holiday one. The client half mounts
 * only while this host fiber is active, so a registration failure is logged
 * and otherwise ignored — the browser half carries its own fallbacks.
 *
 * @param ctx - host plugin context.
 * @param config - loader config; only its `economy` block is read.
 */
export function apply(ctx, config = {}) {
  const economy = createEconomyHost({
    ctx: ctx,
    config: normalizeEconomyConfig(config),
    isRestDay: isRestDay,
    report: economyReport,
    home: typeof config.home === 'string' ? config.home : undefined,
  })

  if (economy.config.enabled === true) {
    ctx.on('dispose', economy.install())
    ctx.on('dispose', economy.start())
    ctx.on('dispose', () => economy.releaseAll())
    warmCalendar()
  }
  economyReport('ready', {
    enabled: economy.config.enabled,
    windows: economy.config.windows.map((window) => window.pauseAt + '-' + window.resumeAt),
    routeFilter: economy.config.routeFilter,
    defaultEnabled: economy.config.defaultEnabled,
    state: economy.statusFor(null).state.name,
  })

  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  try {
    ctx.on('dispose', webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: handleRequest }))
    ctx.on('dispose', webServer.register({ kind: 'prefix', path: ECONOMY_PREFIX, handler: economy.handler }))
  } catch (error) {
    console.warn('[dsh-peak-status] routes not registered:', error)
  }
}

/**
 * Test seam for the plain-node harness in scripts/test-peak.mjs: the route
 * handler is exercised with a stubbed global fetch, so `npm test` stays offline.
 */
export const __test = {
  toIsoDate: toIsoDate,
  fromJiejiariapi: fromJiejiariapi,
  fromApihubs: fromApihubs,
  handleRequest: handleRequest,
  clearCache: function () { cache.clear() },
  ROUTE_PREFIX: ROUTE_PREFIX,
  isRestDay: isRestDay,
  economy: {
    normalizeConfig: normalizeEconomyConfig,
    createSchedule: createSchedule,
    createSessionStore: createSessionStore,
    createGate: createGate,
    createGoalFreezer: createGoalFreezer,
    createHandler: createEconomyHandler,
    createHost: createEconomyHost,
    ECONOMY_PREFIX: ECONOMY_PREFIX,
    beijingWall: beijingWall,
    beijingInstant: beijingInstant,
  },
}
