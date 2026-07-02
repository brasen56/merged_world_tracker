# 🌍 Merged World Tracker

**A unified SillyTavern extension combining World State tracking, Session Chronicle, NPC Knowledge management, and Story Planning into a single modular system.**

*A SillyTavern extension by [Brasen](https://github.com/brasen56)* · `v1.2.0`

---

## 📋 Table of Contents

- [Overview](#overview)
- [Features](#features)
  - [🌍 World State Tracker](#-world-state-tracker)
  - [📜 Session Chronicle](#-session-chronicle)
  - [🧠 Knowledge Tracker](#-knowledge-tracker)
  - [🗺️ Story Planner](#-story-planner)
  - [Shared Core](#shared-core)
  - [Slash Commands & Macros](#slash-commands--macros)
  - [Mobile & Touch](#mobile--touch)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
  - [Connection Profiles (Recommended)](#connection-profiles-recommended)
  - [Custom API Settings](#custom-api-settings)
  - [Per-Module Settings](#per-module-settings)
  - [Injection Settings](#injection-settings)
  - [Floating Buttons](#floating-buttons)
  - [Per-Tracker Enable & Panic Switch](#per-tracker-enable--panic-switch)
- [Usage Guide](#usage-guide)
  - [World State](#world-state)
  - [Session Chronicle](#session-chronicle)
  - [Knowledge Tracker](#knowledge-tracker)
  - [Story Planner](#story-planner)
- [Architecture](#architecture)
- [API Compatibility](#api-compatibility)
- [Theme Support](#theme-support)
- [Data Storage](#data-storage)
- [License](#license)

---

## Overview

Merged World Tracker (MWT) is a modular SillyTavern extension that brings four powerful RP assistance tools under one roof. Each module shares a common core for API calls, diff computation, settings management, and UI — while remaining independently configurable.

Instead of juggling multiple standalone extensions, MWT provides a single tabbed interface with floating quick-access buttons, unified API settings (with per-module overrides), and cross-module integration (e.g., chronicle entries can sync time/location back to the world state, and the Story Planner draws on the current world state and latest chronicle entry for context).

### What It Does

| Module | Purpose |
|---|---|
| **🌍 World State** | Maintains a rolling structured document of the current scene, characters, threads, and plot seeds |
| **📜 Chronicle** | Generates timestamped summaries of RP events with consolidation, editing, and flexible injection |
| **🧠 Knowledge** | Scans for NPCs, tracks their knowledge and relationships, and manages state entries via lorebooks |
| **🗺️ Story Planner** | Brainstorms a menu of medium/long-term plot arcs from your story and injects them as inspiration for the AI |

All four modules use an LLM API (OpenAI-compatible or SillyTavern Connection Manager) to analyze your RP and produce structured, validated output.

---

## Features

### 🌍 World State Tracker

Maintains a live, structured document describing the current state of the roleplay world. It is injected into the prompt to give the LLM consistent context about what's true right now.

- **LLM-Powered Refresh** — Generates a full world state document from recent chat messages using a carefully tuned system prompt
- **Auto-Refresh** — Automatically re-scans every N messages (configurable interval)
- **Per-Section Regeneration** — Regenerate individual sections (e.g., just "Plot Seeds" or "Key Character States") without refreshing the entire document
- **Variety Control** — Adjust regeneration variety from *Conservative* (1) to *Chaotic* (5) for creative exploration
- **Structured Sections** including:
  - Current Scene (date, time, present characters, situation)
  - Recent Changes
  - Off-Screen characters
  - Pending obligations
  - Active & Unresolved Threads
  - World Pressures
  - Key Character States (mood, goal, status, pressure, items)
  - Story Momentum
  - Plot Seeds (with off/passive/proactive/assertive hook modes)
  - Potential Entrances
- **Plot Seed Hook Modes** — Control how aggressively the LLM introduces narrative hooks:
  - **Off** — Plot Seeds are not injected into the prompt at all
  - **Passive** — Hooks are available but the LLM decides when to use them
  - **Proactive** — The LLM is encouraged to introduce hooks organically
  - **Assertive** — The LLM is directed to introduce at least one hook per response
- **Manual Editing** — Edit the world state directly in a text editor
- **Auto-Save History** — Periodic snapshots with diff-based revert
- **Import/Export** — JSON archives and plain text/markdown import
- **Message Filtering** — Regex-based filters to strip unwanted content before scanning
- **Prompt Injection** — Configurable depth and role for prompt injection
- **Injection Preview** — Preview exactly what will be injected, including headers and tags

### 📜 Session Chronicle

Generates timestamped chronicle entries that summarize what happened in the RP, creating a durable historical record that can be injected into future prompts for long-term continuity.

- **LLM-Generated Snapshots** — Produces structured entries with Summary, Relationship & Institutional Shifts, Open Loops Created, Open Loops Closed, and Time Anchors
- **Manual Entries** — Create blank entries with the standard format for hand-written notes
- **Consolidation** — Merge multiple entries into one, with a preview/editor for the input before consolidation. Optionally **designate a base entry** (the foundation) with ★ — useful for merging fresh entries into an already-consolidated entry where the consolidated entry should be the base and the others the deltas
- **Regeneration with Diff** — Regenerate any entry and compare the original vs. new version side-by-side with inline word-level diff highlighting
- **Entry Editor** — Full text editor for any entry with save, regenerate, and delete
- **Trash & Restore** — Deleted entries go to a trash bin (up to 50) and can be restored
- **Flexible Injection Modes**:
  - **Recent** — Inject the last N entries
  - **Selected** — Choose specific entries to inject
  - **All** — Inject every entry
  - **Range** — Inject entries within a date range
- **Auto-Snapshot** — Automatically suggest generating a snapshot every N messages
- **World State Sync** — Chronicle entries automatically sync time and location data back to the World State
- **Character Extraction** — Automatically identifies NPCs mentioned in each entry
- **Search** — Filter entries by text content
- **Statistics** — Token estimates, entry counts, character frequency
- **Export/Import** — JSON and Markdown export, with merge-based import

### 🧠 Knowledge Tracker

Scans your RP for NPCs, classifies them, tracks their knowledge and relationships, and writes entries directly into SillyTavern lorebooks for automatic keyword-triggered injection.

- **NPC Scanning** — LLM-powered scan of recent messages to detect new and updated NPCs
- **Minor vs. Major Classification**:
  - **Minor NPCs** — Background characters with basic info (species, descriptor, tone, first seen)
  - **Major NPCs** — Named characters with a full Knowledge Ledger tracking what they know and how they learned it
- **Staging System** — All scan proposals go to a staging area where you can review, edit, accept, or dismiss them
- **Inline Diff** — Updates to existing NPCs show a line-level diff of changes before you accept
- **Lorebook Integration** — Accepted entries are written directly to a dedicated "Knowledge Tracker" lorebook
- **State Trackers** — Register special lorebook entries as state trackers that can be automatically updated by the LLM based on recent messages
- **NPC Promotion/Demotion** — Promote minor NPCs to major (adds Knowledge Ledger) or demote major to minor
- **NPC Merging** — Merge duplicate NPC entries into one
- **Relationship Tracking** — Define and track relationships between NPCs (ally, enemy, friend, rival, family, etc.)
- **Relationship Graph View** — Visual force-directed node/edge graph with color-coded relationship types, draggable nodes, pan/zoom, and a list-view toggle
- **Notification Panel** — Floating, draggable notification panel alerts you to new scan results
- **Auto-Trigger** — Automatically run state tracker scans every N messages (with cooldown to avoid re-updating recently changed trackers)
- **Import from Lorebook** — Scan existing Knowledge Tracker and State Tracker lorebooks to register entries not yet tracked
- **Cross-Module Integration** — Scans include current World State and latest Chronicle entry for richer context

### 🗺️ Story Planner

Acts as a "Story Architect" that brainstorms a menu of future plot possibilities (arcs, chapters, episodes) from your story so far. The plan is injected into the prompt as inspiration the AI can draw on — branching possibilities, not a fixed roadmap.

- **LLM-Generated Plot Menu** — Produces a list of 10+ medium-to-long-term plot developments grouped under "Upcoming Arcs", each framed as a future arc/chapter/episode rather than a time frame
- **User-Safe Prompting** — The system prompt strictly forbids the model from writing actions, dialogue, thoughts, or reactions for `{{user}}`
- **Manual Editing** — Edit the generated plan freely in the text editor; your edits are injected as-is
- **Auto-Generate** — Automatically refresh the plan every N messages (configurable interval, counted on AI replies)
- **Injection Toggle** — Independently control whether the plan reaches the AI (toggle injection off without deleting the plan)
- **Custom Prompts** — Override the default system and user prompts; the user prompt supports a `{{chatHistory}}` token
- **Token & Word Statistics** — Live char/word/token estimates under the editor and in the toolbar
- **Configurable Injection Depth** — Set how far from the bottom of the prompt the plan is injected
- **Cross-Module Context** — Generation reads recent chat history for rich, story-aware suggestions

### Shared Core

All four modules share a common infrastructure:

- **Unified API Layer** — OpenAI-compatible API *or* SillyTavern Connection Manager profiles, with retry logic, error recovery, reasoning-content fallback, and custom headers support
- **Settings Management** — Global defaults with per-module overrides; settings stored in SillyTavern's `extension_settings` with localStorage fallback and legacy key migration
- **Diff Engine** — LCS-based line and word-level diff computation with customizable HTML rendering
- **Modal System** — Shared modal lifecycle (create, show, hide, status bar) with escape-key and backdrop-click handling
- **Context Helpers** — Safe access to SillyTavern context, chat data, metadata, token estimation, and player name resolution
- **Sync to Modules** — Push global API settings to all modules at once
- **Injection Helpers** — Shared extension-prompt injection with optional XML structural-boundary wrapping

### Slash Commands & Macros

MWT integrates with SillyTavern's STscript system for power-user automation and Quick Replies:

**Slash Commands:**

| Command | Action |
|---|---|
| `/wt-refresh` | Trigger a World State refresh |
| `/wt-snapshot` | Generate a Chronicle snapshot |
| `/wt-scan` | Run a Knowledge NPC scan |
| `/wt-plan` | Generate a Story Planner plan |
| `/wt-inject on\|off` | Toggle injection for World State and Chronicle |
| `/wt-state` | Output the current world state text (pipeable) |

> **Note:** `/wt-inject` toggles World State and Chronicle injection only. Knowledge Tracker uses lorebook keywords (not extension prompts), and Story Planner injection is toggled from its own Settings panel.

**Macros** (SillyTavern 1.12+):

| Macro | Returns |
|---|---|
| `{{worldstate}}` | The current world state text |
| `{{chronicle}}` | The full chronicle injection text |
| `{{lastchronicle}}` | The most recent chronicle entry |
| `{{storyplan}}` | The current story plan text |

Macros let you place content anywhere (Author's Note, prompt manager block, char card, custom-depth WI entry) instead of the fixed injection — pair with disabling injection for a "macro-only" workflow.

### Mobile & Touch

- **Pointer Events** — Floating button drag works with mouse, touch, and pen
- **Responsive Layout** — Modal adapts to small screens (breakpoints at 768px and 480px)
- **Collapse Mode** — Optionally collapse the five floating buttons into a single hub button
- **Right-Click / Long-Press** — Quick-toggle any tracker via the floating button's context menu

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

1. **Open the MWT Modal** — Click any of the floating emoji buttons on the right side of the screen (🌍, 📜, 🧠, 🗺️, or ⚙️), or use the **MWT** entry in the wand (extensions) menu, or the drawer in the Extensions panel
2. **Configure API** — Go to the **⚙️ Settings** tab and either:
   - Select a **Connection Profile** (uses your existing SillyTavern connection), **or**
   - Enter a custom API URL, Key, and Model
3. **Save Settings** — Click **Save Settings**
4. **Start Tracking** — Switch to any module tab and click its action button:
   - 🌍 World State → **🔄 Refresh**
   - 📜 Chronicle → **📸 Snapshot**
   - 🧠 Knowledge → **🔍 Scan**
   - 🗺️ Story Planner → **🎲 Generate Plan**

---

## Configuration

### Connection Profiles (Recommended)

Configured in the **⚙️ Settings** tab. Selecting a Connection Manager profile is the recommended way to power MWT — it reuses your existing SillyTavern connection and supports every backend ST supports (OpenAI, Claude, Gemini, TextGen, KoboldCPP, NovelAI, local models, etc.) with full preset and instruct support.

Profiles marked "(active)" are SillyTavern's currently selected profile. Leave the dropdown empty to fall back to a custom API configuration below.

### Custom API Settings

These appear in the **⚙️ Settings** tab when no Connection Profile is selected. They serve as defaults for all modules.

| Setting | Description | Default |
|---|---|---|
| API URL | Base URL for OpenAI-compatible API | *(empty)* |
| API Key | Bearer token for API authentication (optional for keyless local backends) | *(empty)* |
| Model | Model identifier (e.g., `gpt-4o-mini`) | *(empty)* |
| Max Tokens | Maximum tokens in LLM response | `2000` |
| Temperature | Sampling temperature (0–2) | `0.3` |
| Top P | Nucleus sampling threshold | `1.0` |
| Frequency Penalty | Penalize frequent tokens (-2 to 2) | `0` |
| Presence Penalty | Penalize present tokens (-2 to 2) | `0` |
| Custom Headers | Additional HTTP headers (JSON) | *(empty)* |

> **Note:** Only API URL and Model are required. API Key is optional to support keyless local backends (Ollama, LM Studio, llama.cpp, etc.).

### Per-Module Settings

Each module tab has a **⚙ Settings** button (or expandable settings section) that opens module-specific settings, which can override the global API configuration. This lets you use different models or temperatures for different tasks (e.g., a creative model for world state, a precise model for knowledge scanning, a higher-temperature model for story planning). Use **↓ Sync to Modules** in the global Settings tab to push the global API config to all modules at once.

### Injection Settings

Control how World State, Chronicle, and Story Plan content are injected into the prompt:

| Setting | Description | Default |
|---|---|---|
| World State Depth | How far from the bottom of the prompt to inject | `4` |
| World State Role | Message role for injection (`system`, `user`, `assistant`) | `system` |
| Chronicle Depth | Injection depth for chronicle entries | `4` |
| Chronicle Role | Message role for chronicle injection | `system` |
| Story Plan Depth | Injection depth for the story plan | `4` |
| Structural Boundaries | Wrap injected blocks in XML tags (e.g., `<mwt_world_state>…</mwt_world_state>`) | `On` |

**Structural Boundaries** wrap each injected reference block in tags so the model clearly distinguishes sections. Recommended for smaller / open models (24–70B) that bleed between sections. Frontier models don't need it; turn it off to save a few tokens.

> **Note:** Knowledge Tracker does not use extension prompt injection — it writes directly to SillyTavern lorebooks, which are triggered by keywords. Disabling the Knowledge tracker only stops it from scanning/updating; existing lorebook entries continue to be injected by SillyTavern's World Info until you disable them manually in the World Info panel.

### Floating Buttons

The five floating buttons (🌍 📜 🧠 🗺️ ⚙️) can be individually shown/hidden, repositioned (drag), collapsed into a single hub button, and styled as icon-only ("Modern") or icon+text ("Classic"). Position is persisted across sessions. You can also open the MWT modal from the wand (extensions) menu or the Extensions panel drawer.

### Per-Tracker Enable & Panic Switch

Each tracker can be individually enabled/disabled. Disabling a tracker stops it from injecting and scanning; its floating button shows a red ✕ and can be re-enabled via right-click (or the Settings tab). The global **panic switch** (right-click the ⚙️ button, or the checkbox in Settings) disables all trackers at once — useful for testing or branching a chat.

---

## Usage Guide

### World State

1. Open the **🌍 World State** tab
2. Click **🔄 Refresh** to generate a world state from recent messages
3. Review the generated document in the editor
4. Edit manually if needed — click **💾 Save** to persist changes to chat metadata
5. Toggle **🔌 Injection** to include the world state in every prompt
6. Toggle **🔄 Auto** to automatically refresh every N messages
7. Use **Section Regenerate** (select a section, set variety, click **🎲 Regenerate Section**) to refresh individual sections
8. Use **⏪ Revert** to restore a previous version from auto-save history, or **📋 History** to browse all snapshots
9. Use **📄 Preview Injection** to see exactly what will be injected

### Session Chronicle

1. Open the **📜 Chronicle** tab
2. Click **📸 Snapshot** to generate a chronicle entry from messages since the last snapshot
3. Review the entry — click it to expand and edit
4. Use **Consolidate** mode to merge multiple entries into one summary:
   - Click **Consolidate** to enter selection mode
   - Check the entries you want to merge (2+ required)
   - Optionally click **☆ Set as Base** on one entry to designate it as the foundation — the others become deltas applied on top of it. This is useful when consolidating fresh entries into an already-consolidated entry where the consolidated one should be the base
   - Click **Consolidate N entries** to proceed
5. Toggle **🔌 Injection** to include chronicle entries in the prompt
6. Configure injection mode via the **⚙ Injection Settings** gear button:
   - **Recent** — last N entries (default: 2)
   - **Selected** — hand-picked entries
   - **All** — every entry
   - **Range** — date-filtered entries
7. Export as JSON or Markdown for backup or external use

### Knowledge Tracker

1. Open the **🧠 Knowledge** tab
2. Click **🔍 Scan** to analyze recent messages for NPCs
3. Review proposals in the **Staging** tab:
   - Click a proposal to see details and diff
   - Edit the proposed content in the textarea
   - Click **✓ Accept & Write** to create/update the lorebook entry
   - Click **✗ Dismiss** to discard
4. View tracked NPCs in the **Minor** and **Major** tabs
5. Click any NPC to view/edit their lorebook entry, manage relationships, or promote/demote
6. The **Relationships** tab has a force-directed graph view (default) and a list view — toggle with the Graph/List button. Drag nodes, scroll to zoom, and click a node to open that NPC
7. The **State Trackers** tab shows registered state tracker entries that can be updated via LLM
8. Enable **Auto-Trigger** in module settings to run state tracker scans automatically every N messages (with a cooldown to avoid re-updating recently changed trackers)

### Story Planner

1. Open the **🗺️ Story Planner** tab
2. Click **🎲 Generate Plan** to brainstorm a menu of future plot arcs from your story so far
3. Review the generated plan in the editor — edit freely; your edits are injected as-is
4. Click **💾 Save Plan** to persist edits to chat metadata (the editor also auto-saves on blur)
5. Use **⏪ Revert** / **📋 History** to compare against and restore earlier plans (snapshots are taken automatically before each Generate, Save, or Clear)
6. Toggle **🔌 Injection** to include the plan in the prompt as inspiration
7. Toggle **🔄 Auto** to automatically regenerate the plan every N messages
8. Expand **⚙️ Story Planner Settings** to override the API config, injection depth, auto-generate interval, or replace the default system/user prompts

Regeneration is continuity-aware: the previous plan is fed back so still-relevant arcs are carried forward and evolved rather than discarded. The user prompt supports the tokens `{{chatHistory}}`, `{{worldState}}`, `{{lastChronicle}}`, and `{{previousPlan}}` — each resolves to empty when that data isn't present, so the planner works whether or not you use the World State and Chronicle modules.

---

## Architecture

```
merged_world_tracker/
├── index.js              # Main entry — tabbed UI, event hooks, floating buttons, init
├── manifest.json         # SillyTavern extension manifest
├── style.css             # All styles (dark + light theme, responsive breakpoints)
├── core/                 # Shared infrastructure
│   ├── index.js          # Barrel re-exports for all core modules
│   ├── api.js            # OpenAI-compatible + Connection Profile API client with retry
│   ├── commands.js       # Slash command and macro registration
│   ├── context.js        # SillyTavern context, chat, metadata, token helpers
│   ├── diff.js           # LCS line/word diff computation and HTML rendering
│   ├── file.js           # Download / file-pick helpers
│   ├── injection.js      # Extension prompt injection helpers + XML tag wrapping
│   ├── metadata.js       # Chat metadata access (world state / chronicle / registry)
│   ├── modal.js          # Modal lifecycle, status bar, button bar helpers
│   ├── notifications.js  # Toast notifications
│   ├── settings.js       # Settings manager factory (extension_settings + localStorage)
│   └── ui.js             # API field renderer, floating button bar, drawer, wand menu
├── world_state/          # World State Tracker module
│   ├── index.js          # Orchestrator — public API and lifecycle hooks
│   ├── data.js           # Constants, state, data access (leaf)
│   ├── settings.js       # Settings manager and defaults (leaf)
│   ├── prompts.js        # System prompt template (leaf)
│   ├── injection.js      # Prompt injection + Plot Seeds hook-mode headers
│   ├── refresh.js        # Full refresh, auto-refresh scheduling, auto-save timer
│   ├── sections.js       # Per-section regeneration
│   └── render.js         # UI rendering, events, archive/import, revert/diff, preview
├── chronicle/            # Session Chronicle module
│   ├── index.js          # Orchestrator — public API and lifecycle hooks
│   ├── data.js           # Constants, state, settings, data access, anchor helpers (leaf)
│   ├── prompts.js        # System prompts for snapshot + consolidation (leaf)
│   ├── injection.js      # Prompt injection logic
│   ├── snapshots.js      # Generation, validation, CRUD, world state sync
│   ├── import-export.js  # JSON / Markdown export and import
│   └── render.js         # All UI rendering
├── knowledge/            # Knowledge Tracker module (NPCs + State Trackers)
│   ├── index.js          # Public API barrel — lifecycle, slash commands, macros
│   ├── state.js          # Constants, shared mutable state, content helpers (leaf)
│   ├── settings.js       # Settings manager + settings panel (leaf)
│   ├── prompts.js        # Scan and state-update prompts (leaf)
│   ├── registry.js       # NPC + State Tracker registry operations (chat metadata)
│   ├── lorebook.js       # Lorebook read/write, scan, state update, staging enrichment
│   ├── staging.js        # Build staging items from scan results
│   ├── relationships.js  # Relationship storage and graph layout computation
│   └── render.js         # All UI rendering (staging, minor/major, state, graph, settings)
└── story_planner/        # Story Planner module (future plot arcs)
    ├── index.js          # Thin orchestrator — public API and lifecycle hooks
    ├── data.js           # Constants, shared mutable state, data access (leaf)
    ├── settings.js       # Settings manager and defaults (leaf)
    ├── prompts.js        # Story Architect system + user prompt templates (leaf)
    ├── injection.js      # Prompt injection (depth, structural boundaries, header)
    ├── generation.js     # LLM plan generation with chat-switch guards
    └── render.js         # UI rendering, toolbar/stats, settings panel, event wiring
```

### Module Communication

- Modules read shared global settings (injection depth/role, structural boundaries, enable flags) via `getGlobalSettings()` and `injectionAllowed()` in `core/settings.js`; the global Settings tab pushes API config to each module through their `syncGlobalSettings()`
- The Chronicle module can sync time/location data back to World State
- The Knowledge module reads World State and Chronicle data for richer scan context
- The Story Planner reads recent chat history to ground its suggestions
- All modules respond to SillyTavern events:
  - `CHAT_CHANGED` — reset module state for the new chat
  - `MESSAGE_RECEIVED` — advance auto-refresh / auto-snapshot / auto-trigger / auto-plan counters
  - `GENERATION_STARTED` / `GENERATION_STOPPED` — gate chronicle work during main generation
  - `MESSAGE_DELETED` — decrement counters and invalidate stale chronicle anchors
  - `MESSAGE_SWIPED` / `MESSAGE_EDITED` — schedule world state refresh (if auto-refresh enabled) and flag stale chronicle anchors

---

## API Compatibility

MWT works with any backend via two modes:

1. **Connection Manager Profiles** (recommended) — uses SillyTavern's own connection, supporting every backend ST supports (OpenAI, Claude, Gemini, NovelAI, KoboldCPP, TextGen, etc.) with full preset/instruct support.
2. **Custom OpenAI-compatible API** — any API that implements the `/chat/completions` endpoint.

Tested with:

- OpenAI (`gpt-4o-mini`, `gpt-4o`, etc.)
- Anthropic via OpenAI-compatible proxies
- DeepSeek
- Local models via LM Studio, Ollama, text-generation-webui, etc.

### Tips for Best Results

- **World State** works best with models ≥ 8K context and strong instruction following
- **Chronicle** benefits from higher `maxTokens` (8000+ to allow detailed entries)
- **Knowledge** scans work well with lower temperatures (0.1–0.3) for consistent JSON output
- **Story Planner** benefits from a higher temperature (default `0.6`) for creative, varied arc suggestions
- For models with extended thinking (e.g., DeepSeek R1, o1), the API layer automatically recovers from empty content by falling back to `reasoning_content`

---

## Theme Support

MWT supports both **dark** and **light** SillyTavern themes. CSS variables automatically adapt via theme-aware selectors. The extension matches SillyTavern's look and feel regardless of your chosen theme.

---

## Data Storage

- **Chat data** (world state text, chronicle entries, NPC registry, state tracker registry, relationships, story plan text) is stored in SillyTavern's per-chat metadata (survives backup/restore)
- **Settings** are stored in SillyTavern's `extension_settings` (survives backup/restore) with `localStorage` fallback
- **Knowledge Tracker history** is stored in `localStorage` keyed by lorebook UID
- **Floating button positions** are stored in `localStorage`
- All data is per-chat — switching chats loads that chat's world state, chronicle, NPC registry, and story plan

---

## License

This project is provided as-is for use with SillyTavern. See the repository for license details.
