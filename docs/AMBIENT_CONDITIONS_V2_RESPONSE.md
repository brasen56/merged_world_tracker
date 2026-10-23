# Ambient Conditions v2 — Response

**Status:** Reply for discussion, not a roadmap
**Responds to:** `docs/AMBIENT_CONDITIONS_V2_DESIGN.md` ("the draft")
**Checked against:** branch `experimental` at `bc8c470` (v1 code in `core/ambient_*.js` and `ambient/`). Every formula in the draft was run as written and compared with a reference declination/equation-of-time series and five real eclipses (Appendix).

## Summary

- We like it. "Code computes the sky, the model renders it" is the right extension of v1, and the pure-function contract carries over cleanly. Sun first is the right call: it is the bug users reported.
- The tide model, the moon constants and the "aftermath without a weather log" idea all check out (§1).
- The sun math has one design-level problem: it treats the story clock as sun time, but real clocks run about an hour ahead of the sun in summer. As a result, two of the Phase 6 test anchors fail by an hour (§2.1). Three smaller sun issues need settling before Phase 6 (§2.2–2.4).
- The moon has four issues to settle before Phase 5 (§3). The most visible one is that the natural way to bin phases calls real total solar eclipses "waning crescent".
- Smaller points (§4), answers to the draft's open items (§5), and a suggested order (§6) follow.

## 1. What checks out

- **The pure contract.** The generator really is random-access: `evaluate` reads only (seed, band, config) (`core/ambient_generator.js:105`). D30's "aftermath by re-evaluating past bands" needs no stored log, exactly as the draft says.
- **Moon constants.** The epoch (2000-01-06 18:14 UTC) and the synodic month (29.530589 d) are correct.
- **Tides.** 12.4206 h is exactly half a lunar day. So a fixed seed offset behaves like a real port's lunitidal interval: high water always comes the same time after the moon passes overhead, and spring-tide high water lands at a consistent clock time for each chat. The tides stay consistent with the module's own moon without any extra machinery.
- **The declination approximation** is within 1.3° of the reference all year. That is fine once outputs are rounded (§2.1).
- **Agreed as written:** latitude as the only required new input (D17), with §2.3's storage tweak; no new first-enable ask (D18/D9); three-regime day classification with polar cases first-class (D21); fixed bands for weather (D22); tides off by default and qualitative (D29); calendar data user-authored and independent of ambient enablement (D31); the three-kinds-of-line boundary (§5); everything in §7.

## 2. Settle before Phase 6 (sun)

### 2.1 Sun time is not clock time (D17, D19)

D17 says the in-story clock is local time, and that the sunrise equations "yield local solar time directly". Both are true, but they are different clocks. Real clocks run ahead of the sun because of wide time zones and summer time. At the latitudes in the motivating report, the gap in mid-August is about an hour or more:

| Place, Aug 15 | Sunset, sun time | Sunset, clock | Clock ahead by |
|---|---|---|---|
| Stockholm 59.3°N | 19:49 | 20:42 | 53 min |
| Seattle 47.6°N | 19:10 | 20:24 | 74 min |
| Edinburgh 56.0°N | 19:35 | 20:53 | 78 min |
| Helsinki 60.2°N | 19:53 | 21:18 | 85 min |
| Reykjavik 64.2°N | 20:16 | 21:49 | 93 min |

This table uses the reference declination series, so its sun times can differ by a minute or two from the draft's formula (Appendix).

Consequences:

- **Two Phase 6 anchors fail.** "London Jun 21 sunset ≈ 21:20" is a clock time (BST); the draft's formula gives 20:19. "Seattle Aug 15 ≈ 20:10" matches neither clock: the formula gives 19:08 and the real clock gives about 20:20.
- **D19's "within ~5 minutes of almanac values" cannot be reached.** The equation of time alone moves solar noon by up to ±16 minutes over the year, before zones and summer time.
- **A story set in a real northern place still gets sunsets an hour or more early.** That is the motivating bug at a smaller size.

Suggestions:

- **Keep D17 for the default.** For invented places, sun time is the right answer, and no timezone tables are needed.
- **Restate D19 against sun time.** The test anchors should be the formula's own sun-time values (Appendix), not almanac clock times.
- **Round stated times to the half hour (D20).** "Sunset around 20:45" claims more precision than the inputs have.
- **Optionally, add one per-chat setting: "clocks run ahead of the sun by"** (0 by default, in 30-minute steps up to 2 h), for stories set in real places. Users set it for their story's season. Modelling summer-time switchover dates stays out, as §7 already says.

### 2.2 Evaluate the sun at the exact story time, not the band midpoint

§3.2 evaluates daylight descriptors at the band midpoint. The night band runs 21:00–05:00, so its midpoint is 01:00, and the afternoon band's is 15:00. Two cases with the draft's formula (sun time):

- **55°N, mid-July, scene at 21:00 (night band).** The sun set at 20:25 and is only 4° below the horizon: bright civil twilight until 21:18. The 01:00 descriptor sees the sun 12° down and picks the near-dark wording. With a real clock an hour ahead (§2.1), the sun hasn't even set. Late-summer evenings are the exact scenes this feature exists for.
- **55°N, December 21, scene at 17:00 (afternoon band).** It has been fully dark since about 16:20 (sun 11° down). The 15:00 descriptor says "low sun, sunset around 15:30". That is the motivating bug in reverse.

v1 quantizes to bands so that random noise sitting on a threshold can't flicker within a band (v1 §3.1). The sun has no noise. Evaluating it at the resolved story time is still swipe-stable, because D3 skips the swiped reply's timestamp, so every swipe of a message resolves to the same clock. The Overview and `/wt-ambient` stay identical to the injection because all three use the same resolver. The forecast can keep using the next band's start.

This also takes most of the pressure off D22. Weather keeps its fixed bands, and the daylight phrase is simply right for the moment. The same applies to moon-up (§3.3) and tide state (§4).

### 2.3 Southern hemisphere and the season-warmth fallback (D18, D27)

- **Sign bug.** D27 computes δ ≈ 23.44° · `season.warmth` and feeds it to the hour-angle equation with a signed latitude. On the clockless path, warmth comes from the manual season only (`seasonAt` ignores hemisphere without a calendar, `core/ambient_generator.js:94`). So "summer" gives δ = +23.44° whichever hemisphere the story is in. With φ = −45°, a southern summer gets an **8.8 h** day instead of **15.6 h**. Fix: on the proxy path, use |φ|, since both values are already in the local-season frame.
- **The Phase 6 proxy test can't pass.** "Warmth-proxy vs exact-declination agreement within ~2°" fails because, on the calendar path, warmth peaks in mid-July (temperatures lag the sun, `core/ambient_generator.js:99`), while declination peaks on June 21. The gap reaches **10.1°** in early April. On March 20 the proxy says −10.3° against a real −0.5°, which at 60°N means a 9.8 h day instead of 12.1 h. The proxy only runs without a date anyway. A better test: manual summer at 60° gives the long-day class, manual winter gives the short-day class, and south mirrors north.
- **Two fields that can disagree.** D18 makes latitude's sign the hemisphere, but keeps `hemisphere` as the weather's season shifter, so `hemisphere: north` with latitude −40 is possible. Suggest storing latitude as a magnitude (0–90) and keeping `hemisphere` as the only source of the sign. Disagreement becomes impossible, `hemisphere` needs no migration, and the validation in `getAmbientStatus` (`core/ambient_state.js:19`) stays as it is.

### 2.4 Latitude default: derive it, and say it is a default

- **Derive at read time.** "Existing chats migrate silently" should mean the default is computed whenever latitude is unset, not written into metadata. The Overview and `/wt-ambient` are read-only today (`core/ambient_state.js`). Store a latitude only when the user picks one.
- **The reporter won't see the fix by default.** Their chat is presumably temperate, so it gets 45°. At 45°N on August 15, the sun-time sunset is 19:02; Edinburgh's real clock says about 20:53. The Overview line should read something like "latitude 45° (temperate default) — set yours", with the existing Open link. No new ask is needed (D9 agreed).

## 3. Settle before Phase 5 (moon)

### 3.1 Centre the phase bins

The draft doesn't say how phase maps to the eight names. The natural code, `floor(phase × 8)`, makes "new" cover the 3.7 days after new moon and "full" the 3.7 days after full. The night before full, the moon is 99.9% lit and reads "waxing gibbous". `round(phase × 8) mod 8` centres each name on its event.

Checked against eclipses, which happen exactly at new or full moon:

| Eclipse (UTC) | Moon | Mean-model error | `floor` bin | Centred bin |
|---|---|---|---|---|
| Total solar 2024-04-08 18:21 | new | −4.1 h | waning crescent | new |
| Total lunar 2025-03-14 06:55 | full | −6.0 h | waxing gibbous | full |
| Total lunar 2025-09-07 18:09 | full | +0.8 h | full | full |
| Total lunar 2026-03-03 11:38 | full | −10.1 h | waxing gibbous | full |
| Total solar 2026-08-12 17:37 | new | −14.1 h | waning crescent | new |

The draft's "+14.765 d is full by construction" test passes with either binning, so it wouldn't catch this. An eclipse test would.

On D23's "drift ≈ 1 day per century": there is no meaningful long-term drift; the mean month is very stable. What the single-epoch model does have is scatter: true new and full moons fall up to about ±14 h either side of the mean, because the moon's orbit is elliptical. Almanac spot checks therefore need a ±1 day tolerance, on dates away from bin edges. (The story clock being local while the epoch is UTC adds up to ±12 h more, which is harmless against 3.7-day bins.)

### 3.2 Stories set before 1970

Story hours count from 1970, so earlier dates are negative, and the parser accepts any year from 1 (`core/ambient_time.js:54`). JavaScript's `%` keeps the sign. For a story set on 1850-06-01, `((hours − EPOCH) / 24) % 29.530589` gives −9.17, which maps to bin index −3: `undefined`. Use a floored modulo, `((x % m) + m) % m`, everywhere a cycle position is computed (moon age, tide position), and add a pre-1970 test. The weather generator already uses `Math.floor`, so it is unaffected. Victorian and medieval settings are common in RP, so this would come up.

### 3.3 Is the moon up? (D23, D24)

D23 skips moonrise because exact times need lunar declination. But "is the moon above the horizon now" to within an hour or two only needs the moon's age. The moon transits about 50 minutes later each day: transit ≈ 12:00 + age × 0.813 h, and it is up for about 6 h either side. That puts new moon rising at dawn, first quarter rising at noon and setting around midnight, full moon rising at dusk, and last quarter rising around midnight.

Without this, D24's night brightness asserts moonlight that isn't there. A last-quarter moon reads "moonlit" at 22:00, two hours before it rises. A first-quarter moon reads "moonlit" at 2 AM, after it has set. The night band is 8 hours long, so this has to use the exact time as well (§2.2). High latitudes stretch or shrink the ±6 h (summer full moons barely clear the horizon at 60°N); ignoring that is fine if the code says so, like the aurora heuristic.

Night brightness also needs the sun's regime. At 60°N on June 21 the sun never goes lower than 6.6° below the horizon, so "new moon + overcast = black night, lanterns necessary" would be wrong: it is a white night. Brightness should apply only in the darkness regime. This is the one place Phases 5 and 6 aren't independent. Either brightness lands with or after Phase 6, or Phase 5 ships it and Phase 6 adds the regime gate.

### 3.4 Anchor the moon instead of pinning it (D25)

- **It collides with the existing pin.** There is one pin slot (`settings.pin`, `core/ambient_state.js:11`), and `isAmbientPin` requires all five weather values (`core/ambient_pin.js:8`). A `pin.moonPhase` would either force a weather pin alongside it or need a second slot.
- **A pinned full moon is a one-night full moon.** Pin "full" for the 21st, and the 20th and 22nd keep whatever the epoch says, possibly quarter moons. Tides that night follow the computed moon (D28), so a coastal werewolf story could get a full moon with neap tides. Lunar calendar events (`lunar(full)`) fire on the computed date, not the pinned one.

Suggestion: replace the moon pin with an anchor, a setting like "full moon falls on <date>", stored as one epoch offset in hours. It stays pure and branch-safe, with no interval or expiry logic. The nights before it wax and the nights after wane. Tides, night brightness and lunar events all follow automatically. Fantasy calendars need the same knob anyway, since a real 2000 epoch means nothing there. Moon phase then leaves the pin system entirely.

## 4. Smaller points

- **Tide classes are lopsided.** With |cos| ≥ 0.85 for spring and ≤ 0.15 for neap, "spring" shows 35% of the time (about 5.2 days per half-cycle) and "neap" only 10% (about 1.4 days). Suggest symmetric windows, such as spring within ±2 days of new or full and neap within ±2 days of the quarters.
- **Tide state per band is ill-defined.** The cycle is 12.4 h, so one 8-hour night band can go from low water to high. Report the current state at the exact time (§2.2). For the forecast, say "next high water around 19:00" rather than "the tide state at the evening band".
- **Aftermath follows current settings, not what was narrated.** Because history is recomputed, a reseed, a climate, variability or season change, or a re-pin or unpin rewrites "rain since yesterday", even if the story narrated sunshine. That is a fair trade for having no log, but D30 should say so. The trailing scan must also apply the pin to past bands; expired pins are kept, so `applyAmbientPin` at past times works as long as the pin wasn't replaced.
- **Crossings need a calendar clock.** A manual season has no start date, so "first frost of the season" has nothing to count from. With a calendar, "first" means scanning back to the season's start: up to about 90 days × 5 bands, on every prompt build, Overview render and planner call. It is cheap per evaluation, but worth memoizing per (seed, day).
- **D33's budget is already spent.** Today's v1 body, with guard copy and forecast, is about 95–105 tokens (`ambient/injection.js:10`). "≤ ~60 tokens for the assembled body" presumably means "≤ ~60 added by v2".
- **68°N polar night is only around the solstice.** With the draft's formula, polar night at 68°N runs Dec 8 – Jan 3; on December 1 the sun is up until 13:04. Test December 21. (June is fine: polar day runs May 27 – Jul 17.)
- **Custom calendars need custom weekdays too.** The tag regex hardcodes English weekday names (`core/ambient_time.js:10`, used at `:68`), not just month names. Phase 9 has to generalize both and allow a calendar with no weekdays.
- **A cheap pull-forward.** Weekday drift detection for ordinary Gregorian dates doesn't need Phase 9. The tag regex already matches the weekday and throws it away (`core/ambient_time.js:68`); comparing it with the date's real weekday is a few lines plus the badge.

## 5. Answers to the open items (draft §8)

1. **Descriptor copy:** agreed, keep it constant-swappable. Round stated times to the half hour (§2.1).
2. **Aurora cutoff:** rather than a hard cutoff, scale the per-night chance with latitude (rare near 55°, common at 65° and above). Gate on the sun's darkness regime instead of "night/dawn band + winter-ish season": at 55°N in July even the night band isn't dark enough (§2.2). The 50 vs 55 vs 60 question then matters much less.
3. **Aftermath window:** 24 h is fine. Let the summary say when the current condition started if that falls inside the window ("rain since yesterday evening").
4. **Event lookahead:** it needs a distance cap as well as a count cap. Otherwise a festival 200 days away injects every turn. Suggest the next event within about 14 days (two if both are within a week).
5. **Injection length audit:** agreed. The baseline is about 100 tokens before v2 (§4).
6. **Calendar ⇄ season anchoring:** use the same pattern as the moon (§3.4). When the user defines a calendar, ask which day is midsummer and set the day-count origin from it. The sun, the weather's season (`seasonAt` reads Gregorian months from story hours) and the custom calendar then agree by construction, and no warning is needed. Drift for non-365-day years only shows up over several in-story years.

## 6. Suggested order

1. **Phase 6, sun**, with §2: sun-time anchors and rounding, exact-time evaluation, the southern fix, latitude stored as a magnitude, and the default shown as a default.
2. **Phase 5, moon**, with §3: centred bins, floored modulo, moon-up, an anchor instead of a pin, and brightness gated on the sun's regime.
3. **Gregorian weekday drift check**, pulled forward from Phase 9 (§4).
4. **Phase 7, aftermath.**
5. **Phase 8, tides.**
6. **Calendar panel as its own design doc.** It is the biggest piece of UI, it is independent of ambient enablement (D31), and with the anchor in §5.6 the astronomy side needs nothing more from it.

## Appendix: how the numbers were checked

- The draft's formulas were run as written in Node. Declination was compared with Spencer's (1971) Fourier series; the draft's cosine approximation is within 1.3° all year.
- Clock times use: clock = sun time + (time-zone meridian − longitude) / 15 h + summer time − equation of time (NOAA series). They are good to a few minutes, which is enough to show the hour-sized gap.
- Eclipse instants are published NASA times of new and full moon.

Sun-time anchors from the draft's own formula, for the Phase 6 tests:

| Anchor | Draft expects | Formula gives (sun time) |
|---|---|---|
| London 51.5°N, Jun 21, sunset | 21:20 | 20:19 |
| Seattle 47.6°N, Aug 15, sunset | 20:10 | 19:08 |
| Equator, Jun 21, sunset | 18:00 ± 10 min | 18:04 ✓ |
| 68°N, June | polar day | polar day May 27 – Jul 17 ✓ |
| 68°N, December | polar night | polar night only Dec 8 – Jan 3; Dec 1 sunset 13:04 |
| 55°N, Dec 21 | — | sunset 15:35, civil dusk ends 16:21 |
| 55°N, Jul 15 | — | sunset 20:25, civil dusk ends 21:18 |
