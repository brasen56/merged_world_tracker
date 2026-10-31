# Calendar design — co-author review

**Status:** Reply for discussion; folded into `CALENDAR_DESIGN.md` revision 2.
**Received:** 2026-10-28, by email (outside the repo); recorded verbatim 2026-10-29 so the discussion record lives with the design. Line-number citations were verified against the working tree before folding in.

## Fix before Phases 10–11

1. **Accepting Gregorian tags in a custom-calendar chat can produce a wildly wrong date.** The doc's rule is that both tag styles are accepted and the newest usable tag wins. Suppose the model slips once and writes "June 3, 1247" instead of "Rotmonth 3, 1247". That parses as the real year 1247 AD and moves the story about **764 years** back, and the date line then repeats the wrong date as authoritative. A custom month named "March" would also be ambiguous. **Fix:** once a calendar exists, accept only custom tags. A Gregorian tag gets ignored, with a note on the Overview.

2. **Midsummer only matches the sun in the year the user anchors it to.** Calendars that aren't 365 days long drift a little every year, and the drift counts from the anchor year, not from when the story starts. With a 354-day calendar:
   - anchored 7 years before the story's year, "midsummer" falls in spring;
   - anchored 47 years before, it falls in winter.

   The planned safety check shows the season *at the anchor date*, which is summer by design, so it can never catch this. **Fix:** set the anchor year to the story's current year by default, and preview the season for *today's* date.

3. **The stored `solstice` field repeats the ambient `hemisphere` setting.** That goes against the "never store the same fact twice" rule (decision D18) that the doc itself cites. If the two disagree, the midsummer festival lands in winter (I checked this). They can disagree later, for example after the hemisphere is changed or a calendar is imported from another chat, and the doc only plans a one-time warning. **Fix:** work out the solstice from the hemisphere when it's needed. Only the ambient sky/weather features and moon-based events depend on it.

4. **"Nothing stored needs migration" isn't true.** Weather pins and frequency phenomena store absolute story times plus which kind of clock they were created under. A fantasy chat today usually runs on the message-count clock. When the user adopts a calendar, the clock becomes tag-based, and all of their existing meteor and miasma rules silently stop (`core/ambient_phenomena.js:64`). Pins behave the same way. Re-anchoring or editing month lengths shifts dates against every stored time. **Fix:** store the calendar's own "End now" as a calendar date. When a user adopts a calendar or re-anchors it, the panel should offer to re-stamp existing rules and pins.

## Before Phase 12 (the date line)

5. **The closing sentence in the calendar block was copied from Ambient and doesn't fit.** It says to "keep the date vague; it will be supplied next turn." But the preset makes the model end every reply with a time tag, and that tag *is* the date. On a time skip, the model has to work out the new date itself. **Fix:** give it what it needs: tomorrow including the weekday (the doc's example leaves the weekday out, though that's its stated reason for the date line), and the current month's length plus the next month's name.

6. **If the newest tag can't be read, the date line states yesterday's date as authoritative.** The clock falls back past unreadable tags to an older one. Custom names will fail to parse more often than English ones: misspellings, "day 31" of a 30-day month, curly apostrophes. Being told an old date is "authoritative" pushes the model to roll the story back. **Fix:** turn the date line off when a newer tag failed to parse, and say why on the Overview.

7. **Showing the era in the date line will teach the model to put it in its tag.** A tag like "1247 (Kelen Epoch)" fails, because the tag parser stops at the year, and that feeds straight into #6. **Fix:** let the parser accept the record's era label after the year, or leave the era out of the date line.

## Phase 14

8. **The doc's eclipse example would make every night brighter for a month.** The shipped light override replaces the darkness level for as long as the phenomenon is active (`core/ambient_state.js:24`). Frequency rules only run at night, but a dated rule runs around the clock. At 2 AM the scene would read "twilight", moonlight descriptions would disappear, and with no visibility gates "a dim eclipse veils the sun" would show at midnight. **Fix:** a dated rule's light setting should only ever darken, and dated rules should support the existing visibility gates.

## A scope decision to make now

Ordinary Gregorian chats get no events or dated phenomena, so a modern slice-of-life story can't have "the wedding is in five days". Recreating the Gregorian calendar as a custom one doesn't work either: there are no leap years, and the month names collide with #1. Either say so in the "Explicitly out" section, or add a `structure: 'gregorian' | 'custom'` field now so the record can support Gregorian events later. Adding the field now is cheap.

## Smaller items

- **Gregorian-only date inputs:** in a custom-calendar chat, the Ambient panel's moon-anchor date picker and the pin "until date" field only take real-world dates. Users couldn't set either one, and moon-based events depend on the moon anchor.
- **365-day calendars aren't "fixed":** the shipped sun counts leap years, so a 365-day calendar drifts one day every 4 years. The Phase 10 test should allow ±1 day.
- **Exit check that can't pass:** Phase 11/12 says the ambient output is "byte-identical to the same chat without a calendar". For chats with custom tags, removing the calendar makes those tags unreadable, so the clock changes. It should say "for the same resolved time".
- **Example record:** it has 2 months but anchors to month 6, and the eclipse example puts Rotmonth at month 3 instead of 2.
- **Months and weekdays stored by position:** inserting or reordering a month silently moves every event, so the editor needs to renumber them. The doc should also say what happens to an event whose day disappears when a month is shortened.
- **Name rules:** "letters" should mean letters in any language, curly apostrophes should be treated as straight ones, and the doc should say what happens when a tag has an unknown weekday.

## Follow-up: revision 2 and two open items

**Written:** 2026-10-29, after reading `CALENDAR_DESIGN.md` revision 2. It answers open items §8.1 and §8.8.

Revision 2 folds in all eight fixes, the scope decision (`structure`, D49) and the smaller items as intended. The new example record checks out: counting from the Highsun 18 anchor (a Threeday), Rotmonth 3 is a Starday, tomorrow is a Oneday, and 33 days remain in the 36-day month. On the "753, not 764" correction, both numbers are right: 753 real years is about 764 of the example's 360-day years, and the review counted in calendar years.

### §8.1: month-arithmetic clause always on, or only near month end?

**Only near month end: show it when 7 or fewer days remain.** Also put the full month table (names and day counts, in order) in the preset snippet the panel generates.

- **Most turns it adds nothing.** The line already states tomorrow, so the clause only matters when one reply skips more days than the month has left. With 33 days left, nothing short of a month-long skip needs it. Spending roughly 14 tokens every turn on a fact that rarely matters breaks the rule every Ambient trim followed: everyday defaults don't earn tokens every turn (D33). Phase 12's tokenizer run will give the exact count.
- **7 days covers the common skips.** RP skips are mostly "the next morning", "a few days later" and "a week later". With a 7-day threshold the clause shows on about a fifth of days, and it covers all of those. Months shorter than 7 days will always show it, which is right: that's where the model overruns the month end most often.
- **The month table in the preset covers the rest.** It's fixed text, so it adds no per-turn cost, and it handles longer skips ("two weeks later" on day 25). It also closes a gap fix 6 opened. When a bad tag switches the calendar block off, the model has no calendar facts left. If it writes "Rotmonth 38", it will probably carry on with 39 and 40 until the user steps in. With the month table in the preset, it still has the correct names and lengths to recover from. §3.7 only says the snippet teaches the tag format, so it should also say the snippet includes the month list.

### §8.8: darker-of for frequency light too?

**Yes, and now is the cheapest time.** Frequency phenomena (2.14.0) are only on `testing`, not `main`, and light can only be set through the advanced JSON editor, so almost no tester can have a rule that depends on the current behaviour.

- **Brightening the night doesn't work well even when it's intended.** A frequency occurrence runs from 21:00 to the next noon. The only thing absolute light does that darker-of doesn't is lift the night. When it does, the scene is no longer "darkness", so the moonlight description disappears, aurora turns off and meteors become invisible — usually the very things a night-time rule is about. A "glowing night" works better as an additive clause. The "fixed" light mode (§8.9) is there if a story ever really needs it.
- **Combine overrides as "darkest wins", not "top priority wins, then darken".** As revision 2 words it, a priority-10 twilight eclipse beats a priority-0 darkness miasma at 10 AM and makes the morning *lighter*. If light overrides only ever darken, the darkest active one should win, and priority should only decide whose name is shown on a tie.
- **Keep `'daylight'` as an allowed value, even though it will have no effect.** `isFrequencyRule` checks `light` against the allowed list (`core/ambient_phenomena.js:28`). Removing `'daylight'` would make it reject stored rules, and those rules would disappear without any message. The panel should note the value has no effect instead.
- **One existing test changes on purpose.** `test/ambient_phenomena.test.js:80-81` checks that a `daylight` rule hides meteors at 22:00, which is exactly the brightening being removed. Change it deliberately, say so in the commit, and update `AMBIENT_PHENOMENA.md:14` and the 2.14.0 CHANGELOG entry to match.
