# Onboarding Preset Plan — first-run Lite / Standard / Full

Design record for the one-click first-run setup: a dialog that applies the
**Lite / Standard / Full** presets defined in
[SETUP_GUIDE.md](../SETUP_GUIDE.md) to the module settings stores in one
step. Phase 0 (the documentation version — this shipped) is the checklists
in the setup guide; this document specs the code feature that turns those
checklists into a button.

Status: **draft for review, not scheduled.** Natural home: after the parked
Settings workspace project ([settings_workspace_plan.md](settings_workspace_plan.md),
Project B) — the dialog touches the same settings surfaces and should land
with (or after) that redesign so it isn't built twice.

## 1. Motivation

A newcomer opening MWT sees six modules and dozens of cadence settings, and
the two decisions that actually shape first impressions — *which modules are
on* and *how much runs automatically* — are spread across six settings
panes. The natural response to that is overwhelm and uninstall. The presets
collapse both decisions into one choice with three answers. SETUP_GUIDE.md
solves this for readers; the dialog solves it for everyone, before they ever
open the Settings tab.

## 2. Preset definitions

Three presets. They intentionally touch only two axes — module enables and
automatic cadences — plus the World State Detail Level. Everything else in
every settings store stays at its shipped default. The values below are the
source of truth; SETUP_GUIDE.md checklists and any UI copy must match this
table.

### 2.1 Settings keys each preset writes

| Store · key (default) | Lite | Standard | Full |
|---|---|---|---|
| `merged_world_tracker` · `enableWorldState` (`true`, `core/settings.js`) | true | true | true |
| `merged_world_tracker` · `enableChronicle` (`true`) | true | true | true |
| `merged_world_tracker` · `enableKnowledge` (`true`) | **false** | true | true |
| `merged_world_tracker` · `enableStoryPlanner` (`true`) | **false** | true | true |
| `merged_world_tracker` · `enableInteriority` (`true`) | **false** | true | true |
| `mwt_world_state` · `detailLevel` (`'detailed'`, `world_state/settings.js`) | `'minimal'` | `'standard'` | `'detailed'` |
| `mwt_world_state` · `autoRefresh` (`false`) | false | false | **true** |
| `mwt_world_state` · `autoRefreshInterval` (`5`) | — | — | 5 |
| `mwt_chronicle` · `autoSnapshot` (`false`, `chronicle/data.js`) | false | false | **true** |
| `mwt_chronicle` · `autoSnapshotThreshold` (`40`) | — | — | 40 |
| `mwt_knowledge` · `autoTriggerEnabled` (`false`, `knowledge/settings.js`) | false | false | **true** |
| `mwt_knowledge` · `autoTriggerEveryN` (`5`) | — | — | 5 |
| `mwt_knowledge` · `npcAutoScanEnabled` (`false`) | false | false | **true** |
| `mwt_knowledge` · `npcAutoScanEveryN` (`10`) | — | — | 10 |
| `mwt_knowledge` · `growthAutoCaptureEnabled` (`false`) | false | false | **true** |
| `mwt_knowledge` · `growthAutoCaptureEveryN` (`15`) | — | — | 15 |
| `mwt_knowledge` · `relationshipAutoExtractEnabled` (`false`) | false | false | **true** |
| `mwt_knowledge` · `relationshipAutoExtractEveryN` (`10`) | — | — | 10 |
| `mwt_story_planner` · `autoEnabled` (`false`, `story_planner/settings.js`) | false | false | false |
| `mwt_interiority` · `autoMode` (`true`, `interiority/data.js`) | false | **false** | true |

"—" means *do not write the key*; it keeps its default. Bold marks the
non-default values (Lite's three disables and every cadence switch Full
turns on; Standard's only changes from a fresh install are the Detail Level
and Interiority's auto). Story Planner auto stays off at every level — see
§2.4.

Implementation note: intervals are written alongside their flags in Full so
the dialog is self-describing in Diagnostics' settings view, even though
every written interval equals its default today.

### 2.2 Ambient Conditions is out of scope by design

Ambient is chat-local (`mwt_ambient` in chat metadata), disabled by default,
and its first enable requires an interactive climate + hemisphere answer
(`ambient/settings.js` — `setupAsked` / `isConfigured()`). A global preset
that pre-answers climate questions would violate the module's
ask-never-assume contract. The dialog may *mention* Ambient as an opt-in
extra with a deep link to its settings section; it must never enable or
configure it.

### 2.3 Why Interiority's auto differs per level

`autoMode` ships `true` (the only always-on-by-default cadence). Standard's
position is "everything available, nothing automatic," so the preset sets it
`false`; Full restores `true`. Lite disables the module outright, and the
apply step should still write `false` so a later manual enable doesn't
silently re-arm an automatic cadence the user never saw described.

### 2.4 Why Story Planner auto stays off even in Full

Full's promise is "the bookkeeping runs in the background." Every other
cadence it turns on either keeps records (World State refresh, Chronicle
entries, growth evidence, relationship log) or queues proposals for review
(NPC auto-scan → Staging). Story Planner's auto is different: it
regenerates the whole plan every N AI replies and saves the result without
review, replacing active arcs the user hasn't pinned. That is a creative
rewrite, not bookkeeping, so no preset arms it. Full writes `false`
explicitly (rather than "—") so re-running Full over an install where the
user turned it on is a deliberate reset to the documented level;
SETUP_GUIDE tells Full users where to turn it on if they want it.

### 2.5 Chronicle injection is per-chat and out of reach

Chronicle's injection switch lives in chat metadata
(`session_chronicle_data.injectEnabled`, default `false` —
`chronicle/data.js` `chronicleReadDefaults()`), and §4 forbids touching
chat metadata. So at every level Chronicle entries stay out of the prompt
until the user switches injection on in each chat — which SETUP_GUIDE
covers as the one per-chat step every checklist shares. The dialog's fine
print must say the same; see §7 for the option of a global default.

## 3. First-run detection

There is no existing first-run mechanism (the `schemaVersion` field in
`core/settings_schema.js` is validation-only; nothing migrates or gates on
it). Add to the `merged_world_tracker` store:

- `onboardingVersion: 0` — integer; bumped whenever a future dialog change
  warrants re-showing. `0`/absent = never shown.

Show the dialog when **both** hold:

1. `onboardingVersion < CURRENT_ONBOARDING_VERSION` (`1`), and
2. **fresh-install gate** — every one of the six settings stores
   (`merged_world_tracker`, `mwt_world_state`, `mwt_chronicle`,
   `mwt_knowledge`, `mwt_story_planner`, `mwt_interiority`) is **empty**:
   its `extension_settings` record has no keys, and it has no localStorage
   record.

Two implementation traps in the gate:

- **Test for empty, not for existence.** `createSettingsManager`'s
  `getExtSettingsRef()` (`core/settings.js`) creates an empty `{}` for its
  store on the first read, so by the time any check runs every store
  "exists." `Object.keys(record).length === 0` is the real signal — the same
  test `getSettings()` itself uses before falling back to localStorage.
- **Run it after the modules have initialized.** A store whose data still
  sits under a legacy localStorage key is migrated into `extension_settings`
  on its first `getSettings()` read. Checked before that, an upgrader from
  the standalone extensions looks like a fresh install. Running the gate
  after module init (or also checking each manager's `legacyKey`) closes
  that hole.

The gate is what protects upgraders: anyone who has ever pressed Save in
any MWT settings pane has a persisted store and never sees the dialog for
that version. A user who saves global settings *before* the dialog fires
(e.g. configures the API first) also exits the gate — acceptable: they are
already past the overwhelm point the dialog addresses, and the Settings tab
gets a **Run setup…** button (§5) for the same flow on demand.

Closing the dialog by any path — choosing a preset or **Decide later** —
writes `onboardingVersion = CURRENT` and saves. No nagging: the dialog
appears at most once per version.

## 4. Apply mechanics

- Write through each store's own settings manager (`getSettings` → patch →
  `saveSettings`), never by poking `extension_settings` directly, so
  validation, localStorage fallback, and legacy-key handling all apply.
- **Global stores only.** `autoRefresh`, `injectEnabled`, and the Planner's
  behavior keys resolve through per-chat override chains
  (`world_state/data.js` `GLOBAL_SETTING_KEYS`, `story_planner/data.js`
  `GLOBAL_SETTING_KEYS`); the dialog must not touch chat metadata. A chat
  with explicit overrides keeps them — the preset is a *default*, matching
  how every other global setting behaves.
- Applies are idempotent (a patch of §2.1 values) and can be re-run from
  the Settings-tab button at any time; re-running over a live install is
  the documented "move between levels" path, not a destructive reset.
- Every apply logs one Diagnostics event (`level applied: standard`) so the
  action is visible in the Log tab and Copy Report.
- No Generation Coordinator involvement: applying a preset never triggers
  generation. Cadences arm for their next natural tick.

## 5. UI sketch

A standard MWT modal (real dialog, focus-trapped — same a11y contract as
every other MWT modal), shown once after init when §3 fires:

- Heading: "Welcome to MWT — pick a starting point"
- Three option cards (grid), one per preset, each with: name, the one-line
  "for" phrasing from SETUP_GUIDE, a compact "what's on / what's automatic"
  line, and an estimated API-load hint (lowest / on-demand / background
  calls). Recommended marker on Standard.
- Footer: **Decide later** (link-style) — closes without applying.
- Fine print: "You can change any of this later — every module is
  independent." + "Chronicle entries reach the AI once you switch on
  📥 Injection in the Chronicle tab — once per chat." (§2.5) + link to
  SETUP_GUIDE.md.
- After apply: a toast ("Standard applied — see ⚙️ Settings to adjust") and
  the dialog closes.

Settings tab addition: a **Run setup…** button in the Per-Tracker Enable
section reopening the same dialog (bypasses the fresh-install gate; still
writes `onboardingVersion`).

## 6. Phases

- **Phase 0 — docs (shipped):** SETUP_GUIDE.md checklists; this plan
  records the contract. The README links the guide from Quick Start.
- **Phase 1 — preset engine:** a `core/presets.js` (or `core/onboarding.js`)
  module exporting the §2.1 table, an `applyPreset(name)` that patches the
  six stores per §4, and unit tests asserting every written key/value
  against this table (extend `test/settings_provenance.test.js` patterns).
- **Phase 2 — detection + dialog:** `onboardingVersion` flag, fresh-install
  gate (both §3 traps covered by tests: an all-`{}` install counts as fresh;
  a legacy-key-only install does not), modal per §5, Settings-tab re-entry
  button. Host QA: fresh profile, upgrading profile, profile with API saved
  first, and the dialog on ST mobile (it appears at page load, before the
  user has opened MWT).
- **Phase 3 — docs sync:** SETUP_GUIDE "One-click presets (planned)"
  section becomes the pointer to the shipped dialog; README What's New
  entry.

## 7. Open questions

- Should Full's apply also suggest enabling ⚡ Delta Mode (cheaper scheduled
  refresh), or keep the preset strictly to the §2.1 keys? Current spec:
  strictly §2.1; Delta stays opt-in where it is today.
- Chronicle injection (§2.5): leave it per-chat and off, as today, or add a
  global "inject new chats by default" key to `mwt_chronicle` that a new
  chat's injection switch starts from? The second makes Lite's "World State
  + Chronicle" true out of the box, but it is a settings-model change to
  Chronicle, not part of this dialog, and would need its own small design
  (does it touch chats that already exist? — it shouldn't). Current spec:
  per-chat, documented.
- Should the dialog appear per-device or follow the settings store? Store
  flag (current spec) means one showing per install; localStorage would
  make it per-device. Store wins for simplicity.
- Localization: none today anywhere in MWT; out of scope here, noted for
  consistency.
