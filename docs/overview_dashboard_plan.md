# MWT Overview dashboard + Maintenance tools — build plan

**Project:** one build covering two `TODO.md` §3 items — the **Unified MWT
dashboard** and the remaining (mutating) half of **User-facing UI for the
existing `window.MWT.*` console tools**.
**Status:** In progress — Phases 1–2 landed 2026-09-10; Phase 3 implemented;
Phase 4 waits on open decision point §4.3.4. Target version ≈ 2.8.0 (adjust
freely).
**Origin:** the 2026-09-10 review question "should those two §3 items be one
build?" — answer and rationale in §1.

---

## 1. Decision record — one build, one tab, two sections

The two items pair naturally, and the repo's own planning docs already point
this way:

1. **The console-tool promotion was explicitly waiting for "a home."**
   [`archive/completed_plans/DIAGNOSTICS_PANEL.md`](../archive/completed_plans/DIAGNOSTICS_PANEL.md)
   §I.2 (non-goals) listed *"Promoting the console tools to buttons … a
   follow-up once the panel exists and has a home for them"* — and ruled the
   🩺 Diagnostics panel out as that home: *"Any write path. If a v1 control
   mutates state, it is out of scope"* (§I.1 — read-only by contract). A new
   tab is that home; the Diagnostics contract stays intact.
2. **The dashboard's signals are the tools' triggers.** The audits behind the
   maintenance tools (`MWT.profiles.duplicates()`, `MWT.npcs.auditDuplicates()`,
   `MWT.evidence.list()`, `MWT.interiority.deletions()`) report exactly the
   "something needs attention" conditions a dashboard exists to surface. Split
   builds would force the tool UI to invent its own "you have N problems"
   surfacing — which *is* the dashboard.
3. **Same plumbing.** Both halves are thin presentation over accessors that
   already ship (§2.1–2.2) — several were built *for* this day:
   `getDocumentStatus()` is commented "for the diagnostics console / future
   dashboard," and `getCoordinatorSnapshot()` is "designed to be consumable by
   a future diagnostics row without another shape change." One collector
   module, one tab shell, one set of tests.
4. **Tab-bar economy + cadence separation.** Eight tabs today (`TABS`,
   `index.js:215–230`); two separate additions → ten. One combined 🏠 Overview
   tab → nine, and it becomes the natural landing tab. The routine half
   (status glance) and the rare half (surgical maintenance) stay visually
   separated *inside* the tab: the 🧰 Maintenance section only populates when
   an audit actually finds something (§4.3.3).

What this plan does **not** change: DIAGNOSTICS_PANEL.md §I.2's split —
*"the dashboard is a workflow view (overdue beats, pending staging), this is a
fault-finding view."* Overview **links** to 🩺 Diagnostics and 📊 Budget; it
does not re-render their tables (§3, invariant 2).

---

## 2. What already exists (verified against source 2026-09-10, v2.7.0)

### 2.1 Signals — every status card has an accessor today

| Card | Accessor | Where | Notes |
|---|---|---|---|
| World State staleness | `getDocumentStatus()` | `world_state/index.js:229` | `kind: 'empty'｜'manual'｜'stale'｜'delta'｜'reconciled'` + `msgsSinceRefresh`, `deltasSinceFull`, … |
| Pending staging items | `getStagingCount()` | `knowledge/index.js:997` | proposals awaiting review (the float button's orange signal) |
| Unread growth evidence | `getGrowthEvidenceCount()` | `knowledge/index.js:1005` | the float button's green signal |
| Waiting / overdue beats | `getBeatStatus()` / `getOverdueArcs()` | `story_planner/index.js:285` / `story_planner/data.js:329` | `{awaiting, overdue}`; `core/ui.js:947` already aggregates these for the float button |
| Active / dormant intentions | `getActiveLedger()` / `getDormantLedger()` | `interiority/data.js:1048` / `:1061` | active = injected + evaluated per turn; dormant = scheduled |
| Token load | `collectBudgetSnapshot()` | `budget/panel.js:55` | per-module tokens/kind/plan, `injectedTokens`, `contextLimit`, `dropOrder`, `enforce` |
| Busy / queued / held | `getCoordinatorSnapshot()` | `core/coordinator.js:733` | `running`, `queued`, `recentSettled`, `limits`, `userGeneration` (incl. `backgroundPaused`) |
| Per-module last run / auto / busy | `collectHealthSnapshot()` + `HEALTH_MODULE_SPECS` | `diagnostics_panel/health.js:202` / `:49` | the ❤️ Health tab's collector — reuse it, don't re-implement |
| Deleted-intention records | `getDeletedIntentions()` | `interiority/data.js:732` | feeds the Interiority maintenance row |
| Quarantined records | `collectQuarantineStatus()` | recovery bridge, `index.js:1665+` | optional card → links to 🗂️ Scope & storage / 🛡️ Integrity |

### 2.2 Tools — the mutating console bridge and its guards (`index.js`)

| Console tool | Guard semantics today | Plan |
|---|---|---|
| `MWT.profiles.pruneDuplicates(confirm)` — `:1221` | Dry-run first: keep/delete table (keep = registry-referenced, else largest, tie → highest uid). **Skips** `(unnamed)` groups and tied-size cases — "needs eyes, not a heuristic." `confirm === true` deletes via `deleteProfileEntries()`; warns profiles are "regeneratable from evidence, but only if the evidence is still there." | Phase 4 — preview→confirm modal; skipped cases render as "review by hand," never a button |
| `MWT.profiles.relink(confirm)` — `:1285` | Dry-run plan (`npc → uid`, `was: (none)/(dangling)`, `otherCandidates`); warns when `otherCandidates > 0`; skips unnamed + registry-unmatched entries; `true` applies `setProfileUid()` + `flushBook()` | Phase 4 — plan→confirm modal |
| `MWT.evidence.clear(name)` / `.clearAll(confirm)` — `:1048` / `:1055` | Single-NPC clear warns orphaned profiles after. `clearAll` refuses unless `true`, lists affected NPC names, warns "cannot be undone and re-capturing costs API calls." Both call `warnOrphanedProfiles()`. | Phase 4 — confirm modal naming NPCs + the cost warning |
| `MWT.interiority.clearDeletions()` — `:1550` | Unguarded today (semantics: deletion records forgotten — "these intentions may be proposed again") | Phase 4 — count + consequence-stated confirm |
| Read-only audits: `MWT.profiles.{list,duplicates}`, `MWT.npcs.auditDuplicates()`, `MWT.evidence.list()`, `MWT.interiority.deletions()` | `console.table` reports; `npcs.auditDuplicates()` deliberately explains why it offers no automatic cleanup | Phase 3 — become the 🧰 Maintenance section's data, via shared collectors |

Console-only **on purpose** (not in this build): `MWT.scope.diagnose()` (dev
tool), `MWT.modal.releaseManagedInert()` (emergency escape hatch),
`MWT.recovery.clear` (its own comment: "deliberately console-only until a
mutating recovery UI is designed" — future 🧰 resident, own plan),
`MWT.coordinator.cancel` (the panic switch already owns stopping).

### 2.3 Shell seams

- **`TABS`** (`index.js:215–230`) — the `module: null` pattern for non-feature
  tabs (🩺 Diagnostics, 📊 Budget, ⚙️ Settings).
- **`buildTabContent(tab)`** (`index.js:443–458`) — dispatch by `tab.id`
  (`renderDiagnosticsPanel()`, `renderBudgetPane()`). The modal body is rebuilt
  on every open ⇒ the **open-and-read** refresh model (the D2 rule the
  Diagnostics tabs use).
- **`core/main_tabs.js`** — `renderMainTabShell()` / `wireMainTabBar()`
  (WAI-ARIA tabs, roving tabindex). `test/main_tabbar_adoption.test.js:30–39`
  **pins the tab list** — update it in the same commit as the `TABS` change.
- **Deep links** — click the tab button (`#mwt-tab-<id>`); the adoption test
  uses exactly this mechanism, so it is the sanctioned path.
- **`core/modal.js`** — `createModal({id, title, content, onClose, …})`,
  `showModal()`/`hideModal()`, `setStatus(el, msg, type, clearAfterMs)`;
  stacked modals + managed inert are already handled and tested
  (`test/modal_interactions.test.js`), which is what a preview dialog *over*
  the Overview tab needs. `setControlBusy()` (index.js) for in-flight buttons.
  The backup restore flow (preview → fingerprint confirm → commit) is the
  house precedent for two-step destructive confirmation.

---

## 3. Invariants (must-not-break)

1. **Diagnostics stays read-only.** No write action is added to the 🩺 panel or
   its collectors. Overview is the only new home for mutating controls.
2. **One collector, two surfaces.** Every number Overview shows and every audit
   🧰 renders comes from a module the console bridge also calls — the
   established pattern (the Diagnostics panel's health/environment collectors:
   "console bridge and tab share one collector so they can never disagree").
   Concretely: the audit logic currently living *inside* `index.js` bridge
   closures (`auditProfiles()` at `:1087`, the `npcs.auditDuplicates` loop at
   `:1371+`) is extracted to shared modules in Phase 3 and the bridge is
   rewired onto them, with parity tests pinning the output.
3. **Guard parity.** Each UI action preserves its console twin's safety
   semantics: preview before write, consequence-stated confirm, and the
   deliberately-unautomatable cases (`(unnamed)` entries, tied-size
   duplicates, ambiguous alias collisions) render as **"review by hand"**
   with the console command named — never a button that hides the heuristic's
   limits.
4. **Guarded cells.** One broken accessor can never blank the pane — each card
   renders its own error state (the ❤️ Health tab rule).
5. **Open-and-read.** No polling, no timers in v1. The pane snapshots at open;
   a 🔄 button re-collects and re-renders the pane in place. The float buttons
   already own the live-badge job.
6. **Accessibility floor** (the repo-wide pass already shipped): decorative
   emoji in `aria-hidden` spans, real `<button>`s for every action,
   `role="status"` empty states, focus handling for free via the existing
   tablist wiring.
7. **Lint gate stays correctness-only**; no style rules ride along.

---

## 4. Target shape

### 4.1 Layout

```
🏠 Overview (first tab — see §4.3.1)
├─ Status cards grid (Phase 2) — one card per signal, each a deep link:
│    🌍 World State — staleness kind + msgsSinceRefresh
│    🧠 Knowledge — pending staging count, unread growth evidence
│    🗺️ Story Planner — awaiting / overdue beats
│    💭 Interiority — active / dormant intention counts
│    📊 Budget — injected total vs context limit, enforce mode (summary only)
│    🚦 Coordinator — running / queued, "background HELD" when paused
│    ❤️ Health — one compact line per module: busy / auto / last run
│        (from collectHealthSnapshot(); detail stays one click away in 🩺)
├─ 🧰 Maintenance (Phases 3–4) — rendered only when an audit finds
│    something; per finding: what, why, and a [Preview …] action
└─ Footer — links to 🩺 Diagnostics ("something looks wrong?") and 📊 Budget
```

### 4.2 New module: `dashboard/`

Mirrors `budget/` and `diagnostics_panel/` (collector / render / wire split,
own tests, no new core logic):

- `dashboard/status.js` — `collectOverviewSnapshot()` (Phase 1): pure,
  deps-injected aggregation over the §2.1 accessors, JSON-safe, each cell
  individually guarded (`{ok, value}` / `{ok:false, error}`).
- `dashboard/render.js` — `renderOverviewPane()` / `wireOverviewPane()`
  (Phase 2).
- `dashboard/maintenance.js` — `collectMaintenanceFindings()` + preview/apply
  wrappers (Phases 3–4) calling the same underlying APIs the console bridge
  calls.
- `knowledge/profiles_audit.js` (Phase 3 extraction) — `auditProfiles()`,
  `planPrune()`, `planRelink()`, `auditNpcIdentities()` moved out of the
  `index.js` closures; planning split from applying (the UI needs plan-only;
  the console keeps plan + apply). The bridge becomes a thin `console.table`
  wrapper — console output unchanged.
- `dashboard/style.css` — the `budget/` precedent (diagnostics styles live in
  `core/style.css`; either is fine — pick one and stay there).

### 4.3 Decision points (defaults chosen; cheap to flip before Phase 2)

1. **Tab position: first = default landing.** A dashboard you must hunt for
   isn't a dashboard. Cost: the first-open landing moves off 🌍 World State
   (`renderMainTabShell` marks index 0 active; `TABS` order decides).
   Alternative: slot before 🩺 Diagnostics and keep 🌍 as landing.
2. **No live refresh in v1** — open-and-read + 🔄. Revisit only if testers ask.
3. **🧰 hidden when clean** — the "dangerous buttons in a daily view" problem
   solves itself; the section's empty state names the console commands for
   power users.
4. **OPEN — findings vs. tools (decide before Phase 4).** Raised in the
   Phase 3 review: two of the four §2.2 tools don't fit "🧰 only renders when
   an audit finds something." Interiority tombstones are normal state (every
   intention deletion writes one, capped at 200), so a deleted-intentions
   *finding* keeps 🧰 visible for nearly everyone — and the count already has
   its own status card. `evidence.clearAll` has no finding that could ever
   surface it, and no UI anywhere clears evidence today.
   *Recommendation:* drop deleted intentions from the findings (the card keeps
   the count) and split 🧰 into **Findings** (hidden when clean) and a
   collapsed **Tools** disclosure holding clear-deletions and
   clear-all-evidence. *Alternative:* put those two actions in their owning
   tabs (💭 Interiority, 🧠 Knowledge).

---

## 5. Phase plan

| # | Phase | Delivers | Tests |
|---|---|---|---|
| 1 | Collector | `dashboard/status.js` — `collectOverviewSnapshot()` | `test/dashboard_status.test.js` |
| 2 | Read-only tab | 🏠 Overview tab: status cards + deep links + 🔄 | `test/dashboard_pane.test.js` + adoption-test TABS update |
| 3 | Maintenance audits (read-only) | `knowledge/profiles_audit.js` extraction + 🧰 findings rows + console parity | `test/profiles_audit.test.js` (+ parity) |
| 4 | Guarded writes | preview→confirm modals for the four tools | `test/dashboard_maintenance.test.js` |
| 5 | Polish + release | docs, CHANGELOG, TODO tick-off, version bump | — |

Each phase lands green (tests + lint) and is independently shippable —
Phase 2 alone already retires the "Unified MWT dashboard" checkbox's spirit
(read-only half), exactly like Diagnostics v1 did for its item.

### Phase 1 — collector (no UI)

- `collectOverviewSnapshot(deps?)` — deps-injected like
  `collectBudgetSnapshot()` / `collectHealthSnapshot()`, so it is testable
  with stubs (`test/stubs/` where needed).
- Shape: one entry per §2.1 row, each cell `{ok, value}` or `{ok:false,
  error}` (guarded-cell invariant). JSON-safe (same rule as the coordinator
  snapshot).
- **Acceptance:** unit tests over stubbed accessors, including a throwing
  accessor → that one cell errors, every other cell intact.

### Phase 2 — the tab (read-only)

- `TABS` entry (`{ id: 'overview', label: '🏠 Overview', module: null }`) +
  `buildTabContent` dispatch + `wireOverviewPane(modal)` call in
  `renderModal()`'s rebind loop; **update `test/main_tabbar_adoption.test.js`'s
  pinned list in the same commit.**
- Cards: `<button>` deep links via `#mwt-tab-<id>` click; counts in human
  wording ("3 beats overdue — /wt-beat to review"); `role="status"` empty
  variants; 🔄 re-collects and re-renders the pane in place.
- **Acceptance:** jsdom render test — cards render from a stubbed snapshot;
  deep-link click activates the target tab; a broken cell renders its own
  error without blanking the pane.

### Phase 3 — audits, extraction first

- Move `auditProfiles()` + the prune/relink *planning* + the NPC-identity
  audit out of `index.js` into `knowledge/profiles_audit.js` (planning split
  from applying — the UI needs plan-only; the console keeps plan + apply).
- `collectMaintenanceFindings()` → finding rows: duplicate profiles (count +
  needs-review count), relink candidates (count + `otherCandidates` warnings),
  NPC identity audit rows (read-only guidance — its cleanup is manual **by
  design**), deleted-intention records count.
- Rewire the console bridge onto the shared module; **parity tests** pin the
  console output shapes so behavior cannot drift.
- **Acceptance:** 🧰 hidden when clean; each finding names the underlying
  reason in plain language; parity tests green.

### Phase 4 — guarded writes

- Per tool: preview modal (plan table) → consequence-stated confirm → apply →
  `setStatus()` toast → pane re-render (re-collect). Every write path
  busy-guards (`setControlBusy`) and survives double-click.
  - **prune** — keep/delete table + the "regeneratable from evidence" caveat;
    `(unnamed)`/tied-size rows listed as manual, not actionable.
  - **relink** — plan table incl. the `otherCandidates > 0` warning (offer
    `duplicates()` review first).
  - **evidence.clearAll** — affected NPC names + API-cost warning; two-step
    confirm matching the backup-restore precedent.
  - **clearDeletions** — count + "these intentions may be proposed again."
- **Re-plan at confirm; never apply the previewed plan.** The console's
  `pruneDuplicates(true)` / `relink(true)` recompute their plan when
  confirming, and `deleteProfileEntries()` resolves the book at call time — so
  a preview applied after a chat switch (or a background profile write) could
  delete those uids from a different book. Capture the book name + uids at
  preview, re-plan at confirm, and refuse with a fresh preview if they differ
  (the backup-restore fingerprint precedent).
- **Acceptance:** jsdom tests per tool — preview content, skip-cases rendered
  but not actionable, confirm applies via stubbed API, refusal paths covered.

### Phase 5 — polish + release

- README + CHANGELOG entries; cross-note in `DIAGNOSTICS_CONSOLE_GUIDE.md`
  (console tools remain the power-user path); tick both TODO §3 items with
  landed notes pointing here; bump version.
- CHANGELOG **Fixed** line owed by Phase 3: `MWT.profiles.pruneDuplicates()`
  could queue a comment-less profile entry for deletion — its "never prune
  unnamed entries" guard compared `''` with `'(unnamed)'` and never fired.
  The extraction's `nameKey()` closed it (pinned in
  `test/profiles_audit.test.js`).

---

## 6. Non-goals / later residents

- No new automation, triggers, or polling — Overview observes; it never acts
  on its own.
- Budget **management** stays in 📊 Budget; fault-finding stays in 🩺
  Diagnostics. Overview shows summaries and links.
- `MWT.recovery` UI (quarantine clear) — a future 🧰 resident with its own
  plan; its `{confirm:'CLEAR'}` token design needs translating to a modal.
- **"Pause background automation for this chat"** (TODO §3) — a natural
  future Overview toggle, but a separate item; fold in only if it happens to
  be ready at the same time.
- Cross-module undo/redo (TODO §3) — separate item, no interaction.
- Float-button redesign — none; they keep the live-badge job.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Overview re-implements Health/Budget detail | Invariant 2 + cards show counts only; detail is one click away |
| The Phase 3 extraction regresses console tools | Parity tests pin console output; the bridge stays a thin wrapper |
| Landing-tab change surprises users (§4.3.1) | Decide before Phase 2; call it out in the CHANGELOG entry |
| Write actions buried once audits run clean | By design — clean means hidden; the empty state names the console commands |
| Ninth tab crowds the bar on mobile | Label stays short ("🏠 Overview"); the parked settings-workspace project may later reorganize navigation anyway |
| Preview dialog opens over the main modal | `core/modal.js` already stacks + manages inert; covered by `test/modal_interactions.test.js` |

## 8. Definition of done

- Both TODO §3 items tickable, with landed notes pointing here and to the
  CHANGELOG.
- A tester can, **without devtools**: see everything waiting on them in one
  view; reach each module's action in one click; find and run every §2.2
  maintenance tool with the same safety guarantees as its console twin.
- Console bridge output unchanged (parity tests green); full suite green;
  lint clean.

## 9. File map

**Created:** `dashboard/status.js`, `dashboard/render.js`,
`dashboard/maintenance.js`, `dashboard/style.css`,
`knowledge/profiles_audit.js`, `test/dashboard_status.test.js`,
`test/dashboard_pane.test.js`, `test/profiles_audit.test.js`,
`test/dashboard_maintenance.test.js`.

**Modified:** `index.js` (TABS entry, `buildTabContent` dispatch, pane wiring,
console-bridge rewire onto the extracted audit module),
`test/main_tabbar_adoption.test.js` (pinned tab list), `CHANGELOG.md`,
`README.md` (if it documents the tab list), `DIAGNOSTICS_CONSOLE_GUIDE.md`
(cross-note), `docs/TODO.md` (tick-off, Phase 5).

---

*Drafted 2026-09-10 from the §3 review of `docs/TODO.md`; all file/line
references verified against v2.7.0 on that date — re-check line numbers when
phases start landing.*




