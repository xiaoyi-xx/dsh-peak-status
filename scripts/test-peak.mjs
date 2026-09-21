/**
 * Boundary + holiday tests for the peak/off-peak algorithm.
 *
 * Policy (effective 2026-08-17, weekends adjusted 2026-08-23, calendar-aware
 * since 1.0.4):
 *   workdays: peak 09:00–12:00 / 14:00–18:00 (Beijing time), off otherwise
 *   weekends: Saturday & Sunday all day off-peak (valley price)
 *   holidays: 法定节假日 and 调休上班的周末 are off-peak for the whole day
 *
 * Unlike the 1.0.3 harness this one loads the SHIPPED browser half in a VM and
 * drives its \`__test\` seam, so the algorithm under test is the algorithm that
 * ships — there is no mirrored copy left to drift.
 */
import { readFileSync } from 'node:fs'
import { createContext, Script } from 'node:vm'
import { __test as host } from '../src/index.js'

/** Load src/client.js the way the web shell does, then borrow its test seam. */
function loadClient() {
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  let captured = null
  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    AbortController: AbortController,
    fetch: function () { return Promise.reject(new Error('network disabled in tests')) },
    window: {
      __ModuleLoader__: { load: function (entry) { captured = entry } },
      localStorage: { getItem: function () { return null }, setItem: function () {} },
    },
    document: { currentScript: { src: 'http://127.0.0.1:3080/plugins/dsh-peak-status/client.js' } },
  }
  createContext(sandbox)
  new Script(source).runInContext(sandbox)
  if (captured === null) throw new Error('client half registered no module')
  const react = { useState: function (value) { return [value, function () {}] }, useEffect: function () {}, createElement: function () { return null } }
  const exported = captured.factory(function (name) {
    if (name === 'react') return react
    throw new Error('unexpected require: ' + name)
  })
  if (exported.__test === undefined) throw new Error('client half exposes no test seam')
  return exported.__test
}

const client = loadClient()

/** Independent weekday mapping — deliberately not the plugin's own helper. */
function weekdayOfDate(iso) {
  const parts = iso.split('-').map(Number)
  const day = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay()
  return day === 0 ? 7 : day
}

/** One bjParts()-shaped instant. */
function at(iso, h, m, s) {
  const parts = iso.split('-').map(Number)
  return {
    y: parts[0], mo: parts[1], d: parts[2],
    h: h, m: m === undefined ? 0 : m, s: s === undefined ? 0 : s,
    weekday: weekdayOfDate(iso),
  }
}

const NO_CALENDAR = function () { return null }

/** 2026 国庆 + 2026-09-20 与 2026-10-10 两个调休上班日，2027 元旦（跨年用）。 */
const FIXTURE = {
  2026: {
    '2026-09-20': { name: '国庆节', off: false },
    '2026-10-01': { name: '国庆节', off: true },
    '2026-10-02': { name: '国庆节', off: true },
    '2026-10-03': { name: '国庆节', off: true },
    '2026-10-04': { name: '国庆节', off: true },
    '2026-10-05': { name: '国庆节', off: true },
    '2026-10-06': { name: '国庆节', off: true },
    '2026-10-07': { name: '国庆节', off: true },
    '2026-10-10': { name: '国庆节', off: false },
  },
  2027: {
    '2027-01-01': { name: '元旦', off: true },
  },
}
const WITH_CALENDAR = function (year) { return FIXTURE[year] === undefined ? null : FIXTURE[year] }

let passed = 0
let failed = 0

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) passed++
  else failed++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual)))
}

/** One compute() case: state, next boundary, days ahead and the day verdict. */
function runCompute(label, iso, h, m, s, provider, expected) {
  const r = client.compute(at(iso, h, m, s), provider)
  check(label, {
    peak: r.peak, next: r.nextMin, daysAhead: r.daysAhead,
    kind: r.day.kind, name: r.day.name, rest: r.day.rest,
    nextWeekday: r.nextWeekday, secsToNext: r.secsToNext > 0,
  }, expected)
}

// ── 无日历：必须与 1.0.3 的周末规则完全一致 ─────────────────────────────
console.log('\n== fallback: plain weekday/weekend rule (no calendar) ==')
runCompute('Mon 10:00 morning peak', '2026-09-21', 10, 0, 0, NO_CALENDAR,
  { peak: true, next: 720, daysAhead: 0, kind: 'weekday', name: '', rest: false, nextWeekday: 1, secsToNext: true })
runCompute('Mon 12:30 off before 14:00', '2026-09-21', 12, 30, 0, NO_CALENDAR,
  { peak: false, next: 840, daysAhead: 0, kind: 'weekday', name: '', rest: false, nextWeekday: 1, secsToNext: true })
runCompute('Wed 15:00 afternoon peak', '2026-09-23', 15, 0, 0, NO_CALENDAR,
  { peak: true, next: 1080, daysAhead: 0, kind: 'weekday', name: '', rest: false, nextWeekday: 3, secsToNext: true })
runCompute('Wed 18:00 exact — peak ends', '2026-09-23', 18, 0, 0, NO_CALENDAR,
  { peak: false, next: 540, daysAhead: 1, kind: 'weekday', name: '', rest: false, nextWeekday: 4, secsToNext: true })
runCompute('Thu 19:00 → next day 09:00', '2026-09-24', 19, 0, 0, NO_CALENDAR,
  { peak: false, next: 540, daysAhead: 1, kind: 'weekday', name: '', rest: false, nextWeekday: 5, secsToNext: true })
runCompute('Fri 19:00 → Monday 09:00 (3d)', '2026-09-25', 19, 0, 0, NO_CALENDAR,
  { peak: false, next: 540, daysAhead: 3, kind: 'weekday', name: '', rest: false, nextWeekday: 1, secsToNext: true })
runCompute('Fri 18:00 exact — weekend starts', '2026-09-25', 18, 0, 0, NO_CALENDAR,
  { peak: false, next: 540, daysAhead: 3, kind: 'weekday', name: '', rest: false, nextWeekday: 1, secsToNext: true })
runCompute('Sat 10:00 — weekend all off', '2026-09-26', 10, 0, 0, NO_CALENDAR,
  { peak: false, next: 540, daysAhead: 2, kind: 'weekend', name: '', rest: true, nextWeekday: 1, secsToNext: true })
runCompute('Sat 09:00 edge — still off', '2026-09-26', 9, 0, 0, NO_CALENDAR,
  { peak: false, next: 540, daysAhead: 2, kind: 'weekend', name: '', rest: true, nextWeekday: 1, secsToNext: true })
runCompute('Sun 15:00 — weekend off', '2026-09-27', 15, 0, 0, NO_CALENDAR,
  { peak: false, next: 540, daysAhead: 1, kind: 'weekend', name: '', rest: true, nextWeekday: 1, secsToNext: true })
runCompute('Sun 23:59 — near Monday', '2026-09-27', 23, 59, 59, NO_CALENDAR,
  { peak: false, next: 540, daysAhead: 1, kind: 'weekend', name: '', rest: true, nextWeekday: 1, secsToNext: true })
runCompute('Mon 09:00 exact — peak begins', '2026-09-21', 9, 0, 0, NO_CALENDAR,
  { peak: true, next: 720, daysAhead: 0, kind: 'weekday', name: '', rest: false, nextWeekday: 1, secsToNext: true })
runCompute('Mon 08:00 — before first peak', '2026-09-21', 8, 0, 0, NO_CALENDAR,
  { peak: false, next: 540, daysAhead: 0, kind: 'weekday', name: '', rest: false, nextWeekday: 1, secsToNext: true })

// ── 有日历：法定节假日全谷价、调休上班日照工作日窗口 ───────────────────
console.log('\n== calendar: 法定节假日 / 调休上班日 ==')
runCompute('国庆 10-01 周四 10:00 — 假期全谷价', '2026-10-01', 10, 0, 0, WITH_CALENDAR,
  { peak: false, next: 540, daysAhead: 7, kind: 'holiday', name: '国庆节', rest: true, nextWeekday: 4, secsToNext: true })
runCompute('国庆 10-07 周三 14:30 — 假期最后一天', '2026-10-07', 14, 30, 0, WITH_CALENDAR,
  { peak: false, next: 540, daysAhead: 1, kind: 'holiday', name: '国庆节', rest: true, nextWeekday: 4, secsToNext: true })
runCompute('节后 10-08 周四 10:00 — 恢复高峰', '2026-10-08', 10, 0, 0, WITH_CALENDAR,
  { peak: true, next: 720, daysAhead: 0, kind: 'weekday', name: '', rest: false, nextWeekday: 4, secsToNext: true })
runCompute('调休 10-10 周六 10:00 — 官方口径全天谷价', '2026-10-10', 10, 0, 0, WITH_CALENDAR,
  { peak: false, next: 540, daysAhead: 2, kind: 'makeup', name: '国庆节', rest: true, nextWeekday: 1, secsToNext: true })
runCompute('调休 10-10 周六 15:00 — 高峰窗口内依旧谷价', '2026-10-10', 15, 0, 0, WITH_CALENDAR,
  { peak: false, next: 540, daysAhead: 2, kind: 'makeup', name: '国庆节', rest: true, nextWeekday: 1, secsToNext: true })
runCompute('调休 10-10 周六 19:00 — 下一个高峰是周一', '2026-10-10', 19, 0, 0, WITH_CALENDAR,
  { peak: false, next: 540, daysAhead: 2, kind: 'makeup', name: '国庆节', rest: true, nextWeekday: 1, secsToNext: true })
runCompute('调休 09-20 周日 15:00 — 同为全天谷价', '2026-09-20', 15, 0, 0, WITH_CALENDAR,
  { peak: false, next: 540, daysAhead: 1, kind: 'makeup', name: '国庆节', rest: true, nextWeekday: 1, secsToNext: true })
runCompute('调休 09-20 周日 10:00 — 也不进高峰', '2026-09-20', 10, 0, 0, WITH_CALENDAR,
  { peak: false, next: 540, daysAhead: 1, kind: 'makeup', name: '国庆节', rest: true, nextWeekday: 1, secsToNext: true })
runCompute('节前 09-30 周三 19:00 — 跨整个假期', '2026-09-30', 19, 0, 0, WITH_CALENDAR,
  { peak: false, next: 540, daysAhead: 8, kind: 'weekday', name: '', rest: false, nextWeekday: 4, secsToNext: true })
runCompute('跨年 12-31 周四 20:00 — 到 2027 元旦后', '2026-12-31', 20, 0, 0, WITH_CALENDAR,
  { peak: false, next: 540, daysAhead: 4, kind: 'weekday', name: '', rest: false, nextWeekday: 1, secsToNext: true })
runCompute('日历缺该年时退回周末规则', '2027-06-05', 10, 0, 0, WITH_CALENDAR,
  { peak: false, next: 540, daysAhead: 2, kind: 'weekend', name: '', rest: true, nextWeekday: 1, secsToNext: true })

// ── 归一化：host 路由 / jiejiariapi / apihubs / 脏数据 ──────────────────
console.log('\n== calendar payload normalization ==')
const hostPayload = { year: 2026, source: 'jiejiariapi', fetchedAt: 1, days: { '2026-10-01': { name: '国庆节', off: true } } }
check('host route payload', client.normalizeCalendar(hostPayload), { '2026-10-01': { name: '国庆节', off: true } })
check('jiejiariapi payload', client.normalizeCalendar({
  '2026-10-01': { date: '2026-10-01', name: '国庆节', isOffDay: true },
  '2026-10-10': { date: '2026-10-10', name: '国庆节', isOffDay: false },
}), {
  '2026-10-01': { name: '国庆节', off: true },
  '2026-10-10': { name: '国庆节', off: false },
})
check('apihubs payload (recess/overtime codes)', client.normalizeCalendar({ code: 0, data: { list: [
  { date: 20261001, holiday: 88, holiday_recess: 1, holiday_overtime: 10 },
  { date: 20261008, holiday: 10, holiday_recess: 2, holiday_overtime: 10 },
  { date: 20261010, holiday: 10, holiday_recess: 2, holiday_overtime: 88 },
] } }), {
  '2026-10-01': { name: '', off: true },
  '2026-10-10': { name: '', off: false },
})
check('apihubs unpublished year (no markers)', client.normalizeCalendar({ code: 0, data: { list: [
  { date: 20270101, holiday: 10, holiday_recess: 2, holiday_overtime: 10 },
] } }), null)
check('apihubs 调休值 11/22/55 都算补班', client.normalizeCalendar({ code: 0, data: { list: [
  { date: 20260104, holiday: 10, holiday_recess: 2, holiday_overtime: 22 },
  { date: 20260214, holiday: 17, holiday_recess: 2, holiday_overtime: 11 },
  { date: 20260509, holiday: 10, holiday_recess: 2, holiday_overtime: 55 },
] } }), {
  '2026-01-04': { name: '', off: false },
  '2026-02-14': { name: '', off: false },
  '2026-05-09': { name: '', off: false },
})
check('empty object payload', client.normalizeCalendar({}), null)
check('array payload', client.normalizeCalendar([]), null)
check('null payload', client.normalizeCalendar(null), null)
check('dirty cache entries dropped', client.normalizeCalendar({ days: {
  '2026-10-01': { name: '国庆节', off: true },
  '2026-10-02': { name: 'broken' },
  '2026-10-03': null,
} }), { '2026-10-01': { name: '国庆节', off: true } })

// ── host 半：解析器与路由常量 ──────────────────────────────────────────
console.log('\n== host half ==')
check('host normalizes jiejiariapi', host.fromJiejiariapi({
  '2026-10-01': { date: '2026-10-01', name: '国庆节', isOffDay: true },
}), { '2026-10-01': { name: '国庆节', off: true } })
check('host normalizes apihubs', host.fromApihubs({ data: { list: [
  { date: 20261010, holiday: 10, holiday_recess: 2, holiday_overtime: 88 },
] } }), { '2026-10-10': { name: '', off: false } })
check('host rejects markerless apihubs year', host.fromApihubs({ data: { list: [
  { date: 20270101, holiday: 10, holiday_recess: 2, holiday_overtime: 10 },
] } }), null)
check('host toIsoDate compact', host.toIsoDate(20261001), '2026-10-01')
check('host toIsoDate dashed', host.toIsoDate('2026-10-01'), '2026-10-01')
check('host toIsoDate garbage', host.toIsoDate('2026/10/01'), null)
check('client fetches the host route', client.calRoute, host.ROUTE_PREFIX + '/')

// ── host 路由：状态码、JSON 形状、缓存命中（stub 掉 fetch，离线） ────────
console.log('\n== host route handler ==')
function fakeResponse() {
  const captured = {}
  return {
    captured: captured,
    writeHead: function (status, headers) { captured.status = status; captured.headers = headers },
    end: function (body) { captured.body = body },
  }
}
async function callRoute(pathname, method) {
  const res = fakeResponse()
  await host.handleRequest({ method: method === undefined ? 'GET' : method, url: pathname }, res)
  const body = res.captured.body === undefined ? null : JSON.parse(res.captured.body)
  return { status: res.captured.status, body: body, headers: res.captured.headers }
}

const realFetch = globalThis.fetch
let fetchCalls = 0
globalThis.fetch = async function (url) {
  fetchCalls++
  if (String(url).indexOf('jiejiariapi') >= 0) {
    return { ok: true, status: 200, json: async function () { return { '2026-10-01': { date: '2026-10-01', name: '国庆节', isOffDay: true } } } }
  }
  return { ok: true, status: 200, json: async function () { return { code: 0, data: { list: [{ date: 20261010, holiday: 10, holiday_recess: 2, holiday_overtime: 88 }] } } } }
}
try {
  host.clearCache()
  const ok = await callRoute('/dsh-peak-status/holiday/2026')
  check('route 200 + source + days', { status: ok.status, source: ok.body.source, days: ok.body.days }, {
    status: 200, source: 'jiejiariapi', days: { '2026-10-01': { name: '国庆节', off: true } },
  })
  check('route sets no-store', ok.headers['cache-control'], 'no-store')
  const callsAfterFirst = fetchCalls
  const again = await callRoute('/dsh-peak-status/holiday/2026')
  check('route caches (no second upstream call)', { status: again.status, calls: fetchCalls - callsAfterFirst }, { status: 200, calls: 0 })
  check('route rejects a bad year', (await callRoute('/dsh-peak-status/holiday/abc')).status, 400)
  check('route rejects a non-GET', (await callRoute('/dsh-peak-status/holiday/2026', 'POST')).status, 405)

  // 首源失败 → 落到 apihubs
  host.clearCache()
  globalThis.fetch = async function (url) {
    if (String(url).indexOf('jiejiariapi') >= 0) return { ok: false, status: 404, json: async function () { return {} } }
    return { ok: true, status: 200, json: async function () { return { code: 0, data: { list: [{ date: 20261010, holiday: 10, holiday_recess: 2, holiday_overtime: 88 }] } } } }
  }
  const fallback = await callRoute('/dsh-peak-status/holiday/2026')
  check('route falls back to apihubs', { status: fallback.status, source: fallback.body.source }, { status: 200, source: 'apihubs' })

  // 两个源都挂 → 502（客户端继续退回周末规则）
  host.clearCache()
  globalThis.fetch = async function () { throw new Error('offline') }
  check('route 502 when every upstream fails', (await callRoute('/dsh-peak-status/holiday/2026')).status, 502)
} finally {
  globalThis.fetch = realFetch
}

// ── 标签 ───────────────────────────────────────────────────────────────
console.log('\n== boundary labels ==')
function label(iso, h, m, provider) {
  const r = client.compute(at(iso, h, m, 0), provider)
  if (r.daysAhead === 0) return 'HH:MM'
  if (r.daysAhead === 1) return '明天'
  if (r.daysAhead <= 6) return '周X'
  const parts = client.ordinalToParts(r.nextOrdinal)
  return (parts.mo < 10 ? '0' : '') + parts.mo + '-' + (parts.d < 10 ? '0' : '') + parts.d
}
check('label same day', label('2026-09-21', 10, 0, NO_CALENDAR), 'HH:MM')
check('label tomorrow', label('2026-09-24', 19, 0, NO_CALENDAR), '明天')
check('label weekday (Fri → Mon)', label('2026-09-25', 19, 0, NO_CALENDAR), '周X')
check('label date across 国庆', label('2026-10-01', 10, 0, WITH_CALENDAR), '10-08')

console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exit(1)
