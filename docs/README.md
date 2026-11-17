# MWT documentation map

How this project's documents are organized. User-facing guides live at the
repo root; live planning documents live here; everything historical lives in
`archive/` (local only, not tracked).

## Live documents (tracked, this directory)

Status source of truth is each document's own status line. Reconciled
2026-11-16.

| Document | Status | What it is |
| --- | --- | --- |
| [TODO.md](./TODO.md) | **Live queue** | The single reconciled work list for remaining improvement/feature work (§1 subsystems, §2 reliability, §3 features, §4 UX/a11y, §5 housekeeping, §6 test coverage). Last fully reconciled 2026-09-26 — the per-effort docs below are the status source for anything newer. |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Live | Code map for contributors — annotated file trees and module communication. |
| [AMBIENT_CONDITIONS_DESIGN.md](./AMBIENT_CONDITIONS_DESIGN.md) | Phases 1–4 implemented | v1 design for the deterministic Ambient Conditions module (shipped v2.12.0) — code decides the conditions, the narrator renders them. Folds the weather proposal/response exchange into one buildable design. |
| [CALENDAR_DESIGN.md](./CALENDAR_DESIGN.md) | Revision 3; Phases 10–14 implemented | Custom world calendars — structure, the midsummer anchor, events with repeats, date-shaped phenomena, the Calendar panel. Continues the family numbering (D38+, Phases 10–14). |
| [CALENDAR_RESPONSE.md](./CALENDAR_RESPONSE.md) | Discussion record (folded into the calendar design revision 2) | The co-author review of the calendar draft, received by email 2026-10-28 and recorded verbatim — custom-only tags, anchor defaults, hemisphere-derived solstice, clock-domain migration, the darker-of light rule, the `structure` field. |
| [GROWTH_PROFILE_INJECTION_SCOPE.md](./GROWTH_PROFILE_INJECTION_SCOPE.md) | Phases 1–4 implemented | Opt-in Growth-derived Personality/Voice dossier text: one reviewed model draft per profile through the existing Staging diff, switch-controlled field ownership (never set keeps today's rule), per-NPC length limits up to 1,500/1,000, capture-context leaf-rule fix, a 10-record approval history in its own disabled `[MWT:growth-history]` entry, echo warning, Lorebook-Scope-following state, and Phases 1–5. |
| [GROWTH_PROFILE_INJECTION_RESPONSE.md](./GROWTH_PROFILE_INJECTION_RESPONSE.md) | Discussion record (folded into the scope doc) | The feature request, our first reply, the requester's two answers (verbatim), and the plan we sent with its original internal implementation notes. Kept as the correspondence record; the scope doc is the buildable version. |
| [GROWTH_PROFILE_TIME_ORDER_SCOPE.md](./GROWTH_PROFILE_TIME_ORDER_SCOPE.md) | Phase 1 implemented | Buildable scope for Growth profiles that describe the character *now*: story positions, ordered source-claim samples, distinct-message support, prompt rewrites, and the same view for the Personality/Voice draft. Phase 1 landed 2026-11-14; the host check is the release gate (§10). |
| [GROWTH_PROFILE_TIME_ORDER_REVIEW.md](./GROWTH_PROFILE_TIME_ORDER_REVIEW.md) | Review record (folded into the scope doc) | The 2026-11-14 request recorded verbatim, the finding that Consolidate and Generate Profile receive no timing information, the read-time-only fix proposal, and its landmines. |
| [GROWTH_EVIDENCE_ARCHIVE_SCOPE.md](./GROWTH_EVIDENCE_ARCHIVE_SCOPE.md) | Draft for co-author review; nothing implemented | Proposal to keep only the few archived growth-evidence sources the code actually reads in full, stubbing the rest — the growth evidence store is the largest thing MWT keeps in a long chat file. |
| [KNOWLEDGE_CONCISION_SCOPE.md](./KNOWLEDGE_CONCISION_SCOPE.md) | Draft for review | Proposed field discipline, opt-in ledger condensation, advisory pruning flags, and reviewed existing-field cleanup. |
| [KNOWLEDGE_CONCISION_DECISIONS.md](./KNOWLEDGE_CONCISION_DECISIONS.md) | Recorded defaults | Phase 0 decision record for the concision work — the settled defaults the implementation plan contemplates; amend the decision, not just the code. |
| [KNOWLEDGE_CONCISION_WRITER_INVENTORY.md](./KNOWLEDGE_CONCISION_WRITER_INVENTORY.md) | Phase 0 deliverable | Every code path where model output can become NPC/world-info entry text, plus the seams shared validation and the cleanup guard rails must cover. |
| [KNOWLEDGE_CONCISION_IMPLEMENTATION_PLAN.md](./KNOWLEDGE_CONCISION_IMPLEMENTATION_PLAN.md) | Phases 0–6 implemented | Phases 0–6: design gates, prevention, source-mapped ledger review, durable recovery, guarded writes, release validation, and follow-up field cleanup. The 🧹 Condense review shipped with Phases 0–6. |
| [KNOWLEDGE_MANUAL_EDIT_SCOPE.md](./KNOWLEDGE_MANUAL_EDIT_SCOPE.md) | Phases 1–5 implemented | NPC Edit-in-View scope and safety contract; §13 breaks Slice 1 into Phases 1–5 with exit gates. NPC-only Edit-in-View, Restore, and advisory guidance are implemented and exposed for host QA; the feature is unreleased until Phase 5 records it. |
| [KNOWLEDGE_MANUAL_EDIT_HOST_QA.md](./KNOWLEDGE_MANUAL_EDIT_HOST_QA.md) | QA record — Phases 1–2 mostly passed | Host QA checklist for Phases 1–2: A1–A3, B1–B7, C1, D1, and P1-B1…B7 checked; P1-A1 open, P1-B blocked on a console surface, P1-C pending. |
| [KNOWLEDGE_MANUAL_EDIT_PHASE3_HOST_QA.md](./KNOWLEDGE_MANUAL_EDIT_PHASE3_HOST_QA.md) | QA record — results pending | Phase 3 host QA checklist; implementation checkpoint 2026-11-01, host results pending. |
| [KNOWLEDGE_MANUAL_EDIT_PHASE4_HOST_QA.md](./KNOWLEDGE_MANUAL_EDIT_PHASE4_HOST_QA.md) | QA record — passed with caveats | Phase 4 host QA passed 2026-11-01, with boundary probes still noted as open. |
| [LEDGER_V1_DESIGN.md](./LEDGER_V1_DESIGN.md) | Phases 1–3 implemented; Phase 4 host QA passed | v1 design for the manual-entry money and inventory module: computed balances in exact minor units, Carried/Stored items, a floating badge with one number, chat-metadata storage registered for backup, and World State proposals as the later step. |
| [LEDGER_V2_DESIGN.md](./LEDGER_V2_DESIGN.md) | Draft for review; nothing built | v2 design — World State refresh proposals (the full data model: evidence gate, dedupe tombstones, swipe-aware expiry), debts by counterparty with debt-aware fold-forward, the item change log, pinned items, and a planner-only stored-items projection. Continues the family numbering (D13+, Phases 5–9). |
| [ONBOARDING_PRESET_PLAN.md](./ONBOARDING_PRESET_PLAN.md) | Draft for review; Phase 0 (SETUP_GUIDE) shipped | First-run Lite / Standard / Full onboarding presets — the settings-key contract, fresh-install gating, and the planned one-click dialog. |
| [settings_workspace_plan.md](./settings_workspace_plan.md) | Slice 1-3 implemented | Project B — Settings workspace, reconciled against the current code on 2026-11-16: seven sections, separate global/Ambient save ownership, Ledger synchronization, module deep links, and regression/host-QA gates. Project A is complete. |
| [SETTINGS_WORKSPACE_HOST_QA.md](./SETTINGS_WORKSPACE_HOST_QA.md) | QA record Pass | Per-slice host QA checklist for the Settings workspace (general re-run items plus Slices 1–3 and release bookkeeping), extracted from the plan's §5 exit gates and §6 host gate. |

Root-level user guides (tracked): `README.md`, `SETUP_GUIDE.md`,
`USER_GUIDE.md`, `CHANGELOG.md`, `DATA_SAFETY_GUIDE.md`,
`DIAGNOSTICS_GUIDE.md`, `DIAGNOSTICS_CONSOLE_GUIDE.md`.

One design doc is tracked with its code:
`world_state/STALE_ENTRY_EXPIRY_DESIGN.md` (stale-entry expiry & provenance;
§11 steps 1–4 implemented, off by default).

## `archive/` — historical material (gitignored, local only)

`archive/` consolidates everything historical in one place. It is **not
tracked**: code comments, tests, and the CHANGELOG still point into it as
provenance (the "why" behind a change), which is why the files are kept, but
it is not part of the shipped extension. New planning work goes in `docs/`,
never in `archive/`. See [archive/README.md](../archive/README.md) for the
folder-by-folder contents.

| Folder | Contents |
| --- | --- |
| `archive/bug_reports/` | The earliest round: bug reports 01–08, the `bugs_temp.md` follow-up round, and `VERIFICATION_RESULTS.md`. All verified and fixed. |
| `archive/audits/` | The 2026-08-02 cross-module audit (six `AUDIT_*.md` reports + `AUDIT_SUMMARY.md`), its work queue `REMEDIATION_MAP.md`, the co-author review `Potential_Improvements.md` (the "PI" cited throughout TODO.md), and the 2026-07-28 growth/interiority review TODO. |
| `archive/completed_plans/` | Design docs for work that shipped: backup/restore, the Diagnostics panel, lorebook auto-activation, schema validation + migrations (+ recorded perf baselines), the interiority-lifecycle family (shipped 2026-09-07), targeted growth capture, the overview dashboard (v2.8.0), the accessibility pass (implemented, full manual QA, host-confirmed 2026-11-16), the ambient-conditions v2 family (v2 design + its response + the settled phenomena contract), the World State reliability roadmap (host-confirmed 2026-11-16), and the Story Planner family (baseline roadmap, V3 roadmap, Phase 7 QA record, projection inventory — V3 host-confirmed 2026-11-16). |
| `archive/superseded/` | Drafts replaced by newer docs: the combined UX/accessibility `design.md` and its review (split into the accessibility plan — now completed — and the Settings workspace plan — refreshed 2026-11-16), the schema plan's pre-review draft, and the relationship-context proposal (its implementation half is superseded by the deferred roadmap; the proposal remains the design record). |
| `archive/ideas/` | Unstarted or deferred proposals and reference notes: the intention self-cleaning spec, the intentions potential fix, the NPC growth blueprint, the deferred relationship-context roadmap (pick up only if its stated triggers fire), and the Aikobots-4 fork porting guide (referenced by TODO §5 fork-compat work). |

## History in one paragraph

The bug-report round (`archive/bug_reports/`) came first and was verified and
fixed. The 2026-08-02 cross-module audit (`archive/audits/`) followed; its
remediation map and the feature wishlist were folded into `docs/TODO.md`,
which became the single live queue. Plans that shipped moved to
`archive/completed_plans/`. The accessibility pass and the Settings workspace
were split out of one combined draft (`archive/superseded/design.md`); the
accessibility pass shipped and was archived 2026-11-16. The Settings workspace
plan was reconciled against the current code the same day; it is a refreshed
proposal, not an implemented workspace.
