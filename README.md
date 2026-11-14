# 🌍 Merged World Tracker

**A unified SillyTavern extension combining World State tracking, Session Chronicle, NPC Knowledge management, Story Planning, NPC Interiority, and deterministic Ambient Conditions into a single modular system.**

**New here?** [SETUP_GUIDE.md](SETUP_GUIDE.md) gets you from install to a working setup in a few minutes — including a Lite / Standard / Full choice so you don't have to understand all six modules before your first scene.

---

## 🆕 What's New

One line each; the complete version-by-version history lives in [CHANGELOG.md](CHANGELOG.md).

- **v2.17.0** — Growth-written dossier Personality & Voice: approved NPC growth can write those two lines, reviewed sentence-by-sentence in Staging
- **v2.16.0** — Manual NPC entry editing: opt-in Edit mode in the NPC View, riding the same guarded write path as the module's own cleanups
- **v2.15.0** — Custom world calendars: author your own months, weekdays, and events; drives the story clock and the whole Ambient sky, deterministically
- **v2.12.0** — Ambient Conditions module: deterministic weather with no LLM calls — code decides, the narrator renders

> Design and planning documents for shipped and in-progress work are indexed in the [`docs/` directory](docs/README.md).

---

## Overview

Merged World Tracker (MWT) is a modular SillyTavern extension that brings six RP assistance tools under one roof. Each module shares a common core for API calls, diff computation, settings management, and UI — while remaining independently configurable and independently disableable.

Instead of juggling multiple standalone extensions, MWT provides a single tabbed interface with floating quick-access buttons, unified API settings (with per-module overrides), and cross-module integration (chronicle entries can sync time/location back to the world state, the Story Planner draws on the current world state and latest chronicle entry for context, Interiority reads NPC Knowledge Ledgers to ground each character's private thoughts in what they actually know, and Ambient Conditions supplies deterministic weather that the narrator renders and the Story Planner builds on).

### What It Does

| Module | Purpose |
|---|---|
| **🌍 World State** | Maintains a rolling structured document of the current scene, characters, threads, and plot seeds |
| **📜 Chronicle** | Generates timestamped summaries of RP events with consolidation, editing, and flexible injection |
| **🧠 Knowledge** | Scans for NPCs, tracks their knowledge and relationships, and manages state entries via lorebooks |
| **🗺️ Story Planner** | Brainstorms structured plot arcs across five timeline sections — managed as editable cards with selective injection: inspiration the AI can draw on, not a fixed roadmap |
| **💭 Interiority** | Generates out-of-band NPC private thoughts and a persistent hidden-intentions ledger that drives on-screen actions without leaking secrets to the narrator |
| **🌦️ Ambient Conditions** | Deterministic, LLM-free weather: one authoritative line the narrator renders rather than invents |

Five of the six modules use an LLM API (OpenAI-compatible or SillyTavern Connection Manager) to analyze your RP and produce structured, validated output. The exception is Ambient Conditions — it is fully deterministic and needs no API at all.

Every module, feature, and setting — with its default — is documented in the [User Guide](USER_GUIDE.md).

---

## Installation

### From Git URL (Recommended)

1. Open SillyTavern
2. Go to **Extensions** → **Install Extension**
3. Enter the repository URL:
   ```
   https://github.com/brasen56/merged_world_tracker.git
   ```
4. Click **Install**
5. Reload SillyTavern

### Manual Installation

1. Clone or download this repository
2. Place the `merged_world_tracker` folder in:
   ```
   SillyTavern/public/scripts/extensions/third-party/
   ```
3. Reload SillyTavern

---

## Quick Start

1. **Pick your setup** — skim [SETUP_GUIDE.md](SETUP_GUIDE.md) and choose Lite, Standard, or Full (two minutes; Standard is a safe default)
2. **Open the MWT Modal** — Click any of the floating emoji buttons on the right side of the screen (🌍, 📜, 🧠, 🗺️, 💭, or ⚙️), or use the **MWT** entry in the wand (extensions) menu, or the drawer in the Extensions panel
3. **Configure API** — Go to the **⚙️ Settings** tab and either select a **Connection Profile** (uses your existing SillyTavern connection), or enter a custom API URL, Key, and Model — then **Save Settings**
4. **Start Tracking** — Switch to any module tab and click its action button:
   - 🌍 World State → **🔄 Refresh**
   - 📜 Chronicle → **Generate Entry**, then **📤 Injection OFF** → **📥 Injection ON** so entries reach the prompt (injection is off by default and set per chat)
   - 🧠 Knowledge → **🔍 Scan**
   - 🗺️ Story Planner → **🎲 Generate Plan**
   - 💭 Interiority → runs automatically after every AI reply by default; **💭 Generate Now** runs it on demand

Power users: eleven `/wt-*` slash commands and four macros (`{{worldstate}}` et al.) are listed in the [User Guide](USER_GUIDE.md#slash-commands--macros).

---

## Choosing Your Setup

Six modules is a lot to absorb on day one. Three levels collapse the two decisions that matter — which modules run, and how much runs automatically — into one choice:

| | **Lite** | **Standard** | **Full** |
|---|---|---|---|
| For | Try MWT with the lightest touch | Everything available, but I press the buttons | Bookkeeping runs in the background |
| Modules on | World State + Chronicle | All five | All five |
| Automatic work | None | None | Auto-refresh, auto-snapshot, auto-scans, auto-thoughts |
| API usage | Lowest | On-demand | Scheduled background calls |

Each level's exact checklist (which tab, which control, which value) is in [SETUP_GUIDE.md](SETUP_GUIDE.md) — two to five minutes each, plus one per-chat step every level shares: switching Chronicle injection on. A fresh install with no changes runs all five modules at full detail with manual cadences, so the levels exist to get you somewhere deliberate in one step. A one-click preset dialog for this is specced in [docs/ONBOARDING_PRESET_PLAN.md](docs/ONBOARDING_PRESET_PLAN.md).

## Every module works independently

You cannot break MWT by disabling things. Each module can be turned off on its own: it stops updating and injecting, the others keep working (reading whatever it last saved), and re-enabling restores everything. A global panic switch (right-click the ⚙️ button) silences all trackers at once. Exactly what each module's absence costs — it's never an error, just a lost enrichment — is laid out in [SETUP_GUIDE.md](SETUP_GUIDE.md#whats-safe-to-turn-off-all-of-it--and-what-each-modules-absence-costs).

---

## Documentation

| Document | What it's for |
|---|---|
| [SETUP_GUIDE.md](SETUP_GUIDE.md) | **Start here.** First-run onboarding: Lite / Standard / Full, what's safe to disable, changing your mind later |
| [USER_GUIDE.md](USER_GUIDE.md) | The full reference — every module (features, workflow, settings), shared surfaces, configuration, API compatibility, data storage |
| [DATA_SAFETY_GUIDE.md](DATA_SAFETY_GUIDE.md) | Plain-language guide to validation, migrations, and quarantine in MWT 2.0, written for non-programmers |
| [DIAGNOSTICS_GUIDE.md](DIAGNOSTICS_GUIDE.md) | Beginner's guide to the 🩺 Diagnostics tab and gathering info for a bug report (no devtools needed) |
| [DIAGNOSTICS_CONSOLE_GUIDE.md](DIAGNOSTICS_CONSOLE_GUIDE.md) | Deep reference for the `window.MWT.*` console API |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Code map for contributors — annotated file trees and module communication |
| [docs/README.md](docs/README.md) | Documentation map: live planning docs, shipped designs, archive |
| [CHANGELOG.md](CHANGELOG.md) | Complete version-by-version history |

MWT supports both dark and light SillyTavern themes, is fully operable without a mouse (keyboard navigation, real dialogs with focus management, screen-reader labels — details in the [User Guide's Accessibility section](USER_GUIDE.md#-accessibility) and [docs/accessibility_plan.md](docs/accessibility_plan.md)), and works on touch devices (responsive layout, pointer-event drag, collapsible floating buttons).

---

**Credits/Inspirations:**
Id like to take a moment and thank dptgreg for inspiration and use of his Freaky Frankenstein presets. I have modified his to incorporate MWT. I would also like to thank KazumaONIISAN for the inspiration behind the Story Planner, though theirs is much more advanced than mine at this time!

---

## License

MIT — see [LICENSE](LICENSE).
