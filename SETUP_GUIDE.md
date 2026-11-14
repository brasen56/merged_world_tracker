# 🚀 MWT Setup Guide — from install to your first tracked scene

New to MWT? This page is the whole onboarding: pick a level, work through a short checklist, and you're running. Every module is described in one line in the [README](README.md), and every feature and setting is documented in the [User Guide](USER_GUIDE.md) — neither of those is required reading to start.

**The one thing to know before anything else: every module is independent.** Disable any of the six and nothing breaks — the others keep working, and you can re-enable anything at any time. Nothing irreversible happens in setup, and a global panic switch (right-click the ⚙️ button) turns every tracker off at once if you ever want silence.

One prerequisite, independent of level: the five LLM modules share one API connection. Configure it once in the **⚙️ Settings** tab — a **Connection Profile** is the easiest path (it reuses your existing SillyTavern connection) — and press **Save Settings**. Only 🌦️ Ambient Conditions needs no API at all.

> 💾 **Save as you go.** Most steps below change a field in a settings pane. Each pane has its own **Save Settings** button, and a change you don't save is lost when the pane closes. The 🔄 **Auto** buttons in World State and Story Planner are the exception — they save the moment you click them.

---

## Pick your setup

Three levels. They only set two things: **which modules are on**, and **how much runs automatically**. You can move between them at any time — nothing here is a commitment.

| | **Lite** | **Standard** | **Full** |
|---|---|---|---|
| For | "I want to try MWT with the lightest touch" | "Everything available, but I press the buttons" | "Keep the bookkeeping running in the background" |
| Modules on | 🌍 World State + 📜 Chronicle | All five | All five |
| World State Detail Level | Minimal | Standard | Detailed (default) |
| Automatic work | None — every action is a button you press | None — every action is a button you press | On — World State refresh, Chronicle entries, Knowledge scans, Interiority thoughts |
| Typical API usage | Lowest — occasional manual calls | On-demand only | Steadiest — scheduled background calls |

Not sure? Pick **Standard**. It shows you everything MWT can do with zero surprise API calls, and upgrading to Full later is a handful of toggles.

Every level ends with the same per-chat step: switching **Chronicle injection** on. Chronicle entries only reach the AI when injection is on, it is **off by default**, and it is set separately in each chat.

### Lite (about 2 minutes)

The core loop only: a rolling "what's true right now" document (World State) plus timestamped session summaries (Chronicle). Lighter prompts, minimal API usage.

1. **⚙️ Settings** tab → **Per-Tracker Enable** section: uncheck **Knowledge**, **Story Planner**, and **Interiority** (leave World State and Chronicle on) → **Save Settings**. Their tabs stay in the window; they just go quiet
2. **🌍 World State** tab → **⚙️ World State Settings** → **Detail Level**: **Minimal** (one line per character; the smallest injection) → **Save Settings**. A Detail Level change applies from the next full **🔄 Refresh**
3. Leave every auto toggle as shipped — at this level, you decide when anything runs
4. **📜 Chronicle** tab, in each chat → once the chat has its first entry (**Generate Entry**), click **📤 Injection OFF** so it reads **📥 Injection ON**
5. Optional: hide the floating buttons of the modules you turned off (**⚙️ Settings** → Floating Buttons)

### Standard (about 2 minutes)

All five modules available at moderate prompt size, but nothing runs until you ask. The closest level to "shipped defaults" — the only changes from a fresh install are the Detail Level and Interiority's auto setting.

1. **⚙️ Settings** tab → **Per-Tracker Enable**: leave all five checked (that's the default)
2. **🌍 World State** tab → **⚙️ World State Settings** → **Detail Level**: **Standard** (short character blocks; tighter section limits) → **Save Settings**
3. **💭 Interiority** tab → **⚙ Settings** → uncheck **Auto-generate on each AI message** (it ships checked) → **Save Settings**. With it off, you generate thoughts when you want them with **💭 Generate Now** in the tab, or `/wt-thoughts`
4. **📜 Chronicle** tab, in each chat → once the chat has its first entry (**Generate Entry**), click **📤 Injection OFF** so it reads **📥 Injection ON**

### Full (about 5 minutes)

Everything on, the bookkeeping automated, full-size world state. MWT refreshes itself as the story moves. Note the trade: scheduled background API calls in every chat.

1. **⚙️ Settings** tab → **Per-Tracker Enable**: all five checked (default)
2. **🌍 World State** tab → **⚙️ World State Settings** → **Detail Level**: **Detailed** (default — full six-field character blocks)
3. Same section → click **🔄 Auto: OFF** and accept **5** messages (the shipped interval). It saves immediately
4. **📜 Chronicle** tab → **⚙ Settings** → check **Auto-snapshot**, threshold **40** messages → **Save Settings**. Every 40 messages it writes a new entry on its own — you can open, edit, or delete it afterwards
5. **🧠 Knowledge** tab → the **⚙️** button at the end of the sub-tab row → check the four automatic cadences, then **Save Settings**:
   - **Auto-trigger state tracker updates** every **5** messages — only does anything once you have registered State Trackers
   - **Auto-scan for NPCs** every **10** — results wait in **Staging** for you to accept
   - **Auto-capture growth evidence** every **15** — only for NPCs you have enrolled in Growth
   - **Auto-log relationships** every **10** — extracts and saves relationship changes; each one is listed in Recent Changes on the Relationships tab
6. **💭 Interiority**: leave **Auto-generate on each AI message** checked (default)
7. **📜 Chronicle** tab, in each chat → once the chat has its first entry, click **📤 Injection OFF** so it reads **📥 Injection ON**

**Story Planner stays manual, even in Full.** Its 🔄 Auto doesn't keep records — it regenerates the whole plan every N AI replies and saves the result without review, replacing arcs you haven't pinned. Turn it on from the Story Planner tab only if you want that churn.

> 💡 Delta Mode pairs well with Full: **🌍 World State** tab → **⚡ Delta Refresh (Low-cost Mode)** → check **Delta Mode** → **Save Settings**. The scheduled auto-refresh then asks only for changed sections instead of rebuilding the whole document — usually cheaper. See the [User Guide](USER_GUIDE.md#choosing-full-vs-delta-auto-refresh).

### If you do nothing

A fresh install runs all five modules at the **Detailed** detail level with every cadence manual — except Interiority's auto, which ships on — and with Chronicle injection off in every chat. In other words, defaults sit between Standard and Full: full scope, quiet cadences. That's a perfectly fine way to start; the levels above just get you somewhere deliberate in one step.

### Optional per-chat extras: 🌦️ Ambient Conditions and 📅 Calendar

Deliberately outside the levels. Both are per-chat, off until you set them up, and need no API.

- **🌦️ Ambient Conditions** — deterministic weather the narrator renders instead of inventing. Its only setup is one climate + hemisphere question: enable it in **⚙️ Settings → 🌦️ Ambient Conditions (this chat)**.
- **📅 Calendar** — only if your world doesn't use the real-world calendar. Author your own months and weekdays in the **📅 Calendar** tab, and the story clock and Ambient's sky follow it. See the [User Guide](USER_GUIDE.md#-calendar).

---

## What's safe to turn off (all of it) — and what each module's absence costs

Every disable is clean. The module stops updating, stops running in the background, and stops injecting; its floating button shows a red ✕. Its tab stays in the window, and **whatever it already saved stays where it is**: the other modules can still read that saved copy, it just stops changing. What that means module by module:

- **🌍 World State off** — the saved document freezes. Story Planner, Knowledge scans, and Interiority's list of who is present keep reading that last saved scene, which falls behind as the story moves (Chronicle entries still write their time and place into it, and Ambient Conditions still uses its date when your messages carry no time tags). Turning it off at the start of a chat avoids the drift
- **📜 Chronicle off** — no new entries. Story Planner and Knowledge scans keep using the latest saved entry as context. World State never reads Chronicle, so it loses nothing
- **🧠 Knowledge off** — scanning and updates stop. Story Planner's opt-in private NPC author context refuses to run. Nothing is written to or removed from your lorebooks: existing entries keep working under SillyTavern's own World Info until you disable them there
- **🗺️ Story Planner off** — nothing else depends on it; arcs simply stop being offered to the narrator
- **💭 Interiority off** — nothing else depends on it; NPCs stop carrying hidden intentions into the prompt
- **🌦️ Ambient Conditions off** — planner weather-complication ideas fall back to inventing their own weather; that's it

Nothing errors. The [Diagnostics → Health](USER_GUIDE.md#-diagnostics) tab always shows every module's enabled/gate state if you want to see the wiring.

## Changing your mind later

Everything above is reversible at any time, from the same places: **Per-Tracker Enable** and the module settings re-take any level's values whenever you like. Cadence toggles apply going forward; no data is deleted by disabling a module — its tab just goes quiet. The one-way street doesn't exist here, except deliberately: **Delete** actions inside modules are the only forgets.

## One-click presets (planned)

A first-run dialog that applies Lite / Standard / Full in one click is specced in [docs/ONBOARDING_PRESET_PLAN.md](docs/ONBOARDING_PRESET_PLAN.md) — the checklists above are exactly what it will set, apart from the per-chat Chronicle injection step, which a global preset can't reach. Until then, this page *is* the button.
