# 🌍 Merged World Tracker

**A unified SillyTavern extension combining World State tracking, Session Chronicle, and NPC Knowledge management into a single modular system.**

*A SillyTavern extension by [Brasen](https://github.com/brasen56)*

---

## 📋 Table of Contents

- [Overview](#overview)
- [Features](#features)
  - [World State Tracker](#-world-state-tracker)
  - [Session Chronicle](#-session-chronicle)
  - [Knowledge Tracker](#-knowledge-tracker)
  - [Shared Core](#shared-core)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
  - [Global Settings](#global-settings)
  - [Per-Module Settings](#per-module-settings)
  - [Injection Settings](#injection-settings)
- [Usage Guide](#usage-guide)
  - [World State](#world-state)
  - [Session Chronicle](#session-chronicle)
  - [Knowledge Tracker](#knowledge-tracker)
- [Architecture](#architecture)
- [API Compatibility](#api-compatibility)
- [Theme Support](#theme-support)
- [License](#license)

---

## Overview

Merged World Tracker (MWT) is a modular SillyTavern extension that brings three powerful RP assistance tools under one roof. Each module shares a common core for API calls, diff computation, settings management, and UI — while remaining independently configurable.

Instead of juggling multiple standalone extensions, MWT provides a single tabbed interface with floating quick-access buttons, unified API settings (with per-module overrides), and cross-module integration (e.g., chronicle entries can sync time/location back to the world state).

### What It Does

| Module | Purpose |
|---|---|
| **🌍 World State** | Maintains a rolling structured document of the current scene, characters, threads, and plot seeds |
| **📜 Chronicle** | Generates timestamped summaries of RP events with consolidation, editing, and flexible injection |
| **🧠 Knowledge** | Scans for NPCs, tracks their knowledge and relationships, and manages state entries via lorebooks |

All three modules use an LLM API (OpenAI-compatible) to analyze your RP and produce structured, validated output.

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
  - Plot Seeds (with passive/proactive/assertive hook modes)
  - Potential Entrances
- **Plot Seed Hook Modes** — Control how aggressively the LLM introduces narrative hooks:
  - **Passive** — Hooks are available but the LLM decides when to use them
  - **Proactive** — The LLM is encouraged to introduce hooks organically
  - **Assertive** — The LLM is directed to introduce at least one hook per response
- **Manual Editing** — Edit the world state directly in a text editor
- **Auto-Save History** — Periodic snapshots with diff-based revert
- **Import/Export** — JSON archives and plain text/markdown import
- **Message Filtering** — Regex-based filters to strip unwanted content before scanning
- **Prompt Injection** — Configurable depth and role for prompt injection

### 📜 Session Chronicle

Generates timestamped chronicle entries that summarize what happened in the RP, creating a durable historical record that can be injected into future prompts for long-term continuity.

- **LLM-Generated Snapshots** — Produces structured entries with Summary, Relationship Shifts, Open Loops, and Time Anchors
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
- **Notification Panel** — Floating, draggable notification panel alerts you to new scan results
- **Auto-Trigger** — Automatically run scans every N messages
- **Import from Lorebook** — Scan existing Knowledge Tracker and State Tracker lorebooks to register entries not yet tracked
- **Cross-Module Integration** — Scans include current World State and latest Chronicle entry for richer context

### Shared Core

All three modules share a common infrastructure:

- **Unified API Layer** — OpenAI-compatible API with retry logic, error recovery, and custom headers support
- **Settings Management** — Global defaults with per-module overrides; settings stored in SillyTavern's `extension_settings` with localStorage fallback and legacy key migration
- **Diff Engine** — LCS-based line and word-level diff computation with customizable HTML rendering
- **Modal System** — Shared modal lifecycle (create, show, hide, status bar) with escape-key and backdrop-click handling
- **Context Helpers** — Safe access to SillyTavern context, chat data, metadata, token estimation, and player name resolution
- **Sync to Modules** — Push global API settings to all modules at once

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

1. **Open the MWT Modal** — Click any of the floating emoji buttons on the right side of the screen (🌍, 📜, 🧠, or ⚙️)
2. **Configure API** — Go to the **⚙️ Settings** tab and enter your:
   - API URL (e.g., `https://api.openai.com/v1`)
   - API Key
   - Model name (e.g., `gpt-4o-mini`)
3. **Save Settings** — Click **Save Settings**
4. **Start Tracking** — Switch to any module tab and click its action button:
   - 🌍 World State → **Refresh**
   - 📜 Chronicle → **Generate Snapshot**
   - 🧠 Knowledge → **🔍 Scan**

---

## Configuration

### Global Settings

Configured in the **⚙️ Settings** tab. These serve as defaults for all modules.

| Setting | Description | Default |
|---|---|---|
| API URL | Base URL for OpenAI-compatible API | *(empty)* |
| API Key | Bearer token for API authentication | *(empty)* |
| Model | Model identifier (e.g., `gpt-4o-mini`) | *(empty)* |
| Max Tokens | Maximum tokens in LLM response | `2000` |
| Temperature | Sampling temperature (0–2) | `0.3` |
| Top P | Nucleus sampling threshold | `1.0` |
| Frequency Penalty | Penalize frequent tokens (-2 to 2) | `0` |
| Presence Penalty | Penalize present tokens (-2 to 2) | `0` |
| Custom Headers | Additional HTTP headers (JSON) | *(empty)* |

### Per-Module Settings

Each module tab has a **⚙ Settings** button that opens module-specific settings, which can override the global API configuration. This lets you use different models or temperatures for different tasks (e.g., a creative model for world state, a precise model for knowledge scanning).

### Injection Settings

Control how World State and Chronicle entries are injected into the prompt:

| Setting | Description | Default |
|---|---|---|
| World State Depth | How far from the bottom of the prompt to inject | `4` |
| World State Role | Message role for injection (`system`, `user`, `assistant`) | `system` |
| Chronicle Depth | Injection depth for chronicle entries | `4` |
| Chronicle Role | Message role for chronicle injection | `system` |

> **Note:** Knowledge Tracker does not use extension prompt injection — it writes directly to SillyTavern lorebooks, which are triggered by keywords. Disabling the Knowledge tracker only stops it from scanning/updating; existing lorebook entries continue to be injected by SillyTavern's World Info until you disable them manually in the World Info panel.

---

## Usage Guide

### World State

1. Open the **🌍 World State** tab
2. Click **🔄 Refresh** to generate a world state from recent messages
3. Review the generated document in the editor
4. Edit manually if needed — changes auto-save to chat metadata
5. Toggle **🔌 Injection** to include the world state in every prompt
6. Toggle **🔄 Auto** to automatically refresh every N messages
7. Use **Section Regenerate** buttons (▸ icons next to section headers) to refresh individual sections
8. Use **↩ Revert** to restore a previous version from auto-save history

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
6. **State Trackers** tab shows registered state tracker entries that can be updated via LLM
7. Enable **Auto-Trigger** in module settings to run scans automatically every N messages

---

## Architecture

```
merged_world_tracker/
├── index.js              # Main entry point — tabbed UI, event hooks, floating buttons
├── manifest.json         # SillyTavern extension manifest
├── style.css             # All styles (dark + light theme support)
├── core/
│   ├── index.js          # Barrel re-exports for all core modules
│   ├── api.js            # Shared OpenAI-compatible API client with retry
│   ├── context.js        # SillyTavern context, chat, metadata, token helpers
│   ├── diff.js           # LCS line/word diff computation and HTML rendering
│   ├── modal.js          # Modal lifecycle, status bar, button bar helpers
│   └── settings.js       # Settings manager factory (extension_settings + localStorage)
├── world_state/
│   └── index.js          # World State Tracker module
├── chronicle/
│   └── index.js          # Session Chronicle module
└── knowledge/
    └── index.js          # Knowledge Tracker module (NPCs + State Trackers)
```

### Module Communication

- Modules read shared global settings (injection depth/role) via `getGlobalSettings()` in `core/settings.js`; the global Settings tab pushes API config to each module through their `syncGlobalSettings()`
- The Chronicle module can sync time/location data back to World State
- The Knowledge module reads World State and Chronicle data for richer scan context
- All modules respond to SillyTavern events (`CHAT_CHANGED`, `MESSAGE_RECEIVED`, `GENERATION_STARTED`, `GENERATION_STOPPED`)

---

## API Compatibility

MWT works with any **OpenAI-compatible** chat completions API. Tested with:

- OpenAI (`gpt-4o-mini`, `gpt-4o`, etc.)
- Anthropic via OpenAI-compatible proxies
- DeepSeek
- Local models via LM Studio, Ollama, text-generation-webui, etc.
- Any API that implements the `/chat/completions` endpoint

### Tips for Best Results

- **World State** works best with models ≥ 8K context and strong instruction following
- **Chronicle** benefits from higher `maxTokens` (8000+) to allow detailed entries
- **Knowledge** scans work well with lower temperatures (0.1–0.3) for consistent JSON output
- For models with extended thinking (e.g., DeepSeek R1, o1), the API layer automatically recovers from empty content by falling back to `reasoning_content`

---

## Theme Support

MWT supports both **dark** and **light** SillyTavern themes. CSS variables automatically adapt via theme-aware selectors. The extension matches SillyTavern's look and feel regardless of your chosen theme.

---

## File Structure Notes

- **Chat data** is stored in SillyTavern's per-chat metadata (survives backup/restore)
- **Settings** are stored in SillyTavern's `extension_settings` (survives backup/restore) with `localStorage` fallback
- **Knowledge Tracker history** is stored in `localStorage` keyed by lorebook UID
- All data is per-chat — switching chats loads that chat's world state, chronicle, and NPC registry

---

## License

This project is provided as-is for use with SillyTavern. See the repository for license details.