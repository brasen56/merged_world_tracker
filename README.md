# 🌍 Merged World Tracker

**A unified SillyTavern extension combining World State tracking, Session Chronicle, NPC Knowledge management, Story Planning, and NPC Interiority into a single modular system.**

---

## 📋 Table of Contents

- [Overview](#overview)
- [Features](#features)
  - [🌍 World State Tracker](#-world-state-tracker)
  - [📜 Session Chronicle](#-session-chronicle)
  - [🧠 Knowledge Tracker](#-knowledge-tracker)
  - [🗺️ Story Planner](#-story-planner)
  - [💭 Interiority](#-interiority)
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
  - [Interiority](#interiority-1)
- [Architecture](#architecture)
- [API Compatibility](#api-compatibility)
- [Theme Support](#theme-support)
- [Data Storage](#data-storage)
  - [The \[MWT:store\] entry](#the-mwtstore-entry--what-it-is-and-why-its-there)
  - [Data safety in MWT 2.0](#data-safety-in-mwt-20--validation-migrations-and-quarantine-explained)
- [License](#license)

---

## Overview

Merged World Tracker (MWT) is a modular SillyTavern extension that brings five powerful RP assistance tools under one roof. Each module shares a common core for API calls, diff computation, settings management, and UI — while remaining independently configurable.

Instead of juggling multiple standalone extensions, MWT provides a single tabbed interface with floating quick-access buttons, unified API settings (with per-module overrides), and cross-module integration (e.g., chronicle entries can sync time/location back to the world state, the Story Planner draws on the current world state and latest chronicle entry for context, and Interiority reads NPC Knowledge Ledgers to ground each character's private thoughts in what they actually know).

### What It Does

| Module | Purpose |
|---|---|
| **🌍 World State** | Maintains a rolling structured document of the current scene, characters, threads, and plot seeds |
| **📜 Chronicle** | Generates timestamped summaries of RP events with consolidation, editing, and flexible injection |
| **🧠 Knowledge** | Scans for NPCs, tracks their knowledge and relationships, and manages state entries via lorebooks |
| **🗺️ Story Planner** | Brainstorms structured plot arcs across five timeline sections, managed as editable cards with selective injection — inspiration the AI can draw on, not a fixed roadmap |
| **💭 Interiority** | Generates out-of-band NPC private thoughts and a persistent hidden-intentions ledger that drives on-screen actions without leaking secrets to the narrator |

All five modules use an LLM API (OpenAI-compatible or SillyTavern Connection Manager) to analyze your RP and produce structured, validated output.

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
- **NPC Growth Profiles** — Evidence-based character profiling system that builds personality descriptions from behavioral observations, not from the existing `Personality:` line:
  - **Evidence Capture** — LLM extracts behavioral observations with **verbatim quote receipts** from recent messages. Each quote is verified against the source message (contiguous substring or bigram-overlap match with windowed neighborhood search) to reject paraphrases. Unzitatable "observations" are flagged, not silently trusted
  - **Two-Tier Evidence Store** — Observational evidence is stored append-only in chat metadata as `raw[]` observations (with category, claim, verbatim quote, and source message timestamp). A **consolidation pass** distills raw observations into higher-level `consolidated[]` claims with source back-references, moving consumed raw items to `archived[]`
  - **Anti-Textbook Profile Generation** — Synthesizes a character profile *from evidence only* — never reads prior profiles or the `Personality:` line. Only user-authored canon fields (`Canon Lock`, `Background`, `Role`, `Where to Find`) are passed as authoritative context. Profiles are saved to a separate "NPC Profiles" lorebook and never re-feed into capture (the profile is a leaf, never a root)
  - **Continuous Incremental Capture** — Watermark-gated delta capture that processes only messages newer than the last capture timestamp, preventing the token-bloat of full-window rescans. Runs automatically on message cadence for enrolled NPCs
  - **ILS Backfill** — Reads InlineSummary (ILS) original messages from chat metadata to expand summarized messages back to their verbatim originals, so evidence capture can quote real text instead of a paraphrase. Read-only — never writes to or garbage-collects ILS data, preventing chat corruption
  - **Psychoanalyze Profile** — A separate dead-end view that generates a deeper psychoanalytic portrait from evidence + the full curated lorebook entry (including `Personality:`). Safe because the output has no path back to live context — it's never injected or saved to any lorebook, available for copy/external-save only
  - **User Overrides** — Hand-edits to the profile text that survive automatic regeneration, appended as user notes below the generated profile

### 🗺️ Story Planner

Acts as a "Story Architect" that brainstorms a menu of future plot possibilities across five timeline sections. Each arc is an independently editable card with its own status, section, and pin toggle. The plan is injected into the prompt as inspiration the AI can draw on — branching possibilities, not a fixed roadmap.

- **Five Timeline Sections** — Arcs are organized by when the story can use them:
  - **Immediate Hooks** — Usable right now, could surface in the very next scene
  - **Emerging Arcs** — Threads already in motion, developing over the next few scenes
  - **Horizon Arcs** — Major structural shifts the story must build toward
  - **Character Journeys** — Per-character growth, change, or reckoning arcs
  - **Unresolved Threads** — Setup already planted that still owes a payoff
- **Arc-as-Card UI** — Each arc is an independent card with its own title, body, section dropdown, and status selector — not one flat textarea
- **Arc Status Lifecycle** — Mark arcs as **Active** (live), **Resolved** (paid off), or **Dropped** (abandoned). Dropped arcs are excluded from injection. Resolved arcs are greyed out and kept for reference but never re-suggested
- **Arc Pinning** — Pin important arcs to keep them through regeneration (unpinned arcs may be replaced when the plan refreshes)
- **Selective Injection Modes** — Choose which arcs reach the AI:
  - **All** — Every non-dropped arc
  - **Pinned** — Only arcs you've pinned
  - **Active** — Only arcs still marked active (excludes resolved)
- **Direction Hint** — A free-text field to steer the next generation (e.g. "more political intrigue," "slow down on romance," "I want a villain arc"). Saved per chat
- **Configurable Arc Count** — Set how many arcs to request per generation (3–30), from a tight focus to a sprawling menu
- **Continuity-Aware Regeneration** — The previous plan is fed back so still-relevant arcs carry forward and evolve rather than being discarded. Pinned arcs survive generation; resolved arcs suppress re-suggestion
- **Injection Preview** — Preview exactly what will be injected, showing the current injection mode, arc count, and token estimate
- **Manual Arc Addition** — Add arcs directly to any section via the `+ Add Arc` button, independent of LLM generation
- **LLM-Generated Plan** — Produces structured arcs across all five sections, parsed back into cards from the markdown output
- **User-Safe Prompting** — The system prompt strictly forbids the model from writing actions, dialogue, thoughts, or reactions for `{{user}}`
- **Auto-Generate** — Automatically refresh the plan every N messages (configurable interval, counted on AI replies)
- **Injection Toggle** — Independently control whether the plan reaches the AI (toggle injection off without deleting the plan)
- **Custom Prompts** — Override the default system and user prompts; the user prompt supports tokens: `{{chatHistory}}`, `{{worldState}}`, `{{lastChronicle}}`, `{{previousPlan}}`, `{{directionHint}}`, `{{arcCount}}`
- **Configurable Injection Depth** — Set how far from the bottom of the prompt the plan is injected
- **Cross-Module Context** — Generation reads recent chat history, current World State, latest Chronicle entry, and the previous plan to ground its suggestions
- **Legacy Migration** — Old single-blob plans are automatically parsed into arc cards on first read. The original text is preserved, so migration is recoverable
- **History & Revert** — Snapshots are taken automatically before each generate/save/clear. Browse history, diff against current, and restore any snapshot

### 💭 Interiority

Generates NPC private thoughts and a persistent **intentions ledger** in a separate, out-of-band LLM call. The narrator never sees the thoughts — only the mechanical ledger entries, which are injected back as execution demands. This prevents knowledge leaks (the thinking model physically can't leak secrets to the narration model) and gives NPCs durable hidden agendas that actually surface in their actions.

- **Out-of-Band Generation** — NPC thoughts are generated in a separate API call with restricted context, physically isolated from the narration pass
- **Persistent Intentions Ledger** — Open intentions survive any number of turns; each entry has an action, trigger condition, and in-world "since" timestamp
- **Execution Demand Injection** — When an intention's trigger is met, the ledger injects a mechanical directive (`<mwt_npc_intentions>`) that the narrator must execute on-screen
- **Batched Mode (default)** — One API call per turn covers all scene NPCs simultaneously
- **Strict Mode (optional)** — One call per NPC for true knowledge partition (NPC A's dossier secrets never co-resident with NPC B's thoughts)
- **Auto or Manual** — Generate automatically on every AI message, or trigger per-message with a 💭 button
- **Scene Roster** — Automatically detects present NPCs from the World State, with Knowledge Tracker fallback
- **Knowledge-Grounded** — Each NPC's thoughts are limited to their own Knowledge Ledger + witnessed events
- **Per-Message Display** — Thoughts render as collapsible blocks attached to individual chat messages (never in chat history)
- **Ledger Lifecycle** — Intentions are evaluated each turn: executed (done), dropped (with in-voice reason), or carried forward
- **Rollback on Swipe/Edit/Delete** — Ledger snapshots per message make it trivial to revert state when messages change
- **Manual Ledger Editing** — Add, edit, or delete intentions directly in the UI

### Shared Core

All five modules share a common infrastructure:

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
| `/wt-thoughts` | Generate Interiority for the current/last AI message |
| `/wt-inject on\|off` | Toggle injection for World State and Chronicle |

> **Note:** `/wt-inject` toggles World State and Chronicle injection only. Knowledge Tracker uses lorebook keywords (not extension prompts), and Story Planner/Interiority injection are toggled from their own Settings panels.

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
- **Collapse Mode** — Optionally collapse the floating buttons into a single hub button
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

1. **Open the MWT Modal** — Click any of the floating emoji buttons on the right side of the screen (🌍, 📜, 🧠, 🗺️, 💭, or ⚙️), or use the **MWT** entry in the wand (extensions) menu, or the drawer in the Extensions panel
2. **Configure API** — Go to the **⚙️ Settings** tab and either:
   - Select a **Connection Profile** (uses your existing SillyTavern connection), **or**
   - Enter a custom API URL, Key, and Model
3. **Save Settings** — Click **Save Settings**
4. **Start Tracking** — Switch to any module tab and click its action button:
   - 🌍 World State → **🔄 Refresh**
   - 📜 Chronicle → **📸 Snapshot**
   - 🧠 Knowledge → **🔍 Scan**
   - 🗺️ Story Planner → **🎲 Generate Plan**
   - 💭 Interiority → **💭 Generate** (or enable **Auto** to run per turn)

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

Each module tab has a **⚙ Settings** button (or expandable settings section) that opens module-specific settings, which can override the global API configuration. This lets you use different models or temperatures for different tasks (e.g., a creative model for world state, a precise model for knowledge scanning, a higher-temperature model for story planning, a small/cheap model for interiority). Use **↓ Sync to Modules** in the global Settings tab to push the global API config to all modules at once.

### Injection Settings

Control how World State, Chronicle, Story Plan, and Interiority content are injected into the prompt:

| Setting | Description | Default |
|---|---|---|
| World State Depth | How far from the bottom of the prompt to inject | `4` |
| World State Role | Message role for injection (`system`, `user`, `assistant`) | `system` |
| Chronicle Depth | Injection depth for chronicle entries | `4` |
| Chronicle Role | Message role for chronicle injection | `system` |
| Story Plan Depth | Injection depth for the story plan | `4` |
| Interiority Depth | Injection depth for NPC intentions ledger | `1` |
| Interiority Role | Message role for intentions injection | `system` |
| Structural Boundaries | Wrap injected blocks in XML tags (e.g., `<mwt_world_state>…</mwt_world_state>`) | `On` |

**Structural Boundaries** wrap each injected reference block in tags so the model clearly distinguishes sections. Recommended for smaller / open models (24–70B) that bleed between sections. Frontier models don't need it; turn it off to save a few tokens.

> **Note:** Knowledge Tracker does not use extension prompt injection — it writes directly to SillyTavern lorebooks, which are triggered by keywords. Disabling the Knowledge tracker only stops it from scanning/updating; existing lorebook entries continue to be injected by SillyTavern's World Info until you disable them manually in the World Info panel.

> **Automatic lorebook activation** *(opt-in)* — by default, SillyTavern only scans a lorebook after you switch it on yourself (global selection, the chat's bound book, or the character's books). Two toggles in **Knowledge → Settings** let MWT switch its own books on:
> - **Knowledge Tracker → this chat's World Info slot.** SillyTavern keeps exactly one bound book per chat; MWT claims the slot only when it is empty or already holds an MWT book — a book you chose yourself is never replaced. Binding re-applies automatically on page load and every chat change.
> - **State Tracker → its own activation target** (`character` by default, or `global`): the current card's *additional* World Info books (a settings-only write that leaves the card's own lorebook untouched), or the shared global selection. In group chats, or with the `chat` target, the State book is not auto-bound — the chat slot is single-entry and reserved for the Knowledge book.
>
> MWT records every World Info slot it writes (a ledger in its settings) and, when you turn a toggle off, removes **only its own entries** — books you added yourself are never touched. Changing the lorebook scope switches the old books back off and the new ones on automatically.

### Floating Buttons

The floating buttons (🌍 📜 🧠 🗺️ 💭 ⚙️) can be individually shown/hidden, repositioned (drag), collapsed into a single hub button, and styled as icon-only ("Modern") or icon+text ("Classic"). Position is persisted across sessions. You can also open the MWT modal from the wand (extensions) menu or the Extensions panel drawer.

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

**NPC Scanning & Lorebook Management:**

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

> **Seeing a `[MWT:store]` entry in your lorebook?** That's MWT's registry for that book — a disabled, keyword-less entry that costs 0 tokens and is never sent to the AI. Full explanation in [Data Storage](#the-mwtstore-entry--what-it-is-and-why-its-there).

**NPC Growth Profile:**

1. Open the **🧠 Knowledge** tab and navigate to the **Growth** sub-tab for any registered major NPC
2. Click **🔍 Capture Evidence** to extract behavioral observations with verbatim quote receipts from recent messages. Each quote is verified against its source message — unzitatable claims are flagged rather than silently trusted
3. Review the captured observations — each shows a category (trait/value/speech), the distilled claim, and the verbatim quote with its source message index
4. Click **🎲 Generate Profile** to synthesize an anti-textbook character profile from the accumulated evidence. The profile never reads the existing `Personality:` line — only user-authored canon fields (Background, Role, etc.) are passed as authoritative context
5. Review the generated profile text and click **💾 Save Profile** to persist it to the "NPC Profiles" lorebook. The profile is saved with a `profileUid` cross-reference in the NPC registry and does not feed back into future evidence capture
6. Once enrolled, an NPC is automatically captured on message cadence via **continuous incremental capture** — only new messages since the last capture are processed, avoiding token-bloat rescans
7. Use **🔄 Consolidate** to distill raw observations into higher-level consolidated claims with source back-references. Consumed raw items are archived but remain referenceable
8. Use **🔬 Psychoanalyze** to generate a deeper psychoanalytic portrait that includes the full curated lorebook entry as historical baseline. This is a dead-end view — the result is never injected or saved, only available for copy/paste
9. Hand-edit the profile text via **User Overrides** — these survive automatic regeneration and are appended below the generated profile as user notes

### Story Planner

1. Open the **🗺️ Story Planner** tab
2. Click **🎲 Generate Plan** to brainstorm a menu of future plot arcs organized across five timeline sections
3. Review the generated arcs — each appears as an independent card with its own title, body, section dropdown, and status selector
4. **Manage individual arcs:**
   - Use the **section dropdown** on any card to move an arc between sections (Immediate Hooks → Emerging Arcs → Horizon Arcs → Character Journeys → Unresolved Threads)
   - Change the **status** of any arc: **Active** (live), **Resolved** (paid off), or **Dropped** (abandoned). Dropped arcs are excluded from injection; resolved arcs are greyed out for reference
   - Click the **📌 Pin** icon to protect an arc — pinned arcs survive regeneration; unpinned arcs may be replaced
   - Edit arc titles and bodies inline — changes save automatically
5. **Add arcs manually** — Click the **+ Add Arc** button at the bottom of any section to create an arc without LLM generation
6. Choose an **Injection Mode** from the toolbar:
   - **All** — Every non-dropped arc reaches the AI
   - **Pinned** — Only arcs you've pinned
   - **Active** — Only arcs still marked active (excludes resolved)
7. Use the **💬 Direction Hint** field to steer the next generation (e.g. "more political intrigue," "slow down on romance") — saved per chat
8. Click **💾 Save** to persist the current plan to chat metadata (arcs also auto-save on change)
9. Use **📋 History** to browse automatically-taken snapshots, diff against the current plan, and restore any previous version
10. Toggle **🔌 Injection** to include the plan in the prompt as inspiration
11. Toggle **🔄 Auto** to automatically regenerate the plan every N messages
12. Expand **⚙️ Story Planner Settings** to configure arc count (3–30), injection depth, auto-generate interval, injection mode, or replace the system/user prompts

Regeneration is continuity-aware: the previous plan is fed back so still-relevant arcs carry forward and evolve rather than discarded. Pinned arcs survive generation; resolved arcs are never re-suggested. The user prompt supports the tokens `{{chatHistory}}`, `{{worldState}}`, `{{lastChronicle}}`, `{{previousPlan}}`, `{{directionHint}}`, and `{{arcCount}}` — each resolves to empty when that data isn't present. Old single-blob plans are automatically migrated to arc cards on first read, with the original text preserved for recovery.

### Interiority

1. Open the **💭 Interiority** tab to view the current intentions ledger and module settings
2. Toggle **🔌 Injection** to include the intentions ledger in every prompt
3. Toggle **🔄 Auto** to automatically generate thoughts on every AI message, or leave it off and use the **💭 Generate** button per message
4. Choose **Mode**:
   - **Batched** (default) — one API call per turn for all scene NPCs
   - **Strict** — one call per NPC for true knowledge isolation (higher cost)
5. Set **Max NPCs** (default 4) to cap how many characters are processed per turn
6. View the **Ledger** — a list of open intentions with NPC name, action, trigger condition, and in-world "since" time. Click any entry to edit or delete it
7. Click **➕ Add Intention** to manually create a new ledger entry
8. In the chat, click the 💭 icon on any AI message to expand/collapse that message's thought blocks — each NPC's private reaction and thought is displayed there
9. Thoughts are never injected into the prompt and never appear in chat history — only the flat, mechanical ledger lines reach the narrator

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
│   ├── strip.js          # Non-narrative content stripping for scanner contexts
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
├── knowledge/            # Knowledge Tracker module (NPCs + State Trackers + Growth Profile)
│   ├── index.js          # Public API barrel — lifecycle, slash commands, macros
│   ├── state.js          # Constants, shared mutable state, content helpers (leaf)
│   ├── settings.js       # Settings manager + settings panel (leaf)
│   ├── prompts.js        # NPC scan, state-update, evidence, profile, and consolidation prompts
│   ├── registry.js       # NPC + State Tracker registry operations (chat metadata)
│   ├── lorebook.js       # Lorebook read/write, scan, state update, staging enrichment, profile persistence
│   ├── staging.js        # Build staging items from scan results
│   ├── relationships.js  # Relationship storage and graph layout computation
│   ├── evidence.js       # Two-tier evidence store (raw/consolidated/archived), ILS watermark tracking, user overrides
│   ├── growth.js         # Evidence capture + quote verification, profile generation, continuous incremental capture, consolidation orchestrator
│   ├── ils_compat.js     # InlineSummary (ILS) de-summarize backfill — read-only ILS originals resolution for verbatim evidence capture
│   └── render.js         # All UI rendering (staging, minor/major, state, graph, growth, settings)
├── story_planner/        # Story Planner module (future plot arcs)
│   ├── index.js          # Thin orchestrator — public API and lifecycle hooks
│   ├── data.js           # Constants, shared mutable state, data access (leaf)
│   ├── settings.js       # Settings manager and defaults (leaf)
│   ├── prompts.js        # Story Architect system + user prompt templates (leaf)
│   ├── injection.js      # Prompt injection (depth, structural boundaries, header)
│   ├── generation.js     # LLM plan generation with chat-switch guards
│   └── render.js         # UI rendering, toolbar/stats, settings panel, event wiring
└── interiority/          # Interiority module (NPC thoughts & hidden intentions)
    ├── index.js          # Orchestrator — public API, event wiring, work queue
    ├── data.js           # Constants, chat-metadata storage, settings, ledger helpers
    ├── prompts.js        # System prompt, JSON output contract, injection format
    ├── generation.js     # Context assembly, batched/strict API calls, validation
    ├── injection.js      # <mwt_npc_intentions> extension-prompt injection
    └── render.js         # Settings UI + per-message thought block rendering
```

### Module Communication

- Modules read shared global settings (injection depth/role, structural boundaries, enable flags) via `getGlobalSettings()` and `injectionAllowed()` in `core/settings.js`; the global Settings tab pushes API config to each module through their `syncGlobalSettings()`
- The Chronicle module can sync time/location data back to World State
- The Knowledge module reads World State and Chronicle data for richer scan context
- The Story Planner reads recent chat history to ground its suggestions
- The Interiority module reads the World State for the scene roster, the Knowledge Tracker for per-NPC dossiers, and injects `<mwt_npc_intentions>` back into the prompt
- All modules respond to SillyTavern events:
  - `CHAT_CHANGED` — reset module state for the new chat
  - `MESSAGE_RECEIVED` — advance auto-refresh / auto-snapshot / auto-trigger / auto-plan / auto-thoughts counters
  - `GENERATION_STARTED` / `GENERATION_STOPPED` — gate chronicle work during main generation
  - `MESSAGE_DELETED` — decrement counters and invalidate stale chronicle anchors; Interiority restores ledger snapshots
  - `MESSAGE_SWIPED` / `MESSAGE_EDITED` — schedule world state refresh (if auto-refresh enabled), flag stale chronicle anchors, and rollback Interiority ledger state

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
- **Interiority** runs well on small/cheap models (default `0.4` temp) — the task is closer to a knowledge scan than narration, and output is validated before applying
- For models with extended thinking (e.g., DeepSeek R1, o1), the API layer automatically recovers from empty content by falling back to `reasoning_content`

---

## Theme Support

MWT supports both **dark** and **light** SillyTavern themes. CSS variables automatically adapt via theme-aware selectors. The extension matches SillyTavern's look and feel regardless of your chosen theme.

---

## Data Storage

- **Chat data** (world state text, chronicle entries, growth evidence store, story plan text, interiority ledger + per-message thoughts) is stored in SillyTavern's per-chat metadata (survives backup/restore)
- **Lorebook bookkeeping** (NPC registry, state tracker registry, relationships) lives inside the Knowledge Tracker and State Tracker lorebooks themselves, in a single disabled entry titled `[MWT:store]` — see [the section below](#the-mwtstore-entry--what-it-is-and-why-its-there) for exactly what it is and why it can never reach your prompt
- **Settings** are stored in SillyTavern's `extension_settings` (survives backup/restore) with `localStorage` fallback — validated and version-stamped as of 2.0 (a bad record repairs itself; your values are never silently deleted)
- **Knowledge Tracker history** is stored in `localStorage` keyed by lorebook UID — malformed records are filtered from the view as of 2.0 and the list heals itself on the next edit
- **Floating button positions** are stored in `localStorage` — validated as of 2.0 (an unreadable record just resets the buttons to their anchored spots)
- **NPC Growth Profile evidence** uses a two-tier append-only store in chat metadata (`raw[]` → `consolidated[]` → `archived[]`), with per-NPC watermarks for continuous incremental capture and ILS backfill. Profile text is saved to a separate "NPC Profiles" lorebook with `profileUid` cross-references in the NPC registry
- Chat data is per-chat — switching chats loads that chat's world state, chronicle, growth evidence, story plan, and interiority ledger. The Knowledge Tracker's lorebooks follow its **Scope** setting (global / per-character / per-chat), and each book carries its own registry so books never cross-contaminate

### The `[MWT:store]` entry — what it is and why it's there

If you open a Knowledge Tracker or State Tracker lorebook in the World Info editor, you'll find one entry titled:

> **[MWT:store] — extension bookkeeping (0 tokens, never sent to the AI)**

**What it is.** MWT's bookkeeping for that specific book: the registry that maps each NPC / state tracker name to its lorebook entry, plus relationship data. It's plain, readable JSON — open it and see for yourself. It never contains your API keys, your settings, or your chat log.

**Why it lives in the lorebook.** The registry has to live and die with the book it describes. Older MWT versions kept it in chat metadata, and the two could drift out of sync (a save flushing to one file but not the other), which produced duplicate NPC entries. Keeping it inside the book means the registry and the entries it points at are always written together in one file — and an exported book stays self-contained. It's a visible, plainly labeled entry *on purpose*: you should never have to wonder what an extension has hidden in your files.

**It never reaches your prompt.** Four independent locks, and it costs 0 tokens:

1. **No keywords** — SillyTavern's keyword matching can't ever select it
2. **Disabled** — the World Info scan skips disabled entries entirely
3. **Not constant, not vectorized** — the only two flags that bypass keyword matching are both off
4. **Self-repairing** — MWT re-asserts all of the above every time it saves the book, so a lossy import or an accidental edit can't silently switch it live

**If you delete it.** That book's registry resets: MWT no longer knows which entry belongs to which NPC, and the next scan may create duplicates. Delete it only if you're deliberately resetting the book.

**If you share or export a book.** The store travels with the book by design — that's what keeps a shared book working out of the box. What it carries is the same kind of chat-derived information as the visible NPC entries (names, keywords, relationship summaries) — never credentials or chat logs. If you'd rather share a clean book, just delete the `[MWT:store]` entry from the exported copy; the recipient's MWT will simply rebuild a fresh registry.

### Data safety in MWT 2.0 — validation, migrations, and quarantine, explained

MWT 2.0 adds a safety layer under everything the extension saves. Saved data is checked before it's used, chats in older formats upgrade themselves automatically the first time you open them, and a record MWT can't safely understand is set aside for recovery — preserved, reported, and exportable — instead of being skipped, mangled, or fed to the AI. A problem pauses at most one module, visibly, with a banner and a Retry; your prose and lorebook content are never touched or judged. The same checking now covers MWT's own settings and its browser-local records (floating-button positions, Knowledge edit history, and the per-message ID stamps Interiority keeps): those are validated with the same vocabulary but fail open — a problem falls back to defaults or filters the bad record, never pauses a module, and never deletes what's stored. The full plain-language guide, written for non-programmers, is in **[DATA_SAFETY_GUIDE.md](DATA_SAFETY_GUIDE.md)**.


**Credits/Inspirations:**
Id like to take a moment and thank dptgreg for inspiration and use of his Freaky Frankenstein presets. I have modified his to incorporate MWT. I would also like to thank KazumaONIISAN for the inspiration behind the Story Planner, though theirs is much more advanced than mine at this time!
---

## License

MIT — see [LICENSE](LICENSE).