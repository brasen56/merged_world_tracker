# MWT Settings workspace — refreshed implementation plan

**Project:** B (information architecture, separate from the accessibility pass).
**Status:** Refreshed proposal; workspace implementation has not started.
**Original plan:** 2026-09-08. **Code reconciliation:** 2026-11-16, against
`ee1edc4` (package version 2.18.1).
**Prerequisite:** Project A is implemented; the documentation map records full
manual QA and host confirmation on 2026-11-16. It is no longer an unmerged
dependency. This refresh does not claim a particular duration of real-world use.

This document replaces the parked September plan. It describes future work,
not the current interface. No runtime change is part of this reconciliation.

## 1. Scope and changes since the old plan

The goal remains faster access to settings without changing their meaning,
ownership, persistence, or generation behavior. Keep all existing top-level
tabs and turn the global Settings tab into a sectioned workspace.

The old plan's main persistence warning still applies (§3), but its inventory
and assumptions need these corrections:

- Settings already uses native, collapsible `details` groups: API Connection,
  Stable History, Generation Coordinator, Injection Settings, Floating Buttons,
  and Per-Tracker Enable. This is not a fully expanded linear form anymore.
- Ambient Conditions already has a substantial **per-chat** form inside
  Settings, after the global Save/Sync row. It has its own Save and immediate
  actions; it cannot be treated as another set of global fields.
- Ledger adds global enable, injection, and floating-button switches, also
  editable from its own tab. Existing bidirectional synchronization matters.
- Overview, Calendar, Ledger, Diagnostics, and Budget are existing top-level
  destinations, alongside the five LLM-backed module tabs and Settings.
  Ambient has no dedicated top-level tab.
- Reduced motion already follows the OS preference through CSS and
  `prefersReducedMotion()`. There is no existing saved accessibility preference
  form to move into a new section.
- Module settings are not uniformly embedded forms, and none of them is a
  dialog. There are four different entry-point shapes (§2, "Module settings
  entry points"); deep links must invoke each owner's actual entry point, not
  assume there is a hidden settings panel in every tab.
- Overview already deep-links **into** Settings: its Coordinator and Ambient
  cards open `#mwt-settings-generation-coordinator` and `#mwt-ambient-settings`
  and scroll to them. Those targets will sit inside sections that may be
  hidden, so the workspace must keep both links working (§4).
- The explicit assistant-only/every-message auto-generation trigger setting is
  still unchecked in `docs/TODO.md` §4. It remains a separate feature.

Do not add settings keys, migrate stores, change API precedence, centralize
module forms, or implement proposed onboarding/Ledger-v2 features in this work.

## 2. Verified code map and ownership

Use function names and selectors as anchors rather than old line numbers.
Paths below are relative to the repository root.

| Concern | Current owner / contract |
| --- | --- |
| Global form | `index.js`: `renderSettingsTab()`; profile toggle, global Save, reset positions, and Sync are wired inside `renderModal()`. |
| Global persistence | `core/settings.js`: `GLOBAL_SETTINGS_DEFAULTS`, `createSettingsManager()`, `getGlobalSettings()`. The Settings manager merges defaults; the canonical accessor deliberately does **not** materialize absent fields. |
| API fields | `core/ui.js`: `renderConnectionProfileSelect()`, `renderApiSettingsFields()`, `wireApiSettingsFields()`, `readApiSettingsValues()`; global IDs come from `GLOBAL_API_FIELD_IDS` in `index.js`. |
| Main tabs | `core/main_tabs.js`: `renderMainTabShell()`, `wireMainTabBar()`; explicit `.mwt-tab-content` panel selector excludes nested panels. |
| Section navigation primitive | `core/ui.js`: `wireTablist()` already supports vertical orientation, roving focus, Home/End, hidden panels, and programmatic selection. |
| Ambient form | `ambient/render.js`: `renderAmbientSettings()`, `wireAmbientSettings()`; `ambient/settings.js` persists `mwt_ambient` in chat metadata. |
| Ledger shared switches | `ledger/settings.js`: `LEDGER_SETTINGS`; `index.js` synchronizes the three global controls with the tab's immediately saved `[data-ledger-setting]` strip. |
| Backup / recovery | `backup/render.js`: `renderBackupPanel()`, `wireBackupEvents()`; restore preview, pre-restore backup, undo, recovery export, and scope guards remain owned by backup code. |
| Modal lifecycle | `index.js`: `openMwtModal()`, `renderModal()`, synchronous `CHAT_CHANGED` handler; `core/modal.js` owns dialog/focus/status behavior. |
| Layout / accessibility | `core/style.css`: `.mwt-settings-grid`, `.mwt-settings-disclosure`, `.mwt-settings-actions`, modal/statusbar styles, 768px responsive rule (the settings grid itself collapses at 480px), reduced-motion rules. The stylesheet has **no** `[hidden]` rule; main tabs hide through `.mwt-tab-content` / `.active` display rules. |
| Inbound deep links | `dashboard/render.js`: `wireOverviewPane()` handles `data-overview-target` values `generation-coordinator` and `ambient-settings` by clicking the Settings main tab, resetting `.mwt-modal-body` scroll, opening the target `details`, and scrolling to it. Pinned by `test/dashboard_pane.test.js`. |

### Module settings entry points

Slice 3's Configure actions target these. None is a dialog.

| Module | Entry point today | What Configure needs |
| --- | --- | --- |
| World State | `<details>` ("World State Settings") inside the tab, `world_state/render.js`. | Open the disclosure, scroll, focus. |
| Story Planner | `<details>` ("Story Planner Settings") inside the tab, `story_planner/render.js`. | Same. |
| Chronicle | `showSettingsModal()` in `chronicle/render.js`. Despite the name it **replaces the tab's content in place**; it is module-private (reached from `#sc-settings-btn`). | An exported opener. The swap discards the tab's current view. |
| Knowledge | `showKnowledgeSettings()` in `knowledge/settings.js`, exported; **replaces the NPC content in place** (reached from `#kt-cog-btn`). | Call the export; confirm which sub-tab must be active first. |
| Interiority | `#mwt-int-show-settings` **toggles** `#mwt-int-settings-panel`, which is rendered lazily by `renderSettingsPanel()`. | An idempotent "open" — clicking the button would close a panel that is already open. |
| Ledger | Always-visible `[data-ledger-setting]` switch strip in the tab. | Activate the tab and focus the strip. |

### Global fields to retain

- **API & Connection:** profile; custom URL, key, model; max tokens,
  temperature, top-p, frequency/presence penalties, custom headers.
- **Automation:** `recentHistoryExclude`, `apiMaxConcurrent`,
  `pauseBackgroundJobsDuringGeneration`. Preserve their current clamping and
  help text, including Interiority's Stable History exception.
- **Injection:** World State, Chronicle, and Interiority depth/role pairs;
  `structuralBoundaries`; `injectLedger`.
- **Modules:** `injectionMasterOff`; enable switches for World State,
  Chronicle, Knowledge, Story Planner, Interiority, and Ledger.
- **Floating Buttons:** visibility for those six plus Settings;
  `collapseFloatButtons`, `buttonStyle`, reset-position action.

This is an inventory of the current global form, not an assertion that all
module injection, automation, or presentation settings live here.

## 3. Non-negotiable persistence and lifecycle contracts

### 3.1 All sections remain mounted

The global `#mwt-s-save` handler reads controls from the whole modal. Missing
controls still produce a patch, using fallbacks or numeric coercion. For example:

```js
worldStateDepth: depthOr('#mwt-s-ws-depth', 4),
worldStateRole: modal.querySelector('#mwt-s-ws-role')?.value || 'system',
```

An empty existing numeric input can also behave differently from a missing
control: `Number('')` becomes zero, whereas `Number(undefined)` becomes `NaN`,
before the reader's clamping/fallback logic. At `ee1edc4` this affected exactly
two fields: clearing **Messages to defer** saved 0 (a missing control gave 2),
and clearing **Max parallel API calls** saved 1 after clamping (a missing
control gave 2).

**Resolved 2026-11-16, ahead of Slice 1:** both readers now go through one
`clampedOr()` helper in the Save handler, so an empty field falls back to its
default (2 for each), the same as a missing control or non-numeric input and
the same as `readApiSettingsValues()` does for the API fields. The depth
fields already used `parseInt` and were unaffected. Slice 1's pinning tests
assert the fixed values: empty → 2, and the clamps 0–10 and 1–8. Do not
change this coercion again inside the layout slices.

**Render every section once per modal-body rebuild, then toggle `hidden`.**
Never lazy-render, detach, disable, or reconstruct a section on navigation.
Preserving IDs alone does not protect saved values. Existing profile-dependent
visibility and any remaining closed disclosures must also retain their
controls.

`hidden` only hides a panel while no author `display` rule applies to it, and
the stylesheet has no `[hidden]` rule. Ship an explicit
`.mwt-settings-section[hidden] { display: none; }` rule (or drive visibility
from the helper's active class, as the main tabs do) with the section class.
jsdom does not compute layout, so this is a host check, not a unit test.

The key regression is executable **cross-section Save parity**: populate
non-default values throughout the real form, select each section in turn, and
assert that Save emits the same complete patch. Also check actual expected
values: equal but incorrectly defaulted patches are not success.

### 3.2 Separate save domains stay separate

- Global Save applies to all global sections, not just the visible one. Label
  its scope explicitly (for example, “Save Global Settings”). Keep its ID.
- Global Save does not save Ambient drafts, module forms, calendar edits, or
  Budget settings. Ambient keeps its own Save, immediate actions, and scope
  checks. Give its section conspicuous “This chat” / separate-save wording.
- Sync reads the **current API form**, including unsaved values, and invokes
  the five LLM modules' `syncGlobalSettings()`. It does not save the global form
  or configure Ambient, Calendar, or Ledger. Preserve this distinction and the
  modules' existing sync contracts; do not promise every generation option is
  propagated identically.
- Preserve the global Save side effects: Ledger strip refresh, floating-button
  visibility/style/state, coordinator pumping, injection reapplication, and
  panic-related Ambient/Calendar clears.
- Module enable and floating visibility remain independent. Enabling a tracker
  must not force its button visible, or vice versa.
- Preserve absent-global-field precedence in `getGlobalSettings()`; workspace
  navigation must not materialize defaults or write settings.

### 3.3 Rebuilds and focus

`renderModal()` replaces `.mwt-modal-body` on reopen and on an open-modal chat
switch. `CHAT_CHANGED` currently restores the main tab and then focus by ID or
main-tab identity. It does **not** preserve a Settings subsection today.

Keep the selected section as session UI state (a stable section ID, not a
settings field or chat metadata). Restore it on rebuild, with API & Connection
as fallback if the ID is unknown. Restore in this order: main tab, Settings
section, then focus. Never restore focus into a hidden section, closed
disclosure, or hidden desktop navigation; use the visible picker, selected
section tab, or section heading as appropriate.

`wireTablist()` keeps its selection state on the tablist element, and a
rebuild produces a fresh element whose initial selection is read from markup
(`aria-selected` / the active class). Render the remembered section as
selected in the markup; that gives the required order with no post-wire
`select()` call and no announcement.

Section selection preserves drafts because nodes survive. A modal rebuild
currently reloads persisted form values; **this project does not add draft
persistence across chat switches or close/reopen**. Preserve module dirty-edit
guards and do not make `CHAT_CHANGED` async or move its epoch/schema gates.

## 4. Target information architecture

Use seven concrete sections, with stable IDs:

| ID | Label | Contents / save owner |
| --- | --- | --- |
| `connection` | API & Connection | Existing shared API/profile fields; Sync action with explicit copy-to-five-modules help. Default landing section. |
| `automation` | Automation | Stable History and Generation Coordinator; links to module-owned cadence controls rather than copies. |
| `injection` | Injection | Existing global placement, XML boundaries, Ledger injection switch; links to Diagnostics Injection and Budget. Retain the Knowledge lorebook caveat: panic does not deactivate host World Info entries. |
| `modules` | Modules & Configuration | Global panic and six tracker enable switches; labeled Configure actions. Ambient/Calendar get owner links, not invented global enable keys. |
| `floating-buttons` | Floating Buttons | All seven visibility switches, style, collapse, reset positions. |
| `ambient` | Ambient Conditions — This chat | Existing Ambient form and actions, same renderer/wirer and per-chat persistence. |
| `backup` | Backup & Restore — This chat | Existing backup renderer/wirer; visually separate exports/recovery download from restore/undo. No engine changes. |

Do not create a second Overview: the existing top-level Overview already owns
orientation and maintenance. Link to it where useful. Do not add an empty
Accessibility section or a new reduced-motion preference merely to fill out
the old eight-section outline. Those can be separate features if needed.

### Disclosures and section headings

- The six global `details.mwt-settings-disclosure` groups are **dropped** in
  the workspace: the section navigation replaces them, and a collapsed
  disclosure inside a selected section would cost an extra click compared
  with today. Each former group becomes a headed block inside its section
  (Automation holds two). Keep `#mwt-settings-generation-coordinator` on its
  block as a scroll anchor. `test/collapsible_sections.test.js` expects six
  disclosures and Save/Sync outside them; replace it with the equivalent
  workspace assertions rather than deleting it.
- Ambient and Backup emit their own chrome: Ambient wraps itself in a
  collapsible `details#mwt-ambient-settings` with its own summary, and Backup
  emits an `<hr>` and `<h3>`. Add an option to each owner renderer to omit
  that outer chrome so the shell supplies the one visible section heading;
  the forms, IDs, wiring, and persistence stay untouched. Ambient's nested
  "Frequency-shaped phenomena" and "Pin conditions" disclosures stay. Keep
  `#mwt-ambient-settings` on the form root, since `wireAmbientSettings()`
  and the Overview link both look it up.
- Replace two stale strings while the template moves: "Replace the 4
  floating buttons" (there are seven), and the closing "Module-specific
  settings are available in each tab's ⚙ Settings button" paragraph, which
  Slice 3's Configure rows supersede.

### Navigation and action area

- Desktop: labeled vertical tablist, backed by the existing `wireTablist()`.
  Use workspace-specific tab/panel selectors and Settings as `scope`; nested
  main, Diagnostics, and Ledger tabs must not be captured.
- The helper pairs tabs/panels **in DOM order**, not by section ID. Render both
  from one ordered section definition. Retain its returned controller. The
  controller is index-based (`select(index, focus)`), so the seam owns the
  section-ID ↔ index map.
- Export one **select-section-by-ID** entry point from the seam. The picker,
  rebuild restoration, Slice 3's Ambient link, and the two existing Overview
  links all go through it. An unknown ID falls back to `connection`.
- `onActivate` fires for the controller's programmatic `select()` as well as
  for clicks and keys (the helper's docstring says user-driven only; only the
  initial normalization is silent). Update the session state and the picker
  from that one callback so every path stays in sync.
- Every section change resets `.mwt-modal-body` scroll to the top, because all
  panels share the modal's one scrolling body; a deep link then scrolls on to
  its target. This is the 2.8.9 Overview-link fix applied to sections.
- Overview's `generation-coordinator` and `ambient-settings` targets must
  select the `automation` / `ambient` section before scrolling. Update
  `wireOverviewPane()` and `test/dashboard_pane.test.js` in Slice 2, in the
  same change that introduces the sections.
- Mobile at the existing 768px breakpoint: hide the desktop strip and expose a
  labeled native `select` using the same section IDs. Its change handler calls
  the same controller; desktop activation updates the picker. Do not create a
  second copy of the forms.
- Mobile panel naming: leave the helper's `role="tabpanel"` and
  `aria-labelledby` as stamped (it sets them unconditionally, so overriding
  them per breakpoint would be fragile; a hidden tab still supplies the
  accessible name) and give every section a visible heading. Confirm with a
  screen reader in the host gate. Breakpoint changes must preserve selection
  and keep focus on a visible control.
- Keep global Save in a shared sticky action area **outside** section panels.
  Scope help must remain visible even in Ambient/Backup. Sync may live in the
  connection section because it is API-specific; it is not a second Save.
- Reuse the modal's existing live statusbar; do not introduce duplicate live
  announcements. Sticky content must not cover the last field or focused item.
- Reuse existing theme variables and shared grid/disclosure/action styles;
  add scoped `.mwt-settings-*` layout classes rather than more inline styles.
  Native controls only; no UI framework or new runtime dependency.
- Start without live navigation badges. Any later summaries must distinguish
  unsaved form state from saved/effective state and never recompute Diagnostics
  or Budget reports. No state communicated by color, emoji, or title alone.

## 5. Implementation slices and exit gates

### Slice 1 — Establish a testable form seam (behavior-preserving)

1. Extract the global form rendering, patch collection, and wiring behind a
   small injectable seam, following `core/main_tabs.js`'s render/wire precedent.
   Choose the filename during implementation; it is not an existing module.
2. Keep SillyTavern integration/orchestration in `index.js`; pass callbacks or
   dependencies rather than importing host-heavy `index.js` into tests.
3. Preserve all control IDs, `GLOBAL_API_FIELD_IDS`, current readers/clamps,
   Save side effects, Sync, profile visibility, and reset actions.
4. Pin current values and side effects with executable jsdom tests before
   changing layout. Migrate source-shape tests as necessary; do not simply
   delete coverage that expects the current disclosure template.
   `test/collapsible_sections.test.js` slices the template out of `index.js`
   source, so it breaks as soon as the template moves; point it at the seam
   in this slice.
5. Pin the §3.1 empty-field fix (empty → default) in the same tests; the
   handler lives in `index.js` today, so it has no executable test until the
   seam exists.

**Exit:** same persistence and actions under the current layout; new tests call
the production seam, not a parallel reimplementation of its save reader.

### Slice 2 — Workspace shell and responsive navigation

1. Render the seven sections, keep every form mounted, and move existing owner
   renderers into the relevant sections without changing their save behavior.
2. Add vertical tabs, mobile picker, shared selected-section state, scoped CSS,
   visible headings/help, and the global action area described in §4.
3. Restore selection and visible focus across rebuilds; rewire once per fresh
   element, without stacking handlers on surviving nodes.
4. Keep detailed module forms in their existing destinations. Retain the Ledger
   two-way switch updates and Ambient/Backup event wiring after every rebuild.
5. Drop the six global disclosures, add the omit-chrome option to the Ambient
   and Backup renderers, and ship the `[hidden]` rule (§3.1, §4).
6. Route Overview's two Settings links through the select-section entry point
   and reset body scroll on every section change.

**Exit:** cross-section Save parity and all existing actions pass; both
navigation variants select the same panels without losing drafts; chat switch
and reopen retain section choice without leaking prior-chat data; Overview's
Coordinator and Ambient links land on the right section and target.

### Slice 3 — Module discoverability

1. Provide a concise row for each of the six globally switchable trackers and
   owner links for Ambient and Calendar. Explain disabled state in text.
2. Configure activates the correct top-level tab and then invokes that module's
   real settings entry point from the §2 table: open a disclosure, call the
   in-place settings view's opener, or open the lazy panel. Reveal and focus
   the target, not merely the tab.
3. For Ambient, select the Settings Ambient section; for Calendar, use its
   existing top-level panel. Do not add global controls for their per-chat data.
4. Use small owner-facing adapters where necessary; do not scatter brittle DOM
   clicks or assume every module has the same settings UI. Keep Configure usable
   while a tracker is disabled, without enabling it as a side effect.
5. Each adapter's "open" is idempotent: Configure on an already-open target
   leaves it open. Interiority's button is a toggle, so do not click it;
   expose an open function. Chronicle needs its opener exported.
6. Chronicle's and Knowledge's settings views replace the tab's current
   content. Configure must respect whatever unsaved-edit guard that content
   has and must not discard an in-progress view silently.

**Exit:** every listed configuration destination is reachable by keyboard,
including Chronicle's and Knowledge's in-place settings views and
Interiority's lazy panel; repeating Configure never closes its target;
existing unsaved-edit and focus guards survive.

### Optional follow-up — Settings consolidation

Only after real use, decide whether to keep deep links or move any detailed
forms. Deep links to a single owned form are a valid final architecture, not an
unresolved duplicate-source problem. Moving forms would require a separate
scope covering save ownership, per-chat/global precedence, dirty-edit guards,
and modal/module lifecycles. Do not build duplicate editable copies.

## 6. Validation required during implementation

### Automated gates

- Save parity from **every** section with non-default API, numeric, role,
  checkbox, and style values; assert the full expected patch and one save.
  Include depth zero, unchecked switches, and existing numeric boundary cases.
- Section changes retain node identity and drafts; closed disclosures and
  profile-hidden fields remain readable. No save occurs on navigation alone.
- Vertical Up/Down wrap, Home/End, selected/hidden/roving-tabindex consistency;
  nested tablists remain independent. Desktop/mobile state stays synchronized.
- Repeated renders and rewiring do not stack Save, Sync, picker, Ambient,
  Backup, or Configure listeners. Unknown section state falls back safely.
- Rebuild tests cover Settings both active and inactive, section restoration
  before focus, and safe focus fallback when the original target is hidden.
- Global Save versus separate Ambient save/immediate actions; chat-scope guard
  behavior; Ledger switch synchronization in both directions; independent
  enable/visibility; existing coordinator/injection/panic callbacks.
- Sync uses unsaved API inputs and only the five current LLM module callbacks;
  profile selection (including a missing saved profile) survives unrelated Save.
- Backup export/preview/confirm/undo/recovery behavior still works after section
  switching, without weakening restore scope and busy-state guards.
- Overview's `generation-coordinator` and `ambient-settings` links select the
  owning section, reset body scroll, and reach their anchor from any
  previously selected section.
- Each Configure adapter is idempotent (twice in a row leaves the target
  open) and works while its tracker is disabled.

Relevant existing suites include `test/dashboard_pane.test.js`,
`test/tab_navigation.test.js`,
`test/main_tabbar_adoption.test.js`, `test/collapsible_sections.test.js`,
`test/connection_profile_fields.test.js`, `test/module_connection_profile.test.js`,
`test/settings_schema.test.js`, `test/settings_provenance.test.js`,
`test/ledger_plumbing.test.js`, `test/ledger_ui.test.js`,
`test/ambient_surface.test.js`, `test/backup_ui.test.js`, and
`test/backup_calendar_ambient.test.js`. Some assert source/template shape;
update them deliberately when extracting the seam. Existing tests alone do not
prove workspace Save parity. Run focused suites per slice, then `npm test` and
`npm run lint` before merging.

### Host/manual release gate (not proven by jsdom)

- Keyboard-only and screen reader: nested navigation, mobile picker, section
  naming (panels named by a hidden tab on mobile), Configure targets and their
  focus, Save scope, single status announcement.
- Only the selected section is visible in the real host stylesheet stack
  (the `[hidden]` rule holds against MWT and SillyTavern `display` rules).
- Overview → Coordinator and Overview → Ambient land on the target, scrolled
  into view, on desktop and mobile.
- Desktop near the modal's 960px maximum, tablet, 768px boundary and narrower
  mobile, long labels, 200% zoom, both themes: no clipped controls, hidden focus,
  oversized secondary strip, or sticky action overlay.
- Resize while either navigation has focus; chat switch while a field has
  focus; close/reopen; disabled tracker Configure; missing connection profile.
- Global Save, Sync, reset positions, Ledger strip, Ambient Save/pins/phenomena,
  Backup preview/cancel/confirm/undo/recovery on disposable chat data.
- Reduced-motion behavior and host styles remain unchanged.

Update `USER_GUIDE.md` and the setup guide's control-location instructions when
the UI actually ships, not as part of this proposal refresh.