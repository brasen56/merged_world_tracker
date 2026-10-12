# Ambient Conditions module design (v1)

**Status:** Phases 1–3 implemented; planner integration remains pending (Phase 4, see §6). Live SillyTavern smoke testing remains required.
**Written:** 2026-10-11, folding `WEATHER_MODULE_PROPOSAL.md` and `WEATHER_MODULE_RESPONSE.md` into one design. Those two docs remain the discussion record; this doc is what we build from.
**Naming:** the module is **Ambient Conditions**, not Weather. The name states the contract: conditions nobody in the story can change (§4.6). Weather is v1's only condition family; the name leaves room for calendar items later without inviting incidents in.

## 1. Goal

Weather in ST RP is static unless the user hand-declares it, and LLMs don't generate it credibly — they don't do randomness, they drift, and on regen they contradict the weather they themselves narrated. The module injects one line of ambient conditions per generation. **Code decides the conditions; the narrator model only renders them.**

Conditions are a **pure function of the in-story clock** plus a seed, recomputed at prompt-build time. The only stored state is one seed number in `chat_metadata` and user settings. Nothing to refresh, nothing to go stale, nothing to desync across branches.

## 2. Decisions this design adopts

Each row settles a point from the proposal/response exchange. Source § refers to `WEATHER_MODULE_RESPONSE.md`.

| # | Decision | Source |
|---|----------|--------|
| D1 | Generator is **smooth noise over continuous channels** (temperature offset, moisture, wind), not a Markov chain. Persistence comes from smoothness; each lookup is one calculation from (seed, time); no anchor, no walk, no seam edge cases (flashbacks and edited first timestamps dissolve rather than need handling). | §2.1 |
| D2 | Seed is a **random value stored in `chat_metadata`**, never derived from the chat ID (renames and branches change the ID; `core/scope.js` documents this). Branches inherit the parent's seed via metadata copy. | §2.3 |
| D3 | Injection recomputes on **every included generation** in a manifest `generate_interceptor`; `GENERATION_STARTED` only clears the stale slot. The interceptor is for timing: ST runs it after inserting pending user input (`script.js:4454`) and deleting a regenerated reply (`:4409`). It reads the **raw chat**, not its `messages` argument — that is ST's prompt copy, with hidden messages dropped and prompt-only regex applied, so it would disagree with the Overview and `/wt-ambient`. A swiped reply is still in the raw chat (ST pops it only from the copy, `:4497`), so the time scan **skips the last message when `type === 'swipe'`**. | §2.2 |
| D4 | Time source ladder: latest `[In-story time:]` tag → world state scene date → message count. New parser in `core/`, written to accept custom month lists later. | §2.5, Q3 |
| D5 | Injection header **explains itself** (plot-seeds pattern, `world_state/injection.js:191`); works without the preset. The `<mwt_awareness>` sentence is an optional preset extra. | Q4 |
| D6 | Time-skip guard line included: on a skip, the model keeps conditions vague; the module supplies real conditions next turn. | §2.4 |
| D7 | Qualitative values, never numeric ("cool, damp", not "14°C"); "when perceptually relevant" keeps indoor scenes from narrating weather through walls; anti-spam in the `do_not_repeat_descriptions` register. | proposal |
| D8 | Forecast cap: one band ahead. The module knows the future (determinism); "rain likely within the hour" is a truthful forecast of an already-computed outcome. A longer horizon invites the model to fast-forward the story. | proposal |
| D9 | **Climate is v1 must-have, one per chat, chosen from all presets** + hemisphere + manual season. A climate gates which conditions are *possible*, not just likely (desert never snows, whatever the slider says — enforced by construction: baseline/clamps make thresholds unreachable, no allowlist). **No silent default**: first enable asks for climate and hemisphere before injecting anything, with a dismiss path ("temperate, don't ask again") so it can't become a nag. | §6 |
| D10 | Variability slider changes **how often conditions change** (anchor spacing + fast-layer strength), never which conditions can exist. | §6 |
| D11 | Planner integration is **v1 scope**, not future: `WORLD_PRESSURE_RULE` (`story_planner/prompts.js:80`) already lists "weather and seasons" as inventable, so without integration two systems own the weather. Planner sees current conditions + one-step forecast; the lens is told weather comes from the module and must build on it, not invent new weather. | §3 |
| D12 | **Ambient vs incidents boundary:** conditions nobody in the story can change are ambient (weather, later daylight/moon/tides/calendar); incidents the player can change (a clearable rockslide) are **not** this module — they belong to World Pressures and the lens. Derived conditions that follow from weather (muddy roads after rain) come free from the same function. | §5 |
| D13 | Pin/lock with **optional expiry** ("thunderstorm tonight" ends at dawn / at a band or date); pinned state is visible in the dashboard mirror. | §2.5 |
| D14 | Slash command `/wt-ambient` with `/wt-weather` alias (commands support aliases, `core/commands.js:31`). | §2.5, §5 |
| D15 | Generator and time parser live in `core/` as pure helpers with no ST dependencies (`core/world_state_document.js` pattern). The module, Story Planner, and dashboard all read them without new module-to-module imports. | §2.5 |

## 3. Target contract

### 3.1 Generator

- **Channels:** temperature offset, moisture/cloud, wind — continuous values.
- **Slow layer:** hash the seed at fixed points every ~24–36 h (default ~30 h, see §8), smooth interpolation between them. Weather systems outlive a day, not a week.
- **Fast layer:** smaller amplitude, higher frequency, for change within a day.
- **Evaluation:** `temperature = climate seasonal baseline + daily cycle (cold night, warm afternoon) + noise`; conditions from thresholds — precipitation above a moisture level, snow vs rain by temperature, fog when moist + early + calm.
- **Bands:** time is rounded to its hour band before evaluating (night, dawn, morning, afternoon, evening), so a value on a threshold can't flicker within a band. Noise and season read the band start; the daily temperature term reads the band midpoint — night spans 21:00–05:00, and scoring it at its 21:00 start read warmer than morning while afternoon (12:00) and evening (18:00) tied.
- **Forecast** is the same function evaluated one band ahead (D8).
- **Determinism:** `mulberry32` + string hash; same (seed, time, climate) always yields the same conditions. Unit-testable across 10k sampled times.

### 3.2 Time source and fallbacks

1. Latest `[In-story time: HH:MM AM/PM, Weekday, Month D, YYYY]` tag scanning back through recent messages, **skipping the last message when swiping** (D3). The correct clock for a regen is the timestamp before the turn being replaced — the old swipe's time jump must not leak into its replacement.
2. World state "Current Scene" date/time (free text; parser tries, doesn't trust).
3. Message count (users without the timestamp block).

The parser returns "no time" cleanly for `Unknown`, qualitative values ("Evening"), and fantasy month names — never a wrong date. With no usable month, the manual season setting applies (D9).

### 3.3 Injection contract

Draft copy (final wording iterated during Phase 2):

```
<mwt_ambient>
Stage direction, not narration. Ambient conditions (authoritative): overcast,
cool, damp air; rain likely within the hour. Wind light.
Reference when perceptually relevant; do not re-mention conditions every reply.
Conditions shift only as in-story time advances. If this response skips ahead
in time, keep conditions vague; they will be supplied next turn.
</mwt_ambient>
```

One line through the standard seam — `wrapInTag('mwt_ambient', ...)` via `core/injection.js` — inheriting budget enforcement and boundary escaping. Prompt key `mwt_ambient_injection`. Recorded in diagnostics; a detected time jump above a threshold is logged to the diagnostics console (the moment the contract is softest, per D6).

**Generation-type matrix** (adopted for Phase 2; live host confirmation remains in §8):

| Type | Inject | Notes |
|------|--------|-------|
| normal, swipe | yes | swipe skips last message in the time scan |
| continue | yes | narrative continues at the current clock |
| quiet (MWT tracker, other extensions) | no | clear the slot for the generation |
| impersonate | no | leaner prompt for user-side writing |
| dry run (token counting) | no recompute | last registered injection persists, keeping counts consistent |

### 3.4 User surface

- Settings: enable, climate preset, hemisphere, manual season, variability slider. Per chat.
- First-enable ask: climate + hemisphere before first injection; dismiss path uses temperate silently thereafter (D9).
- Pin with expiry (D13), visible in the dashboard mirror alongside world state (read-only display — answers "users want to see it" without putting conditions *in* world state).
- `/wt-ambient` shows current conditions + one-step forecast; optional `reseed` subcommand rolls a new seed (escape hatch; branches inherit the parent seed, so this is the per-branch differentiation tool).

### 3.5 Planner integration (v1)

When the module is enabled: planner generation receives current conditions + one-step forecast as context, and one sentence is added to the world-pressure lens context: weather comes from the Ambient Conditions module — build on current conditions, never invent new weather. Arc beats pinning weather stays deferred (§7).

## 4. Code layout

- `core/ambient_time.js` — timestamp parser + fallback ladder. Pure.
- `core/ambient_generator.js` — PRNG, noise channels, climate presets, threshold→condition vocabulary, forecast. Pure.
- `ambient/` — module folder (`index.js`, `injection.js`, `settings.js`, `render.js`, `schema.js`), following the world_state folder pattern. Settings key `mwt_ambient`.
- `story_planner/` reads `core/ambient_*` directly (D15); no module-to-module imports anywhere.

## 5. Ambient vs incidents boundary

The rule: **can nobody in the story change it?** If yes, it's ambient and fits a pure function. If the player could clear/fix/change it, it's an incident — World Pressures territory (`world_state/prompts.js:173`), and the lens turns ambient inputs into incident arcs (a blizzard becomes a road-closure arc). Derived conditions implied by the line (muddy roads, swollen ford, snowed-in pass) are free — same function, always consistent with the injected conditions.

## 6. Delivery plan

### Phase 1 — Core pure helpers (startable now, solo)

- `core/ambient_time.js` and `core/ambient_generator.js` with climate presets and the condition vocabulary.
- Unit tests (vitest): parser accepts the canonical tag; returns no-time for `Unknown`/"Evening"/fantasy months; determinism (same seed+time → same conditions); climate gating (desert never snows across 10k sampled times); band quantization (no flicker within a band); forecast equals one band ahead; variability slider changes change-frequency, not the possible set.
- No ST dependencies, no injection, no UI. This is the reviewable pure-logic core; nothing here blocks on design sign-off of §8 items.

Implemented API / tuning choices:

- `parseAmbientTimestamp(text)` returns `{ hours, year, month, day, hour, minute }` or `null`. Story hours use UTC-shaped Gregorian arithmetic, independent of the machine's timezone. `parseAmbientDateTime(date, time)` also accepts explicit World State dates (English month or `YYYY-MM-DD`) and 12/24-hour clocks; ambiguous/qualitative input fails closed. An optional twelve-entry `monthNames` list supports renamed Gregorian months, not different calendar lengths.
- `resolveAmbientTime({ messages, worldState, type })` is the pure fallback ladder; `worldState` may be Markdown or a parsed scene. Raw-chat swipe excludes the last message from scanning and count time; regenerate excludes a trailing reply but retains a trailing user message if the host already removed the reply. Fallback is one synthetic hour per included message (configurable `hoursPerMessage`), with `month: null` so it never infers a season from a fabricated calendar date. Runtime wiring is implemented in Phase 2 below.
- `generateAmbientConditions({ seed, time, climate, hemisphere, manualSeason, variability })` returns `{ band, season, conditions, forecast }`. `time` accepts numeric Gregorian story hours or the resolver result. Climate is required; other defaults are north, spring, and variability `0.5`. Seed is supplied by the caller; no metadata ownership or random seed creation is introduced here.
- Qualitative channels are sky, temperature, air, precipitation, and wind. All five presets are implemented: temperate, desert, tropical, arctic, mediterranean. Climate bounds make impossible precipitation unreachable without a condition allowlist; the desert preset is dry-only in this first tuning.
- Bands start at dawn 05:00, morning 08:00, afternoon 12:00, evening 18:00, night 21:00. Night spans midnight through 05:00 without a re-roll. Forecast is exactly the next band (not necessarily within one hour).
- Variability is `0–1`: slow anchor spacing is `48–12 h` (30 h at the default), and the fast-layer weight is `0.05–0.25`. A convex blend preserves channel bounds at every slider value. Tests verify increased change frequency and matching observed qualitative value sets at the slider endpoints.
- Tests live in `test/ambient_time.test.js` and `test/ambient_generator.test.js`; helpers are imported directly, not through the ST-dependent core barrel.

### Phase 2 — Per-generation injection

- `GENERATION_STARTED` wiring (D3): time scan with swipe-skip and the fallback ladder, generation-type gating per the §3.3 matrix, injection through the budget seam, diagnostics recording + time-jump log.
- Exit criteria: line present on normal and swipe gens; stable across swipes of the same message; absent on quiet gens; block visible in the budget console; time-skip line present in the injected copy.

**Implemented (2026-10-11):**

- `ambient/index.js` prepares the slot from `GENERATION_STARTED(type, options, dryRun)` and recomputes through the manifest's `mwtAmbientGenerationInterceptor`. The interceptor runs after ST inserts pending user input and deletes a regenerated reply, and reads the raw chat rather than ST's prompt copy (which drops hidden messages and applies prompt-only regex), so the injected clock matches the Overview and `/wt-ambient`. Swipes skip the swiped reply, which is still in the raw chat; regenerate needs no skip at that point. Continue retains the current reply. Quiet/impersonate/unknown types clear both registered and desired budget context; dry-run start events leave the slot untouched (the host does not run interceptors for dry runs). Chat changes clear ambient context; panic activation clears it immediately through the Settings, floating button, and `/wt-inject off` paths.
- The chat-local `mwt_ambient` record holds `{ enabled, climate, hemisphere, manualSeason, variability, seed }`. Until Phase 3 supplies the setup UI, enablement requires explicit `enabled: true`, a valid climate, and explicit `north`/`south` hemisphere. No automatic enablement or silent climate fallback is introduced. Manual season and variability default to spring and `0.5`; a seed is created and saved only on the first included, configured generation. Existing seeds (including zero) are retained across renames and inherited branch metadata.
- `ambient/injection.js` sends self-explaining qualitative current conditions and exactly one named-band forecast through the shared wrapper/budget/diagnostics seam, respecting the global structural-boundaries toggle. Placement is system role at depth 1. The perceptual relevance, anti-repetition, and time-skip guard copy is included without requiring a preset. Forecast wording intentionally avoids the draft's unsupported "within the hour" claim.
- Ambient Conditions is a budget-managed module (default priority 2, uncapped), visible in the Budget tab and `MWT.budget` console snapshots. Exact registered payloads are available through `MWT.diagnostics.injection('mwt_ambient_injection')`, including clock source, story hours, selected band and season. Clock movement strictly greater than six story hours in either direction records `ambient_time_jump`; source transitions and chat/epoch changes are not treated as jumps. This comparison is in-memory only, not stored weather state.
- Integration coverage: `test/ambient_injection.test.js` drives the real injection and budget seam, including the generation matrix, stable swipes, fallback ladder, seed persistence/branch inheritance, caps, diagnostics, panic gates and chat cleanup. Live host prompt placement still needs a SillyTavern smoke test.

For Phase 2 developer smoke testing before the UI exists, explicitly configure the active chat in the browser console, then run a normal generation:

```js
const ctx = SillyTavern.getContext();
ctx.chatMetadata.mwt_ambient = {
    ...ctx.chatMetadata.mwt_ambient,
    enabled: true, climate: 'temperate', hemisphere: 'north',
    manualSeason: 'spring', variability: 0.5,
};
ctx.saveMetadataDebounced?.();
```

Setting only `enabled: true` is insufficient: explicit climate and hemisphere are required. After a generation, `MWT.diagnostics.injection('mwt_ambient_injection')` shows the **latest slot state**, not a history of narrator prompts. A subsequent quiet/background generation deliberately clears it. Cleared snapshots include `diagnostics.clearReason` and generation-triggered clears include `diagnostics.generationType`. A clear with nothing registered records no ring event — its reason lives in the per-key snapshot alone — while `MWT.diagnostics.events({ module: 'ambient' }).filter(entry => entry.event === 'ambient_injection_cleared')` reads the reason of every clear that actually removed a registered payload (the events accessor does not support an `event` filter argument). Panic activation identifies its origin as `panic-settings-save`, `panic-floating-button`, or `panic-slash-command`. Included generations also record their generation type beside the exact payload. The global panic switch overrides chat-local `enabled: true`.

### Phase 3 — User surface

- Settings (climate picker, hemisphere, manual season, variability), first-enable ask with dismiss path, pin with expiry, `/wt-ambient` (+ alias), dashboard mirror, optional `reseed`.
- Exit criteria: settings persist per chat; the ask appears exactly once unless dismissed with default; a pinned condition overrides rolls and expires at its bound; `/wt-ambient` output matches the injected line.

Implemented user surface:

- **Settings → Ambient Conditions (this chat)** saves independently of the global Save Settings button. First enable exposes an inline climate/hemisphere ask before enabling injection. The explicit **Temperate, don’t ask again (Northern hemisphere)** action configures and enables the chat; custom setup also suppresses subsequent asks. An unanswered setup remains available without creating weather or silently choosing a climate. A seed is created on successful enable and inherited by branches.
- **Pin conditions** selects all five qualitative channels. Pinning intentionally overrides climate gates (an explicit author override), with expiry options **Until unpinned**, **Next band**, **Next dawn**, or an explicit Gregorian **story date/time**. Dated expiry requires a usable calendar clock; relative expiry also works with the message-count fallback. Pin bounds use story hours, start-inclusive/end-exclusive. Forecast applies the same interval at the next band; it returns to generated conditions if that band lies beyond expiry.
- Pins store their starting clock source; timestamp and World State calendars are compatible, but synthetic message-count clocks are not comparable to calendar clocks. An incompatible pin is inactive rather than assigned a fabricated expiry. Expired pins remain stored so rewinding inside their interval restores the override. **Unpin** removes them explicitly.
- **Overview** has a read-only Ambient card showing current conditions, one-band forecast, panic/off state, and pin activity/start/expiry. It never creates a seed or writes metadata. Its Open button links to the Ambient Settings section.
- **Variability feedback** shows a live percentage with slower/faster endpoints and the 50% default. Help explains frequency rather than severity/climate possibilities, that 0% is not frozen weather, band stability, and the separate Save action.
- **Overview clock visibility** shows the resolved story clock used for conditions, its source (for timestamp tags, ST's `#N` message number and how many messages have arrived since, so a stale tag stands out), the current band, and the next band's start date/time. Message-count fallback is explicitly synthetic, never presented as a real calendar date. This is the current read-only calculation, not the last injected prompt or an independently ticking weather clock; source visibility helps identify stale tags/fallbacks without claiming to know an authoritative time beyond the resolver's inputs.
- **`/wt-ambient`** (alias **`/wt-weather`**) returns the same unwrapped body used by injection, including current conditions, one-band forecast and guard copy. **`/wt-ambient reseed`** changes only the seed and preserves settings/pins. Disabled, incomplete or panic-blocked configurations report their state rather than presenting conditions as active. Commands describe the current clock, not a historical prompt; swipe generation still uses the preceding clock, and budget enforcement can shorten/drop the registered payload.
- Changes clear the old registered injection; included generations recompute through the existing seam. Settings handlers reject stale chat/epoch scopes. Tests in `test/ambient_surface.test.js` cover setup, chat isolation, pin UI and interval/forecast semantics, reseed/alias/body parity, dashboard read-only status and panic gates.

### Phase 4 — Planner integration

- Planner context includes current conditions + one-step forecast; lens sentence added (D11).
- Exit criteria: with the module on, planner output builds on stated conditions rather than inventing conflicting weather.

Dependencies: 2 needs 1; 3 needs 2; 4 needs 1 and ships after 3 for UX coherence.

## 7. Explicitly out of v1

Per-region weather (world state `Location` is room-level and model-written — seeding off it would re-roll on stepping outside; needs the user-authored region idea). User-authored world/calendar panel (fixed data, pure functions — same "code decides, model renders" property). Arc beats that pin weather. Derived conditions beyond what the line implies. Daylight/moon phase/tides (trivial later additions per §5). Lorebook/card climate override. "Suggest climate from character card" button.

## 8. Open items (small, non-blocking)

1. **Noise anchor spacing default** — Phase 1 implements 30 h at variability `0.5`; further aesthetic tuning can follow story testing without changing the pure API.
2. **Generation-type matrix entries** — Phase 2 adopts §3.3 as written; confirm live behavior during the SillyTavern smoke test.
3. **First-enable ask copy** — modal vs inline settings banner; must include the dismiss path either way.
