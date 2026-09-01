# Changelog

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
