# Changelog

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
