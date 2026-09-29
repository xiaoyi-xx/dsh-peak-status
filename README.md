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

Per DeepSeek's peak/valley note, the only days that can peak are ordinary Monday–Friday working days:

| Day | State (Beijing time) |
| :-- | :-- |
| 法定节假日 (statutory holiday) | valley for the whole day, exactly like a weekend |
| 调休上班的周末 (a weekend worked) | valley for the whole day too — 调休 does not change billing |

So the chip shows 🟢 **国庆节** instead of a red peak on 1 October, and 🟢 **调休上班 · 谷价** on a 调休 Saturday.

## What you get

- A colored status dot — **red = peak, green = off-peak** — plus the live Beijing clock (`HH:MM:SS`, timezone `Asia/Shanghai`, independent of your machine's timezone)
- A countdown: `剩 3h 54m · 价格 ×2` during peak / `距高峰 3h 54m · 半价` off-peak
- Holiday awareness: on a 法定节假日 the chip names the festival (e.g. `国庆节`) and counts down to the first peak window after the break; on a 调休上班的周末 it shows all-day valley and tags the day
- Click the chip to expand a detail card: peak windows, the next transition with a `HH:MM:SS` countdown, and a progress bar of the current phase
- Fully themed with the web UI's native `--dsw-alias-*` variables — it blends into the interface instead of floating over it
- Mounted persistently: it survives dsh web restarts
- Economy mode: a per-chat green-leaf switch that holds that chat’s model calls through a peak window, resumes them automatically in the half-price valley, and shows a green-leaf dormant bar while a call is parked

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

## Economy mode (per chat)

The header chip now carries a **green-leaf switch**: open the detail card and the bottom row lets you turn economy mode on for **this chat alone**.

While it is on:

- **Peak pauses the chat.** Its model calls are parked before they reach the provider — `llm/stream` is the waterfall every call passes through — so nothing is sent and nothing is billed. An active goal in that chat is frozen too, so it reads as paused instead of spinning forever.
- **A message you send during peak waits.** It lands in the transcript, but the model call behind it only starts once the half-price valley arrives.
- **The valley resumes it automatically**, including across a restart: frozen goals are recorded on disk, and the next process resumes exactly the ones it froze.
- **A green-leaf dormant bar appears while a call is parked**, docked above the composer: `🍃 经济模式休眠中 · 高峰时段已暂停本对话的模型请求，不会产生费用 · 12:02 自动继续（剩 01:23:45）`. To continue immediately, turn this chat's economy mode off in the chip.

Chats without economy mode are untouched — chat A can be dormant while chat B runs at full speed.

The schedule is the very same one the chip draws (same calendar, same rules), so the chip can never claim "valley" while a request is still parked. A call already in flight when the window opens runs to completion; the pause lands on the next step, because aborting mid-step would discard that step's work.

Configuration is optional, in the `dsh-peak-status` row of `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
config:
  economy:
    enabled: true              # master switch; each chat's own switch is the real control
    windows:                   # half-open [pauseAt, resumeAt), Beijing time
      - { id: peak-am, pauseAt: '09:00', resumeAt: '12:00' }
      - { id: peak-pm, pauseAt: '14:00', resumeAt: '18:00' }
    activeDays: [1, 2, 3, 4, 5]  # ISO weekdays a window may apply to (weekends are valley)
    warnMinutes: 5             # how long before a window the chip reports "approaching"
    routeFilter: deepseek-official   # or `all` to hold every provider
    defaultEnabled: false      # true = every new chat starts in economy mode
```

State files: `$DSH_HOME/peak-status-economy-sessions.json` (the per-chat switches) and `$DSH_HOME/peak-status-economy-paused.json` (goals this plugin froze, so a restart resumes only those).

Known limits: **a subagent does not follow its parent's switch** — it has its own session id and its own switch. Auxiliary calls (title generation, compaction) carry the session id, so they are held with everything else.

## Holiday calendar

The calendar (法定节假日 + 调休 makeup days) is fetched over the network, with three layers of fallback:

1. **Host route** — the plugin's host half serves a same-origin route `/dsh-peak-status/holiday/<year>`. It tries jiejiariapi first and apihubs second, normalizes both shapes and caches the result in memory for 6 hours, so every browser tab shares one fetch.
2. **Browser fallback** — if that route is unavailable, the browser half calls `api.apihubs.cn` directly (it is CORS-enabled).
3. **Plain weekend rule** — with no calendar at all the chip behaves exactly like 1.0.3: weekday windows plus weekend valley.

Normalized days are cached in `localStorage` for 24 hours, so a restart or a spell offline still renders the right state, and the detail card always reports the source (`已同步 · jiejiariapi` / `未同步 · 暂按周末规则`).

Pricing follows DeepSeek's 峰谷时间说明: **调休上班的周末 and 中国法定节假日 are billed at the off-peak rate for the whole day**. The calendar supplies exactly those two labels — a 调休 day never gains a peak window.

## License

[MIT](LICENSE)
