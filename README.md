# dsh-peak-status

English | [中文](README.zh-CN.md)

![peak indicator preview](assets/peak-indicator.png)

A peak-hour indicator for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI. A small native chip in the session header shows whether the current **Beijing time** is inside DeepSeek's API **peak window**, with a live clock, a countdown to the next transition, and a pricing hint.

## Peak windows

DeepSeek's official peak/valley API pricing (effective 2026-08-17, weekends adjusted 2026-08-23):

| State | When (Beijing time) | Price |
| :-- | :-- | :-- |
| 🔴 **Peak** | weekdays 09:00–12:00 and 14:00–18:00 | peak price (= off-peak ×2) |
| 🟢 **Off-peak** | everything else — including all of Saturday & Sunday | half of peak |

Weekends (Saturday and Sunday) are charged at the valley price all day — no peak windows on weekends.

The Chinese official work calendar refines the weekend half of that rule:

| Day | State (Beijing time) |
| :-- | :-- |
| 法定节假日 (statutory holiday) | valley for the whole day, exactly like a weekend |
| 调休 makeup workday (a weekend worked) | the normal weekday windows apply |

So the chip shows 🟢 **国庆节** instead of a red peak on 1 October, and 🔴 peak windows on a 调休 Saturday.

## What you get

- A colored status dot — **red = peak, green = off-peak** — plus the live Beijing clock (`HH:MM:SS`, timezone `Asia/Shanghai`, independent of your machine's timezone)
- A countdown: `剩 3h 54m · 价格 ×2` during peak / `距高峰 3h 54m · 半价` off-peak
- Holiday awareness: on a 法定节假日 the chip names the festival (e.g. `国庆节`) and counts down to the first peak window after the break; on a 调休 workday it shows the normal peak state and tags the day
- Click the chip to expand a detail card: peak windows, the next transition with a `HH:MM:SS` countdown, and a progress bar of the current phase
- Fully themed with the web UI's native `--dsw-alias-*` variables — it blends into the interface instead of floating over it
- Mounted persistently: it survives dsh web restarts

## Install

```sh
dsh plugin --profile web add dsh-peak-status
```

Prefer installing straight from GitHub:

```sh
dsh plugin --profile web add github:xiaoyi-xx/dsh-peak-status
```

Then restart `dsh web` (or refresh the page). The chip appears at the top-right of the conversation header.

## Usage

The chip updates every second. Click it to expand/collapse the detail card; hover for a quick tooltip. Peak/off-peak state follows the official schedule above, computed in Beijing time over the official work calendar.

If DeepSeek ever changes the peak schedule, a new release will ship with the updated windows — open an issue on this repository if you notice a mismatch.

## Holiday calendar

The calendar (法定节假日 + 调休 makeup days) is fetched over the network, with three layers of fallback:

1. **Host route** — the plugin's host half serves a same-origin route `/dsh-peak-status/holiday/<year>`. It tries jiejiariapi first and apihubs second, normalizes both shapes and caches the result in memory for 6 hours, so every browser tab shares one fetch.
2. **Browser fallback** — if that route is unavailable, the browser half calls `api.apihubs.cn` directly (it is CORS-enabled).
3. **Plain weekend rule** — with no calendar at all the chip behaves exactly like 1.0.3: weekday windows plus weekend valley.

Normalized days are cached in `localStorage` for 24 hours, so a restart or a spell offline still renders the right state, and the detail card always reports the source (`已同步 · jiejiariapi` / `未同步 · 暂按周末规则`).

This is the *official Chinese work calendar* reading of the pricing: statutory holidays are valley and 调休 days are workdays. DeepSeek's published adjustment only mentions Saturday and Sunday — if the calendar ever diverges from what is billed, the chip follows the calendar.

## License

[MIT](LICENSE)
