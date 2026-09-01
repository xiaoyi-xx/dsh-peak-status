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

    /** Beijing time parts incl. ISO weekday (1=Mon … 7=Sun), timezone-proof. */
    function bjParts() {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TZ, hour12: false, weekday: 'short',
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
        h: Number(get('hour')),
        m: Number(get('minute')),
        s: Number(get('second')),
        weekday: wdMap[get('weekday')] || 1,
      }
    }

    /**
     * Peak/off-peak state at a Beijing-time instant.
     * Weekends (Sat/Sun) are all-day off-peak; weekdays follow the peak
     * windows 09:00–12:00 / 14:00–18:00. Returns the next state boundary as
     * { nextMin, daysAhead } (daysAhead counts how many Beijing days away),
     * seconds until it, and the progress through the current phase.
     */
    function compute(t) {
      var now = t.h * 60 + t.m
      var weekend = t.weekday === 6 || t.weekday === 7
      var peak, nextMin, daysAhead, phaseStartMin, phaseLenMin

      if (weekend) {
        peak = false
        nextMin = BOUNDS[0] // Monday 09:00
        daysAhead = ((1 - t.weekday + 7) % 7) || 7 // Sat → 2, Sun → 1
        var daysSinceSat = (t.weekday - 6 + 7) % 7 // Sat=0, Sun=1
        phaseStartMin = daysSinceSat * 1440
        phaseLenMin = 2 * 1440 + BOUNDS[0] // Sat 00:00 → Mon 09:00
      } else {
        peak = (now >= BOUNDS[0] && now < BOUNDS[1]) || (now >= BOUNDS[2] && now < BOUNDS[3])
        var next = null
        for (var i = 0; i < BOUNDS.length; i++) {
          if (BOUNDS[i] > now) { next = BOUNDS[i]; break }
        }
        if (next !== null) {
          nextMin = next
          daysAhead = 0
          var ps = 0
          for (var j = BOUNDS.length - 1; j >= 0; j--) {
            if (BOUNDS[j] <= now) { ps = BOUNDS[j]; break }
          }
          phaseStartMin = ps
          phaseLenMin = nextMin - ps
        } else {
          nextMin = BOUNDS[0]
          // After 18:00: Friday → next Monday 09:00 (3 days), otherwise next day 09:00.
          daysAhead = t.weekday === 5 ? 3 : 1
          phaseStartMin = BOUNDS[3]
          phaseLenMin = daysAhead * 1440 + BOUNDS[0] - phaseStartMin
        }
      }

      var secsToNext = daysAhead * 86400 + (nextMin - now) * 60 - t.s
      var elapsedMin = weekend ? daysSinceSat * 1440 + now : now - phaseStartMin
      var progress = phaseLenMin > 0 ? Math.min(100, Math.max(0, (elapsedMin / phaseLenMin) * 100)) : 0
      return { peak: peak, nextMin: nextMin, daysAhead: daysAhead, secsToNext: secsToNext, progress: progress }
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
    /** Human label for the next boundary: "18:00" / "明天 09:00" / "周一 09:00". */
    function fmtBoundaryLabel(t, s) {
      if (s.daysAhead === 0) return fmtBoundary(s.nextMin)
      if (s.daysAhead === 1) return '明天 ' + fmtBoundary(s.nextMin)
      var nextW = ((t.weekday - 1 + s.daysAhead) % 7) + 1
      return '周' + WEEKDAY_LABELS[nextW - 1] + ' ' + fmtBoundary(s.nextMin)
    }

    function PeakChip() {
      var tickState = react.useState(bjParts())
      var tick = tickState[0]
      var setTick = tickState[1]
      var open = react.useState(false)
      var setOpen = open[1]

      react.useEffect(function () {
        var id = setInterval(function () { setTick(bjParts()) }, 1000)
        return function () { clearInterval(id) }
      }, [])

      var s = compute(tick)
      var weekend = tick.weekday === 6 || tick.weekday === 7
      var color = s.peak ? PEAK_COLOR : OFF_COLOR
      var clock = fmtClock(tick)
      var boundaryLabel = fmtBoundaryLabel(tick, s)

      var chip = react.createElement(
        'div',
        {
          onClick: function () { setOpen(!open[0]) },
          title: s.peak
            ? '高峰期（工作日 9:00-12:00 / 14:00-18:00）：价格 = 空闲 ×2。' + boundaryLabel + ' 结束，点击展开详情'
            : '空闲期：价格为高峰一半' + (weekend ? '（周末全天谷价）' : '') + '。下一高峰 ' + boundaryLabel + '，点击展开详情',
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
          react.createElement('span', { key: 'state', style: { fontWeight: s.peak ? 700 : 500, color: color } },
            s.peak ? '高峰期' : (weekend ? '周末谷价' : '空闲期')),
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
              s.peak ? '高峰时段' : (weekend ? '周末谷价' : '空闲时段')),
            react.createElement('span', { key: 'tm', style: { fontVariantNumeric: 'tabular-nums' } },
              clock + '（北京）'),
            react.createElement('span', { key: 'price', style: { color: color, fontWeight: 500 } },
              s.peak ? '价格 ×2' : '半价'),
          ]),
          react.createElement('div', { key: 'l2' },
            '高峰窗口（工作日）：09:00–12:00 / 14:00–18:00'),
          react.createElement('div', { key: 'l2b', style: { color: weekend ? OFF_COLOR : DIM, fontWeight: weekend ? 600 : 400 } },
            '周末（周六、周日）：全天按谷价计费'),
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
