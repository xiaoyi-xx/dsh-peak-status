/**
 * Boundary tests for the peak/off-peak algorithm.
 *
 * Policy (effective 2026-08-17, weekends adjusted 2026-08-23):
 *   weekdays: peak 09:00–12:00 / 14:00–18:00 (Beijing time), off otherwise
 *   weekends: Saturday & Sunday all day off-peak (valley price)
 *
 * NOTE: mirrors the `compute` function in src/client.js — keep in sync when
 * editing BOUNDS, the weekend rule, or the boundary logic there.
 */
const BOUNDS = [540, 720, 840, 1080] // 09:00, 12:00, 14:00, 18:00 (minutes)

// weekday: ISO 1=Mon … 7=Sun
function compute(h, m, s, weekday) {
  const now = h * 60 + m
  const weekend = weekday === 6 || weekday === 7
  let peak, nextMin, daysAhead, phaseStartMin, phaseLenMin

  if (weekend) {
    peak = false
    nextMin = BOUNDS[0]
    daysAhead = ((1 - weekday + 7) % 7) || 7
    const daysSinceSat = (weekday - 6 + 7) % 7
    phaseStartMin = daysSinceSat * 1440
    phaseLenMin = 2 * 1440 + BOUNDS[0]
  } else {
    peak = (now >= BOUNDS[0] && now < BOUNDS[1]) || (now >= BOUNDS[2] && now < BOUNDS[3])
    let next = null
    for (let i = 0; i < BOUNDS.length; i++) {
      if (BOUNDS[i] > now) { next = BOUNDS[i]; break }
    }
    if (next !== null) {
      nextMin = next
      daysAhead = 0
      let ps = 0
      for (let j = BOUNDS.length - 1; j >= 0; j--) {
        if (BOUNDS[j] <= now) { ps = BOUNDS[j]; break }
      }
      phaseStartMin = ps
      phaseLenMin = nextMin - ps
    } else {
      nextMin = BOUNDS[0]
      daysAhead = weekday === 5 ? 3 : 1
      phaseStartMin = BOUNDS[3]
      phaseLenMin = daysAhead * 1440 + BOUNDS[0] - phaseStartMin
    }
  }

  const secsToNext = daysAhead * 86400 + (nextMin - now) * 60 - s
  const elapsedMin = weekend ? (weekday - 6 + 7) % 7 * 1440 + now : now - phaseStartMin
  const progress = phaseLenMin > 0 ? Math.min(100, Math.max(0, (elapsedMin / phaseLenMin) * 100)) : 0
  return { peak, nextMin, daysAhead, secsToNext, progress }
}

const cases = [
  // label, h, m, s, weekday, expectPeak, nextMin, daysAhead
  ['Mon 10:00 morning peak', 10, 0, 0, 1, true, 720, 0],
  ['Mon 12:30 off before 14:00', 12, 30, 0, 1, false, 840, 0],
  ['Wed 15:00 afternoon peak', 15, 0, 0, 3, true, 1080, 0],
  ['Wed 18:00 exact — peak ends', 18, 0, 0, 3, false, 540, 1],
  ['Thu 19:00 → next day 09:00', 19, 0, 0, 4, false, 540, 1],
  ['Fri 19:00 → Monday 09:00 (3d)', 19, 0, 0, 5, false, 540, 3],
  ['Fri 18:00 exact — weekend starts', 18, 0, 0, 5, false, 540, 3],
  ['Sat 10:00 — weekend all off', 10, 0, 0, 6, false, 540, 2],
  ['Sat 09:00 edge — still off', 9, 0, 0, 6, false, 540, 2],
  ['Sun 15:00 — weekend off', 15, 0, 0, 7, false, 540, 1],
  ['Sun 23:59 — near Monday', 23, 59, 59, 7, false, 540, 1],
  ['Mon 09:00 exact — peak begins', 9, 0, 0, 1, true, 720, 0],
  ['Mon 08:00 — before first peak', 8, 0, 0, 1, false, 540, 0],
]

let failed = 0
for (const c of cases) {
  const r = compute(c[1], c[2], c[3], c[4])
  const ok = r.peak === c[5] && r.nextMin === c[6] && r.daysAhead === c[7]
  const next = Math.floor(r.nextMin / 60) + ':' + String(r.nextMin % 60).padStart(2, '0')
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c[0].padEnd(34)} peak=${String(r.peak).padEnd(5)} next=${next} +${r.daysAhead}d in=${Math.round(r.secsToNext / 60)}m`)
  if (!ok) failed++
}
if (failed > 0) {
  console.error(`${failed} case(s) failed`)
  process.exit(1)
}
console.log(`all ${cases.length} cases passed`)
