# 📖 Merged World Tracker — User Guide

The full reference for every MWT module and shared feature: what each one does, how to use it, and every setting with its default. New here? Start with [SETUP_GUIDE.md](SETUP_GUIDE.md) — it gets you from install to a working setup in a few minutes. The [README](README.md) has the short version of everything.

**Contents**

- [How MWT settings are organized](#how-mwt-settings-are-organized)
- [Modules](#modules)
  - [🌍 World State](#-world-state)
  - [📜 Chronicle](#-chronicle)
  - [🧠 Knowledge](#-knowledge)
  - [🗺️ Story Planner](#-story-planner)
  - [💭 Interiority](#-interiority)
  - [🌦️ Ambient Conditions](#-ambient-conditions)
  - [📅 Calendar](#-calendar)
- [Shared Surfaces](#shared-surfaces)
  - [Shared Core](#shared-core)
  - [🏠 Overview](#-overview)
  - [🩺 Diagnostics](#-diagnostics)
  - [📊 Budget](#-budget)
  - [Slash Commands & Macros](#slash-commands--macros)
- [Configuration](#configuration)
  - [Connection Profiles](#connection-profiles-recommended)
  - [Custom API Settings](#custom-api-settings)
  - [Per-Module API Overrides](#per-module-api-overrides)
  - [Injection Settings](#injection-settings)
  - [Floating Buttons](#floating-buttons)
  - [Per-Tracker Enable & Panic Switch](#per-tracker-enable--panic-switch)
  - [Theme, Mobile & Touch](#theme-mobile--touch)
- [API Compatibility](#api-compatibility)
- [Data Storage](#data-storage)
- [♿ Accessibility](#-accessibility)

---

## How MWT settings are organized

- **Global settings** live in the **⚙️ Settings** tab: API connection, injection depths and roles, floating buttons, per-tracker enables, and the panic switch.
- **Per-module settings** open from a **⚙ Settings** button inside each module tab. Every module can override the global API configuration (different model, temperature, max tokens per task).
- **Per-chat behavior** — World State and Story Planner resolve a few behavior toggles (injection on/off, auto-refresh and its interval, and the Planner's injection mode / arc count / auto interval) through a per-chat override that falls back to the global values. Chronicle's injection settings (on/off, mode, entry count) belong to each chat, and injection starts **off** in every new chat. Ambient Conditions, the Calendar, and Budget caps are entirely per-chat.
- **Knowledge lorebook scope** (global / per-character / per-chat) decides which lorebooks the Knowledge module writes to; each book carries its own registry.

Nothing here is exotic: every setting is just a checkbox, dropdown, or number field, every default is stated where it matters, and the [🩺 Diagnostics](#-diagnostics) tab always shows you the *effective* value and where it came from.

---

## Modules

### 🌍 World State

Maintains a live, structured document describing the current state of the roleplay world. It is injected into the prompt to give the LLM consistent context about what's true right now.

**Features**

- **LLM-Powered Refresh** — Generates a full world state document from recent messages using a carefully tuned system prompt
- **Auto-Refresh** — Automatically re-scans every N messages (configurable interval)
- **Reliable Current Scene** — Validates the shared `Current Scene` contract (Date, Time, Location, Present, and Situation), preserves unchanged established details, normalizes the Present roster, and keeps the saved document human-readable
- **Per-Section Regeneration** — Regenerate individual sections (e.g., just "Plot Seeds" or "Key Character States") without refreshing the entire document
- **⚡ Delta Refresh (Low-Cost Mode)** — Instead of regenerating the whole document, a delta refresh asks the model only for the sections that changed and applies a strictly validated patch protocol (`### UPDATE:` / `### REMOVE:` / `### NO CHANGES` — malformed patches are rejected, never half-applied). Off by default; turn it on in World State settings to use it for the scheduled auto-refresh, or run it on demand with the **⚡ Delta** button. A full refresh still runs when there is no baseline document, after manual edits, and on a configurable reconciliation cadence (default: every 5 consecutive partial updates)
- **Document Status Chip** — A live chip above the editor says where the document stands: 🟢 **Fully reconciled** (last full refresh), 🟡 **Delta ×N** (N partial updates since the last full refresh), ✏️ **Manually edited** (edited or imported since the last refresh, not yet LLM-reconciled), or 🔴 **Stale · N msgs** (N messages since the last refresh of any kind; threshold configurable, default 15)
- **Continuity-Safe Chronicle Sync** — Chronicle time and location anchors are range-, revision-, and chronology-checked before they can update the current scene. Older entries cannot overwrite newer World State evidence, and a sync waits safely for an active World State operation to finish
- **Compact, Separate Prompt Views** — The saved document remains a complete continuity record, while prompt consumers receive factual and hook-aware projections. Hook mode affects both generation and injection; `Archive (Stale)` stays saved for reference but is not injected
- **Injection Diagnostics** — Diagnostics → Injection breaks World State usage down by semantic section, factual versus hook totals, omissions, and the final post-Budget payload, using the same projection as live injection and Preview
- **Variety Control** — Adjust regeneration variety from *Conservative* (1) to *Chaotic* (5) for creative exploration
- **Manual Editing & History** — Edit the document directly; auto-save snapshots with diff-based revert (**⏪ Revert** / **📋 History**)
- **Import/Export** — JSON archives and plain text/markdown import
- **Message Filtering** — Regex-based filters to strip unwanted content before scanning
- **Prompt Injection** — Configurable depth and role, with **📄 Preview Injection** showing exactly what will be injected, headers and tags included
- **Structured Sections** — Current Scene (date, time, present characters, situation), Recent Changes, Off-Screen characters, Pending obligations, Active & Unresolved Threads, World Pressures, Key Character States, Story Momentum, Plot Seeds, Potential Entrances

**Using it**

1. Open the **🌍 World State** tab
2. Click **🔄 Refresh** to generate a world state from recent messages
3. Review the generated document in the editor
4. Edit manually if needed — click **💾 Save** to persist changes to chat metadata
5. Toggle **🔌 Injection** to include the world state in every prompt
6. Toggle **🔄 Auto** to automatically refresh every N messages
7. Use **Section Regenerate** (select a section, set variety, click **🎲 Regenerate Section**) to refresh individual sections
8. Use **⚡ Delta** for a cheap incremental update — the model is asked only for changed sections and returns a validated patch. It needs an existing document as the baseline (the button is disabled without one); on a malformed patch it fails safe and suggests a full 🔄 Refresh instead
9. Watch the **document status chip** (🟢 reconciled / 🟡 delta / ✏️ manual / 🔴 stale) — hover it for the exact message counts and delta tally behind the status
10. Use **⏪ Revert** to restore a previous version from auto-save history, or **📋 History** to browse all snapshots
11. Use **📄 Preview Injection** to see exactly what will be injected

#### Choosing Full vs. Delta Auto-Refresh

**Full refresh** rebuilds the whole document from the scan window. Use it for the first document, after substantial manual changes, or whenever you want a complete reconciliation. **Delta refresh** sends the existing document as a baseline and asks the model for only the sections that changed; MWT validates and applies that patch, leaving unmentioned sections intact. It is best for normal, incremental roleplay and usually costs less.

Enabling **Delta Mode** changes the *kind* of scheduled refresh, not its timing. If Auto-Refresh is currently every **10 messages**, keep it at **10** when you first switch on Delta Mode. The first eligible scheduled run uses delta; MWT automatically uses a full refresh instead when it needs a clean baseline: the first generation, an imported or manually edited document, after a rejected delta patch, and after the reconciliation cadence.

The two Delta Refresh defaults are separate from Auto-Refresh:

| Setting | Default | What it does | Recommended starting point |
|---|---:|---|---|
| **Auto-Refresh every N messages** | `5` | Sets how often a scheduled refresh attempt occurs | Keep your existing `10`; lower it only if you want the World State to follow faster scene changes more closely |
| **Full Refresh Every** | `5` delta/section updates | Forces the *next scheduled* update to be a full reconciliation after that many consecutive partial updates | Keep `5` |
| **Stale After** | `15` messages | Changes only when the status chip says the document is stale; it does **not** trigger a refresh | Keep `15`, or raise it if a 10-message cadence makes the warning noisier than useful |

For example, with Auto-Refresh set to `10` and Full Refresh Every set to `5`, MWT normally makes up to five scheduled delta updates at 10-message intervals, then makes the following scheduled update a full refresh. Manual section regenerations also count as partial updates toward that same reconciliation counter. The `15`-message stale threshold is only an attention signal: it does not cause an API call or override the 10-message schedule. Delta Mode remains opt-in while its long-term default is evaluated from real-use reliability and cost measurements.

### 📜 Chronicle

Generates timestamped chronicle entries that summarize what happened in the RP, creating a durable historical record that can be injected into future prompts for long-term continuity.

**Features**

- **LLM-Generated Snapshots** — Produces structured entries with Summary, Relationship & Institutional Shifts, Open Loops Created, Open Loops Closed, and Time Anchors
- **Manual Entries** — Create blank entries with the standard format for hand-written notes
- **Consolidation** — Merge multiple entries into one, with a preview/editor for the input before consolidation. Optionally **designate a base entry** (the foundation) with ★ — useful for merging fresh entries into an already-consolidated entry where the consolidated entry should be the base and the others the deltas
- **Regeneration with Diff** — Regenerate any entry and compare the original vs. new version side-by-side with inline word-level diff highlighting
- **Entry Editor** — Full text editor for any entry with save, regenerate, and delete
- **Trash & Restore** — Deleted entries go to a trash bin (up to 50) and can be restored
- **Flexible Injection Modes** — **Recent** (last N entries), **Selected** (specific entries), **All**, or **Range** (date range)
- **Auto-Snapshot** — Automatically generates and saves a new entry every N messages (default 40, off by default). You can open, edit, regenerate, or delete it afterwards like any other entry
- **World State Sync** — Chronicle entries automatically sync time and location data back to the World State (range-, revision-, and chronology-checked — see World State above)
- **Character Extraction** — Automatically identifies NPCs mentioned in each entry
- **Search & Statistics** — Filter entries by text; token estimates, entry counts, character frequency
- **Export/Import** — JSON and Markdown export, with merge-based import

**Using it**

1. Open the **📜 Chronicle** tab
2. Click **Generate Entry** to generate a chronicle entry from messages since the last snapshot
3. Review the entry — click it to expand and edit
4. Use **Consolidate** mode to merge multiple entries into one summary:
   - Click **Consolidate** to enter selection mode
   - Check the entries you want to merge (2+ required)
   - Optionally click **☆ Set as Base** on one entry to designate it as the foundation — the others become deltas applied on top of it. This is useful when consolidating fresh entries into an already-consolidated entry where the consolidated one should be the base
   - Click **Consolidate N entries** to proceed
5. Click **📤 Injection OFF** so it reads **📥 Injection ON** to include chronicle entries in the prompt. Injection is **off by default and set per chat**, and the button appears once the chat has at least one entry
6. Configure injection mode via the **⚙ Injection Settings** gear button: **Recent** (default: 2), **Selected**, **All**, or **Range**
7. Export as JSON or Markdown for backup or external use

### 🧠 Knowledge

Scans your RP for NPCs, classifies them, tracks their knowledge and relationships, and writes entries directly into SillyTavern lorebooks for automatic keyword-triggered injection.

**Features**

- **NPC Scanning** — LLM-powered scan of recent messages to detect new and updated NPCs
- **Minor vs. Major Classification** — **Minor NPCs** are background characters with basic info (species, descriptor, tone, first seen); **Major NPCs** are named characters with a full Knowledge Ledger tracking what they know and how they learned it
- **Staging System** — All scan proposals go to a staging area where you can review, edit, accept, or dismiss them; updates to existing NPCs show a line-level **inline diff** of changes before you accept
- **Lorebook Integration** — Accepted entries are written directly to a dedicated "Knowledge Tracker" lorebook
- **State Trackers** — Register special lorebook entries as state trackers that can be automatically updated by the LLM based on recent messages
- **NPC Promotion/Demotion & Merging** — Promote minor NPCs to major (adds Knowledge Ledger), demote major to minor, merge duplicate NPC entries
- **✍️ Manual Entry Editing** *(v2.16.0)* — Fix a tracked NPC's entry right where you read it: on the Minor and Major sub-tabs, **View** has an explicit **Edit** mode with a body editor, a trigger-keywords field, and a **Restore previous version** action. Saves go through the same guarded write path as the module's own cleanups: if the entry changed since you opened it (a background scan, another tab, an edit in SillyTavern's World Info editor), the save is refused and your draft is kept. The previous text is snapshotted before every change, format warnings are advisory (only an empty entry is blocked), and keywords fixed here are the ones that last — MWT's next write overwrites keyword edits made in SillyTavern's editor. State Tracker entries and NPC profiles stay read-only. No model calls
- **📋 Dossier Mode** *(Knowledge settings, off by default)* — Scans produce richer major-NPC entries: Role, Where to Find, Appearance, Voice, Background, Personality, Read on PC, Current Agenda, Secrets, and a Canon Lock for fields you hand-curate
- **🎯 Per-Field Dossier Refresh** — Major NPCs in Dossier Mode have a **🎯 Fields** button that opens a per-field picker showing each section's current value and a staleness chip (a per-field watermark tracks when it was last examined; a field counts as stale after 30 messages). **Select stale** bulk-checks everything stale; **Refresh selected** asks the model to re-derive *only* the chosen fields — everything else is preserved verbatim, Canon-Locked fields are skipped, and the merged result goes through the normal staging review
- **🧹 Ledger Condense Review** — Every non-orphan NPC card has a **🧹 Condense** button that opens a consent-first cleanup for oversized Knowledge Ledgers: the resolved model and payload size are disclosed up front (with a consent gate before anything is sent), then a reviewed proposal shows each condensed record beside its expandable exact original for per-record editing. Every original stays represented until you explicitly remove it — removals require a reason, the model's pruning suggestions stay advisory, size deltas are labeled estimates — and Apply is a separate two-step confirm backed by span-aware undo and a recovery manager (list / restore / export / import / delete)
- **Concision that never runs itself** — Neither cleanup path triggers automatically, on upgrade, or when an entry crosses a size threshold; the ledger review sends only the ledger and minimal identity context to the model, never the whole chat. Ordinary generation follows field-shape discipline so ledgers stop ballooning in the first place
- **Relationship Tracking** — Define and track relationships between NPCs (ally, enemy, friend, rival, family, etc.), with a **visual force-directed graph view** (color-coded types, draggable nodes, pan/zoom, list-view toggle)
- **🕘 Relationship Recent Changes** — Automatic extraction and manual edits alike are logged to a session-scoped Recent Changes panel on the Relationships tab (newest first, 🤖 auto / ✍️ you origin badges, ages, clear log). The completion toast names *who* changed and *to what*, not just counts
- **Notification Panel** — Floating, draggable notification panel alerts you to new scan results
- **Auto-Trigger** — Automatically run state tracker scans every N messages (with cooldown to avoid re-updating recently changed trackers)
- **Import from Lorebook** — Scan existing Knowledge Tracker and State Tracker lorebooks to register entries not yet tracked
- **Cross-Module Integration** — Scans include current World State and latest Chronicle entry for richer context

**Using it — scanning & lorebook management**

1. Open the **🧠 Knowledge** tab
2. Click **🔍 Scan** to analyze recent messages for NPCs
3. Review proposals in the **Staging** tab: click a proposal to see details and diff, edit the proposed content in the textarea, **✓ Accept & Write** to create/update the lorebook entry, or **✗ Dismiss** to discard
4. View tracked NPCs in the **Minor** and **Major** tabs; click any NPC to view their lorebook entry, manage relationships, or promote/demote. To correct an entry by hand, open **View** and switch to **Edit**. **Restore previous version** loads the last different text as an unsaved draft, so nothing changes until you save
5. Major NPCs in **Dossier Mode** have a **🎯 Fields** button — pick individual stale fields, **Select stale** checks them all, and **Refresh selected** re-derives only those fields (staged for review like any scan)
6. The **Relationships** tab has the graph view (default) and a list view — toggle with the Graph/List button. Drag nodes, scroll to zoom, and click a node to open that NPC. The 🕘 **Recent Changes** collapsible logs every relationship mutation this session
7. The **State Trackers** tab shows registered state tracker entries that can be updated via LLM
8. Enable **Auto-Trigger** in module settings to run state tracker scans automatically every N messages (with cooldown)
9. When a ledger has grown unwieldy, use the **🧹 Condense** button on that NPC's card — the consent-first, reviewed condensation workflow above. It only ever runs when you ask for it

> **Seeing a `[MWT:store]` entry in your lorebook?** That's MWT's registry for that book — a disabled, keyword-less entry that costs 0 tokens and is never sent to the AI. Full explanation in [Data Storage](#the-mwtstore-entry--what-it-is-and-why-its-there).

**Using it — NPC Growth Profiles**

Evidence-based character profiling that builds personality descriptions from behavioral observations, not from the existing `Personality:` line.

1. Open the **🧠 Knowledge** tab and navigate to the **Growth** sub-tab for any registered major NPC
2. Click **🔍 Capture Evidence** to extract behavioral observations with verbatim quote receipts from recent messages. Each quote is verified against the source message (contiguous substring or bigram-overlap match) — paraphrases are rejected and unverifiable "observations" are flagged, not silently trusted
3. Review the captured observations — each shows a category (trait/value/speech), the distilled claim, and the verbatim quote with its source message index
4. Click **🎲 Generate Profile** to synthesize an anti-textbook character profile from evidence only. The profile never reads the existing `Personality:` line or prior profiles — only user-authored canon fields (Background, Role, etc.) are passed as authoritative context. Profiles are saved to a separate "NPC Profiles" lorebook and never feed back into capture (the profile is a leaf, never a root); since v2.17.0, capture never sees the dossier's identity lines (`Personality:`, `Voice:`, `Tone:`, `Perceived as:`) either, so approved text can't loop back into evidence and confirm itself
5. Review the generated profile text and click **💾 Save Profile** — the profile is saved with a `profileUid` cross-reference in the NPC registry
6. Once enrolled, an NPC is automatically captured on message cadence via **continuous incremental capture** — only new messages since the last capture watermark are processed, avoiding token-bloat rescans
7. Use **🔄 Consolidate** to distill raw observations into higher-level consolidated claims with source back-references. Consumed raw items are archived but remain referenceable
8. Use **🔬 Psychoanalyze** to generate a deeper psychoanalytic portrait from evidence plus the full curated lorebook entry. This is a dead-end view — the result is never injected or saved, only available for copy/external-save
9. Hand-edit the profile text via **User Overrides** — these survive automatic regeneration and are appended below the generated profile as user notes
10. **Growth-written dossier lines** *(v2.17.0, opt-in per NPC)* — to let approved growth write that NPC's `Personality:` and `Voice:` lines, tick **Use Growth in dossier** (it also lives on the NPC card), optionally raise the **Personality limit** / **Voice limit** beside it (defaults 450/350, up to 1,500/1,000, with a token estimate), then press **Prepare dossier lines — model call**. One explicit, disclosed call turns the saved profile into proposed one-line text — the profile itself is never injected. Nothing is written yet, and an NPC whose switch stays untouched behaves exactly as before
11. Review the Growth proposal in **Staging**: sentence-level add/edit/keep/remove actions with evidence links, "no evidence" labels for pre-Growth and hand-edited text, and an advisory echo warning when all of a sentence's supporting evidence comes from messages written after its first approval (backfilling older scenes never trips it). **✓ Accept & Write** makes the approved text the field text — so it reaches the RP prompt — and records it in the Growth window's **Approval history** (last 10 approvals, newest first). While the switch is on, scans leave both lines to Growth while still updating every other field and the Ledger; turning it off keeps the approved text and hands both lines back to scans from the next scan on

### 🗺️ Story Planner

Acts as a "Story Architect" that brainstorms a menu of future plot possibilities across five timeline sections. Each arc is an independently editable card with stable setup-beat progress, lifecycle controls, and selective injection. The plan is inspiration the narrator can draw on — branching possibilities, not a fixed roadmap. Generation is scoped: ask for ideas only in the sections you chose, for the characters you chose, under an explicit cast policy — and, when you opt in, plan with what only the author knows.

**Features**

- **Five Timeline Sections** — Arcs are organized by when the story can use them: **Immediate Hooks** (usable right now), **Emerging Arcs** (developing over the next few scenes), **Horizon Arcs** (major structural shifts the story must build toward), **Character Journeys** (per-character growth, change, or reckoning), and **Unresolved Threads** (setup already planted that still owes a payoff)
- **Arc-as-Card UI** — Each arc is an independent card with its own title, body, section dropdown, and status selector — not one flat textarea. **+ Add Arc** creates one manually at the bottom of any section
- **Setup Beat Workflow** — Long-range arcs carry stable beat records. **Planted** means the event happened and counts toward readiness; **Skipped** records a route change without pretending it happened. The narrator sees only the current pending beat. When no pending beats remain, the arc is **Ready** for payoff
- **Arc Lifecycle** — **Active** arcs can inject and age. **Parked** arcs are retained but do not inject, age, or remind until resumed. **Resolved** and **Dropped** arcs move to the Archive and remain durable closed memory; exact-title recurrences are suppressed. **Delete** is the explicit forget action
- **Pin, Focus, and Park are independent** — **Pin** protects an arc through full regeneration; **Focus** spotlights it, sorts it first, and includes it in Focused-only injection; **Park** shelves it without discarding its history
- **Selective Injection Modes** — **All active**, **Pinned only**, or **Focused only**. Parked, Resolved, and Dropped records never enter narrator injection, and injection can be toggled independently from storage
- **Direction Hint** — A free-text field to steer the next generation (e.g., "more political intrigue," "slow down on romance," "I want a villain arc"). Saved per chat
- **Configurable Arc Count** — Set how many arcs to request per full-plan generation (3–30); a scoped Add request can ask for as few as one
- **Scoped Add/Refresh** — The **🎲 Generate Plan** dialog sends only what you asked for: choose **Add ideas** or **Refresh selected arcs**, check just the sections to touch (everything else is carried forward unchanged), set a requested count (1–30) for Add, or pick the exact active arcs to refresh. Review shows how many arcs are new, refreshed, and carried forward — nothing is saved until you choose **Apply changes**
- **Journey Subjects & Stable Ownership** — Character Journeys can be planned for **any tracked character** or a **selected** list (up to 30 candidates). Each journey carries a **primary subject** (its owner) and optional **supporting participants**; ownership survives Knowledge rename/merge and is never guessed from prose — only you can assign or change it
- **Cast Policy** — Three explicit policies: **Established cast only** (the model may not introduce new characters), **New characters allowed**, or **Actively propose new characters** (an Add request must include a newcomer arc with a concrete on-screen entrance beat). Proposed newcomers stay hypothetical until the story itself establishes them. Manual scoped requests pick their policy in the dialog; the Story Palette policy governs legacy full-plan, targeted, and automatic generation
- **World-Pressure Planning Lens** — Scoped **Add** requests can choose a *Planning lens*: **Open brainstorm** (the default) or **World complications**. The complications lens asks the setting itself to act on the story — weather and seasons, scarcity and supply, infrastructure and utilities, money and markets, law and institutions, illness, public mood — instead of another character's scheme. Developments may be adverse, beneficial, or mixed; Character Journeys can take their pressure from the complication. Refresh ignores the Add-only lens, so existing premises are never silently rewritten. With Ambient Conditions enabled, the lens defers weather ownership to that module
- **Opt-in Private Author Context** — Plan with what only the author knows. A collapsed per-chat picker in the Generate dialog offers major-NPC dossier field groups — public profile, agenda, secrets, Knowledge Ledger, read on PC, and Canon Lock — chosen per NPC (up to 24), with the consent stated plainly: selected private fields are **sent to the configured planning model**. A **private author-context budget** (Standard 12,000 / Expanded 24,000 / Large 48,000 characters, saved per chat) caps this additional planning context — not the model's whole context window — and a pre-generation coverage preview reports exactly how many ledger entries each NPC would contribute before anything is sent. Private context rides only reviewed scoped requests, is budgeted to whole records (never clipped mid-entry), fails closed when a dossier cannot be read exactly, keeps Canon Lock's refusal when it cannot fit, and the review banner plus per-arc author editor let you scrub every narrator-facing field before Apply
- **Story-Quality Prompts** — Each arc is asked for what it wants or unsettles, what puts it under pressure, and the concrete turning point it builds toward; every setup beat must change the situation, and the turning point stays out of the beats so a **Ready** arc still has a payoff to deliver. Quiet arcs may turn on an admission, a boundary, or a changed relationship instead of escalation
- **Targeted Arc Development** — Rework remaining setup, develop one arc, suggest an alternate route, or generate setup beats through a reviewable proposal that touches only the selected arc after scope/revision checks
- **Evidence-Backed Progress Review** — **Check progress** scans bounded settled history and proposes only quote-verified beat/resolution changes. Suggestions remain transient until accepted or ignored; no automatic progress-check cadence is enabled
- **Creative Controls** — Per-chat emphasis chips, restrained/balanced/escalating preference, the Story Palette cast policy, Direction Hint, and opt-in public **Safe Character Context** (off, active cast, or selected characters) shared by full and targeted generation
- **Continuity-Aware Regeneration** — Active arcs use request-local identity handles and stable beat IDs; planted/skipped history cannot transfer to rewritten beats. Pinned/in-progress arcs survive omission, parked/closed records remain durable, and exact closed-title recurrence is suppressed
- **User-Safe Prompting** — The system prompt strictly forbids the model from writing actions, dialogue, thoughts, or reactions for `{{user}}`
- **Custom Prompts** — Override the default full-plan system and user prompts; the user prompt supports `{{chatHistory}}`, `{{worldState}}`, `{{lastChronicle}}`, `{{previousPlan}}`, `{{directionHint}}`, `{{storyPalette}}`, `{{safeCharacterContext}}`, and `{{arcCount}}`. Custom templates replace the full-plan prompts only — targeted, scoped Add/Refresh, and progress-check prompts keep their fixed safety contracts
- **Auto-Generate** — Automatically refresh the plan every N messages (configurable interval, counted on AI replies; always regenerates the whole plan and saves without review)
- **Diagnostics & History** — Injection diagnostics show focused/pinned/Ready selection, parked/closed/mode omissions, and the exact post-Budget payload. Snapshots are taken automatically before each generate/save/clear — browse, diff, restore. Old single-blob plans migrate into arc cards automatically with the source text preserved

**Using it**

1. Open the **🗺️ Story Planner** tab
2. Click **🎲 Generate Plan** to open the scoped generation dialog:
   - Choose **Add ideas** or **Refresh selected arcs**, and check only the sections to touch — unchecked sections are carried forward unchanged
   - Set a **requested count** (1–30) for Add, or pick the exact active arcs to refresh (a Character Journey arc needs an assigned, available primary subject first)
   - Pick this request's **cast policy** — *Established cast only*, *New characters allowed*, or *Actively propose new characters*
   - For **Add ideas**, optionally pick a **Planning lens** — *Open brainstorm* (default) or *World complications*
   - With Character Journeys checked, choose **Any tracked character** or **Selected characters** as the journey subjects
   - Optionally expand **Opt-in private NPC author context (this chat)** to plan with private major-NPC dossier fields (see the feature list above). Left collapsed, the request carries public context only
   - Prefer the classic full rebuild? Use **Regenerate the whole plan** — it follows the Story Palette cast policy and honors custom templates
3. Review the scoped proposal before anything is saved. Each row shows its diff; new arcs list their primary subject and supporting participants; coverage, cast-policy, and newcomer diagnostics explain what came back. When private author context was used, edit every narrator-facing title, premise, beat, and payoff in the author editor first. Uncheck rows you don't want, then **Apply changes** or **Discard**
4. Review the arcs — each appears as an independent card with title, endpoint, section, lifecycle, Pin, Focus, Park/Resume, and a collapsible setup-beat editor
5. **Manage individual arcs:**
   - Use the **section dropdown** on any card to move an arc between sections
   - **Pin** protects an arc through full regeneration; **Focus** spotlights it and powers Focused-only injection; **Park** shelves it without injection, aging, or reminders
   - Character Journey cards carry a **Journey ownership** editor — assign or change the primary subject and supporting participants; ownership never changes through generation
   - Mark a beat **Planted** only when it happened. Use **Skip** when the route changed; skipped beats remain historical but do not count as planted
   - **Ready** means setup is complete but the arc is still active. Mark it **Resolved** only after the payoff happens; use **Dropped** for a rejected direction
   - Resolved/Dropped arcs remain in **Archive** as closed memory. **Delete** explicitly forgets the record and allows the idea to be proposed again
   - Edit arc titles and bodies inline — changes save automatically
6. Use a card's development menu to **Rework remaining setup**, **Develop this arc**, **Suggest an alternate route**, or **Generate setup beats**. Review the diff before applying it
7. Click **🔎 Check progress** for evidence-backed suggestions. Verify each quoted source, then Accept or Ignore; the checker never writes progress automatically
8. Choose **All active**, **Pinned only**, or **Focused only** injection
9. Use the Story Palette (emphasis chips, escalation choice, cast policy), optional safe character context, and **Direction Hint** to steer full and targeted generation
10. Use **📋 History** to browse snapshots, diff against the current plan, and restore a previous version
11. Toggle **🔌 Injection** independently from storage. Toggle **🔄 Auto** only for full-plan regeneration every N AI replies — progress checking remains manual
12. Use <code>/wt-beat</code> to list waiting beats and Ready arcs, <code>/wt-beat 2</code> to plant item 2, or <code>/wt-beat resolve R1</code> to resolve Ready item R1
13. Expand **⚙️ Story Planner Settings** for arc count (3–30), injection depth, auto interval, custom full-plan prompts, reminders, palette, and safe character context

### 💭 Interiority

Generates NPC private thoughts and a persistent **intentions ledger** in a separate, out-of-band LLM call. The narrator never sees the thoughts — only the mechanical ledger entries, which are injected back as execution demands. This prevents knowledge leaks (the thinking model physically can't leak secrets to the narration model) and gives NPCs durable hidden agendas that actually surface in their actions.

**Features**

- **Out-of-Band Generation** — NPC thoughts are generated in a separate API call with restricted context, physically isolated from the narration pass
- **Persistent Intentions Ledger** — Open intentions survive any number of turns; each entry has an action, trigger condition, and in-world "since" timestamp
- **Private Follow-Through** — Plans can grow from ongoing motives, current needs, and opportunities supported by the recent scene. A new threat or reveal is not required; old dossier plans alone are insufficient, and completed actions and public appointments are excluded
- **Execution Demand Injection** — When an intention's trigger is met, the ledger injects a mechanical directive (`<mwt_npc_intentions>`) that the narrator must execute on-screen. A departure that would end a conversation the player hasn't ended is started on-screen and finished the next turn, so the player can still respond
- **Batched Mode (default)** — One API call per turn covers all scene NPCs simultaneously. **Strict Mode** (optional) makes one call per NPC for true knowledge partition (NPC A's dossier secrets never co-resident with NPC B's thoughts)
- **Auto or Manual** — Generate automatically on every AI message (the default), or only on demand with **💭 Generate Now** or `/wt-thoughts`
- **Scene Roster** — Automatically detects present NPCs from the World State, with Knowledge Tracker fallback
- **Knowledge-Grounded** — Each NPC's thoughts are limited to their own Knowledge Ledger + witnessed events
- **Per-Message Display** — Thoughts render as collapsible blocks attached to individual chat messages (never in chat history); thoughts are never injected into the prompt — only the flat, mechanical ledger lines reach the narrator
- **Priority & Expiry** — Every intention carries a priority (low / normal / high / urgent) that sorts the ledger and annotates the narrator injection. In-world expiry labels ("no longer plausible once…") ride the ledger line, the prompt, and the injection; a per-entry turn expiry closes that specific plan after N turns; and the **Max Turns Open** setting (default: never) auto-closes engine-authored plans only — your hand-authored (✋) plans are never auto-evicted
- **Lifecycle History** — Completions, drops, expiries, merges, sleeps, wakes, and reopens are logged newest-first with their reasons and supersession links. Any closure can be 🔁 **reopened** (it returns as an active, user-owned plan), and the log can be cleared
- **Manual Lifecycle Actions** — Per-entry ✔ **mark done** and 🚫 **dismiss** (no longer plausible — closes the plan without permanently blocking it), 💤 **sleep** to schedule an intention (no per-turn narrator demands until its wake condition is near; ⏰ **wake** or the periodic dormant poll brings it back), and ⚠ duplicate/occasion conflict badges with a one-click **merge** that records the supersession
- **Proposal Guardrails** — A per-NPC accepted-proposal cap (**Max New/NPC**, default 2 — completion/drop evaluation is unaffected, and malformed or duplicate proposals never consume the cap), owner-checked close IDs (one NPC's response block can never close another NPC's plan), a same-response replay guard, and a **Closure Dedup** window (recent closures suppress near-identical re-proposals for that NPC). Completion is also separated from abandonment grace: an `executed` mark may close an engine plan still inside its **Grace Period** once genuine story time has elapsed with the plan live, while `dropped` marks keep the full grace window
- **Per-NPC Controls** — Per NPC: a **privacy exclusion** that withholds their dossier-derived context from every interiority call while leaving intentions tracking and the actor/witness rules intact, plus creation-only cost dials — **pause new proposals**, a **cooldown** after each accepted proposal, and an **active-plan cap**. Existing plans are always evaluated while proposals are gated, and nothing is ever auto-evicted to meet a cap
- **Rollback on Swipe/Edit/Delete** — Ledger snapshots per message make it trivial to revert state when messages change; lifecycle history and evidence boundaries roll back with the ledger
- **Manual Ledger Editing** — Add, edit, or delete intentions directly in the UI

**Using it**

1. Open the **💭 Interiority** tab to view the current intentions ledger; **⚙ Settings** opens the module settings (press **Save Settings** there after changing anything)
2. The intentions ledger is injected whenever Interiority is enabled — there is no separate injection button. To stop it, turn Interiority off in **⚙️ Settings → Per-Tracker Enable**, uncheck **Generate intentions** in the module settings, or use the panic switch
3. In **⚙ Settings**, **Auto-generate on each AI message** (on by default) runs Interiority after every AI reply. Uncheck it to generate only when you ask — with **💭 Generate Now** in the tab, or `/wt-thoughts`
4. Choose **Mode**: **Batched** (default) or **Strict** (one call per NPC, higher cost)
5. Set **Max NPCs** (default 4) to cap how many characters are processed per turn
6. View the **Ledger** — open intentions with NPC name, action, trigger condition, in-world "since" time, turns open, priority badge, and any in-world expiry note. Each entry has its own controls:
   - ✔ **Done** — mark the plan completed (recorded in Lifecycle History)
   - 🚫 **Dismiss** — close it as no longer plausible, without permanently blocking it
   - 💤 **Sleep** — schedule it: no per-turn narrator demands until its wake condition is near. Scheduled plans move to their own list (with a 📅 wake hint), and ⏰ **wake** brings one back on demand
   - ✎ **Edit** — change the wording, priority (low/normal/high/urgent), in-world expiry, or per-entry turn expiry
   - ✕ **Remove** — delete it and never re-propose it
   - ⚠ duplicate/conflict badges offer a one-click merge of near-identical plans
7. Click **➕ Add Intention** to manually create a new ledger entry
8. Check **Lifecycle History** below the ledger — every closure and state change is listed newest-first with its reason, and 🔁 **reopen** restores any closure as an active, user-owned plan
9. Use **Per-NPC Controls** to add a privacy exclusion or creation-only cost dials — pause new proposals, cooldown, active-plan cap
10. Tune the lifecycle dials in module settings: **Grace Period** (minimum turns a plan must survive before it can be executed or dropped), **Max New/NPC** (default 2), **Closure Dedup**, and **Max Turns Open** (never applies to ✋ user-authored plans). A temporary, opt-in intentions diagnostics capture for issue reports also lives here — in-memory only, never saved
11. In the chat, click the 💭 icon on any AI message to expand/collapse that message's thought blocks — each NPC's private reaction and thought is displayed there

### 🌦️ Ambient Conditions

Deterministic, opt-in weather (and, later, other ambient facts nobody in the story can change). **Code decides the conditions; the narrator model only renders them** — no model calls, no API key, no extra cost.

**Features**

- **Code decides, the model renders** — Conditions are a pure function of the chat's seed, the in-story clock, and your climate. The same story moment always produces the same weather on every regeneration and every branch, because nothing is stored except the seed — nothing to refresh, nothing to go stale, nothing to desync across branches
- **Climate gates what can exist** — Five presets (temperate, desert, tropical, arctic, mediterranean) plus hemisphere and a manual season make impossible weather unreachable by construction rather than merely discouraged: the desert never snows. The **variability** slider (slower / balanced / faster) changes how *often* weather changes as story time advances — never how extreme it is or what the climate allows
- **A story clock with honest fallbacks** — The latest usable `[In-story time:]` tag, else the World State Current Scene date, else one synthetic hour per message (a fallback never dressed up as a calendar date). Conditions hold steady within each time band (dawn, morning, afternoon, evening, night), warmth follows the day (afternoon peak, night trough), and clock jumps over six story hours are logged
- **One authoritative line per generation** — Normal, swipe, regenerate, and continue generations are injected; quiet and impersonate generations are not. Swipes and regenerations keep the clock from *before* the replaced reply, hidden messages and prompt-only regex can't shift the clock, and on a time skip the model is told to keep conditions vague until the next turn supplies real ones
- **Words first, with a fixed range** — "overcast, cool (8–16°C / 46–61°F), damp air", never a raw reading like "14.3°C". The range is the word's fixed band, so the model can't misread a season-relative word: "mild" in July is the cool end of summer, not chilly. The line also names the season the generator used. The forecast cap is one band ahead: the module truthfully knows the future (it's deterministic), but a longer horizon would invite the model to fast-forward your story
- **Pins with story-time expiry** — Lock "thunderstorm tonight" until unpinned, next band, next dawn, or a story date/time. Pins can even override climate restrictions, and expired pins remain stored, so rewinding inside their interval restores the override
- **First enable asks, never assumes** — Enabling inlines a climate + hemisphere question instead of silently defaulting ("Temperate, don't ask again" is the dismiss path); an unanswered setup creates no weather at all
- **Visible where you already look** — A read-only Ambient card on the 🏠 Overview dashboard (conditions, forecast, pin status and bound, off/panic state), `/wt-ambient` (alias `/wt-weather`) in chat, and listings in the Budget tab and diagnostics console
- **Story Planner integration** — Every planner request (full-plan, scoped Add/Refresh, targeted operations — custom templates included) receives the current conditions and one-band forecast, active pins included, and is told to build on them; the world-pressure planning lens defers weather ownership to the module rather than inventing conflicting weather
- **Safe by construction** — The per-chat seed survives renames and branch copies (branch off for a different weather fate, or `/wt-ambient reseed` to reroll just this branch); the panic switch and chat switches gate it like every other module; and player-fixable incidents (a clearable rockslide) stay in World Pressures territory instead of becoming weather

**Using it**

1. Open the **⚙️ Settings** tab and find the **🌦️ Ambient Conditions (this chat)** section — its controls save independently of the global **Save Settings** button
2. Check **Enable Ambient Conditions** and answer the one-time climate + hemisphere question (or pick **Temperate, don't ask again**). Set a manual season if your story is mid-season, and tune **variability** to taste
3. That's the whole setup — every normal, swipe, regenerate, and continue generation now carries one authoritative ambient line. Check the **🏠 Overview** card or run `/wt-ambient` to see the current conditions and one-band forecast
4. Open **Pin conditions** to hold a specific state ("thunderstorm tonight") — per-channel picks with an expiry in story time (until unpinned, next band, next dawn, or a story date/time). Pins override even climate restrictions; **Unpin** removes them
5. Branches inherit the parent chat's seed — same story moment, same weather. Run `/wt-ambient reseed` on a branch that deserves a different fate
6. With the module on, Story Planner requests automatically receive the current conditions and are told to build on them — no extra setup

### 📅 Calendar

A per-chat calendar for worlds that don't use the real-world one. Author your own months, weekdays, and events in the **📅 Calendar** tab, and the story clock, a short date line for the narrator, and the whole 🌦️ Ambient sky (daylight, moon, tides, seasons) follow it. Like Ambient, it is deterministic: **no model calls**, and the same story moment always gives the same date across swipes, branches, and rewinds.

**Features**

- **Custom or Gregorian** — A **Custom** calendar has your own months (any lengths), weekdays (or none), and an optional era. **Gregorian** keeps the real-world calendar but still lets you author events and dated phenomena. A chat with no calendar saved behaves exactly as before
- **Your date tags drive the clock** — Once a custom calendar exists, `[In-story time:]` tags and the World State scene date are read in your calendar's format (for example `Fiveday, Rotmonth 31, 1247`). A real-world date that slips in ("June 3, 1247") is skipped with a note on the 🏠 Overview instead of moving the story centuries, and a newest tag that can't be read switches the date line off — with the reason on the Overview — instead of stating a stale date
- **Midsummer anchor** — You tell MWT which day of your calendar is midsummer (the year defaults to the story's current year), so seasons, daylight, and the moon line up. The panel previews today's date and the derived season before you save, and the midsummer reference follows the Ambient hemisphere
- **A short date line** — **Inject authoritative date line** (custom calendars, on by default) gives the narrator today and tomorrow with their weekdays, plus the days left in the month once 7 or fewer remain — roughly 64–80 tokens. It never states the era
- **Events** — Named events that happen once, yearly, every N years, or on the new or full moon, lasting 1–14 days. **Inject bounded events line** (on by default) mentions at most the next event within 14 days (a second only when both are within a week). The same line reaches the Overview and the Story Planner, which is told not to invent distances to events or cancel them
- **Dated phenomena** — Scheduled sky effects for Ambient Conditions (an eclipse, a month of twilight) with a start date, a duration in days or calendar months, an optional yearly repeat, and visibility gates. A light override can only darken a scene, never brighten the night. **End now** stops one while keeping the played past
- **Month grid** — A navigable month view showing events and active phenomena
- **Edits rewrite history consistently** — Re-anchoring, month edits, removal, and hemisphere changes reposition the whole clock, past and future; the panel says so and asks you to confirm before saving. Weather pins and frequency rules stored in hours can optionally be re-stamped by date. Removing a month that something still refers to is refused
- **Export / import** — Calendar JSON through a text box, plus a ready-made preset snippet carrying your full month and weekday tables, so the narrator can correct its own bad date tags

**Using it**

1. Open the **📅 Calendar** tab. It applies to this chat only, and its saves are separate from the global **Save Settings**
2. Choose **Structure**: **Custom** for your own calendar, or **Gregorian** for real-world dates with events and phenomena
3. For a custom calendar: add months with **Add month**, list weekdays one per line, optionally set an era, and fill in the **Midsummer anchor** (year, month, day, weekday). Check the preview line for today's date and season
4. Optionally add **Events** and **Dated phenomena** — **Apply event to draft** / **Apply phenomenon to draft** adds each one to the draft
5. Tick **I understand the clock-domain and history changes** and press **Save Calendar**. Nothing is saved until then
6. Copy the **preset snippet** into your preset so the narrator writes dates in your calendar's format
7. Run `/wt-calendar` any time to see the exact date line the narrator receives

---

## Shared Surfaces

### Shared Core

All six modules share a common infrastructure:

- **Unified API Layer** — OpenAI-compatible API *or* SillyTavern Connection Manager profiles, with retry logic, error recovery, reasoning-content fallback, and custom headers support
- **Settings Management** — Global defaults with per-module overrides; settings stored in SillyTavern's `extension_settings` with localStorage fallback and legacy key migration
- **Diff Engine** — LCS-based line and word-level diff computation with customizable HTML rendering
- **Modal System** — Shared modal lifecycle (create, show, hide, status bar) with escape-key and backdrop-click handling
- **Context Helpers** — Safe access to SillyTavern context, chat data, metadata, token estimation, and player name resolution
- **Sync to Modules** — Push global API settings to all modules at once
- **Injection Helpers** — Shared extension-prompt injection with optional XML structural-boundary wrapping
- **Schema Validation & Self-Repair** — Every store MWT persists (chat metadata, lorebook registries, settings, browser-local records) is version-stamped and validated on load. Old formats migrate themselves automatically, a store that can't be safely understood pauses at most its own module (visibly, with a banner) rather than corrupting data, and rejected records are quarantined — preserved, reported, and exportable — never silently dropped or fed to the AI. See [Data safety in MWT 2.0](#data-safety-in-mwt-20--validation-migrations-and-quarantine-explained)
- **Unified Backup & Restore** — A Backup / Restore panel in the Settings tab exports every module's chat data as one versioned JSON envelope. Restore runs a two-step dry run (preview the exact per-section changes, then confirm), with an Undo that replays the in-memory pre-restore snapshot; quarantined records can be exported separately as recovery data

### 🏠 Overview

The **🏠 Overview** tab is the MWT modal's landing view: one page showing everything waiting on you in this chat, with a deep link from every signal straight to the module that owns it. The status cards only observe; the maintenance actions below (🔎 Findings previews and 🧰 Tools) change data only through a preview → confirm modal. The pane follows the open-and-read refresh model (re-open the modal or press 🔄 Refresh).

- **Status cards** — World State staleness (messages since refresh, delta counts), Knowledge (pending staging items, unread growth evidence), Story Planner (awaiting / overdue beats), Interiority (active / dormant intentions, deleted-intention records), Ambient (current conditions, one-band forecast, pin status, off/panic state), Budget (injected tokens vs context limit, observe / enforce), Coordinator (running / queued jobs, a "background HELD" flag while background work is paused), one compact health line per module, and quarantined record counts. Every card carries a one-click **Open …** button into the relevant tab
- **Guarded cells** — each card's data source is independently guarded, so a broken subsystem renders its own "Unavailable" card instead of blanking the pane
- **🔎 Findings** — a maintenance section that appears only when an audit finds something: duplicate NPC profiles, profile relink candidates, and NPC identity-audit guidance (its cleanup is manual by design — the finding prints the steps). Duplicate and relink findings offer a **Preview …** button: preview → consequence-stated confirm → apply, where the apply step **re-plans from scratch** and refuses with "review a fresh preview" if the chat or the profile book changed since the preview. Unnamed and tied-size duplicate groups need human judgment, so they are listed as review items and never auto-applied. Relink points each profile at its largest candidate entry (newest on ties), and its preview shows how many **other candidates** each link had — anything above 0 means duplicates worth reviewing first. Hidden entirely while the audits run clean
- **🧰 Tools** — a collapsed disclosure holding the two deliberate destructive actions: **Clear all evidence** (names every affected NPC, warns which generated profiles would be left unbacked and that rebuilding evidence costs API calls, and re-checks the NPC list at confirm) and **Clear deleted intentions** (warns those intentions may be proposed again). On hosts that don't expose a chat id, both refuse with an explanation and point at their console twins

The same audits and write actions remain available to power users through the `window.MWT.*` console bridge (see **[DIAGNOSTICS_CONSOLE_GUIDE.md](DIAGNOSTICS_CONSOLE_GUIDE.md)**) — one collector, two surfaces.

### 🩺 Diagnostics

A read-only **🩺 Diagnostics** tab inside the MWT modal answers "what is MWT actually doing?" without devtools. It is in-memory only (nothing is persisted; the buffer clears on reload) and opening it never changes state:

- **❤️ Health** — One row per module: enabled, injection gate, busy state, token estimates, auto-cadence countdowns, last run
- **🌐 Environment** — MWT + SillyTavern versions, feature detection, and the raw context-field probe (fork compatibility)
- **🗂️ Scope & storage** — Which lorebooks this chat resolves to and *why*, per-book hydration and store versions, saved bindings, and fallback-to-global warnings
- **💉 Injection** — Per-module on/off, gate, resolved role/depth with provenance, token estimate, and the exact payload last registered with SillyTavern
- **📡 Last request** — The most recent LLM request per module (statuses, retries, timings — never API keys)
- **📋 Log** — Rolling in-memory event buffer with severity filtering
- **🛡️ Integrity** — Schema/quarantine status across stores, plus recovery-data export
- **📋 Copy Report** — One click bundles everything into redacted, paste-ready Markdown. Chat text is included only if you explicitly opt in; API keys and secrets are redacted either way

Everything the tab shows (and more) is also available via the `MWT.diagnostics.*` console API. Full references: **[DIAGNOSTICS_GUIDE.md](DIAGNOSTICS_GUIDE.md)** and **[DIAGNOSTICS_CONSOLE_GUIDE.md](DIAGNOSTICS_CONSOLE_GUIDE.md)**.

### 📊 Budget

The **📊 Budget** tab shows the estimated prompt tokens MWT has registered and lets you set per-chat limits for World State, Chronicle, Story Planner, Interiority, and Ambient Conditions. Its settings are stored in the current chat's metadata, so changing a cap does not affect other chats.

- **Observe mode is the default.** It does not change injection applies; the table and Diagnostics Log show what enforcement *would* do. On a chat change, MWT still clears stale injection snapshots before the new chat's modules re-apply, preventing old-chat context from influencing the new allocation.
- **Enforce budget** applies limits at the shared injection seam. A **soft cap** truncates a payload with a visible `[…truncated ~N tokens]` marker while preserving closed wrapper tags. A **hard cap** drops that module's injection. The **global hard cap** protects higher-priority context by dropping lower-priority content first.
- **Priority** uses lower numbers first: P1 survives longer than P2. A global cap only displaces strictly lower-priority registered modules; equal-or-higher priority content is protected.
- **Caps apply on the next injection apply.** After saving, toggle a module's injection or trigger its refresh to enforce new settings against its current payload.
- **Knowledge is advisory.** Its lorebook entries are activated by SillyTavern World Info keywords rather than MWT's extension-prompt seam, so the tab reports its stored size but never modifies it.

Use `0` for any cap to leave that cap off. Token figures are estimates using the same tokenizer MWT uses throughout its UI.

### Slash Commands & Macros

MWT integrates with SillyTavern's STscript system for power-user automation and Quick Replies:

**Slash Commands:**

| Command | Action |
|---|---|
| `/wt-refresh` | Trigger a World State refresh |
| `/wt-snapshot` | Generate a Chronicle snapshot |
| `/wt-scan` | Run a Knowledge NPC scan |
| `/wt-plan` | Open scoped Story Planner generation; review before applying |
| `/wt-beat` | List due Story Planner setup beats; `/wt-beat 2` marks one planted, `/wt-beat resolve R1` resolves a Ready arc |
| `/wt-thoughts` | Generate Interiority for the current/last AI message |
| `/wt-ambient` | Show current Ambient Conditions and the one-band forecast (alias `/wt-weather`); `/wt-ambient reseed` rolls a new seed for this chat/branch |
| `/wt-calendar` | Show the Calendar date line exactly as the narrator receives it (edit the calendar in the 📅 Calendar tab) |
| `/wt-inject on\|off` | Toggle injection for **all** MWT modules at once (mirrors the right-click panic switch) |
| `/wt-state` | Output the current world state text (pipeable) |
| `/wt-reset-buttons` | Reset the floating buttons to their default positions |

> **Note:** `/wt-inject` toggles injection for every MWT module — Interiority and Knowledge are gated through the same master injection flag as the rest. Knowledge Tracker's lorebook entries are additionally keyword-activated by SillyTavern's own World Info.

**Macros** (SillyTavern 1.12+):

| Macro | Returns |
|---|---|
| `{{worldstate}}` | The current world state text |
| `{{chronicle}}` | The full chronicle injection text |
| `{{lastchronicle}}` | The most recent chronicle entry |
| `{{storyplan}}` | The current story plan text |

Macros let you place content anywhere (Author's Note, prompt manager block, char card, custom-depth WI entry) instead of the fixed injection — pair with disabling injection for a "macro-only" workflow.

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

### Per-Module API Overrides

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

Each tracker can be individually enabled/disabled. Disabling a tracker stops it from injecting and scanning; its floating button shows a red ✕ and can be re-enabled via right-click (or the Settings tab). Its tab stays in the window, and what it already saved stays readable by the other modules — frozen at its last update. [SETUP_GUIDE.md](SETUP_GUIDE.md#whats-safe-to-turn-off-all-of-it--and-what-each-modules-absence-costs) lists what each module's absence costs. The global **panic switch** (right-click the ⚙️ button, or the checkbox in Settings) disables all trackers at once — useful for testing or branching a chat.

### Theme, Mobile & Touch

- **Themes** — MWT supports both **dark** and **light** SillyTavern themes; CSS variables adapt via theme-aware selectors
- **Pointer Events** — Floating button drag works with mouse, touch, and pen
- **Responsive Layout** — The modal adapts to small screens (breakpoints at 768px and 480px)
- **Collapse Mode** — Optionally collapse the floating buttons into a single hub button
- **Right-Click / Long-Press** — Quick-toggle any tracker via the floating button's context menu

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
- **🌦️ Ambient Conditions** needs no model at all — conditions are computed locally from the story clock, so it works even with no API configured
- For models with extended thinking (e.g., DeepSeek R1, o1), the API layer automatically recovers from empty content by falling back to `reasoning_content`

---

## Data Storage

- **Chat data** (world state text, chronicle entries, growth evidence store, story plan text, interiority ledger + lifecycle history + per-message thoughts) is stored in SillyTavern's per-chat metadata (survives backup/restore)
- **Ambient Conditions** stores only a random seed and its per-chat settings in chat metadata — the conditions themselves are never stored or refreshed; they are recomputed from (seed, in-story clock, climate) at prompt-build time
- **Calendar** stores its structure, anchor, events, and dated phenomena in chat metadata (`mwt_calendar`). Dates and event mentions are never stored — they are recomputed from the story clock, so they stay correct across swipes, branches, and rewinds
- **Lorebook bookkeeping** (NPC registry, state tracker registry, relationships) lives inside the Knowledge Tracker and State Tracker lorebooks themselves, in a single disabled entry titled `[MWT:store]` — see [the section below](#the-mwtstore-entry--what-it-is-and-why-its-there) for exactly what it is and why it can never reach your prompt
- **Settings** are stored in SillyTavern's `extension_settings` (survives backup/restore) with `localStorage` fallback — validated and version-stamped as of 2.0 (a bad record repairs itself; your values are never silently deleted)
- **Knowledge Tracker history** is stored in `localStorage` keyed by lorebook UID — malformed records are filtered from the view as of 2.0 and the list heals itself on the next edit
- **Floating button positions** are stored in `localStorage` — validated as of 2.0 (an unreadable record just resets the buttons to their anchored spots)
- **NPC Growth Profile evidence** uses a two-tier append-only store in chat metadata (`raw[]` → `consolidated[]` → `archived[]`), with per-NPC watermarks for continuous incremental capture and ILS backfill. Profile text is saved to a separate "NPC Profiles" lorebook with `profileUid` cross-references in the NPC registry. Growth-written dossier lines keep their state in the Knowledge lorebook too — the per-NPC switch and limits in `[MWT:store]`, and the last 10 approved Personality/Voice versions in a second disabled, never-injected `[MWT:growth-history]` entry — so all of it follows the Lorebook Scope setting
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

**A sibling entry, `[MWT:growth-history]`.** If you use Growth-written dossier lines (v2.17.0), each Knowledge lorebook also carries a disabled, keyword-less `[MWT:growth-history]` entry — the last 10 approved `Personality:`/`Voice:` versions per NPC — protected by the same four locks, never sent to the AI, and following the Lorebook Scope setting like everything else in the book. Delete it only if you're deliberately discarding that approval history.

### Data safety in MWT 2.0 — validation, migrations, and quarantine, explained

MWT 2.0 adds a safety layer under everything the extension saves. Saved data is checked before it's used, chats in older formats upgrade themselves automatically the first time you open them, and a record MWT can't safely understand is set aside for recovery — preserved, reported, and exportable — instead of being skipped, mangled, or fed to the AI. A problem pauses at most one module, visibly, with a banner and a Retry; your prose and lorebook content are never touched or judged. The same checking now covers MWT's own settings and its browser-local records (floating-button positions, Knowledge edit history, and the per-message ID stamps Interiority keeps): those are validated with the same vocabulary but fail open — a problem falls back to defaults or filters the bad record, never pauses a module, and never deletes what's stored. The full plain-language guide, written for non-programmers, is in **[DATA_SAFETY_GUIDE.md](DATA_SAFETY_GUIDE.md)**.

---

## ♿ Accessibility

MWT is built to be fully operable without a mouse and usable with a screen reader:

- **Real Dialogs** — Every modal is a proper dialog (labelled by its heading) with `aria-modal` backed by real page inertness. Focus moves into the dialog on open, stays trapped inside it (Tab wraps first ↔ last, skipping disabled and hidden-panel controls), and returns to the button that opened it on close — whether closed via ×, Escape, or the backdrop. Stacked dialogs resolve to the one you actually see on top
- **Keyboard Navigation** — The main tab strip and the Diagnostics sub-tabs are keyboard-operable tablists (← / → to move, Enter / Space to activate), every panel is reachable keyboard-only, and inactive tabs and panels are hidden from the accessibility tree
- **Visible Focus** — Keyboard focus gets a clear outline on every interactive control in both themes, scoped to MWT's own surfaces so SillyTavern's UI is never restyled
- **Accessible Names** — Every control has a real name (emoji-only buttons included), form fields are associated with their labels, tooltips that carried essential meaning became visible help text, and no state is color- or emoji-only anymore — badges and origin icons carry screen-reader text
- **Status Announcements** — Status bars and module status lines are polite live regions (`role="status"`), async controls expose their busy state (`aria-busy` alongside disabled, cleared on error paths too), and countdown digits are never announced
- **Reduced Motion** — With `prefers-reduced-motion` enabled, pulses, transitions, and graph animation are suppressed — functional timers keep counting, they just stop animating
- **Keyboard Graph, Cards & Staging** — The relationship graph has labeled zoom in/out/reset controls and full keyboard node selection (Tab to a node, Enter to select, Enter again to open) with a screen-reader-only summary, plus NPC/type filters whose results are announced; staging proposals are real buttons with a pressed state, so reviewing, accepting, and dismissing never requires a mouse; NPC and tracker cards use real headings with native action buttons

The full implementation plan, verified baseline, and manual QA checklist are in [docs/accessibility_plan.md](docs/accessibility_plan.md).
