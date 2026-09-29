# Changelog

## [1.1.0] - 2026-09-24

- **新增：经济模式（每个对话独立）。** 会话头部胶囊的详情卡底部多出一行「经济模式」，可以为当前对话单独开启。开启后：
  - 高峰时段该对话的模型请求在到达 provider 前被挂起（`llm/stream` waterfall），不发送、不计费；该对话的活跃 goal 同时被冻结，状态显示为暂停而非永远转圈。
  - 高峰期间发出的消息会进入对话，但背后的模型调用等到空闲（半价）时段才开始处理。
  - 窗口结束自动恢复；插件卸载或 dsh 重启也不会让对话永久冻住——冻结的 goal 记录在 `$DSH_HOME/peak-status-economy-paused.json`，新进程只恢复自己冻的那些。
  - 挂起时在 composer 上方显示**绿叶休眠条**（`经济模式休眠中 · 高峰时段已暂停本对话的模型请求，不会产生费用 · HH:MM 自动继续`）。关闭该对话的经济模式即可立即恢复。
  - 未开启经济模式的对话完全不受影响。
- host 半新增 `src/economy/`：`schedule.js`（host 侧时段判定，与浏览器半共用同一份日历与规则）、`sessions.js`（按 session id 的开关存储）、`gate.js`（请求闸门）、`goals.js`（goal 冻结/恢复）、`routes.js`（`/dsh-peak-status/economy/{status,toggle,set}`，逐请求走 `connection.requestRejection()` 继承同一套 Host/Origin 与浏览器会话校验）、`host.js`（组装）。
- 新增可选配置 `config.economy`（窗口、适用星期、提前提醒、`routeFilter`、`defaultEnabled`），默认值即官方峰谷窗口，不配置也能用。
- 测试：新增 `scripts/test-economy.mjs`，66 例。其中 156 个采样点**交叉校验 host 时段判定与浏览器 `compute()` 的 peak/valley 结论**，两侧不可能悄悄分叉；另有闸门挂起/释放/中止行为、按对话开关持久化、路由状态码与围栏、以及两半 UI 的渲染用例。`npm test` 现在跑 51 + 66 例。
- 未改动现有的胶囊外观与「深度求索中…」显示：壳层那个忙碌状态是内联渲染、没有 slot，locale 命名空间也只有一个归属者，所以经济模式在 composer 上方自己声明休眠原因，而不是去争抢同一行像素。

## [1.0.5] - 2026-09-18

- **Fix (计费口径):** 调休上班的周末全天按空闲时段计费，而不是走工作日高峰窗口。DeepSeek 的峰谷时间说明把「调休上班的周末」与「中国法定节假日」都算作全天空闲，因此**只有普通周一~周五工作日才可能有高峰窗口**。1.0.4 错误地让调休周六进入了高峰窗口（09:00–12:00 / 14:00–18:00 按 ×2）；现在这类日期显示 🟢 `调休上班 · 谷价`，下一转折直接扫描到下一个普通工作日的 09:00。
- 调休标签仅作为信息保留：胶囊标注该日、详情卡解释口径，"下一次转换"的扫描也把调休周末与节假日一样跳过。
- 测试更新：调休用例改为断言全天谷价（含原先落在高峰窗口内的时间点），调休周六与调休周日各覆盖，共 51 例。
- README（中英）与包描述改为陈述官方口径，替换原先"调休日算工作日"的读法。

## [1.0.4] - 2026-09-18

- Calendar-aware peak/off-peak: 法定节假日 (statutory holidays) are valley for the whole day and 调休 makeup workdays keep the weekday windows. The Monday-weekend shortcut is replaced by a day-scanning algorithm, so both the current state and the "next transition" respect holiday spans — e.g. the last workday before 国庆 counts down to the first workday after it, and the label switches to an explicit date (`10-08 09:00`) once the jump passes a week.
- The Chinese official work calendar is fetched over the network: the host half now registers a same-origin route `/dsh-peak-status/holiday/<year>` (it fetches jiejiariapi, then apihubs, normalizes both shapes and caches results in memory for 6 h), and the browser half falls back to the CORS-enabled `api.apihubs.cn` and finally to the plain weekend rule. Normalized days are cached in `localStorage` for 24 h.
- The chip now names the day: a holiday shows its festival name (e.g. `国庆节`) instead of a generic state word, a 调休 workday is tagged as such, and the detail card carries a calendar sync line (`已同步 · jiejiariapi` / `未同步 · 暂按周末规则`).
- Every failure degrades softly — with no calendar at all the chip behaves exactly like 1.0.3.
- Verified against live upstreams for 2026: jiejiariapi and apihubs agree on all 33 holiday rest days and all 6 调休 makeup days.
- Tests rewritten to drive the shipped `src/client.js` (and `src/index.js`) through a `__test` seam in a Node VM instead of mirroring the algorithm: 49 cases now cover the weekend rule, holidays, 调休 days, year-crossing, payload normalization, the host route (status codes, caching, upstream fallback) and boundary labels.

## [1.0.3] - 2026-09-01

- Compatible with dsh 0.1.2-alpha.3 combo-batch plugin loading: since alpha.3 the web shell may concatenate plugin bundles into one shared combo script, so `document.currentScript.src` no longer identifies this bundle. The client now derives the module id from the single-file URL, falls back to scanning the combo URL for its own package leaf, and keeps the dual-registration fallback for scriptless mounts.
- No behavior change to the chip itself; the slot API (`conversation.session.header.utilities`) is unchanged in alpha.3.

## [1.0.2] - 2026-08-23

- Follow DeepSeek's peak/valley adjustment (effective 2026-08-23): weekends (Saturday & Sunday) are all-day valley price — no peak windows on weekends.
- Weekday windows unchanged: 09:00–12:00 / 14:00–18:00 (Beijing time); off-peak = half price.
- Next-boundary label now shows "明天"/"周一" style when the transition crosses days (e.g. Friday evening → Monday 09:00).
- Weekend chip shows "周末谷价" and the detail card lists the weekend rule.
- Tests extended with weekend and cross-weekday cases (13 total).

## [1.0.1] - 2026-08-17

- Package renamed to `dsh-peak-status` (npm name `dsh-peak-indicator` was taken); repository URL normalized.
- Preview image title updated to the new name.

## [1.0.0] - 2026-08-17

- Initial release.
- Native session-header chip (top-right, `conversation.session.header.utilities`) themed with `--dsw-alias-*` variables.
- Peak determination per DeepSeek's official peak/valley pricing (effective 2026-08-17): daily 09:00–12:00 / 14:00–18:00 Beijing time; off-peak = half price.
- Live Beijing clock (Asia/Shanghai), countdown to next transition, ×2/off-peak pricing hint.
- Click to expand a detail popover: peak windows, `HH:MM:SS` countdown, phase progress bar.
- Persistent install via profile `cordis.patch.yml` (survives dsh web restarts).
- Zero runtime dependencies; plain-JS build (`src/` → `lib/`).
