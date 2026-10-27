# Ambient Conditions module design (v2)

**Status:** Revision 3. Phases 5–8 (sun/daylight, moon, Gregorian weekday drift, and aftermath) implemented; Phase 9 remains planned. Optional meteor showers deferred. Custom ambient phenomena are recorded outside v2: frequency-shaped ones as a future ambient channel, dated ones for the later calendar design (§3.5.1).
**Written:** 2026-10-23. **Revision 2 (2026-10-24):** folds in `AMBIENT_CONDITIONS_V2_RESPONSE.md` — the sun-time framing, centered phase bins, floored modulo, the southern-hemisphere proxy fix, exact-time evaluation, the moon anchor replacing the moon pin, the calendar panel splitting into its own design doc, and a phase reorder (sun is now Phase 5, moon Phase 6). The response doc and this history remain the discussion record; every formula in revision 1 was re-run and the response's corrections verified independently before folding in. Companion to `AMBIENT_CONDITIONS_DESIGN.md` (v1, Phases 1–4 implemented); that doc stays authoritative for shipped behavior.
**Decisions continue v1 numbering** (D16+). Phase numbering also continues (v1 shipped Phases 1–4).

**Revision 3 (2026-10-25):** records user-requested custom ambient phenomena — frequent meteor showers, month-long eclipses, miasma clouds — as future scope (§3.5.1/D37). These are authored rules, separate from computed astronomy, split by shape: frequency-shaped phenomena reuse the aurora per-night roll and need no calendar; dated ones belong to the calendar design. Effects start additive with one light override, and ending a phenomenon preserves its past. No new v2 implementation phase is added.

## 1. Goal

v1 made weather stop contradicting itself. v2 makes the **sky** stop contradicting itself: sun, moon, and tides all agreeing with the clock, the season, the latitude, and each other. The audience is slice-of-life / slow-burn RP, where "how dark is it, really" and "what date are we walking toward" carry scenes.

The motivating failure mode (real user report): a story set at high northern latitude, in-story August, and the narrator calls it *dark at 5 PM*. August at 55–60°N means sunset near nine or later. This is a model-prior failure, not a weather failure — and it is not fixable by prompting harder. It is fixable the same way v1 fixed weather: **code computes the fact, the model renders it.**

Daylight, moon phase, and tides are *more* tractable than weather: they are (or can be shaped as) deterministic astronomy over the in-story clock, with no noise channels at all. Everything in v2 keeps the v1 contract — pure function of (clock, seed, config), no stored state, branch-safe by construction (D1/D2 unchanged).

## 2. Decisions this design adopts

| # | Decision |
|---|----------|
| D16 | Astronomy is code-owned, full stop. Sun, moon, and tides join weather as authoritative injected facts. The model never guesses a sky fact again; it renders "long light past nine" the same way it renders "overcast, cool". |
| D17 | **Latitude is the only new required input.** No longitude, no timezone tables, no DST modeling. The module computes and speaks **sun time** (local apparent solar time). This is the right default for invented places — but real civil clocks run ahead of the sun by up to ~1 h+ in summer (time zones, summer time, plus equation of time ±16 min), so stories set in real places get one optional per-chat setting: **"clocks run ahead of the sun by"** (0–2 h in 30-min steps, default 0), applied when stating clock-time facts. DST switchover dates stay out (§7). |
| D18 | Latitude is stored as a **magnitude 0–90**; the existing `hemisphere` field stays the only sign and the weather season shifter — the two can never disagree, `hemisphere` needs no migration, and `getAmbientStatus` validation is untouched. The per-climate default (arctic 65, temperate 45, mediterranean 40, desert 25, tropical 10) is **derived at read time and never written to metadata**; the Overview shows it as a default ("latitude 45° (temperate default) — set yours") with the existing Open link. No new first-enable ask (D9). |
| D19 | Sunrise/sunset/twilight use the refraction-corrected hour-angle equation with standard altitude −0.833° and civil twilight at −6°. Accuracy is stated **against sun time**: the test anchors are the formula's own values (Phase 5 list), not almanac clock times — a clock-time anchor is unreachable by a solar formula and the gap is the user's `clockAhead`, not an error. Equation of time is deliberately ignored. |
| D20 | Narrator-facing daylight is **qualitative** ("long midsummer evening, bright well past nine"); exact times are computed internally and exposed only as rounded stage-direction facts — **rounded to the half hour** ("sunset around 20:30"). Extends D7: a computed sunset time is a fact like the forecast band, not a measurement the model must narrate as prose. |
| D21 | The day is classified into three regimes — daylight, civil twilight, darkness — each possibly **empty**. Empty-by-daylight = polar night; empty-darkness = white night / polar day; sun skimming between −6° and −0.833° all day = "no true darkness" descriptor. Polar cases are first-class, not edge cases. Note polar night at 68°N exists only near the solstice (Dec 8 – Jan 3); Dec 1 there still has sunset ~13:00, so anchors test Dec 21, and one non-solstice December date proves the window. |
| D22 | **Weather keeps fixed bands; the sun, moon-up, and tide state evaluate at the exact resolved story time.** v1 quantizes to bands so noise on a threshold can't flicker within a band (v1 §3.1) — the sun has no noise, and swipes resolve to the same clock (D3), so exact-time evaluation is swipe-stable. Overview, `/wt-ambient`, and injection share one resolver, so parity holds. The weather forecast keeps the next band's start; sky facts forecast by naming the next event ("civil dusk ends around 21:30", "next high water around 19:00"). Daylight descriptors are deliberately exempt from band quantization: the night band's midpoint (01:00) would call a bright 21:00 mid-July evening near-dark, and the afternoon band's midpoint (15:00) would call a dark-by-16:20 December day "low sun" — the motivating bug in both directions. |
| D23 | Moon phase is days-since-epoch modulo the synodic month: epoch **2000-01-06 18:14 UTC**, month **29.530589 d**, over the existing story-hours number. Phase bins are **centered**: `round(phase × 8) mod 8`, so "new" and "full" name the days around the event, not the 3.7 days after it — with floor bins, real total solar eclipses bin as "waning crescent" (verified against five NASA eclipse instants; see Phase 6 tests). No meaningful secular drift, but **±14 h scatter** vs true events from the elliptical orbit: almanac spot checks need ±1 day tolerance, away from bin edges. **Floored modulo** (`((x % m) + m) % m`) everywhere a cycle position is computed — story hours go negative before 1970 and JS `%` keeps the sign, which today would yield bin index −3 (`undefined`) for an 1850 story. The weather generator already floors (`ambient_generator.js` noise/quantize) and is unaffected. |
| D24 | **Night brightness is derived, not configured**: illumination × sky/precipitation × **moon-up** × **darkness regime**. Moon-up is an age-based heuristic: lunar transit ≈ 12:00 + age × **0.841 h/day** (the canonical 24 h 50.5 m lunar day), up for roughly ±6 h either side — the same constant as the tide's daily shift (D28), so moon-up and high water lock together like a real port's lunitidal interval. Latitude stretches or shrinks the ±6 h (summer full moons at 60°N barely clear the horizon); that is ignored and documented, like the aurora heuristic. Brightness applies **only in the darkness regime** — a new moon during a white night is not "black night, lanterns necessary". |
| D25 | **Moon anchor, not moon pin** (replaces revision 1's `pin.moonPhase`). The pin system has one slot that requires all five weather values (`ambient_pin.js`), and a pinned full moon is a one-night anomaly: the nights before and after keep epoch phases (the moon cannot wax instantly), tides follow the computed phase (pinned full moon with neap tides), and `lunar(full)` events fire on computed dates. Instead: a setting like **"full moon falls on \<date\>"**, stored as one epoch offset in hours. Everything follows automatically — waxing before, waning after, tides, brightness, lunar events. Pure, branch-safe, no interval or expiry logic; the pin system stays weather-only. Fantasy calendars need this knob anyway (a real-2000 epoch is arbitrary there). |
| D26 | Moon and tides **require a calendar clock** (timestamp tag or World State date). Under the message-count fallback the absolute epoch hour is fabricated, so moon phase would be meaningless: channels are omitted, never fabricated. Daylight degrades gracefully instead (D27). |
| D27 | Daylight without a calendar clock uses the **season-warmth proxy**: declination ≈ 23.44° · `season.warmth` — evaluated with **|φ|**, since `warmth` is already in the local-season frame (`seasonAt` ignores hemisphere without a calendar); with signed φ, southern manual summer produced an 8.8 h day instead of 15.6 h. Proxy accuracy is class-level only (warmth peaks mid-July while declination peaks June 21; the gap reaches ~10° in early April), so tests assert day-length classes, not degrees: manual summer at 60° → long-day class, winter → short-day, south mirrors north. |
| D28 | Tides are **internally consistent, not port-accurate** — real tide tables are coastline-specific (Baltic 0.2 m, Fundy 12 m, diurnal Gulf), and there is no correct answer for a fictional cove. What is real: the M2 semidiurnal period (**12.4206 h** — exactly half the lunar day, so the seed-derived phase offset behaves like a real port's lunitidal interval: high water keeps a constant lag behind the moon's transit), and **spring/neap modulation from our own moon phase**: symmetric windows — **spring within ±2 days of new/full, neap within ±2 days of the quarters** (tunable). Revision 1's amplitude thresholds (\|cos\| ≥ 0.85 / ≤ 0.15) were lopsided: 35% of days spring, 10% neap. `reseed` deliberately re-rolls weather *and* tides together (a whole new location). |
| D29 | Tide settings: `coastal` (default **off** — inland stories must never see a tide line) and a qualitative range class (calm / normal / extreme) that changes wording only. Output is qualitative — rising/falling, high/low/slack, spring/neap — with **state evaluated at the exact time** (the 12.4 h cycle makes per-band states ill-defined: one 8-hour night band spans low-to-high) and forecasts stated as events: "next high water around 19:00". |
| D30 | **Aftermath is pure** (the single best v2 property): the v1 generator is random-access, so "conditions over the trailing ~24 h" is computed by evaluating it at past bands from (seed, time) — **no stored weather log, nothing to desync across branches**. The stated trade: recomputed history **follows current settings** — a reseed, climate/variability/season change, or pin edit rewrites "rain since yesterday" even if the story narrated sunshine; that is the price of a log-free world and it is accepted knowingly. The trailing scan applies the stored pin to past bands (expired-but-stored pins restore on rewind, per v1 Phase 3). The summary says when the current condition started when that point falls inside the window ("rain since yesterday evening"). Threshold crossings (first frost, first snow, first thaw) are comparisons of evaluations, visible while the clock is inside the crossing's day-window, then naturally gone — no "fired once" state; rewinding the clock rewinds the crossing. |
| D31 | The **calendar panel splits into its own design doc** — it is the biggest UI piece, independent of ambient enablement, and with the moon anchor (D25) and a midsummer anchor (see §8) the astronomy side needs nothing more from it. v2 keeps from revision 1: calendar data stays user-authored at its own metadata key `mwt_calendar`, independent of ambient enablement — and pulls forward **Gregorian weekday drift detection**: the timestamp tag already carries a weekday that the parser matches and discards (`ambient_time.js:68`); comparing it with the date's computed weekday is a few lines plus an Overview badge and a diagnostics event. |
| D32 | **Bounded event lookahead** (the D8 analog): at most the next two upcoming events, **and only within ~14 days** (two only if both are within a week) — otherwise a festival 200 days out injects every turn. Dates to walk toward, not an invitation to fast-forward. |
| D33 | Injection stays **one gated line**: channels assemble conditionally (tides only when coastal, events only when upcoming, moon is 3–4 words). The v1 body today is ~95–105 tokens; v2's budget is **≤ ~60 tokens added** on top of that baseline, audited once the channels land. The generation-type matrix (v1 §3.3) is unchanged. |
| D34 | Custom astronomy — twin moons, moonless worlds, tinted suns, custom cycle lengths — is **explicitly out of v2**. The epoch moon plus the anchor covers the overwhelming majority; full multi-moon generators are a large surface for very few users. |
| D35 | Crossings require a calendar clock — a manual season has no "start of season" date to count "first" from. "First" means scanning back to the season's start: up to ~90 days × 5 bands per prompt build, cheap per evaluation but **memoized per (seed, day)**. |
| D36 | **Aurora** gates on the sun's **darkness regime** (not the night band — at 55°N in July even the night band isn't dark), with the per-night chance **scaled by latitude** (≈0 below ~50°, common by 65°+) instead of a hard cutoff. Heuristic, not physics, and documented as such in code. |
| D37 | **Custom ambient phenomena come in two shapes, and the shape picks the home.** *Frequency-shaped* phenomena ("meteor showers every few nights", "miasma on calm nights") are an **ambient channel on the aurora pattern** (D36): a per-night start roll keyed on (seed, rule ID, night), random-access over story hours, so they work on any clock, including the message-count fallback, and do not wait on the calendar doc. *Date-shaped* phenomena ("an eclipse from the 3rd of Rotmonth for one month") need real dates and month lengths, so they belong to the **future calendar design**. Both resolve into one effective projection. Effects start **additive** (one short authored clause), with a single override type, **light**; field-level weather overrides amount to a scheduled pin and are deferred. A month-long fantasy eclipse is an authored world rule, not a prediction from the v2 moon model. Ending a phenomenon sets its end to the current story time instead of deleting the rule, so the past survives. Recorded in §3.5.1; neither shape has a v2 phase number. |

## 3. Target contract

### 3.1 Moon

Pure functions over story hours (floored modulo throughout, D23):

- `age = flooredMod((hours − EPOCH_HOURS) / 24, 29.530589)`, `phase = age / 29.530589`, `illumination = (1 − cos(2π·phase)) / 2`.
- Eight bins, **centered**: `round(phase × 8) mod 8` — new, waxing crescent, first quarter, waxing gibbous, full, waning gibbous, last quarter, waning crescent. A bin spans ~3.7 days; ±14 h model scatter fits inside it.
- **Moon-up** (D24): transit ≈ 12:00 + age × 0.841 h, up ±6 h. First quarter is not "moonlit" at 2 AM; a last-quarter moon has not risen at 22:00; a full moon is up all evening.
- **Anchor** (D25): "full moon falls on \<date\>" resolves to one stored epoch offset; phase, tides, brightness, and lunar events all derive from the anchored epoch. Re-anchoring is global and pure (it rewrites the moon's past and future consistently).
- Night brightness buckets over (illumination, moon-up, sky, precipitation, darkness regime): { "black night", "starlit", "faint moonlight", "moonlit", "bright moonlight, shadows cast" } — darkness regime only (white nights are bright regardless).
- Requires a calendar clock (D26); otherwise omitted, and `/wt-ambient` and the Overview say "no calendar clock".

### 3.2 Sun and daylight

Inputs: resolved story time (exact, not band — D22), latitude magnitude + hemisphere sign (D18). All local-solar (D17).

- Declination: `δ = −23.44° · cos(360°/365 · (N + 10))`, or `23.44° · season.warmth` with **|φ|** when no calendar clock exists (D27).
- Hour angle at standard altitude `h₀`: `cos ω = (sin h₀ − sin φ sin δ) / (cos φ cos δ)` with `h₀ = −0.833°` (sunrise/set) and `h₀ = −6°` (civil twilight). Sunrise = `12 − ω/15°`, sunset = `12 + ω/15°` sun-time hours. No solution → the sun never crosses that altitude; the sign of `φ·δ` picks polar day vs polar night (D21).
- Descriptors from the three regimes at the exact time (D22): day-length classes (≥17 h "white-night borders", ≤8 h "short winter day"), position descriptors ("golden light, sunset around 20:30" — half-hour rounded, D20), polar specials ("the sun will not rise today", "the sun does not set; midsummer night is twilight"). Descriptors may contradict the weather band's label; that is the fix for the motivating failure.
- Sun-time anchors (the formula's own values, D19): London 51.5°N Jun 21 sunset 20:19; Seattle 47.6°N Aug 15 sunset 19:06; equator ≈ 18:04 year-round; 55°N Jul 15 sunset 20:24 / civil dusk 21:16; 55°N Dec 21 sunset 15:35 / civil dusk 16:21; 45°N Aug 15 sunset 19:01; 68°N polar day May 27 – Jul 17, polar night Dec 8 – Jan 3 (test Dec 21; Dec 1 sunset ≈ 12:58 proves the window's edge).
- **Aurora** (D36): darkness regime + latitude-scaled seeded per-night roll. **Meteor showers** (optional, last): fixed date table (Quadrantids Jan 3, Perseids Aug 12, Leonids Nov 17, Geminids Dec 14), real-calendar clocks only.

### 3.3 Aftermath: recent past and crossings

Pure evaluation over trailing bands (D30):

- Sample the generator at each band start over the trailing 24 h; summarize transitions into one clause, naming the change point when it falls inside the window ("steady rain since yesterday evening", "clear all day").
- Aftermath wording is the model's to render (D12's muddy roads stay free); the line supplies the fact, the model supplies the lane.
- Crossings: temperature channel's daily minimum first ≤ 0° in autumn = "first frost this morning"; first qualifying snow; first thaw. Calendar clock required (D35); scan-back memoized per (seed, day).
- History follows current settings — a reseed or climate change rewrites it (stated trade, D30). Stored pins apply to past bands; rewinding inside a pin's interval restores it.

### 3.4 Tides

Pure functions over (story hours, seed) plus the anchored moon phase (D28/D29):

- High-tide times: `T = offset(seed) + k · 12.4206 h`; state at the exact time (rising/falling, high/low/slack); forecast states the next event ("next high water around 19:00").
- Spring within ±2 days of new/full, neap within ±2 days of the quarters (symmetric, tunable windows); range class scales wording only.
- Follows the anchored moon automatically: anchor the full moon and that night is spring tide (D25).
- Requires calendar clock + `coastal: true` (D26/D29); otherwise omitted entirely.

### 3.5 Calendar (reduced scope in v2)

- **In v2:** Gregorian weekday drift detection only (D31) — tag weekday vs computed weekday, Overview badge, diagnostics event. Works for every chat with timestamp tags, ambient enabled or not.
- **Own design doc, later:** the panel, custom months/lengths/weekdays (the tag regex currently hardcodes English weekday names, `ambient_time.js:10` — generalization includes weekday lists and weekday-less calendars), events with repeats, the midsummer anchor (§8). Founded on `mwt_calendar` staying user-authored and ambient-independent.

#### 3.5.1 Future scope: custom ambient phenomena

User feedback asks for frequent meteor showers, month-long eclipses, and "miasma clouds". These are authored world rules, not another climate preset or a temporary weather pin, and their timing must agree across scenes, swipes, and rewinds. They come in two shapes, and the shape decides where each one lives (D37):

| Shape | Examples | Home | Clock needed |
| --- | --- | --- | --- |
| **Frequency**: "how often", no dates | Meteor showers every few nights; miasma rolls in on calm nights | Ambient channel on the aurora pattern (D36); does not wait on the calendar doc | Any clock, including the message-count fallback |
| **Dated**: starts on a date, lasts an interval, may repeat by date | An eclipse from a chosen date for one calendar month; a miasma season every Rotmonth | Calendar design (dates, month lengths, repeats) | Calendar clock |

| Example | Shape | Ambient effect |
| --- | --- | --- |
| Frequent meteor showers | Frequency: per-night chance | Additive sky clause, visible only in darkness and under a clear enough sky at the exact time (D22). This does not depend on the optional real-world shower table in §3.2. |
| Month-long eclipse | Dated: starts on a chosen date, lasts one month of that calendar's month lengths | The one override type, **light**: daylight copy names the eclipse instead of also claiming ordinary daylight. |
| Miasma clouds | Frequency (calm nights) or dated (a season or window) | Additive atmospheric clause. Consequences such as illness or evacuation remain story material. |

Contract to settle before implementation:

- **Authorship:** a stable rule ID, name, a concise length-capped clause, shape, and duration in nights. Frequency rules add a per-night chance and optional start gates drawn from facts ambient already computes (darkness regime, sky cover, wind, season). Dated rules add a start/anchor, an end or duration, and a repeat. Dated schedules live with user-authored calendar data (`mwt_calendar`); frequency rules are ambient settings. This is a design direction, not a shipped schema. Ordinary festivals and appointments need no ambient effect.
- **Frequency determinism:** one start roll per night, keyed `${seed}:${ruleId}:${night}` with aurora's noon-to-noon night index and the same hash-below-chance test (`auroraPossible`). The roll is random-access: no stored counter, no "fired" flag, and no occurrence index, because finding the k-th occurrence at a given time would mean counting every occurrence from an origin. A phenomenon lasting N nights is active on night n if any night in (n−N, n] rolled a start whose start gates held: a bounded look-back, memoized per (seed, rule, night) like D35. Visibility (meteors behind cloud) is evaluated at the exact current time, not stored.
- **Dated determinism:** evaluate active intervals from the resolved calendar clock, with inclusive starts and exclusive ends; nothing is persisted or advanced on generation. A missing calendar clock gives dated rules an unavailable notice rather than an invented schedule; frequency rules are unaffected.
- **Editing, starting, and ending:** editing a rule's chance, gates, or schedule rewrites its evaluated past and future, like D30's settings trade. **End it now** sets the rule's end to the current story time. The past stays intact, rewinding before that point restores the phenomenon, and the story can disperse the miasma (§5) without the injection contradicting it. A new rule likewise defaults its start to the current story time, so adding one does not rewrite nights already played. Deleting a rule is the history-rewriting option, and the UI should say so.
- **Effects and composition:** each active phenomenon contributes one capped clause. The single override type is **light**: the sun channel consults the effective light before choosing daylight descriptors. Downstream darkness gates also read the effective light: night brightness (D24), aurora (D36), and meteor visibility. The computed moon phase and tide cycle are unchanged. Field-level overrides of weather (sky, precipitation, visibility) amount to a scheduled weather pin, with all its overlap and contradiction cost, so they are deferred until additive clauses prove insufficient. Weather pins keep precedence for the fields they cover. Overlapping light overrides need a priority rule. Everything resolves into the one projection shared by injection, Overview, `/wt-ambient`, and planner context.
- **Bounded output:** active conditions stay present for their full duration, including intervals longer than D32's lookahead. Upcoming dated starts use D32's bounded event lookahead; frequency phenomena are never forecast. Active phenomena need their own count cap and concise summary within the D33 budget. The calendar can display dated schedules independently, while ambient effects obey ambient enablement and injection gates.
- **Validation:** for frequency rules, evaluating night n directly equals walking up to it, the observed rate over many nights tracks the chance, start gates hold, duration look-back boundaries are exact, and clockless chats work. For dated rules, cover interval boundaries, recurrence across custom month and year lengths, and missing clocks. For both, cover identical output after swiping or rewinding, end-it-now preserving the past, a new rule not rewriting played nights, light overlaps, and pins. The light-override priority and output-cap defaults must be chosen before either shape ships.

This adds authored environmental rules, not custom orbital simulation. Twin moons and custom astronomical cycles remain a separate deferred feature (D34).

### 3.6 Injection and user surface changes

- `buildInjectionBody` assembles gated channels, e.g.:
  `Stage direction, not narration. Ambient conditions (authoritative): clear, mild, dry air; no precipitation. Wind light. Long late-summer light, sunset around 20:30; bright waning gibbous moon. Forecast (evening band): … Recent: steady rain yesterday evening, ground still wet. The Lantern Festival is in three days.`
- Surfaces mirror each new channel as it lands (v1 Phase 3 parity): Settings grows latitude (magnitude picker), `clockAhead`, coastal/range, the moon anchor; the Overview Ambient card grows daylight/moon/tide/recent lines, the latitude-as-default nudge (D18), and the drift badge; `/wt-ambient` stays body-identical to injection.
- Planner block (`core/ambient_prompt.js`) grows the same daylight/moon lines; the complications lens keeps its ownership sentence, now reading "sky conditions" instead of "weather".

## 4. Code layout

- `core/ambient_astronomy.js` — pure sun/moon/tide math and vocabularies (declination, hour angles, regimes, centered phase bins, moon-up, tide cycle; floored modulo lives here). No ST deps, mirrors `ambient_generator.js` purity rules.
- `core/ambient_aftermath.js` — pure trailing-band summary + memoized crossing detection; consumes the v1 generator's public API only.
- Weekday drift lands in the existing time-parsing/diagnostics seam (small; no new file expected).
- Vocabulary constants live beside their producers; the generator's `AMBIENT_VOCABULARY` is untouched (weather words don't change).
- `ambient/` absorbs all UI: settings pickers, Overview lines. No module-to-module imports (D15 pattern). Calendar files wait for the calendar doc.

## 5. Boundary notes (extends v1 §5)

The D12 rule survives intact: can nobody in the story change it? Sun/moon/tides are ambient by definition. A **flooded causeway at spring tide** is an incident — World Pressures and the lens turn ambient inputs into arcs exactly as blizzards already do (v1 §5). Calendar events are a third thing: **user-authored world facts** — not ambient-generated, not story-changeable incidents. Three kinds of line, one boundary rule.

Future authored phenomena follow that same split: the rule establishes "miasma clouds persist through this week"; a disrupted journey or an effort to disperse them belongs to the story. Ambient supplies the active condition, without automatically inventing an incident or arc. When the story does disperse them, the user ends the rule at the current story time (§3.5.1), so the injection stops claiming miasma without rewriting the nights already played.

## 6. Delivery plan

Ordering per the response §6: sun first (it is the reported bug), moon second, then the cheap drift check, aftermath, tides; calendar becomes its own doc. Every phase independently shippable.

### Phase 5 — Sun and daylight

Implemented 2026-10-24: pure solar math and exact-time regimes in `core/ambient_astronomy.js`, read-time climate latitude defaults, optional latitude/clock-ahead settings, half-hour event copy, polar specials, and deterministic latitude-scaled aurora possibilities. Shared projection feeds injection, command, Overview, and planner. Weather bands and weather pins are unchanged. Clock-ahead shifts stated event times only, per the Phase 5 contract; it does not shift the resolved story-hour input. Aurora is a seeded possibility heuristic, not a visibility or geomagnetic forecast. Meteor showers remain deferred.

- Latitude magnitude setting + read-time per-climate default (shown as a default, D18); `clockAhead` optional setting; declination/hour-angle math; three-regime classification at exact time (D22); descriptor vocabulary with half-hour rounding (D20); polar specials; aurora gating (D36); meteor showers last if at all.
- Tests: the sun-time anchors above (±10 min); polar day/night windows at 68°N including the Dec 1 edge (D21); exact-time swipe stability (swipes of one message yield one descriptor); descriptor-vs-band contradiction present at 55–60°N summer "night" and December afternoon; proxy class tests (manual summer 60° → long-day, winter → short-day, south mirrors north — via |φ|, D27); `clockAhead` shifts stated times only, never internals; default never written to metadata.
- Exit: the motivating bug is dead — at 55–60°N in August, 17:00 reads bright with a stated sunset on every generation type, and a story clock an hour ahead of the sun can say so.

### Phase 6 — Moon

Implemented 2026-10-24: pure lunar math in `core/ambient_astronomy.js`, shared by injection, Overview, `/wt-ambient`, and planner context. Eight centered bins use floored modulo, including pre-1970 dates. The moon-up heuristic uses exact resolved story time, not weather bands; brightness consumes the already-pinned current weather and is omitted outside true darkness. Calendarless chats omit computed moon facts and show a shared "no calendar clock" notice (including the injection body, preserving command/body parity).

The chat-local `moonEpochOffset` setting stores one epoch shift in hours; null/absent uses the standard epoch. Settings exposes a full-moon story date and explicit time (initially 18:00); clearing the date restores the standard cycle. Re-anchoring rewrites past/future phases coherently, is independent of weather reseeding, and never uses the weather pin slot. The pure `lunarPhaseAt` result is the future tide/lunar-event seam; tide generation and spring/neap output remain Phase 9, not a Phase 6 claim.

Moon-up ignores latitude and terrain, as planned; night brightness is qualitative cloud/precipitation attenuation, not photometry. Phase bins normally agree across scenes in one night, but can legitimately cross a centered bin edge during that night: they are not artificially frozen to a band or a date. Tests cover both cases. Added copy is conditional and concise, but the complete ≤~60-added-token audit remains an integration check as later channels land; no tokenizer-backed budget claim is made here.

- Centered bins, floored modulo, moon-up heuristic, the anchor setting, night brightness gated on darkness regime, injection + Overview + `/wt-ambient` lines, planner block line.
- Tests: five real eclipse instants (2024-04-08, 2025-03-14, 2025-09-07, 2026-03-03, 2026-08-12) all bin to new/full under centered rounding (four of five fail under floor); pre-1970 story (e.g. 1850-06-01) yields a valid bin, not `undefined`; determinism across 10k sampled times; bins stable within a night; moon-up (first quarter not up at 02:00, last quarter not up at 22:00, full up in the evening); anchor (nights before an anchored full moon wax, after wane; that night's tide is spring); brightness regime gate (new moon + white night ≠ black night); omission under message-count fallback; almanac spot checks ±1 day, away from bin edges.
- Exit: two scenes hours apart agree on the moon; a werecreature chat anchors the full moon and the tides and brightness agree with it.

### Phase 7 — Gregorian weekday drift

Implemented 2026-10-25: the timestamp parser retains the normalized tagged weekday and compares it with the Gregorian date's UTC weekday without altering story hours or the source ladder. A separate read-only Overview status displays a mismatch badge (date, source message, tagged and computed weekdays), independent of Ambient/World State enablement and the panic switch. Matching, absent, and unusable tags remain silent. The latest usable tag is authoritative; older historical mismatches do not keep a badge alive after a matching newer tag.

The always-on observer records `calendar / gregorian_weekday_drift` warnings on chat load and message receive/edit/swipe/delete/hydration. Consecutive observations of the same mismatch are deduplicated within the current chat/operation epoch; fixing and later restoring a mismatch records it again. Overview reads never emit events. No metadata, timestamps, injection, or story facts are rewritten; this is a Gregorian integrity hint, not a custom-calendar implementation.

- Tag weekday vs computed weekday; Overview badge; diagnostics event. No ambient enablement required.
- Tests: constructed mismatch badges; matches pass silently; no-tag chats unaffected.
- Exit: a model drifting across weekdays gets caught by the badge, without Phase 9.

### Phase 8 — Aftermath

Implemented 2026-10-26: `core/ambient_aftermath.js` evaluates recent weather and seasonal crossings through the generator and pin public APIs, without metadata writes. The ~24 h window is anchored to the current band's start for stability; pin starts/ends are honored even within bands. The summary names the current run's start when known and retains the latest earlier precipitation episode. Narration owns ground effects, not the summary. All four surfaces (injection/command, Overview, planner) share the projection; settings explain history rewriting.

Crossing thresholds use public qualitative conditions: freezing (≤0°) for autumn frost, snow/heavy snow/blizzard for autumn/winter snow, and a freezing→nonfreezing transition for spring thaw. Each first is counted from its hemisphere-aware meteorological season start, with the previous condition carried into spring. Crossings appear only after their time and until that calendar day's exclusive midnight end, never anticipating a later band. The bounded disposable day cache includes seed, climate, hemisphere, variability and stored pin, so settings changes cannot reuse stale history. Clockless summaries work; seasonal firsts require a calendar clock.

- Trailing-24 h summary clause with "since" phrasing; first frost/snow/thaw crossings (calendar-clock gated, memoized); injection + Overview lines.
- Tests: summary determinism and band-boundary stability; crossing visible only inside its day-window, rewind restores it; settings-change rewrites history (reseed → new past, and no metadata writes happen); stored pins applied to past bands, expired pins restore on rewind.
- Exit: "the ground is still soft from yesterday's rain" is always consistent with the injected history of the last day, across swipes and branches.

### Phase 9 — Tides

- `coastal` + `tideRange` settings; M2 cycle + seed offset + symmetric spring/neap windows; exact-time state; "next high water" forecasts; follows the anchored moon.
- Tests: period and offset by construction; spring within ±2 d of new/full, neap within ±2 d of quarters (cross-checked against the Phase 6 moon and the anchor); qualitative bucketing; omission when inland or clockless; `reseed` moves the tide schedule with the weather.
- Exit: a coastal story can schedule "we cross at low tide" and the module's tide facts never contradict the plan.

### Calendar panel → its own design doc

Biggest UI piece, ambient-independent, nothing left in the astronomy contract depends on it (D31). The doc starts from the response's midsummer-anchor idea (§8), the weekday-name generalization, and dated ambient phenomena (§3.5.1/D37). Frequency-shaped phenomena are an ambient channel and do not wait on this doc. Calendar schedules remain usable without ambient; their optional environmental effects integrate through ambient's shared projection. Phase numbering for it resumes when that doc is approved.

Dependencies: 6 needs 5's darkness regime for the brightness gate. 7 is standalone. 8 needs nothing new. 9 needs 6 (moon, anchored).

## 7. Explicitly out of v2

Twin moons / moonless worlds / custom cycle lengths (D34). Precise moonrise/moonset times (the moon-up heuristic is the v2 answer). Dynamic twilight-following weather bands (D22 keeps weather bands; sky facts went exact-time instead). Per-region weather or per-region latitude (still v1 §7). Real-port tide emulation (D28). DST switchover modeling (D17's offset is season-set by the user). Computed eclipse prediction (the v2 phase model does not model orbital alignment). Authored fantasy eclipses and other custom ambient phenomena are also outside v2, but recorded: frequency-shaped ones as a future ambient channel, dated ones for the later calendar design (§3.5.1/D37). Lorebook/card climate or latitude override; "suggest latitude from card". The calendar panel itself (its own doc).

## 8. Open items (small, non-blocking)

1. **Descriptor copy tuning** — the daylight vocabulary lives or dies in story testing; keep it constant-swappable like `AMBIENT_VOCABULARY`.
2. **Aurora latitude curve** — scaling shape between ~50° and ~65°; decide with test stories, not geography.
3. **`clockAhead` discoverability** — zero by default and invisible unless looked for; the Overview default-latitude nudge (D18) is the current answer, revisit after story testing.
4. **Tide window width** — ±2 d default is a first tuning; symmetric shape is the commitment, not the number.
5. **Injection length audit** — measure real token spend of all channels against the ≤ ~60-added budget (D33) once Phases 5–6 land.
6. **Calendar doc foundations** — the midsummer anchor (declare which day is midsummer; the day-count origin follows, so sun, weather season, and custom calendar agree by construction instead of by warning); authored-event UX, including dated phenomena schedules, the light-override priority, and the active-phenomena output cap (§3.5.1); how loudly to surface weekday-name mismatches once custom weekday lists exist.
