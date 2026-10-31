# Authored ambient phenomena

Frequency rules implement §3.5.1/D37. Calendar Phase 14 adds date-shaped schedules on both Gregorian and custom calendars.

Open **Settings → Ambient Conditions → Frequency-shaped phenomena**. The form adds meteor, calm-night miasma, or unrestricted additive rules. Advanced JSON supports editing gates and light overrides. Rules belong to chat-local `mwt_ambient.phenomena` settings and are inherited with that metadata.

## Settled contract

- Stable, unique alphanumeric/underscore/hyphen IDs (1–64 characters); names up to 60 characters; single-line clauses up to 80 characters. No angle brackets in names or clauses.
- At most 16 rules; duration 1–30 integer nights; per-night chance 0–1. Probability describes **starts**, not the fraction of nights active when durations overlap.
- Night identity is `floor((storyHours - clockAhead - 12) / 24)`, matching aurora's sun-time noon-to-noon identity. A start attempt is at 21:00 sun time, or the rule's start if later in that night. Rules created before 21:00 wait until that evening; rules added after 21:00 can start immediately. An occurrence lasts through its Nth noon-to-noon night, ending at the following noon. This is not N × 24 hours from the attempt.
- One FNV hash-below-chance roll keyed `${seed}:${ruleId}:${night}`. Evaluate the current and preceding N−1 nights only. Historical start gates read generated weather with the stored pin applied, natural sunlight, and local season at the attempt time. Start gates deliberately do not depend on other phenomena, avoiding ordering/cycle ambiguity.
- `startGates` and `visibilityGates` optionally map `regime`, `sky`, `wind`, and `season` to nonempty arrays of accepted values. Gates combine with AND; values within an array combine with OR. Visibility reads current pinned weather and effective light, never cached visibility. Active but hidden meteors remain active and can reappear when clouds clear.
- `light` optionally selects `daylight`, `twilight`, or `darkness`. **Light only ever darkens:** the effective regime is the darker of the natural one and the override, so a night-time rule never lifts darkness — moonlight, aurora and meteors survive an eclipse at 2 AM. `daylight` is therefore accepted but has no effect (the panel notes this); a "glowing night" works better as an additive clause. When several overrides are active the darkest wins; integer `priority` (−100 to 100; default 0) only decides whose name is shown when the darkness ties, ascending rule ID after that. A light effect applies throughout the active occurrence, independently of visibility and the output cap. Its name and the effective regime replace ordinary daylight copy; effective light gates moon brightness, aurora, and meteor visibility. Natural solar calculations remain available, and moon phase/tides are untouched. Light starts are still governed by frequency rolls, not eclipse prediction.
- At most three visible clauses, ordered by priority then ID. Overview reports the omitted visible count. No frequency forecasts. Weather pins retain precedence over weather fields; rules cannot override weather fields.
- New rules default to current story hours. **End now** sets an exclusive end bound without changing past evaluations, including when rewound. Editing JSON rewrites evaluated history; **Delete** erases a rule's history. Ending an already-ended rule never extends it.
- `source` separates message-count hours from dated hours; timestamp and World State are the same dated domain. A source mismatch suppresses the rule instead of comparing unrelated origins. Advanced rules may omit `source` to explicitly apply in either domain.
- Bounded disposable memoization includes seed, rule, night, clock domain and all environmental options. It is not an occurrence log; eviction, swipes, reloads and rewinds do not change results.

## Advanced schema example

```json
{
    "id": "violet-miasma",
    "shape": "frequency",
    "name": "Violet miasma",
    "clause": "violet miasma hangs over the ground",
    "chance": 0.25,
    "durationNights": 2,
    "startHours": 21,
    "endHours": null,
    "source": "message-count",
    "startGates": { "regime": ["darkness"], "wind": ["calm"] }
}
```

Use the form to obtain the correct current start hours and clock source rather than copying this synthetic-clock example into a dated story. Illness, evacuation and other consequences remain narrative material.

## Dated schedules (Calendar tab)

Open **Calendar → Dated phenomena**. Rules live at `mwt_calendar.phenomena`, independently of the events/date-line toggles; Ambient must be enabled to render their environmental consequences. Create or edit a draft, then **Save Calendar**. Gregorian chats need no fantasy-month adoption.

- Use `shape: "dated"`, a calendar `start: {year, month, day}`, exactly one of `durationDays` (1–400) or `durationMonths` (1–13), `repeat: "none" | "yearly"`, and `end: null` initially. IDs, names, clauses, light, priority and visibility gates follow the frequency limits; each storage list permits 16 rules.
- Starts are inclusive at midnight; duration and End now bounds are exclusive. Calendar-month addition clamps to the destination month's last day (January 31 plus one month ends on February 28/29). Yearly schedules begin in the authored year; February 29 skips non-leap years.
- **End now** stores a calendar instant, not absolute hours. Rewinding restores earlier activity; re-anchoring and hemisphere changes preserve the same ending date. Date references follow month identity/clamping edits automatically and are not re-stamped. End now never extends an already-ended rule. Schedule edits rewrite history; Delete requires explicit acknowledgement and erases it.
- Dated rules are inactive without a readable dated clock (Overview explains why). Both shapes share the darkest-wins light override, effective-regime visibility gates, priority/ID order, three visible clauses and omitted count. A twilight eclipse never brightens midnight; gate its clause with `{"regime":["daylight","twilight"]}` to hide it at night. Moon phase and tides are unaffected. No fired/evaluated state is stored.