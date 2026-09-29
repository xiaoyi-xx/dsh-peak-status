/**
 * Economy-mode tests.
 *
 * Two things are being protected here:
 *
 *  1. The hold itself — the gate must park a call for a chat whose switch is
 *     on inside a peak window, and must release it at the window's end, on
 *     abort, or when the switch goes off.
 *  2. Agreement between the two halves. The browser chip draws the schedule
 *     with its own `compute()`; the gate asks the host schedule. If they ever
 *     disagreed, the chip would claim "valley" while a request was still
 *     parked. The cross-check below drives both against the same instants and
 *     the same calendars, so a change to either side fails the build.
 *
 * Offline: the client half is loaded in a VM with `fetch` disabled, and the
 * host half's calendar is injected as a fixture.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, Script } from 'node:vm'
import { __test as hostTest } from '../src/index.js'

const economy = hostTest.economy

/**
 * Load src/client.js the way the web shell does.
 * @returns `{ exported, sandbox, setFetch }` — the module's exports, the VM
 *   global, and a hook for swapping the stubbed `fetch`.
 */
function loadClientModule() {
  const source = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
  let captured = null
  let fetchImpl = function () { return Promise.reject(new Error('network disabled in tests')) }
  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    // The components are rendered below, so their effects run — the poller's
    // interval is stubbed out to keep the test process from hanging.
    setInterval: function () { return 0 },
    clearInterval: function () {},
    AbortController: AbortController,
    fetch: function () { return fetchImpl.apply(null, arguments) },
    window: {
      __ModuleLoader__: { load: function (entry) { captured = entry } },
      localStorage: { getItem: function () { return null }, setItem: function () {} },
    },
    document: { currentScript: { src: 'http://127.0.0.1:3080/plugins/dsh-peak-status/client.js' } },
  }
  createContext(sandbox)
  new Script(source).runInContext(sandbox)
  if (captured === null) throw new Error('client half registered no module')

  // A rendering-capable React stub: both components are exercised below, so
  // `createElement` builds a real tree instead of returning null.
  const react = {
    useState: function (value) { return [typeof value === 'function' ? value() : value, function () {}] },
    // Runs the effect body once, synchronously: the stub has no commit phase,
    // and the two components below only need their subscriptions wired.
    useEffect: function (effect) {
      try {
        effect()
      } catch (error) {
        // an effect that throws still must not abort the render under test
      }
    },
    createElement: function (type, props) {
      const children = []
      for (let index = 2; index < arguments.length; index++) children.push(arguments[index])
      return { type: type, props: props === undefined || props === null ? {} : props, children: children.flat() }
    },
  }
  const exported = captured.factory(function (name) {
    if (name === 'react') return react
    throw new Error('unexpected require: ' + name)
  })
  if (exported.__test === undefined) throw new Error('client half exposes no test seam')
  return {
    exported: exported,
    setFetch: function (impl) { fetchImpl = impl },
  }
}

const loaded = loadClientModule()
const client = loaded.exported.__test

/** Render one element tree with the stub React. */
const render = (element) => {
  if (element === null || element === undefined || typeof element !== 'object') return element
  if (typeof element.type === 'function') return render(element.type(element.props))
  return element
}

/** Whether a rendered tree carries the economy leaf icon. */
const hasLeaf = (node) => {
  if (node === null || node === undefined || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some(hasLeaf)
  if (typeof node.type === 'function') return hasLeaf(node.type(node.props))
  if (node.type === 'svg') return true
  return (node.children === undefined ? [] : node.children).some(hasLeaf)
}

/** Flatten a rendered tree to its visible text. */
const textOf = (node) => {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node === 'object') {
    if (typeof node.type === 'function') return textOf(node.type(node.props))
    return textOf(node.children)
  }
  return ''
}

let passed = 0
let failed = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) passed++
  else failed++
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '  expected ' + JSON.stringify(expected) + ' got ' + JSON.stringify(actual)))
}

/** Independent weekday mapping — deliberately not the plugin's own helper. */
function weekdayOf(iso) {
  const parts = iso.split('-').map(Number)
  const day = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])).getUTCDay()
  return day === 0 ? 7 : day
}

/** The client's bjParts()-shaped instant for a Beijing wall reading. */
function clientAt(iso, h, m) {
  const parts = iso.split('-').map(Number)
  return { y: parts[0], mo: parts[1], d: parts[2], h: h, m: m, s: 0, weekday: weekdayOf(iso) }
}

const day = (iso) => {
  const parts = iso.split('-').map(Number)
  return { y: parts[0], mo: parts[1], d: parts[2] }
}

/** 2026 国庆 + the two 调休 workdays, 2027 元旦. Same fixture as test-peak.mjs. */
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

const keyOf = (d) => String(d.y).padStart(4, '0') + '-' + String(d.mo).padStart(2, '0') + '-' + String(d.d).padStart(2, '0')
const fixtureIsRestDay = (d) => {
  const year = FIXTURE[d.y]
  if (year === undefined) return false
  const row = year[keyOf(d)]
  return row !== undefined && row.off === true
}

const config = (overrides) => economy.normalizeConfig(overrides === undefined ? {} : { economy: overrides })
const scheduleFor = (overrides, isRestDay) =>
  economy.createSchedule({
    getConfig: () => config(overrides),
    isRestDay: isRestDay === undefined ? fixtureIsRestDay : isRestDay,
  })

// ── config normalization ───────────────────────────────────────────────
console.log('\n== economy config ==')
check('defaults', config(), {
  enabled: true,
  windows: [
    { id: 'peak-am', pauseAt: '09:00', resumeAt: '12:00', days: [] },
    { id: 'peak-pm', pauseAt: '14:00', resumeAt: '18:00', days: [] },
  ],
  activeDays: [1, 2, 3, 4, 5],
  warnMinutes: 5,
  routeFilter: 'deepseek-official',
  defaultEnabled: false,
  tickMs: 30000,
})
check('shorthand windows', config({ windows: [[9, 12]] }).windows, [{ id: 'window-0', pauseAt: '09:00', resumeAt: '12:00', days: [] }])
check('junk window falls back', config({ windows: [{ pauseAt: 'nope', resumeAt: '12:00' }] }).windows.length, 2)
check('master off', config({ enabled: false }).enabled, false)
check('routeFilter all', config({ routeFilter: 'all' }).routeFilter, 'all')

// ── the schedule ───────────────────────────────────────────────────────
console.log('\n== host schedule ==')
const schedule = scheduleFor()
const instant = (iso, h, m) => economy.beijingInstant(day(iso), h * 60 + m)
check('Mon 10:00 peak', schedule.stateAt(instant('2026-09-21', 10, 0)).state, 'PAUSED')
check('Mon 09:00 peak (half-open start)', schedule.stateAt(instant('2026-09-21', 9, 0)).state, 'PAUSED')
check('Mon 12:00 not peak (half-open end)', schedule.stateAt(instant('2026-09-21', 12, 0)).state, 'NORMAL')
check('Mon 14:00 peak', schedule.stateAt(instant('2026-09-21', 14, 0)).state, 'PAUSED')
check('Mon 18:00 not peak', schedule.stateAt(instant('2026-09-21', 18, 0)).state, 'NORMAL')
check('Mon 08:00 not peak', schedule.stateAt(instant('2026-09-21', 8, 0)).state, 'NORMAL')
check('Sat 10:00 weekday-off', schedule.stateAt(instant('2026-09-26', 10, 0)).reason, 'weekday-off')
check('Sun 15:00 weekday-off', schedule.stateAt(instant('2026-09-27', 15, 0)).reason, 'weekday-off')
check('国庆 10-01 周四 10:00 holiday', schedule.stateAt(instant('2026-10-01', 10, 0)).reason, 'holiday')
check('调休 10-10 周六 15:00 weekday-off', schedule.stateAt(instant('2026-10-10', 15, 0)).reason, 'weekday-off')
check('10-08 周四 10:00 back to peak', schedule.stateAt(instant('2026-10-08', 10, 0)).state, 'PAUSED')
check('resume instant is 12:00 Beijing', schedule.stateAt(instant('2026-09-21', 10, 30)).resumeAt, instant('2026-09-21', 12, 0))
check('resume instant is 18:00 for the afternoon', schedule.stateAt(instant('2026-09-21', 15, 0)).resumeAt, instant('2026-09-21', 18, 0))
check('warn before the window', schedule.stateAt(instant('2026-09-21', 8, 57)).state, 'WARN')
check('warn carries the start', schedule.stateAt(instant('2026-09-21', 8, 57)).startsAt, instant('2026-09-21', 9, 0))
check('disabled master', scheduleFor({ enabled: false }).stateAt(instant('2026-09-21', 10, 0)).reason, 'disabled')
check('calendar absent → weekday rule', scheduleFor({}, () => false).stateAt(instant('2026-10-01', 10, 0)).state, 'PAUSED')

// ── cross-check: host schedule vs browser compute ──────────────────────
console.log('\n== cross-check: both halves agree on peak/valley ==')
const DATES = ['2026-09-21', '2026-09-23', '2026-09-25', '2026-09-26', '2026-09-27', '2026-10-01', '2026-10-07', '2026-10-08', '2026-10-10', '2026-12-31', '2027-01-01', '2027-06-05']
const TIMES = [[0, 0], [8, 0], [8, 59], [9, 0], [9, 30], [11, 59], [12, 0], [13, 0], [14, 0], [17, 59], [18, 0], [19, 0], [23, 59]]
const cross = scheduleFor()
const daysOf = (year) => (FIXTURE[year] === undefined ? null : FIXTURE[year])
let mismatches = []
for (const iso of DATES) {
  for (const [h, m] of TIMES) {
    const hostPeak = cross.stateAt(instant(iso, h, m)).state === 'PAUSED'
    const clientPeak = client.compute(clientAt(iso, h, m), daysOf).peak
    if (hostPeak !== clientPeak) mismatches.push(iso + ' ' + h + ':' + String(m).padStart(2, '0') + ' host=' + hostPeak + ' client=' + clientPeak)
  }
}
check('every sampled instant agrees (' + DATES.length * TIMES.length + ' samples)', mismatches, [])

// ── the per-chat store ─────────────────────────────────────────────────
console.log('\n== per-chat switch store ==')
const dir = mkdtempSync(join(tmpdir(), 'peak-economy-'))
try {
  const file = join(dir, 'sessions.json')
  const store = economy.createSessionStore({ filePath: file, getDefault: () => false })
  check('default off', store.isEnabled('chat-a'), false)
  check('toggle on', store.toggle('chat-a').enabled, true)
  check('reopen keeps it', economy.createSessionStore({ filePath: file, getDefault: () => false }).isEnabled('chat-a'), true)
  check('unrecorded chat follows the default', economy.createSessionStore({ filePath: file, getDefault: () => true }).isEnabled('chat-z'), true)
  check('bad id refused', store.set('', true), null)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ── the gate ───────────────────────────────────────────────────────────
console.log('\n== request gate ==')
const gateConfig = config()
const enabled = new Set(['chat-a'])
let handler = null
const gateCtx = { on: (event, fn) => { handler = fn; return () => {} } }
const gate = economy.createGate({
  ctx: gateCtx,
  getConfig: () => gateConfig,
  getState: (now) => scheduleFor().stateAt(now),
  isEnabled: (id) => enabled.has(id),
})
gate.install()

check('enabled chat at peak holds', gate.decide({ sessionId: 'chat-a', provider: 'deepseek-official' }, instant('2026-09-21', 10, 0)).hold, true)
check('other chat at peak passes', gate.decide({ sessionId: 'chat-b', provider: 'deepseek-official' }, instant('2026-09-21', 10, 0)).hold, false)
check('enabled chat at valley passes', gate.decide({ sessionId: 'chat-a', provider: 'deepseek-official' }, instant('2026-09-21', 12, 0)).hold, false)
check('no session id passes', gate.decide({ provider: 'deepseek-official' }, instant('2026-09-21', 10, 0)).reason, 'no-session')
check('non-DeepSeek route is exempt', gate.decide({ sessionId: 'chat-a', provider: 'some-relay' }, instant('2026-09-21', 10, 0)).reason, 'route-exempt')

// A window that covers "now", so the parking behaviour can be observed offline.
const nowWall = economy.beijingWall(Date.now())
const pad = (n) => (n < 10 ? '0' : '') + n
const covering = config({ windows: [{ pauseAt: pad(Math.floor(Math.max(0, nowWall.minutes - 1) / 60)) + ':' + pad(Math.max(0, nowWall.minutes - 1) % 60), resumeAt: pad(Math.floor(Math.min(1439, nowWall.minutes + 2) / 60)) + ':' + pad(Math.min(1439, nowWall.minutes + 2) % 60) }] })
const liveEnabled = new Set(['chat-a'])
let liveHandler = null
const liveGate = economy.createGate({
  ctx: { on: (event, fn) => { liveHandler = fn; return () => {} } },
  getConfig: () => covering,
  getState: (now) => economy.createSchedule({ getConfig: () => covering, isRestDay: () => false }).stateAt(now),
  isEnabled: (id) => liveEnabled.has(id),
})
liveGate.install()

const parked = async () => {
  let reached = false
  const stream = liveHandler(
    { sessionId: 'chat-a', provider: 'deepseek-official', signal: new AbortController().signal },
    () => { reached = true; return (async function* () { yield 'chunk' })() },
  )
  const iterator = stream[Symbol.asyncIterator]()
  let settled = false
  const first = iterator.next().then((result) => { settled = true; return result })
  await new Promise((resolve) => setTimeout(resolve, 25))
  return { reached: () => reached, settled: () => settled, first: first }
}

{
  const run = await parked()
  check('parked call did not reach the adapter', run.reached(), false)
  check('parked call is still pending', run.settled(), false)
  check('the gate reports the parked chat', liveGate.pending, ['chat-a'])
  liveGate.releaseAll('test')
  check('release delivers the stream', (await run.first).value, 'chunk')
  check('adapter reached after release', run.reached(), true)
}

{
  const run = await parked()
  liveEnabled.delete('chat-a')
  liveGate.revalidate()
  check('switching the chat off releases', (await run.first).value, 'chunk')
}

{
  const controller = new AbortController()
  let reached = false
  const stream = liveHandler(
    { sessionId: 'chat-a', provider: 'deepseek-official', signal: controller.signal },
    () => { reached = true; return (async function* () {})() },
  )
  const first = stream[Symbol.asyncIterator]().next()
  await new Promise((resolve) => setTimeout(resolve, 25))
  controller.abort()
  await first
  check('abort releases', reached, true)
}

// ── routes ─────────────────────────────────────────────────────────────
console.log('\n== economy routes ==')
const fakeResponse = () => {
  const captured = {}
  return {
    captured: captured,
    writeHead: (status, headers) => { captured.status = status; captured.headers = headers },
    end: (body) => { captured.body = body },
  }
}
const fakeRequest = (method, url, body) => ({
  method: method,
  url: url,
  on(event, fn) {
    if (event === 'data' && body !== undefined) fn(body)
    if (event === 'end') fn()
  },
})
// Mirrors the real wiring: a switch write refuses an unusable session id by
// returning null, and the route turns that into 400.
const acceptId = (sessionId) => (typeof sessionId === 'string' && sessionId.length > 0 ? true : null)
const call = async (method, url, body, ctx, handler) => {
  const res = fakeResponse()
  await (handler === undefined ? economy.createHandler({
    ctx: ctx === undefined ? { get: () => undefined } : ctx,
    status: () => ({ ok: true, marker: 'status' }),
    toggle: acceptId,
    set: (sessionId, enabled) => (typeof enabled === 'boolean' ? acceptId(sessionId) : null),
  }) : handler)(fakeRequest(method, url, body), res)
  const raw = res.captured.body
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    parsed = null
  }
  return { status: res.captured.status, body: parsed, text: raw }
}

check('GET status', await call('GET', economy.ECONOMY_PREFIX + '/status?sessionId=x'), { status: 200, body: { ok: true, marker: 'status' }, text: '{"ok":true,"marker":"status"}' })
check('GET status without a session id still answers', (await call('GET', economy.ECONOMY_PREFIX + '/status')).status, 200)
check('POST toggle', (await call('POST', economy.ECONOMY_PREFIX + '/toggle', '{"sessionId":"x"}')).status, 200)
check('POST set', (await call('POST', economy.ECONOMY_PREFIX + '/set', '{"sessionId":"x","enabled":true}')).status, 200)
check('POST set without enabled', (await call('POST', economy.ECONOMY_PREFIX + '/set', '{"sessionId":"x"}')).status, 400)
check('POST toggle without a session', (await call('POST', economy.ECONOMY_PREFIX + '/toggle', '{}')).status, 400)
check('unknown endpoint', (await call('GET', economy.ECONOMY_PREFIX + '/nope')).status, 404)
check('malformed body', (await call('POST', economy.ECONOMY_PREFIX + '/toggle', 'not json')).status, 400)
const fenced401 = await call('GET', economy.ECONOMY_PREFIX + '/status', undefined, { get: () => ({ requestRejection: () => 401 }) })
const fenced403 = await call('GET', economy.ECONOMY_PREFIX + '/status', undefined, { get: () => ({ requestRejection: () => 403 }) })
check('connection fence 401', { status: fenced401.status, text: fenced401.text }, { status: 401, text: 'unauthorized' })
check('connection fence 403', { status: fenced403.status, text: fenced403.text }, { status: 403, text: 'forbidden' })
check('fence passes when it returns undefined', (await call('GET', economy.ECONOMY_PREFIX + '/status', undefined, { get: () => ({ requestRejection: () => undefined }) })).status, 200)

// ── the route path the browser uses ────────────────────────────────────
check('economy prefix sits beside the holiday route', economy.ECONOMY_PREFIX, '/dsh-peak-status/economy')

// ── the browser half ───────────────────────────────────────────────────
console.log('\n== browser half ==')
const registered = []
const slots = {
  inject: (name, callback) => callback(),
  register: (meta, component) => { registered.push({ meta: meta, component: component }) },
}
const runtimeCtx = {
  get: (name) => (name === 'slots' ? slots : undefined),
  sessions: { list: { getSnapshot: () => ({ current: null }), subscribe: () => () => {} } },
}
loaded.exported.apply(runtimeCtx)
check('registers the header chip and the dormant bar', registered.map((entry) => entry.meta.name), [
  'conversation.session.header.utilities',
  'conversation.composer.dock',
])
check('declares the services it reads', loaded.exported.inject, ['slots', 'sessions'])

const chipNoSession = textOf(render(registered[0].component()))
check('the chip renders without a session', chipNoSession.indexOf('高峰') >= 0 || chipNoSession.indexOf('谷价') >= 0 || chipNoSession.indexOf('空闲') >= 0, true)
check('the dormant bar stays hidden without a session', render(registered[1].component()), null)

// Now with a live chat that the host reports as dormant.
const status = {
  ok: true,
  sessionId: 'chat-a',
  sessionEnabled: true,
  masterEnabled: true,
  dormant: true,
  state: { name: 'PAUSED', reason: 'in-window', resumeAt: Date.now() + 3600 * 1000, minutesUntilResume: 60 },
  pending: ['chat-a'],
  pendingCount: 1,
  pausedGoals: 0,
}
runtimeCtx.sessions.list.getSnapshot = () => ({ current: 'chat-a' })
loaded.setFetch(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(status) }))

check('the chip carries no leaf while the status is unknown', hasLeaf(render(registered[0].component())), false)
await new Promise((resolve) => setTimeout(resolve, 10))
check('the chip marks economy mode with the leaf', hasLeaf(render(registered[0].component())), true)

// The dormant bar mounts after the shared poller's first answer lands.
await new Promise((resolve) => setTimeout(resolve, 10))
const bar = render(registered[1].component())
const barText = textOf(bar)
check('the dormant bar appears for a parked chat', barText.indexOf('经济模式休眠中') >= 0, true)
check('the dormant bar names the resume time', barText.indexOf('自动继续') >= 0, true)
check('the dormant bar explains the saving', barText.indexOf('不会产生费用') >= 0, true)

// ── host assembly ──────────────────────────────────────────────────────
console.log('\n== host assembly ==')
{
  const hostHome = mkdtempSync(join(tmpdir(), 'peak-economy-host-'))
  const events = []
  const disposers = []
  const hostCtx = {
    get: () => undefined,
    on: (event, fn) => { events.push({ event: event, fn: fn }); return () => {} },
  }
  try {
    const host = economy.createHost({
      ctx: hostCtx,
      config: economy.normalizeConfig({}),
      isRestDay: () => false,
      report: () => {},
      home: hostHome,
    })
    disposers.push(host.install())
    const stopTick = host.start()

    check('mount registers the llm/stream gate', events.map((entry) => entry.event), ['llm/stream'])
    const status = host.statusFor('chat-a')
    check('status names the chat and its switches', {
      ok: status.ok,
      sessionId: status.sessionId,
      sessionEnabled: status.sessionEnabled,
      masterEnabled: status.masterEnabled,
      dormant: status.dormant,
      windows: status.windows.map((window) => window.pauseAt + '-' + window.resumeAt),
    }, {
      ok: true,
      sessionId: 'chat-a',
      sessionEnabled: false,
      masterEnabled: true,
      dormant: false,
      windows: ['09:00-12:00', '14:00-18:00'],
    })
    check('status without a chat is inert', { sessionId: host.statusFor(null).sessionId, sessionEnabled: host.statusFor(null).sessionEnabled }, { sessionId: null, sessionEnabled: false })

    // Flip the switch through the real route handler.
    const flipped = await call('POST', economy.ECONOMY_PREFIX + '/toggle', '{"sessionId":"chat-a"}', undefined, host.handler)
    check('the host route toggles the chat on', flipped.status, 200)
    check('and the status reflects it', host.statusFor('chat-a').sessionEnabled, true)

    host.releaseAll()
    stopTick()
  } finally {
    for (const dispose of disposers) dispose()
    rmSync(hostHome, { recursive: true, force: true })
  }
}

console.log('\n' + passed + ' passed, ' + failed + ' failed')
if (failed > 0) process.exit(1)
