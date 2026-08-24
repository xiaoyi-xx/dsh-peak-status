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

## What you get

- A colored status dot — **red = peak, green = off-peak** — plus the live Beijing clock (`HH:MM:SS`, timezone `Asia/Shanghai`, independent of your machine's timezone)
- A countdown: `剩 3h 54m · 价格 ×2` during peak / `距高峰 3h 54m · 半价` off-peak
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

The chip updates every second. Click it to expand/collapse the detail card; hover for a quick tooltip. Peak/off-peak state follows the official schedule above, computed in Beijing time.

If DeepSeek ever changes the peak schedule, a new release will ship with the updated windows — open an issue on this repository if you notice a mismatch.

## License

[MIT](LICENSE)
