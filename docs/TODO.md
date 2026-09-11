# Merged World Tracker — Forward TODO

> **What this is.** A single, reconciled work list for the *improvement / feature*
> work that remains. It folds together [`archive/audits/Potential_Improvements.md`](../archive/audits/Potential_Improvements.md)
> (the feature/architecture wishlist) and [`archive/audits/REMEDIATION_MAP.md`](../archive/audits/REMEDIATION_MAP.md)
> (the bug-fix queue), so the two source files can be treated as archived
> reference and this file becomes the live queue.
>
> **Status at a glance (re-verified 2026-08-22):**
> - 🟢 **Bug-fix baseline: COMPLETE.** All 48 code findings + 6 test-coverage gaps
>   from the 2026-08-02 audit are closed (Tier 0 → Tier 5 + both follow-up passes).
>   The shared primitives (`core/scope.js`, `core/revision.js`, `core/prompt.js`,
>   `core/api.js`) are built **and** wired into production.
> - 🟢 **Tests:** 9 files / 165 tests at audit time → 21 files / 430 at the last
>   glance → **99 files / 2493 tests now** (suite re-run 2026-09-11, all green —
>   includes the schema validation + migrations milestone, Parts 1–7, the
>   World State delta-mode feature, the Knowledge per-field dossier
>   refresh, the entity identity + alias service, the §6 deeper-coverage
>   pass: API failure families, generation commit races, import/export round
>   trips, lorebook hydration retry, and modal interactions, and the
>   Overview dashboard: status collector, pane, profile-audit extraction,
>   and maintenance tools).
> - 🟢 **Lint + CI:** ESLint (correctness-only) + GitHub Actions (lint+test, Node
>   20 & 22) shipped and green. `manifest.json homePage` populated. The Appendix A
>   zero-churn rule expansion (`eqeqeq`, `prefer-const`, `no-shadow`, …) landed in
>   v1.5.0.
> - 🟢 **Diagnostics panel: COMPLETE (v1.5.1 → v1.7.10).** All 13 phases shipped
>   (Phase 13 landed 2026-08-21): instrumentation (event ring, API-call capture,
>   injection recording, recovery counters, settings provenance), the 🩺
>   Diagnostics tab with seven live sub-tabs + redacted 📋 Copy Report, the
>   `MWT.diagnostics.*` console bridge, and the shared redaction layer. See §2
>   below and `archive/completed_plans/DIAGNOSTICS_PANEL.md`.
> - 🟢 **Backup/restore + housekeeping tail: COMPLETE (v1.5.0).** Unified
>   chat-local backup/restore (engine + UI), CHANGELOG started, Vitest
>   `world-info.js` warning silenced.
> - 🟡 **What's left = this file:** the §1 subsystems (entity identity now
>   heads the queue — schema validation + migrations finished in 2.0.0; the
>   central generation coordinator + cancellation model shipped in 2.4.0), the
>   §2 context-budget panel **(shipped 2.5.0)**, the "Bucket C" feature work, and a small
>   housekeeping tail (ST-version/fork compat notes).
>
> Source-file status: `REMEDIATION_MAP.md` has exactly one open checkbox left
> ("re-open Bucket C") — i.e. *this file*. `Potential_Improvements.md` remains the
> detail behind each feature item; open it only when you need the why behind one.

---

## How this list is organized

The source docs already triaged everything into three buckets. This file keeps
that split because it predicts the *kind* of work each item is:

- **§1 — Subsystems (Bucket B).** Bugs behind these were fixed "as bugs now,
  behind one seam." The seam exists; the full subsystem does not. **Highest
  leverage** — each one retires a whole class of future bugs.
- **§2 — Reliability hardening still open.** The budget *mechanism* and prompt
  boundary work landed as bug fixes; the user-facing panels did not.
- **§3 — New features (Bucket C).** The genuinely new, deliberately-deferred work.
- **§4 — UX / accessibility / polish.**
- **§5 — Housekeeping / release hygiene.** (Where your completed lint + CI live.)
- **§6 — Optional deeper test coverage.**

Priority tags: **P1** = reliability impact worth doing before nice-to-haves;
**F** = feature; **H** = housekeeping. `[partly done]` = a seam exists.

Work is not blocked top-to-bottom — pick what you want — but the
[recommended order](#recommended-order) at the bottom reflects what the audits
argued gives the most safety per unit of effort.

## §1 — Subsystems that unify several now-fixed bugs (Bucket B) · highest leverage

These three supersede clusters of findings that were already fixed as individual
bugs. Building the subsystem now means the next similar bug is fixed in one
place, not six. Each bug fix already routed through the intended seam, so the
subsystem *replaces one thing instead of twenty*.

- [x] **Schema validation + migrations as a first-class subsystem** `[done in 2.0]`
  - Seam exists: one validator per store was added for STORY-PLANNER-04,
    WORLD-STATE-07, KNOWLEDGE-07, CHRONICLE-04.
  - Done — **all seven parts of
    [`SCHEMA_VALIDATION_MIGRATIONS_PLAN.md`](../archive/completed_plans/SCHEMA_VALIDATION_MIGRATIONS_PLAN.md)
    landed (v1.8.1 → 2.0.0)**: versioned schemas + a migration runner for
    every authoritative store; validate-on-load (the runtime gate), on
    import, and on backup restore; quarantined invalid records kept
    recoverable (exportable "recovery data", never silently dropped);
    unknown future versions refused untouched; blocked stores pause only
    their own module, visibly (banner + Retry + Diagnostics rows); plus the
    final Part 7 coverage pass — settings (`createSettingsManager()`
    records validated + version-stamped, fail-open) and the remaining
    browser-local records (`mwt_float_positions`, `kt_history_*`,
    `mwt_uuid` message stamps). Covered: IDs/duplicate IDs, dates/anchors,
    section/status enums, malformed/missing text, provenance refs,
    interiority ledger refs, story-arc beat indexes. *(Source: PI §2)*
- [x] **Entity identity + alias management service** `[done 2026-09-03 → 09-04 — v2.3.0 + v2.4.1]`
  - Seam existed: every name lookup routes through the single `getRegistryEntry()`
    accessor (KNOWLEDGE-03), with `normalizeRegistryName()` as the source of truth.
  - Shipped as `knowledge/identity.js` on top of that seam: canonical `entityId`s
    (lorebook-store schema v2 migration stamps them; `saveRegistry` keeps new
    records stamped), user-approved `aliases[]` the resolver honors (fail-closed
    on ambiguity), user-approved renames/merges that propagate through
    relationships + stances, the evidence map (quote-receipt links survive via
    namespaced ids), dossier watermarks, and label-verified lorebook/profile
    relabels; a `mergedFrom` audit trail; and `repairEntityLinks()` healing
    drifted edge names from stable `subjectEntityId`/`targetEntityId` pointers.
    UI: ✏️ Identity button on NPC cards; console: `MWT.npcs.rename/merge/
    addAlias/removeAlias/entityId/repairLinks`. *(Source: PI §4)*
    - [x] World State grounding + Interiority matchers now consult the alias
      list `[done 2026-09-04 — v2.4.1]` — `groundingGate()` takes
      `aliasGroups` from the new `collectRegistryAliasGroups()` (approved
      spellings ground outright, like pinned entities; a canonical name
      grounds through an alias in the evidence), wired into the full
      refresh, delta patches, and per-section regen. `buildSceneRoster`'s
      registry union matches aliases as well as keys (and reads the live
      store registry, which is where aliases live), and
      `resolveRosterName()` gained an explicit-alias step
      (`collectRosterAliases()` index, fail-closed on ambiguity) threaded
      through `mergeSplitResults`/`validateAndApply`/`runStrictCalls`/
      `getEvaluatedNpcNames`. Pinned by `test/alias_matchers.test.js`.
- [x] **Central generation coordinator + cancellation model** ✅ *shipped v2.4.0*
  - Per-module busy flags/timers/epochs are fixed (WORLD-STATE-08,
    INTERIORITY-03, STORY-PLANNER-03), but the modules still each issued their
    own calls. Done via `core/coordinator.js` — a central job queue both API
    transports (`fetchFromApi` / `fetchViaConnectionProfile`) submit through,
    so every module's outbound call is coordinated with zero per-module
    restructuring: per-module limit 1 + global limit (`apiMaxConcurrent`,
    default 2, 1–8), queued jobs with priorities (manual < auto < background),
    dedupe of pending jobs by key, `AbortController` cancellation (queued jobs
    never start; running calls abort mid-wire on custom-API mode, at
    dispatch/backoff boundaries on Connection-Manager mode — "where the
    backend supports it"; a chat switch retires stale-epoch jobs), a unified
    busy/queued/cancelled/failed status (`getCoordinatorSnapshot()`, the 📋
    Log tab's `coordinator` events, `MWT.coordinator.{status,jobs,cancel}`),
    and the optional `pauseBackgroundJobsDuringGeneration` policy
    (Settings → 🚦, default off, depth-counted so ST's double-fired stop
    events can't wedge it). Modules thread `trigger: 'auto'|'manual'` at the
    main generation call sites; cancellation surfaces as a quiet discard
    (`_mwtCancelled`), never a failure toast. Pinned by
    `test/coordinator.test.js`. *(Source: PI P1)*

---

## §2 — Reliability hardening still open

- [x] **P1 — Context / token budget PANEL** `[done 2026-09-05 — v2.5.0]`
  - Mechanism exists: per-module token budgets were added (WORLD-STATE-03) for
    prior state, section context, and injection.
  - Reporting half now exists too (2026-08-21): the ❤️ Health tab surfaces
    per-module token load and the 💉 Injection tab states token kind
    (recorded / est. / stored) per module — Diagnostics *reports* token load
    but deliberately does not *manage* it (DIAGNOSTICS_PANEL.md §I.2 non-goal).
  - Done — **`core/budget.js` + the 📊 Budget tab + `MWT.budget.*` shipped in
    v2.5.0**: a per-chat context budget adopted at the ONE seam every
    setExtensionPrompt injection already funnels through
    (`applyExtensionPromptInjection`), so all four injecting modules are
    covered with zero per-module restructuring. **Observe by default** — a
    fresh chat models only (the panel's "Budget action" column + Log-tab
    `budget_would_*` events); an explicit **Enforce** toggle per chat enables:
    soft caps → structure-preserving truncation with a visible
    `[…truncated ~N tokens]` marker (wrapper tags stay closed); hard caps →
    drop; the global hard cap drops lowest-priority first (an incoming payload
    displaces strictly-worse-priority registered modules through the same
    seam, never an equal-or-better one; if it still can't fit it drops and
    nothing is wasted). Default priority follows the original suggestion
    (current World State + triggered intentions first, then recent Chronicle,
    current Story Planner beats, older/reference material last) = World State +
    Interiority P1 → Chronicle P2 → Story Planner P3 → Knowledge advisory
    last, all editable. The panel shows estimated tokens per module (registered payload
    tokens for the seam modules; Knowledge's lorebook total as advisory-only),
    total vs the resolved context limit (ctx.maxContext / preset probes /
    manual override), and the drop-order model — one planner shared by the
    panel and the seam, so they can never disagree. Settings live in this
    chat's metadata (per-project, per the design decision). Never managed:
    ST's own prompt and Knowledge's World-Info-activated entries.
    Pinned by `test/budget.test.js`. See CHANGELOG 2.5.0 "Added". *(Source: PI P1)*
- [x] **P1 — Final-prompt inspection + request diagnostics panel**
  - Done — **all 13 phases shipped across v1.5.1 → v1.7.10** (Phase 13 landed
    2026-08-21). The 🩺 Diagnostics tab inside the MWT modal carries seven live
    sub-tabs (❤️ Health, 🌐 Environment, 🗂️ Scope & storage, 💉 Injection, 📡
    Last request, 📋 Log, 🛡️ Integrity) plus the redacted **📋 Copy Report**;
    `window.MWT.diagnostics.*` mirrors everything console-side. Injected blocks
    with role/depth/enabled per key, token estimates, last-request duration /
    model / profile / finish reason / usage, and redacted previews all shipped —
    chat content behind an explicit opt-in (default off), with API keys,
    custom-header values, and API-URL hosts redacted *unconditionally*
    (`core/redaction.js`). Design + per-phase landed notes:
    `archive/completed_plans/DIAGNOSTICS_PANEL.md`; user guides:
    `DIAGNOSTICS_GUIDE.md` (beginner) and `DIAGNOSTICS_CONSOLE_GUIDE.md`
    (repo root). Two deliberately-human follow-ups stay tracked in that doc's
    §0: live-build manual QA of the report (content OFF and ON) and the
    fork-compat finding log. **Pulled ahead of the schema-migration work on
    purpose** — read-only, and it multiplies the quality of tester reports
    mid-tester-wave. *(Source: PI P1)*
- [x] **P1 — Quiet the `world-info.js` Vitest warning**
  - Done. Added `test/stubs/world-info.js` (benign stand-in) and aliased
    `'../../../../world-info.js'` to it in `vitest.config.js`, so the top-level
    `await import` in `knowledge/lorebook.js` resolves cleanly instead of
    throwing. `knowledge/state.js` `wiScript` is now a tri-state (`undefined` =
    not yet attempted, object = loaded, `null` = tried and failed) so
    `knowledge/store.js` `getWiScript()` keeps its self-sufficient fallback import
    (for future callers like backup/restore that import `store.js` without going
    through the knowledge barrel) while tests that set `state.wiScript = null`
    still short-circuit directly. Added a `console.warn` to `hydrateBook`'s
    `!wi$` branch so a genuinely absent world-info is never silent. *(Source: PI
    testing; AUDIT_SUMMARY.md; co-author review)*

---

## §3 — New features (Bucket C)

- [x] **F — Unified backup/restore for all chat-local MWT data.** Chronicle and
  World State have export paths; add a user-facing, versioned backup for the
  *complete* chat state: world state + history, chronicle entries/trash, knowledge
  evidence + growth metadata, story arcs/history, interiority ledger + tombstones
  + per-message state, plus schema version + chat identity metadata. Support
  merge vs replace, validate every imported record, provide a dry-run summary.
  *(Source: PI §1)*
- [x] **F — Low-cost delta mode for World State.** Full refreshes are expensive.
  Add an incremental mode that asks the model only for changes since the last
  refresh and applies a validated patch, with periodic full reconciliation
  (section regen + provenance machinery is a good foundation). UI should surface
  whether the document is fully reconciled / delta-updated / manually edited /
  stale relative to chat. *(Source: PI §3)*
  *Shipped: `world_state/delta.js` (patch protocol `### UPDATE:`/`### REMOVE:`/
  `### NO CHANGES`, prompts, status bookkeeping, `planAutoRefresh`),
  `refreshWorldStateDelta`/`runScheduledWorldStateRefresh` in refresh.js (full
  guard stack + escalation-to-full after two rejected patches; reconciliation
  every `deltaReconcileEvery` partials), status chip in the World State toolbar,
  ⚡ Delta button, `deltaMode`/`deltaReconcileEvery`/`deltaStaleAfterMsgs`
  settings, and `getDocumentStatus()` for external surfaces. Tests in
  `test/world_state_delta.test.js`. See CHANGELOG 2.0.0 "Added".*
- [x] **F — Per-field / partial dossier refresh (Knowledge).** *User request —
  nice-to-have, not a priority.* Dossier-mode entries (the fields in
  `DOSSIER_FIELDS` at `knowledge/lorebook.js`: Role, Where to Find,
  Appearance, Voice, Background, Personality, Read on PC, Current Agenda,
  Secrets, Canon Lock, Image Tags) can go stale individually — e.g. an NPC's
  `agenda` is now outdated, or `appearance` changed in the story but wasn't
  captured — but today `runNpcUpdate` / `DOSSIER_UPDATE_PROMPT` always refreshes
  the whole entry. Add a way to refresh **specific** sections only: either a
  per-field "refresh" control on the dossier card, or a bulk "refresh stale
  fields" action, mirroring the World State delta-mode concept above but applied
  to a single NPC's dossier. **Must respect two existing ownership boundaries:**
  (1) `canon_lock` is user-authored immutable canon — never auto-overwrite; and
  (2) for NPCs with a growth profile, `personality` is owned by the evidence/
  growth system (`hasEvidenceFile(name)` null-out guard in `runNpcUpdate`,
  per `NPC_GROWTH_BLUEPRINT.md` §"The split-brain resolution") — a field-scoped
  refresh must keep that partition or it reintroduces the "telephone loop." A
  field-staleness signal (last-updated timestamp or message-count watermark per
  field) would let the UI mark individual stale sections the way Chronicle flags
  a stale anchor. *(Source: user ticket; cross-ref PI §3 World State delta mode)*
  *Shipped: `runDossierFieldRefresh` + `sanitizeDossierRefreshFields` +
  `extractDossierFieldValues` in `knowledge/lorebook.js` (field-scoped
  `DOSSIER_FIELD_REFRESH_PROMPT`, response re-scoped to requested keys,
  both ownership boundaries enforced in the sanitizer AND on the response),
  `knowledge/dossier_status.js` (per-field `{at, msgIdx}` watermarks inside the
  counters store value — the `deltaStatus` precedent; stamped at accept time by
  update/enrich/scan/field-refresh proposals), a 🎯 Fields picker modal on
  major NPC cards (staleness chips, 🔒 canon-lock and 🌱 growth-owned locks,
  "Select stale" bulk action) that stages into the normal review flow, watermark
  cleanup on NPC removal + chat switch. Tests in
  `test/dossier_field_refresh.test.js`. See CHANGELOG 2.2.0 "Added".*
- [ ] **F — User-visible source & confidence tracking, cross-module.** The
  Knowledge evidence system already has quote receipts — surface that concept:
  source message range/index, source type (user-authored / assistant-authored /
  imported / inferred), confidence or verification status, "why is this here?"
  links from injected state back to evidence/chronicle entries, quick
  pin/lock/correct controls. Makes MWT much easier to trust and debug. *(Source: PI §5)*
- [x] **F — Better Interiority lifecycle controls.** Interiority already has
  rollback/tombstone handling. **Start with intention correctness:** prevent
  proposals for already-completed actions, deduplicate same-outcome paraphrases
  within/across generations, separate completion from abandonment grace, retain
  occurrence-specific closure history, and track newly evaluated evidence per NPC.
  Investigation and phased plan: [INTERIORITY_LIFECYCLE.md](../archive/completed_plans/INTERIORITY_LIFECYCLE.md)
  (2026-09-07; proposed, not implemented). Then add intention priority/urgency,
  conflicts between intentions, explicit expiration / "no longer plausible" dates, user-visible
  audit history for execution/drop/wake events, per-NPC cost limits + cooldowns,
  and a privacy mode that never sends selected NPC dossiers to batched calls.
  Extend existing backup export/import to cover the new lifecycle history and
  fields (ledger/tombstones already supported). *(Source: PI §6)*
  **COMPLETE** — Tiers 1–3 shipped first (see CHANGELOG); the deferred
  lifecycle tier landed 2026-09-07 as interiority store v2: bounded
  occurrence-specific lifecycle history separate from tombstones, conservative
  windowed cross-turn closure dedup, per-NPC evidence boundaries (stamped only
  by scoped successful intentions commits), priority + conflicts/merge with
  supersession links, in-world `expiresOn` vs turn-aging expiry, the audit
  panel with done/dismiss/merge/reopen/sleep/wake actions, per-NPC privacy +
  cost controls, rollback restores, and backup merge/replace — specified in
  [INTERIORITY_LIFECYCLE_V2_SPEC.md](../archive/completed_plans/INTERIORITY_LIFECYCLE_V2_SPEC.md).
  Completion receipts / structured outcome response fields stay deferred by
  design (only if failures surviving Tiers 1–3 justify their response-schema
  cost — none have).
- [x] **F — Unified MWT dashboard.** One view showing tracker health, stale data,
  pending staging items, overdue beats, active intentions, token load, and last
  successful run per module. *(Source: PI UX)*
  `[plan drafted 2026-09-10]` — merged with the console-tools UI item below
  into [`overview_dashboard_plan.md`](overview_dashboard_plan.md): one 🏠
  Overview tab, status cards + a 🧰 Maintenance section.
  **COMPLETE 2026-09-11 (v2.8.0)** — the 🏠 Overview tab is the modal's first
  tab: guarded status cards with deep links for every signal (per-module
  health lines, World State staleness, staging + growth evidence, beats,
  intentions, budget summary, coordinator, quarantine), plus 🔎 Findings and
  🧰 Tools. Receipts: CHANGELOG 2.8.0; the design record stays at
  [`overview_dashboard_plan.md`](overview_dashboard_plan.md).
- [ ] **F — "Pause background automation for this chat"** as a control **separate**
  from disabling injection. *(Source: PI UX)*
- [x] **F — User-facing UI for the existing `window.MWT.*` console tools**
  (profile duplicate/relink, evidence diagnostics) instead of requiring console
  commands. *(Source: PI UX)* `[partly done 2026-08-21]` — the *read-only* half
  now has a UI: the 🩺 Diagnostics tab + 📋 Copy Report render everything
  `MWT.diagnostics.*` exposes. What remains is the *mutating* toolset
  (`MWT.profiles.pruneDuplicates` / `relink`, `MWT.evidence.clearAll`,
  `MWT.interiority.clearDeletions`), which Diagnostics v1 deliberately left
  console-only (read-only by contract — DIAGNOSTICS_PANEL.md §I.1).
  `[plan drafted 2026-09-10]` — the mutating toolset is now planned as the 🧰
  Maintenance section of the Overview dashboard
  ([`overview_dashboard_plan.md`](overview_dashboard_plan.md)): Diagnostics
  stays read-only by contract, and DIAGNOSTICS_PANEL.md §I.2 already reserved
  this promotion for "a home for them." The console tools remain the
  power-user path (one collector, two surfaces).
  **COMPLETE 2026-09-11 (v2.8.0)** — the mutating toolset ships as Overview's
  🔎 Findings (prune / relink previews) + 🧰 Tools (clear all evidence /
  clear deletions): preview→confirm modals that re-check at confirm —
  prune and relink re-plan, the clears re-verify the chat (the evidence
  clear also its NPC list) — and refuse if anything changed. The console
  bridge stays the power-user path, now a thin wrapper over the shared
  `knowledge/profiles_audit.js` (console output unchanged). Receipts:
  CHANGELOG 2.8.0.
- [ ] **F — Cross-module undo/redo / unified history view**, not only per-module
  history stacks. *(Source: PI UX)*

---

## §4 — UX / accessibility / polish

- [x] **Accessibility pass.** ARIA labels for icon-only controls, keyboard
  navigation for tabs/cards/graph, visible focus states, screen-reader text, and
  reduced-motion support. *(Source: PI UX)*
- [x] **Panic switch UI clarity.** Make it visually impossible to miss that
  Knowledge lorebook entries stay active in SillyTavern even when the panic
  switch kills injection (the README documents this; the UI doesn't show it).
  *(Source: PI UX)* — **Done 2026-08-19 as a side effect of Diagnostics
  Phase 9** (archive/completed_plans/DIAGNOSTICS_PANEL.md): the 💉 Injection tab
  carries a permanent "Knowledge caveat" banner (amber normally, red + "NOT
  stopped by the panic switch" wording when the switch is on), and the same
  caveat is warned by `MWT.diagnostics.injectionStatus()`.
- [ ] **Explicit auto-generate trigger setting** — "auto-generate only on
  assistant messages" vs "every received message" — rather than relying on event
  semantics. *(Source: PI UX)*
- [ ] **`/wt-inject` scope clarity (verify).** The contract was fixed in CORE-02
  (four operations: disableInjection / stopGeneration / cancelDeferredWork /
  cleanupMutation, composed by both the panic switch and the slash command).
  Confirm the user-facing command description now matches actual scope, or decide
  whether it should become a true global injection toggle. *(Source: PI UX; REMEDIATION Tier 2b)*

---

## §5 — Housekeeping / release hygiene

- [x] **ESLint (correctness-only)** — done. `eslint.config.mjs`; currently lint-clean.
- [x] **CI that runs tests on every push** — done. `.github/workflows/ci.yml`
      (lint + test, Node 20 & 22, concurrency cancellation).
- [x] **Populated `manifest.json` `homePage`** — done
      (`https://github.com/brasen56/merged_world_tracker`).
- [x] **H — CHANGELOG / release notes file.** Added `CHANGELOG.md` (Keep a
      Changelog format; v1.3.0–v1.4.7 reconstructed from git history, v1.4.23
      forward written as releases happen). *(Source: PI)*
- [ ] **H — Explicit supported SillyTavern version/fork compatibility notes.**
      The CORE-07 upstream validation is recorded in `REMEDIATION_MAP.md`, but
      the user-facing compat surface (which ST versions/forks are supported) isn't
      stated. *(Source: PI)* — **Evidence-gathering half now exists (2026-08-22):**
      the 🌐 Environment tab (Diagnostics Phase 7 + the v1.7.10 DOM
      `#version_display` probe) reports the running ST version and which context
      APIs that build actually exposes, on any fork. The written compat statement
      is still missing; the fork-compat finding log in DIAGNOSTICS_PANEL.md §0
      feeds it.
- [x] **Decide: expand the lint scope?** See [Appendix A](#appendix-a--should-the-lint-scope-expand)
      for a concrete recommendation.

---

## §6 — Optional deeper test coverage

The current suite covers the highest-risk async/persistence paths via the Tier 5
regression net and the chat-switch harness. (`test/README.md`'s corresponding
section is now titled "What NOT to test (yet)" — a broader runtime-coupling
list; the picks below remain the live ones.) These are **optional** now that
the core guards are exercised — pick up only if you want defense-in-depth on a
specific area:

- [x] `setExtensionPrompt` payloads — role, depth, enabled/cleared state.
      Done via Diagnostics Phase 2: `test/injection_diagnostics.test.js` drives
      the real `applyExtensionPromptInjection()` (send, overwrite, and the
      disabled/empty-body clear paths) through the `test/stubs/core.js`
      interception and pins role / depth / enabled per key (e.g. `'assistant' →
      2`, `globalDepth` winning over `fallbackDepth`, cleared-state fidelity).
- [x] API fakes — success, retry, 429/5xx, 4xx, timeout, truncation, malformed.
      Done: `test/api_diagnostics.test.js` pins success capture, HTML-failure
      classification without retry, and empty-success; the open families
      landed in `test/api_failure_families.test.js` — 429/5xx/timeout/
      truncation retry-then-recover, plain 4xx fatal after one attempt
      (`errorClass: '_noRetry'`), exhaustion on persistent 429/length/malformed
      bodies, the 1s exponential-backoff floor, and the status/retries/
      errorClass ring capture for each family.
- [x] Generation commit races beyond the scope-guard cases.
      Done via `test/generation_commit_races.test.js`: the full-refresh
      same-chat edit race (document edited mid-call → result discarded), the
      section-regen scope / target-section-edit / edit-during-grounding-retry
      discards, and story-planner's scope discard + rebase-keeps-user-pins
      (the chat-switch halves were already pinned in tier5 +
      `world_state_delta.test.js`).
- [x] Scheduler deduplication + cancellation (relevant once the §1 coordinator lands).
      Done with the coordinator itself via `test/coordinator.test.js`: the
      pending-job dedupe join (equal key → one run, both awaiters settle
      together, never joins *running* work), queued-never-starts and
      running-aborts cancellation, external caller signals, chat-switch
      (epoch) retirement incl. the no-stale-start-mid-sweep property, and the
      transport adoption contract (signals reach `fetch()`, aborts are never
      retried, auto triggers are held under the user-generation policy).
- [x] Import/export validation + round trips (relevant once the §1 backup/restore lands).
      Done via `test/import_export_roundtrip.test.js`: Chronicle export payload
      + filename/status, the Markdown export, a real export → import round
      trip (ids stable, declined injection-confirm keeps the destination's
      session config), the invalid-JSON / missing-snapshots error statuses,
      and the Knowledge export → import round trip incl. API-key redaction.
      (The backup envelope round trip was already pinned in
      `test/backup_schema_roundtrip.test.js`.)
- [x] Lorebook hydration failure/retry behavior.
      Done: the failure side was already pinned (`test/knowledge_store_hydration.test.js`
      KNOWLEDGE-02 + tier5); `test/lorebook_hydration_retry.test.js` adds the
      retry halves — a transient load failure heals on the next attempt
      (hydrating the real on-disk store, never a rebuild), repeated failures
      keep failing closed (the seed is never adopted as an empty book), and
      `hydrateCurrentBooks()` tolerates one failing book and heals it on a
      later run. The pause breadcrumb (`peekStore` observedVersion) is pinned
      alongside.
- [x] Mobile/keyboard modal interactions.
      Done via `test/modal_interactions.test.js` driving `core/modal.js`
      through a minimal fake DOM: the Escape topmost-visible rule (stacked
      modals, hidden modals, non-Escape keys), the × close-button and backdrop
      (mobile tap) pointer paths, the `onClose` veto on every close path,
      same-id recreation cleanup (no leaked keydown handlers), and `setStatus`
      timer semantics incl. the CORE-03 stale-fade cancel.

---

## Recommended order

Re-prioritized 2026-08-06 after the bug baseline closed (incorporating co-author
review). The original audits' "defer everything until async paths are guarded"
rationale is now **moot** — those paths are guarded — so there's no longer a
sequencing reason to postpone cheap, compounding, dependency-free work.

*Reconciled 2026-08-22 against what actually shipped. The drift from the 08-06
plan: the diagnostics panel (old step 5) was deliberately pulled ahead of the
schema + identity steps — read-only, and it multiplies tester-report quality
mid-tester-wave, whereas the schema work is the 2.0 data-shape break (see
`archive/completed_plans/DIAGNOSTICS_PANEL.md`, "Roadmap position"). Steps 1–2 also
landed. Original step numbers preserved below.*

1. ✅ **Housekeeping tail + zero-churn lint + quiet the Vitest warning — DONE
   (v1.5.0).** Lint expansion landed (`eqeqeq`, `prefer-const` + `--fix`,
   `no-shadow`, per [Appendix A](#appendix-a--should-the-lint-scope-expand));
   the `world-info.js` test warning silenced; CHANGELOG started. *(§5,
   §2-warning)*
2. ✅ **Unified backup/restore — DONE (v1.5.0, Phases 1–4 incl. UI).** Versioned
   export, two-step restore (preview → confirm), merge vs replace, pre-restore
   safety backup, undo-last-restore — with the schema-version field present from
   day one, as this step required. *(§3)*
3. ✅ **Diagnostics panel — DONE (v1.5.1 → v1.7.10, all 13 phases).** See §2.
   The **context-budget panel** — the other half of the original pairing —
   remains open. *(§2)*
4. ✅ **Schema validation + migrations — DONE (v1.8.1 → 2.0.0, all seven
   parts).** The 2.0 data-layer break landed: versioned schemas + migration
   runner for every authoritative store, validate-on-load (the runtime gate
   runs on every startup and chat switch), quarantined-recovery with
   exportable "recovery data", per-module pause banners with Retry, and the
   Part 7 coverage pass over settings and the browser-local records. See
   [`SCHEMA_VALIDATION_MIGRATIONS_PLAN.md`](../archive/completed_plans/SCHEMA_VALIDATION_MIGRATIONS_PLAN.md)
   and [`DATA_SAFETY_GUIDE.md`](../DATA_SAFETY_GUIDE.md). The 🗂️ Scope &
   storage (store versions) and 🛡️ Integrity (dangling refs) diagnostics
   tabs give live visibility into exactly the data this work touches. *(§1)*
5. ✅ **Entity identity service.** Depends on 2 (recoverable merges — done) and 4
   (canonical-ID rollout as a migration, not a breaking change). Build behind the
   existing `getRegistryEntry()` seam. *(§1)*
6. **Features by taste — delta mode, generation coordinator, dossier refresh,
   dashboard, context-budget panel.** Note: the coordinator would have closed
   WORLD-STATE-08 / INTERIORITY-03 / STORY-PLANNER-03, but those are **already
   fixed individually**, so it's leverage against *future* concurrency bugs, not
   current ones — hence "by taste." **Jump it up the queue if you see live
   cross-module symptoms** (rate-limit bursts, overlapping notifications, token
   pressure from parallel refreshes) — which the 🩺 Diagnostics panel (❤️
   Health, 📡 Last request, 📋 Log) now makes directly observable. *(§3,
   §2-budget, §1-coordinator)*
7. **Accessibility / UX in parallel** throughout. *(§4)*

> Why this differs from the source docs' original order: that order existed to
> keep feature work off provably-unguarded async paths. The remediation work
> shipped those guards, so the constraint is gone. Bugs-first delivered the
> original P0; nothing is traded away by re-prioritizing now.

---

## Appendix A — Should the lint scope expand?

**Short answer: keep the merge gate as-is, but add a small set of *zero-churn
correctness guardrails*. Don't add style/formatting.**

Your instinct to keep it narrow was right. `test/README.md` explicitly values the
property *"if lint reports anything, it's a real issue, not a style nit."* Adding
Prettier or style rules would break that and produce large review diffs for zero
correctness gain — not worth it for a solo project.

Measured across the whole project (the scope CI actually lints) on 2026-08-06,
re-checked against co-author review:

| Candidate rule | What it catches | Measured | Verdict |
|---|---|---:|---|
| `eqeqeq` with `['error','always',{null:'ignore'}]` | `==`/`!=` coercion bugs, while still allowing the idiomatic `== null` (null-or-undefined) check | **0 violations** — all 84 loose-eq sites in the project are `== null`/`!= null` checks; zero value-vs-value `==` | ✅ **Enable today, literally zero churn.** Stronger than "cleanup then enable." |
| `no-var` | accidental `var` | **0** | ✅ Add — free guardrail |
| `no-prototype-builtins` | `obj.hasOwnProperty` prototype-pollution bugs | **0** | ✅ Add — free guardrail |
| `no-self-assign`, `no-self-compare`, `no-constant-binary-expression`, `no-unsafe-negation`, `no-cond-assign` | logic bugs | ~0 | ✅ Add — pure correctness |
| `no-shadow` | inner var hiding outer | **4** | ✅ Add — trivial |
| `prefer-const` | `let` that's never reassigned | **17** (`--fix`-able) | ✅ Add, but as its **own one-command `--fix` commit** — not "zero-churn." |
| `import/no-cycle` | circular module deps | **0 reported by the rule**, yet real logical cycles exist — masked by ~68 dynamic `await import()` calls, several explicitly commented as cycle-breakers (`store`→`settings`→`index`, `staging`→`render`, `relationships`→`lorebook`, `sections`→`render`, `core/scope` lazy import, `world_state/refresh` lazy render) | ❌ **Don't enable as a gate.** In static-only mode it reports 0 (blind to the dynamic-import-masked cycles) and would give false confidence. Treat the cycle clusters as input to the §1 subsystem work; revisit once that centralizes access and the dynamic imports can return to static. |
| `import/no-unused-modules` | dead exports | not measured | 🟡 Nice-to-have; probe later. |
| Prettier / style rules | formatting | large | ❌ Skip — breaks "lint = real issue." |

**Recommended concrete step:** enable `eqeqeq` (`null:'ignore'`), `no-var`,
`no-prototype-builtins`, `no-shadow`, and the logic-bug rules in one commit — all
measure at zero or near-zero churn today and preserve the gate's "correctness
only" framing. Run `npm run lint -- --fix` for `prefer-const` as a separate
one-command commit (17 sites). Leave `import/no-cycle` out of the gate entirely;
its cycle clusters are input to the §1 subsystem work, not a lint fix. Leave
style/formatting out unless you want a separate `npm run format` check.

---

*Drafted 2026-08-06 from `archive/audits/Potential_Improvements.md` and
`archive/audits/REMEDIATION_MAP.md`. Update the "Status at a glance" counts when
you tick items off. Last reconciled against the repo **2026-09-11**: schema
validation + migrations complete through 2.0.0 (Parts 1–7); World State delta
mode shipped (§3-F); Knowledge per-field dossier refresh shipped (§3-F); the
§6 optional-coverage pass is now fully landed (the generation coordinator
shipped in 2.4.0 unlocked its scheduler item); the unified Overview dashboard +
console-tools UI shipped in 2.8.0 (both §3-F items ticked); suite at 99 files /
2493 tests, all green.*
