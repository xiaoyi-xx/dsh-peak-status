/**
 * dsh-peak-status — browser half.
 *
 * A compact status chip in the session header's right-aligned utilities
 * strip (conversation.session.header.utilities) — the very top of the
 * conversation — fully themed with the web UI's native --dsw-alias-*
 * variables so it blends into the interface.
 *
 * Shows whether the current Beijing time falls in DeepSeek's API peak
 * window. Official pricing (peak/valley, effective 2026-08-17, weekends
 * adjusted 2026-08-23):
 *   weekdays peak:   09:00–12:00 and 14:00–18:00 (Beijing time)
 *   weekends:        Saturday & Sunday all day at the valley price
 *   off-peak:        everything else (priced at half of peak)
 *
 * The Chinese official work calendar refines the weekend half of that rule:
 * 法定节假日 (holiday rest days) are valley all day, and 调休 makeup days keep
 * the normal weekday windows. The calendar is fetched over the network — the
 * host half serves it same-origin, a CORS-capable public source and finally
 * the plain weekend rule are the fallbacks — and cached in localStorage.
 *
 * Red = peak (bold), green = off-peak; live Beijing clock, countdown to the
 * next transition, click to expand a small popover with the full detail.
 * Mounted persistently via the profile's cordis.patch.yml, so it survives
 * restarts.
 */
(function () {
  // The host client-modules expects a bundle to register the id of the entry
  // it is mounted as — the package name ("@local/dsh-peak-status" for a
  // profile @local install, "dsh-peak-status" when installed from npm).
  //
  // Single-file loads use /plugins/<id>/client.js, so the id is derivable
  // from document.currentScript.src. Since dsh 0.1.2-alpha.3 the web shell
  // may serve plugin bundles as one shared combo script
  // (/plugins/??<id>/client.js,<id2>/client.js&rev=...) — currentScript.src
  // then names every bundle in the batch, not this one. Fall back to
  // scanning the combo URL for our own package leaf, which is present in
  // both install shapes.
  var MODULE_ID = (function () {
    var OWN = 'dsh-peak-status'
    try {
      var el = document.currentScript
      if (el && el.src) {
        var src = el.src
        var single = /\/plugins\/([^/]+)\/client\.js(?:\?|$)/.exec(src)
        if (single) return decodeURIComponent(single[1])
        var combo = /\/plugins\/\?\?([^&]+)/.exec(src)
        if (combo) {
          var parts = combo[1].split(',')
          for (var i = 0; i < parts.length; i++) {
            var m = /^(.+?)\/client\.js$/.exec(parts[i])
            if (m && decodeURIComponent(m[1]).split('/').pop() === OWN) {
              return decodeURIComponent(m[1])
            }
          }
        }
      }
    } catch (error) { /* ignore */ }
    return null
  })()

  var MODULE_FACTORY = (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')

    var TZ = 'Asia/Shanghai'
    // Weekday peak window boundaries in minutes of day: 09:00, 12:00, 14:00, 18:00.
    var BOUNDS = [540, 720, 840, 1080]
    // Weekday labels for "next boundary" display (ISO weekday 1..7).
    var WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

    var FONT = 'var(--dsw-font-family, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif)'
    var DIM = 'var(--dsw-alias-label-secondary, var(--dsh-text-dim, #8a8f98))'
    var PEAK_COLOR = 'var(--dsw-alias-state-error-primary, #e5484d)'
    var OFF_COLOR = 'var(--dsw-alias-state-success-primary, #30a46c)'

    /**
     * Beijing time parts: calendar date (y/mo/d), clock, and ISO weekday
     * (1=Mon … 7=Sun). `mo` is the month; minutes are `m`, timezone-proof.
     */
    function bjParts() {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ, hour12: false, weekday: 'short',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(new Date())
      var get = function (type) {
        for (var i = 0; i < parts.length; i++) {
          if (parts[i].type === type) return parts[i].value
        }
        return ''
      }
      var wdMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
      return {
        y: Number(get('year')),
        mo: Number(get('month')),
        d: Number(get('day')),
        h: Number(get('hour')),
        m: Number(get('minute')),
        s: Number(get('second')),
        weekday: wdMap[get('weekday')] || 1,
      }
    }

    // ── 节假日表（网络拉取 + 本地缓存） ────────────────────────────────────
    // 数据源优先级：host 半同源路由 → 浏览器可直连的 CORS 源 → 内置周末规则。
    // 全部失败时退化成 1.0.3 的行为：胶囊照常工作，只在详情里标注未同步。
    var CAL_ROUTE = '/dsh-peak-status/holiday/'
    var CAL_CORS_URL = function (year) { return 'https://api.apihubs.cn/holiday/get?year=' + year + '&size=400' }
    var CAL_TTL_MS = 24 * 60 * 60 * 1000
    var CAL_TIMEOUT_MS = 8000
    var CAL_KEY = 'dsh-peak-status:holiday:'
    var CAL_SCAN_LIMIT = 40

    /** year → { days, source, fetchedAt }；pending[year] 防止并发重复拉取。 */
    var cal = { years: {}, pending: {}, listeners: [] }

    /** 订阅节假日表变化，返回退订函数（React 侧用它触发重渲染）。 */
    function calSubscribe(listener) {
      cal.listeners.push(listener)
      return function () {
        var index = cal.listeners.indexOf(listener)
        if (index >= 0) cal.listeners.splice(index, 1)
      }
    }

    function calNotify() {
      for (var i = 0; i < cal.listeners.length; i++) {
        try { cal.listeners[i]() } catch (error) { /* 单个订阅者失败不影响其它 */ }
      }
    }

    /** 'YYYY-MM-DD' —— 日历表的键。 */
    function dayKey(y, mo, d) { return y + '-' + pad(mo) + '-' + pad(d) }

    /** 自 1970-01-01 起的天序号；用 UTC 换算，绕开本地时区与夏令时。 */
    function dayOrdinal(y, mo, d) { return Math.round(Date.UTC(y, mo - 1, d) / 86400000) }
    function ordinalToParts(ordinal) {
      var at = new Date(ordinal * 86400000)
      return { y: at.getUTCFullYear(), mo: at.getUTCMonth() + 1, d: at.getUTCDate() }
    }
    /** 1970-01-01 是周四 → ISO 1=周一 … 7=周日。 */
    function weekdayOf(ordinal) { return ((ordinal + 3) % 7 + 7) % 7 + 1 }

    function storageGet(key) {
      try { return window.localStorage.getItem(key) } catch (error) { return null }
    }
    function storageSet(key, value) {
      try { window.localStorage.setItem(key, value) } catch (error) { /* 隐私模式/配额满：忽略 */ }
    }

    /** `20261001` 或 `2026-10-01` → `2026-10-01`；其它 → null。 */
    function toIsoDate(value) {
      if (typeof value === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
      if (typeof value !== 'number' || !isFinite(value)) return null
      var text = String(Math.trunc(value))
      return /^\d{8}$/.test(text) ? text.slice(0, 4) + '-' + text.slice(4, 6) + '-' + text.slice(6, 8) : null
    }

    /** 只保留结构正确的条目，脏缓存不至于把 UI 弄崩。 */
    function sanitizeDays(days) {
      if (days === null || typeof days !== 'object') return null
      var out = {}
      var count = 0
      for (var key in days) {
        if (!Object.prototype.hasOwnProperty.call(days, key)) continue
        var row = days[key]
        if (row === null || typeof row !== 'object' || typeof row.off !== 'boolean') continue
        out[key] = { name: typeof row.name === 'string' ? row.name : '', off: row.off }
        count++
      }
      return count > 0 ? out : null
    }

    /** jiejiariapi：{ 'YYYY-MM-DD': { date, name, isOffDay } }，只列特殊日。 */
    function fromJiejiariapi(payload) {
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
      var days = {}
      var count = 0
      for (var key in payload) {
        if (!Object.prototype.hasOwnProperty.call(payload, key)) continue
        var row = payload[key]
        if (row === null || typeof row !== 'object' || typeof row.isOffDay !== 'boolean') continue
        var date = toIsoDate(row.date === undefined ? key : row.date)
        if (date === null) continue
        days[date] = { name: typeof row.name === 'string' ? row.name : '', off: row.isOffDay }
        count++
      }
      return count > 0 ? days : null
    }

    /**
     * apihubs：{ data: { list: [ { date: 20261001, holiday_recess, holiday_overtime } ] } }。
     * 数字是节日编码：holiday_recess=1 放假，holiday_overtime≠10 为调休补班（见下方注释）。
     */
    function fromApihubs(payload) {
      if (payload === null || typeof payload !== 'object') return null
      var data = payload.data !== null && typeof payload.data === 'object' ? payload.data : payload
      var list = Array.isArray(data.list) ? data.list : (Array.isArray(data) ? data : null)
      if (list === null) return null
      var days = {}
      var count = 0
      for (var i = 0; i < list.length; i++) {
        var row = list[i]
        if (row === null || typeof row !== 'object') continue
        var date = toIsoDate(row.date)
        if (date === null) continue
        // apihubs 用节日编号编码：holiday_recess=1 是放假日，holiday_overtime
        // 为 10 表示非调休，其余值（11/22/55/88…）都是周末补班。
        var off = row.holiday_recess === 1
        var overtime = typeof row.holiday_overtime === 'number' && row.holiday_overtime !== 10
        if (!off && !overtime) continue
        days[date] = { name: '', off: off }
        count++
      }
      return count > 0 ? days : null
    }

    /** 归一化任一支持的载荷（host 路由 / jiejiariapi / apihubs）。 */
    function normalizeCalendar(payload) {
      if (payload === null || typeof payload !== 'object') return null
      if (payload.days !== undefined) return sanitizeDays(payload.days)
      return fromJiejiariapi(payload) || fromApihubs(payload)
    }

    /** 带超时的 JSON 拉取；浏览器不支持 fetch 时直接失败，走下一层降级。 */
    function fetchJson(url) {
      return new Promise(function (resolve, reject) {
        if (typeof fetch !== 'function') { reject(new Error('fetch unavailable')); return }
        var controller = typeof AbortController === 'function' ? new AbortController() : null
        var timer = setTimeout(function () {
          if (controller !== null) controller.abort()
          reject(new Error('timeout'))
        }, CAL_TIMEOUT_MS)
        var options = { headers: { accept: 'application/json' } }
        if (controller !== null) options.signal = controller.signal
        fetch(url, options).then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        }).then(function (json) {
          clearTimeout(timer)
          resolve(json)
        }, function (error) {
          clearTimeout(timer)
          reject(error)
        })
      })
    }

    /** 读缓存：内存 → localStorage。 */
    function cachedYear(year) {
      var entry = cal.years[year]
      if (entry !== undefined) return entry
      var raw = storageGet(CAL_KEY + year)
      if (raw === null) return null
      var parsed = null
      try { parsed = JSON.parse(raw) } catch (error) { return null }
      if (parsed === null || typeof parsed !== 'object') return null
      var days = sanitizeDays(parsed.days)
      if (days === null) return null
      entry = { days: days, source: String(parsed.source || 'cache'), fetchedAt: Number(parsed.fetchedAt) || 0 }
      cal.years[year] = entry
      return entry
    }

    /** 拉取一年：先同源路由（含节日名），再浏览器可直连的 CORS 源。 */
    function loadYear(year) {
      return fetchJson(CAL_ROUTE + year).then(function (payload) {
        var days = normalizeCalendar(payload)
        if (days === null) return null
        return {
          days: days,
          source: String(payload === null || payload === undefined || payload.source === undefined ? 'host' : payload.source),
          fetchedAt: Date.now(),
        }
      }, function () { return null }).then(function (entry) {
        if (entry !== null) return entry
        return fetchJson(CAL_CORS_URL(year)).then(function (payload) {
          var days = normalizeCalendar(payload)
          return days === null ? null : { days: days, source: 'apihubs', fetchedAt: Date.now() }
        }, function () { return null })
      })
    }

    /** 需要时异步补拉一年；命中新鲜缓存或已在拉取则直接返回。 */
    function ensureYear(year) {
      var entry = cachedYear(year)
      if (entry !== null && Date.now() - entry.fetchedAt < CAL_TTL_MS) return
      if (cal.pending[year] === true) return
      cal.pending[year] = true
      loadYear(year).then(function (loaded) {
        cal.pending[year] = false
        if (loaded === null) { calNotify(); return }
        cal.years[year] = loaded
        storageSet(CAL_KEY + year, JSON.stringify({ source: loaded.source, fetchedAt: loaded.fetchedAt, days: loaded.days }))
        calNotify()
      }, function () {
        cal.pending[year] = false
        calNotify()
      })
    }

    /** 该年的日历；未同步/未缓存 → null，调用方按周末规则退化。 */
    function daysOfYear(year) {
      var entry = cachedYear(year)
      return entry === null ? null : entry.days
    }

    /** 详情卡里的同步状态文案。 */
    function calStatusText(year) {
      if (cal.years[year] !== undefined) return '已同步 · ' + cal.years[year].source
      if (cal.pending[year] === true) return '同步中…'
      return '未同步 · 暂按周末规则'
    }

    /**
     * 一天的工作/休息属性。
     * 有日历：法定节假日 = 全天谷价；调休上班日 = 照工作日窗口；其余照常。
     * 无日历：退化成 1.0.3 的规则（周六周日休息，其余工作日）。
     * @param key - 'YYYY-MM-DD'。
     * @param weekday - ISO 1=周一 … 7=周日。
     * @param days - 该年归一化日历或 null。
     */
    function classifyDay(key, weekday, days) {
      var row = days === null || days === undefined ? null : days[key]
      if (row !== undefined && row !== null) {
        if (row.off === true) return { rest: true, kind: 'holiday', name: row.name || '' }
        if (weekday === 6 || weekday === 7) return { rest: false, kind: 'makeup', name: row.name || '' }
        return { rest: false, kind: 'weekday', name: row.name || '' }
      }
      if (weekday === 6 || weekday === 7) return { rest: true, kind: 'weekend', name: '' }
      return { rest: false, kind: 'weekday', name: '' }
    }

    function classifyOrdinal(ordinal, daysOf) {
      var parts = ordinalToParts(ordinal)
      return classifyDay(dayKey(parts.y, parts.mo, parts.d), weekdayOf(ordinal), daysOf(parts.y))
    }

    /** 下一个转折点：当天剩下的窗口边界，或下一个工作日 09:00（可跨假期）。 */
    function nextTransition(ordinal, nowMin, daysOf) {
      if (!classifyOrdinal(ordinal, daysOf).rest) {
        for (var i = 0; i < BOUNDS.length; i++) {
          if (BOUNDS[i] > nowMin) return { ordinal: ordinal, min: BOUNDS[i] }
        }
      }
      for (var step = 1; step <= CAL_SCAN_LIMIT; step++) {
        var ahead = ordinal + step
        if (!classifyOrdinal(ahead, daysOf).rest) return { ordinal: ahead, min: BOUNDS[0] }
      }
      return { ordinal: ordinal + 1, min: BOUNDS[0] } // 40 天内没有工作日：理论上不可达
    }

    /** 上一个转折点：当天已过的最后一个边界，或上一个工作日 18:00。 */
    function prevTransition(ordinal, nowMin, daysOf) {
      if (!classifyOrdinal(ordinal, daysOf).rest) {
        for (var i = BOUNDS.length - 1; i >= 0; i--) {
          if (BOUNDS[i] <= nowMin) return { ordinal: ordinal, min: BOUNDS[i] }
        }
      }
      for (var step = 1; step <= CAL_SCAN_LIMIT; step++) {
        var behind = ordinal - step
        if (!classifyOrdinal(behind, daysOf).rest) return { ordinal: behind, min: BOUNDS[3] }
      }
      return { ordinal: ordinal - 1, min: BOUNDS[3] } // 40 天内没有工作日：理论上不可达
    }

    /**
     * Peak/off-peak state at one Beijing-time instant.
     * The official work calendar decides which days may peak at all: holiday
     * rest days are valley across their whole span and makeup workdays keep the
     * weekday windows, so both the current state and its neighbouring
     * transitions are found by scanning days instead of weekday arithmetic.
     * @param t - bjParts() result (calendar date, clock, ISO weekday).
     * @param daysOf - year → normalized days; defaults to the loaded cache.
     * @returns { peak, nextMin, daysAhead, nextOrdinal, nextWeekday, secsToNext, progress, day }
     */
    function compute(t, daysOf) {
      var lookup = daysOf === undefined ? daysOfYear : daysOf
      var ordinal = dayOrdinal(t.y, t.mo, t.d)
      var nowMin = t.h * 60 + t.m
      var day = classifyDay(dayKey(t.y, t.mo, t.d), t.weekday, lookup(t.y))
      var peak = !day.rest &&
        ((nowMin >= BOUNDS[0] && nowMin < BOUNDS[1]) || (nowMin >= BOUNDS[2] && nowMin < BOUNDS[3]))
      var next = nextTransition(ordinal, nowMin, lookup)
      var prev = prevTransition(ordinal, nowMin, lookup)
      var nowAbs = ordinal * 1440 + nowMin
      var nextAbs = next.ordinal * 1440 + next.min
      var prevAbs = prev.ordinal * 1440 + prev.min
      var phaseLen = nextAbs - prevAbs
      return {
        peak: peak,
        nextMin: next.min,
        daysAhead: next.ordinal - ordinal,
        nextOrdinal: next.ordinal,
        nextWeekday: weekdayOf(next.ordinal),
        secsToNext: (nextAbs - nowAbs) * 60 - t.s,
        progress: phaseLen > 0 ? Math.min(100, Math.max(0, ((nowAbs - prevAbs) / phaseLen) * 100)) : 0,
        day: day,
      }
    }

    function pad(n) { return (n < 10 ? '0' : '') + n }
    function fmtClock(t) { return pad(t.h) + ':' + pad(t.m) + ':' + pad(t.s) }
    function fmtBoundary(min) { return pad(Math.floor(min / 60)) + ':' + pad(min % 60) }
    function fmtDur(totalSecs) {
      var s = Math.max(0, Math.round(totalSecs))
      var d = Math.floor(s / 86400)
      var h = Math.floor((s % 86400) / 3600)
      var m = Math.floor((s % 3600) / 60)
      if (d > 0) return d + 'd ' + h + 'h'
      return (h > 0 ? h + 'h ' : '') + m + 'm'
    }
    function fmtDurFull(totalSecs) {
      var s = Math.max(0, Math.round(totalSecs))
      var h = Math.floor(s / 3600)
      var m = Math.floor((s % 3600) / 60)
      var sec = s % 60
      return pad(h) + ':' + pad(m) + ':' + pad(sec)
    }
    /**
     * Human label for the next boundary: "18:00" / "明天 09:00" / "周一 09:00",
     * and an explicit date once the jump passes a week — a 国庆 break or a 调休
     * week easily spans six days and a weekday name would read as next week.
     */
    function fmtBoundaryLabel(s) {
      if (s.daysAhead === 0) return fmtBoundary(s.nextMin)
      if (s.daysAhead === 1) return '明天 ' + fmtBoundary(s.nextMin)
      if (s.daysAhead <= 6) return '周' + WEEKDAY_LABELS[s.nextWeekday - 1] + ' ' + fmtBoundary(s.nextMin)
      var parts = ordinalToParts(s.nextOrdinal)
      return pad(parts.mo) + '-' + pad(parts.d) + ' ' + fmtBoundary(s.nextMin)
    }

    function PeakChip() {
      var tickState = react.useState(bjParts())
      var tick = tickState[0]
      var setTick = tickState[1]
      var open = react.useState(false)
      var setOpen = open[1]
      var setBump = react.useState(0)[1]

      react.useEffect(function () {
        var id = setInterval(function () {
          var next = bjParts()
          setTick(next)
          ensureYear(next.y)
          if (next.mo === 12) ensureYear(next.y + 1) // 跨年：提前取下一年的表
        }, 1000)
        return function () { clearInterval(id) }
      }, [])

      // The calendar arrives asynchronously — re-render when it lands. Until
      // then compute() degrades to the plain weekday/weekend rule on its own.
      react.useEffect(function () {
        return calSubscribe(function () { setBump(function (n) { return n + 1 }) })
      }, [])

      var s = compute(tick)
      var day = s.day
      var color = s.peak ? PEAK_COLOR : OFF_COLOR
      var clock = fmtClock(tick)
      var boundaryLabel = fmtBoundaryLabel(s)
      var stateWord = s.peak
        ? '高峰期'
        : (day.kind === 'holiday' ? (day.name || '法定节假日') : (day.kind === 'weekend' ? '周末谷价' : '空闲期'))
      var dayNote = day.kind === 'holiday'
        ? ('今日' + (day.name === '' ? '为法定节假日' : '为' + day.name) + '：全天按谷价计费。')
        : (day.kind === 'makeup'
          ? ('今日为调休上班日（周' + WEEKDAY_LABELS[tick.weekday - 1] + '）：高峰窗口照常。')
          : '')
      var offNote = day.kind === 'holiday'
        ? ('（' + (day.name === '' ? '法定节假日' : day.name) + ' 全天谷价）')
        : (day.kind === 'weekend' ? '（周末全天谷价）' : '')
      var tooltip = (s.peak
        ? '高峰期（工作日 9:00-12:00 / 14:00-18:00）：价格 = 空闲 ×2。' + boundaryLabel + ' 结束。'
        : '空闲期：价格为高峰一半' + offNote + '，下一高峰 ' + boundaryLabel + '。') + dayNote + '点击展开详情'

      var chip = react.createElement(
        'div',
        {
          onClick: function () { setOpen(!open[0]) },
          title: tooltip,
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontFamily: FONT, fontSize: 12, lineHeight: '20px',
            padding: '1px 10px', borderRadius: 999,
            background: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
            border: '1px solid var(--dsw-alias-border-l1, #e4e7ec)',
            color: DIM, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
          },
        },
        [
          react.createElement('span', { key: 'dot', style: { width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 } }),
          react.createElement('span', { key: 'state', style: { fontWeight: s.peak ? 700 : 500, color: color } }, stateWord),
          react.createElement('span', { key: 'clock', style: { fontVariantNumeric: 'tabular-nums' } }, clock),
          react.createElement('span', { key: 'count', style: { fontVariantNumeric: 'tabular-nums' } },
            s.peak
              ? ('剩 ' + fmtDur(s.secsToNext) + ' · 价格 ×2')
              : ('距高峰 ' + fmtDur(s.secsToNext) + ' · 半价')),
          react.createElement('span', { key: 'caret', style: { fontSize: 9, opacity: 0.7 } }, open[0] ? '▾' : '▸'),
        ],
      )

      if (!open[0]) return chip

      var popover = react.createElement(
        'div',
        {
          style: {
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, width: 264,
            zIndex: 60, display: 'flex', flexDirection: 'column', gap: 5,
            fontFamily: FONT, fontSize: 11.5, lineHeight: 1.6,
            color: DIM,
            background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-base, #ffffff))',
            border: '1px solid var(--dsw-alias-border-l1, #e4e7ec)',
            borderRadius: 10, padding: '8px 11px',
            boxShadow: 'var(--dsw-shadow-lv2, 0 8px 24px rgba(15,23,42,.14))',
          },
        },
        [
          react.createElement('div', { key: 'l1', style: { display: 'flex', alignItems: 'center', gap: 6 } }, [
            react.createElement('span', { key: 'st', style: { fontWeight: 700, color: color } },
              s.peak ? '高峰时段' : stateWord),
            react.createElement('span', { key: 'tm', style: { fontVariantNumeric: 'tabular-nums' } },
              clock + '（北京）'),
            react.createElement('span', { key: 'price', style: { color: color, fontWeight: 500 } },
              s.peak ? '价格 ×2' : '半价'),
          ]),
          react.createElement('div', { key: 'l2' },
            '高峰窗口（工作日）：09:00–12:00 / 14:00–18:00'),
          react.createElement('div', { key: 'l2b', style: { color: day.rest ? OFF_COLOR : DIM, fontWeight: day.rest ? 600 : 400 } },
            '法定节假日与周末（周六、周日）：全天按谷价计费'),
          react.createElement('div', { key: 'l2c', style: { color: day.kind === 'makeup' ? PEAK_COLOR : DIM, fontWeight: day.kind === 'makeup' ? 600 : 400 } },
            '调休上班日：照工作日高峰窗口计费'),
          dayNote === '' ? null : react.createElement('div', { key: 'daynote', style: { color: color, fontWeight: 600 } }, dayNote),
          react.createElement('div', { key: 'l3', style: { fontVariantNumeric: 'tabular-nums' } },
            '下一转折：' + boundaryLabel + ' · 倒计时 ' + fmtDurFull(s.secsToNext)),
          react.createElement('div', { key: 'bar', style: { display: 'flex', alignItems: 'center', gap: 8 } }, [
            react.createElement('div', { key: 'track', style: { flex: 1, height: 4, borderRadius: 2, background: 'var(--dsw-alias-border-l1, #e4e7ec)', overflow: 'hidden' } },
              react.createElement('div', { key: 'fill', style: {
                height: '100%', width: s.progress.toFixed(1) + '%',
                background: color, borderRadius: 2, transition: 'width .4s ease',
              } }),
            ),
            react.createElement('span', { key: 'pct', style: { fontSize: 10.5, fontVariantNumeric: 'tabular-nums' } },
              s.progress.toFixed(0) + '%'),
          ]),
          react.createElement('div', { key: 'cal', style: { fontSize: 10.5, opacity: 0.85 } },
            '节假日表（北京）：' + calStatusText(tick.y)),
          react.createElement('div', { key: 'foot', style: { fontSize: 10.5, lineHeight: 1.5, opacity: 0.85 } },
            '官方峰谷定价 8/17 生效，8/23 起周末全天谷价；空闲价 = 高峰一半。'),
        ],
      )

      return react.createElement(
        'div',
        { style: { position: 'relative', display: 'inline-block' } },
        [chip, popover],
      )
    }

    function apply(ctx) {
      try {
        var slots = ctx.get('slots')
        if (slots === undefined) return
        slots.inject('conversation.session.header.utilities', function () {
          return slots.register(
            { name: 'conversation.session.header.utilities', id: 'dsh-peak-status', order: 1 },
            PeakChip,
          )
        })
      } catch (error) {
        console.warn('[dsh-peak-status] apply failed:', error)
      }
    }

    var inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    // Test seam for scripts/test-peak.mjs: the harness drives these pure
    // functions directly instead of mirroring them, so the shipped algorithm
    // is the one under test. The loader never reads it.
    exports.__test = {
      compute: compute,
      classifyDay: classifyDay,
      dayKey: dayKey,
      dayOrdinal: dayOrdinal,
      ordinalToParts: ordinalToParts,
      weekdayOf: weekdayOf,
      normalizeCalendar: normalizeCalendar,
      calRoute: CAL_ROUTE,
      calCorsUrl: CAL_CORS_URL,
      calStatusText: calStatusText,
      ensureYear: ensureYear,
      daysOfYear: daysOfYear,
    }
    return module.exports
  }

  function registerModule(id) {
    window.__ModuleLoader__.load({ id: id, factory: MODULE_FACTORY })
  }

  if (MODULE_ID !== null) {
    registerModule(MODULE_ID)
  } else {
    // Script URL unavailable — cover both install shapes so neither mount
    // fails the "loaded without registering" check.
    registerModule('@local/dsh-peak-status')
    registerModule('dsh-peak-status')
  }
})()
