# Ambient Conditions module design (v2)

**Status:** Draft for review. Nothing here is implemented.
**Written:** 2026-10-23, from the v2 brainstorm session. Companion to `AMBIENT_CONDITIONS_DESIGN.md` (v1, Phases 1–4 implemented); that doc stays authoritative for shipped behavior, this doc picks up exactly what v1 §7 deferred: daylight/moon/tides and the calendar panel.
**Decisions continue v1 numbering** (D16+). Phase numbering also continues (v1 shipped Phases 1–4).

## 1. Goal

v1 made weather stop contradicting itself. v2 makes the **sky** stop contradicting itself: sun, moon, and tides all agreeing with the clock, the season, the latitude, and each other. The audience is slice-of-life / slow-burn RP, where "how dark is it, really" and "what date are we walking toward" carry scenes.

The motivating failure mode (real user report): a story set at high northern latitude, in-story August, and the narrator calls it *dark at 5 PM*. August at 55–60°N means sunset near nine or later. This is a model-prior failure, not a weather failure — and it is not fixable by prompting harder. It is fixable the same way v1 fixed weather: **code computes the fact, the model renders it.**

Daylight, moon phase, and tides are *more* tractable than weather: they are (or can be shaped as) deterministic astronomy over the in-story clock, with no noise channels at all. Everything in v2 keeps the v1 contract — pure function of (clock, seed, config), no stored state, branch-safe by construction (D1/D2 unchanged).

## 2. Decisions this design adopts

| # | Decision |
|---|----------|
| D16 | Astronomy is code-owned, full stop. Sun, moon, and tides join weather as authoritative injected facts. The model never guesses a sky fact again; it renders "long light past nine" the same way it renders "overcast, cool". |
| D17 | **Latitude is the only new astronomical input.** No longitude, no timezone tables: the in-story clock is definitionally *local time at the story's location*, and the sunrise equations yield local solar time directly. Equation of time (±15 min) is ignored; refraction is not (D19). |
| D18 | Latitude **generalizes** the existing `hemisphere` field (sign = hemisphere); `hemisphere` remains the season shifter for weather. Existing chats migrate silently to a per-climate default latitude (arctic 65°, temperate 45°, mediterranean 40°, desert 25°, tropical 10°; south mirrors negative), visible in Settings and the Overview card. No new first-enable ask — D9's anti-nag rule; latitude is additive enrichment, not a gate on existing behavior. |
| D19 | Sunrise/sunset/twilight use the refraction-corrected hour-angle equation with standard altitude −0.833° and civil twilight at −6°. Accuracy target: within ~5 minutes of almanac values at test anchors. |
| D20 | Narrator-facing daylight is **qualitative** ("long midsummer evening, bright well past nine"), with exact times computed internally and exposed only as rounded stage-direction facts ("sunset around 21:00"). Extends D7: a computed sunset time is a fact like the forecast band, not a measurement the model must narrate as prose. |
| D21 | The day is classified into three regimes — daylight, civil twilight, darkness — each possibly **empty**. Empty-by-daylight = polar night; empty-darkness = white night / polar day; sun skimming between −6° and −0.833° all day = "no true darkness" descriptor. Polar cases are first-class, not edge cases. |
| D22 | **Fixed bands stay** (v1 §3.1). Daylight descriptors may contradict a band's connotation ("night band, but the sky stays light"). Dynamic, twilight-following band boundaries are explicitly deferred: variable band lengths would break one-band-forecast cadence, pin intervals, and the band-stability tests for marginal gain. |
| D23 | Moon phase is days-since-epoch modulo the synodic month: epoch **2000-01-06 18:14 UTC**, month **29.530589 d**, over the existing story-hours number. Eight named bins + illumination fraction. No moonrise/moonset computation (needs lunar declination and the 18.6-year nodal cycle; models already know a full moon rises near sunset). |
| D24 | **Night brightness is derived**, not configured: illumination × sky/precipitation channels from the weather generator. Full + clear = "bright moonlight, shadows cast"; new + overcast = "black night, lanterns necessary". Free derived condition in the D12 sense. |
| D25 | The **pin system extends to moon phase** (`pin.moonPhase`, same interval/expiry mechanics as weather pins, D13): the werewolf-pacing use case ("full moon pinned for the 21st") is the one place users need to override astronomy. Pinning astronomy intentionally overrides reality, exactly as weather pins override climate gates. |
| D26 | Moon and tides **require a calendar clock** (timestamp tag or World State date). Under the message-count fallback the absolute epoch hour is fabricated, so moon phase would be meaningless: channels are omitted, never fabricated. Daylight degrades gracefully instead — see D27. |
| D27 | Daylight without a calendar clock uses the **season-warmth proxy**: declination ≈ 23.44° · `season.warmth` (the generator's existing −1…1 cosine, which already encodes manual season + hemisphere). Approximate daylight beats no daylight; the descriptor says "late-season light" without claiming a sunset clock time. With a calendar clock, the exact day-of-year formula applies. |
| D28 | Tides are **internally consistent, not port-accurate** — real tide tables are coastline-specific (Baltic 0.2 m, Fundy 12 m, diurnal Gulf), and there is no correct answer for a fictional cove. What is real: the M2 semidiurnal period (12.4206 h), a spring/neap amplitude modulation from **our own moon phase** (amplitude ∝ \|cos 2π·phase\| — spring at new and full, neap at quarters), and a **seed-derived phase offset** that acts as the location fingerprint: different chats get different tide schedules, deterministically, branch-safely. `reseed` deliberately re-rolls weather *and* tides together (a whole new location). |
| D29 | Tide settings: `coastal` (default **off** — inland stories must never see a tide line) and a qualitative range class (calm / normal / extreme) that changes wording only ("the tide is out" vs "the causeway floods at high water"). Output is qualitative: rising/falling, high/low/slack, spring/neap, plus "high water around seven" as a rounded stage fact (D20). |
| D30 | **Aftermath is pure** (the single best v2 property): the v1 generator is random-access, so "conditions over the trailing ~24 h" is computed by evaluating it at past bands from (seed, time) — **no stored weather log, nothing to desync across branches**. Threshold crossings (first frost, first snow, first thaw) are the same: a comparison of evaluations, visible while the clock is inside the crossing's day-window, then naturally gone. No "fired once" state. |
| D31 | The **calendar is user-authored world data** at its own metadata key `mwt_calendar`, independent of ambient enablement (weekday validation and events are useful without weather). Model never authors calendar facts; it reads them. The existing `monthNames` parser seam (v1 §6, Phase 1) generalizes to months with **arbitrary names and lengths** over an absolute-day-count seam (Julian-day-number style). |
| D32 | **Bounded event lookahead** (the D8 analog): at most the next two upcoming events inject ("the Lantern Festival is in three days"), so the calendar creates dates to walk toward without inviting the model to fast-forward the story. |
| D33 | Injection stays **one gated line**: channels assemble conditionally (tides only when coastal, events only when upcoming, moon is 3–4 words), soft target ≤ ~60 tokens for the assembled body. The generation-type matrix (v1 §3.3) is unchanged. |
| D34 | Custom astronomy — twin moons, moonless worlds, tinted suns, custom cycle lengths — is **explicitly out of v2**. The epoch moon covers the overwhelming majority; full multi-moon generators are a large surface for very few users. |

## 3. Target contract

### 3.1 Moon

Pure functions over story hours:

- `age = ((hours − EPOCH_HOURS) / 24) mod 29.530589`, `phase = age / 29.530589`, `illumination = (1 − cos(2π·phase)) / 2`.
- Eight bins: new, waxing crescent, first quarter, waxing gibbous, full, waning gibbous, last quarter, waning crescent. A bin spans ~3.7 days — zero flicker risk against bands; evaluate at band start like the noise channels.
- Single-epoch drift ≈ 1 day per century — far beyond any RP horizon; determinism is the actual product (the model stops calling it a full moon in one scene and a crescent in the next).
- Night brightness derivation (D24): buckets over (illumination, sky, precipitation, band) → { "black night", "starlit", "faint moonlight", "moonlit", "bright moonlight, shadows cast" }. Night bands only.
- Moon pins (D25) reuse `ambient_pin.js` interval mechanics; a pinned moon phase also overrides the night-brightness derivation.
- Requires a calendar clock (D26); otherwise the channel is omitted from injection and shows "no calendar clock" in `/wt-ambient` and the Overview.

### 3.2 Sun and daylight

Inputs: story hours (day-of-year when a calendar clock exists), latitude (D18). All local-solar, no longitude (D17).

- Declination: `δ = −23.44° · cos(360°/365 · (N + 10))`, or `23.44° · season.warmth` without a calendar (D27).
- Hour angle at standard altitude `h₀`: `cos ω = (sin h₀ − sin φ sin δ) / (cos φ cos δ)` with `h₀ = −0.833°` (sunrise/set) and `h₀ = −6°` (civil twilight). Sunrise = `12 − ω/15°`, sunset = `12 + ω/15°` local solar hours. No solution → the sun never crosses that altitude; the sign of `φ·δ` picks polar day vs polar night (D21).
- Day classification per regime (D21) yields the descriptor vocabulary:
  - long-day / short-day classes from day length (≥17 h "white-night borders", ≤8 h "short winter day"),
  - position descriptors evaluated at the **band midpoint** (same convention as the v1 daily temperature term): "dark, dawn near nine", "golden light, sunset around 20:45", "dusk lingering, dark past eleven",
  - polar specials: "the sun will not rise today", "the sun does not set; midsummer night is twilight".
- Descriptors may contradict the band label; that is the fix for the motivating failure ("night band, but the sky stays light — midsummer dusk").
- **Aurora** rides along (cheap, huge nordic flavor): gate on `|latitude| ≥ 55°` + night/dawn band + winter-ish season + sky clear/partly cloudy, with a seeded per-night roll from the existing hash machinery. Heuristic, not physics, and says so in code comments.
- **Meteor showers** (optional, lowest priority): a fixed date table (Quadrantids Jan 3, Perseids Aug 12, Leonids Nov 17, Geminids Dec 14) applies only when a real-calendar clock is active; custom calendars get user-authored shower dates via Phase 9 events instead.

### 3.3 Aftermath: recent past and crossings

Pure evaluation over trailing bands (D30):

- Sample the generator at each band start over the trailing ~24 h; summarize transitions into one clause: "steady rain since yesterday evening", "clear all day", "the wind has been rising since dawn". Changes only when the underlying evaluations change — same determinism as everything else.
- Aftermath wording is the model's to render (D12's "muddy roads after rain" stays free); the line supplies the fact ("rain the past two days"), the model supplies the lane.
- Crossings: compare season-scoped evaluations — temperature channel's daily minimum first ≤ 0° in autumn = "first frost this morning"; first qualifying snow = "first snow of the season"; first thaw / first sweltering night similarly. Visible while the clock is inside that day; no event state, no "already fired" flag — rewinding the clock rewinds the crossing.

### 3.4 Tides

Pure functions over (story hours, seed) plus our moon phase (D28):

- High-tide times: `T = offset(seed) + k · 12.4206 h`; state derived from position within the cycle (rising/falling, high/low/slack, next high/low as rounded stage facts).
- Amplitude class: `|cos(2π·phase)|` → spring (≥ 0.85), neap (≤ 0.15), else normal; range class (D29) scales the wording, never the physics.
- Forecast band interplay: the one-band forecast reports the tide state at that band, same as weather.
- Requires calendar clock + `coastal: true` (D26/D29); otherwise omitted entirely.

### 3.5 Calendar panel

- **Definition schema** (`mwt_calendar`): months as `{name, days}[]` (arbitrary lengths and names), weekday names list, era label, optional year anchor. Pure `core/calendar.js`: serialize/parse dates against an absolute-day count; that count is the join key the moon/sun/day-of-year arithmetic already understands.
- **Timestamp parsing** generalizes: `parseAmbientDateTime`'s month-name seam extends to custom lengths; the model tags `[In-story time: …]` with the custom names because the injection tells it today's date.
- **Weekday validation**: the tag carries a weekday; the calendar computes the true one. Mismatch → Overview badge + diagnostics event (`ambient_clock_drift`). Free continuity policing for slow burn.
- **Events**: `{name, date, repeat: none | weekly | monthly | annual | lunar(full|new)}`, panel-managed. Panel UI: month grid, today highlighted, event/moon/solstice markers, day detail.
- **Season anchoring wrinkle** (resolve during Phase 9): with non-365-day years, the sun stays on the absolute-day cycle (astronomy stays real) and solstices are computed dates on the grid; where "midsummer" the *month* falls is the user's placement, validated with a gentle warning if it drifts far from the computed solstice.
- Bounded lookahead injection (D32); solstice/equinox/full-moon markers computed, events user-authored — the model reads the calendar, never writes it (D31).

### 3.6 Injection and user surface changes

- `buildInjectionBody` assembles gated channels, e.g.:
  `Stage direction, not narration. Ambient conditions (authoritative): clear, mild, dry air; no precipitation. Wind light. Long late-summer light, sunset around 20:45; bright waning gibbous moon. Forecast (evening band): … Recent: steady rain yesterday evening, ground still wet. The Lantern Festival is in three days.`
- Surfaces mirror each new channel as it lands (v1 Phase 3 parity): Settings grows latitude picker, coastal/range, moon-pin UI; the Overview Ambient card grows daylight/moon/tide/recent lines and the drift badge; `/wt-ambient` output stays body-identical to injection.
- Planner block (`core/ambient_prompt.js`) grows the same daylight/moon lines; the complications lens keeps its weather-ownership sentence, now reading "sky conditions" instead of "weather".

## 4. Code layout

- `core/ambient_astronomy.js` — pure sun/moon/tide math and vocabularies (declination, hour angles, regimes, phase bins, tide cycle). No ST deps, mirrors `ambient_generator.js` purity rules.
- `core/ambient_aftermath.js` — pure trailing-band summary + crossing detection; consumes the v1 generator's public API only.
- `core/calendar.js` — pure calendar definition, day-count seam, formatting, event resolution.
- Vocabulary constants live beside their producers; generator's `AMBIENT_VOCABULARY` untouched (weather words don't change).
- `ambient/` module folder absorbs all UI: settings pickers, panel tab (`render.js`), Overview lines. No module-to-module imports (D15 pattern).

## 5. Boundary notes (extends v1 §5)

The D12 rule survives intact: can nobody in the story change it? Sun/moon/tides are ambient by definition. A **flooded causeway at spring tide** is an incident — World Pressures and the lens turn ambient inputs into arcs exactly as blizzards already do (v1 §5). Calendar events are a third thing: **user-authored world facts** — not ambient-generated, not story-changeable incidents. Three kinds of line, one boundary rule.

## 6. Delivery plan

Ordering maximizes value-per-phase for the SoL audience and keeps every phase independently shippable.

### Phase 5 — Moon

- `core/ambient_astronomy.js` (moon half), night-brightness derivation, moon pins, injection + Overview + `/wt-ambient` lines, planner block line.
- Tests: epoch day is new by construction; +14.765 d is full by construction; determinism across 10k sampled times; bins stable within a band; night brightness buckets; pin interval/expiry/rewind parity with weather pins; omission under message-count fallback; four real-world spot dates verified against an almanac during implementation.
- Exit: two scenes hours apart agree on the moon; a werecreature chat can pin the full moon.

### Phase 6 — Sun and daylight

- Latitude setting + silent per-climate migration (shown in Overview), declination/hour-angle math, three-regime day classification, descriptor vocabulary (band-midpoint evaluation), polar specials, aurora gating; meteor showers last if at all.
- Tests (anchors, refraction-corrected): London 51.5°N Jun 21 sunset ≈ 21:20 local; Seattle 47.6°N Aug 15 ≈ 20:10; equator ≈ 06:00/18:00 year-round (±10 min); 68°N June = polar day, December = polar night; equinox ~12 h everywhere; warmth-proxy vs exact-declination agreement within ~2° declination; migration defaults per climate; descriptor-band-contradiction copy present at high-latitude summer "night".
- Exit: the motivating bug is dead — at 60°N in August, 5 PM reads bright afternoon/evening light with a stated sunset, on every generation type.

### Phase 7 — Aftermath

- Trailing-24 h summary clause + first frost/snow/thaw crossings; injection + Overview lines.
- Tests: summary determinism and band-boundary stability; crossing visible only inside its day-window; rewind restores it; pure across branches (no metadata writes; existing seed-persistence tests still pass untouched).
- Exit: "the ground is still soft from yesterday's rain" is always consistent with the injected history of the last day, across swipes and branches.

### Phase 8 — Tides

- `coastal` + `tideRange` settings, M2 cycle + seed offset + spring/neap modulation, tide lines gated to calendar clocks and coastal mode.
- Tests: period and offset by construction; spring at new/full, neap at quarters (cross-checked against the Phase 5 moon); qualitative bucketing; omission when inland or clockless; `reseed` moves the tide schedule with the weather.
- Exit: a coastal story can schedule "we cross at low tide" and the module's tide facts never contradict the plan.

### Phase 9 — Calendar panel

- `core/calendar.js` + definition schema, generalized timestamp parsing, weekday drift detection, events + panel UI, bounded lookahead injection, solstice anchoring rule.
- Tests: round-trip serialize/parse for Gregorian and a 13×28 fantasy calendar; day-count arithmetic vs known Gregorian dates; weekday drift badge on constructed mismatch; event repeat rules including lunar; lookahead ≤ 2 events; ambient-disabled chats still get calendar + validation.
- Exit: a fantasy calendar with renamed months validates the model's own timestamps, shows the drifting model the true date, and gives the story dates to walk toward.

Dependencies: 5 and 6 are independent of each other (6 first if forced to choose — it is the accuracy fix users actually asked for; 5 first if shipping smallest). 7 needs nothing new. 8 needs 5 (moon phase). 9 last.

## 7. Explicitly out of v2

Twin moons / moonless worlds / custom cycle lengths (D34). Moonrise/moonset (D23). Dynamic twilight-following bands (D22). Per-region weather or per-region latitude (still v1 §7). Real-port tide emulation (D28 — internal consistency is the achievable accuracy). DST modeling (the story's clock is the story's clock). Eclipses (computable from the same cycles; nobody's slow burn needs a Saros). Lorebook/card climate or latitude override; "suggest latitude from card" (v1 §7's cousins).

## 8. Open items (small, non-blocking)

1. **Descriptor copy tuning** — the daylight vocabulary's wording will live or die in story testing; keep the vocabulary constant-swappable like `AMBIENT_VOCABULARY`.
2. **Aurora latitude cutoff** — 55° is a heuristic; 50° catches Scotland/St. Petersburg, 60° misses them. Decide with test stories, not geography.
3. **Aftermath window** — trailing 24 h vs trailing two bands; longer windows are more mood, less precision.
4. **Event lookahead count** — two (D32) is a guess; one may be right.
5. **Injection length audit** — with all channels on, measure real token spend against the D33 soft target before Phase 9 ships.
6. **Calendar ⇄ season anchoring UX** — how loudly to warn when the user's "midsummer" month disagrees with the computed solstice.
