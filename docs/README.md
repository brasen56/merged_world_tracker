# MWT documentation map

How this project's documents are organized. User-facing guides live at the
repo root; live planning documents live here; everything historical lives in
`archive/` (local only, not tracked).

## Live documents (tracked, this directory)

| Document | Status | What it is |
| --- | --- | --- |
| [TODO.md](./TODO.md) | **Live queue** | The single reconciled work list for remaining improvement/feature work (§1 subsystems, §2 reliability, §3 features, §4 UX/a11y, §5 housekeeping, §6 test coverage). |
| [overview_dashboard_plan.md](./overview_dashboard_plan.md) | Complete | The 🏠 Overview dashboard + 🧰 Maintenance build (both TODO §3-F items). Shipped as v2.8.0 — see CHANGELOG; kept as the design record. |
| [accessibility_plan.md](./accessibility_plan.md) | Active | Project A — the accessibility pass (TODO §4). Implementation slices 1–5 landed across v2.6.x–v2.7.0; the §7 manual QA checklist governs release sign-off. |
| [settings_workspace_plan.md](./settings_workspace_plan.md) | Parked | Project B — the Settings information-architecture redesign. Starts only after Project A has landed and had real-world use. |
| [KNOWLEDGE_RELATIONSHIP_CONTEXT_ROADMAP.md](./KNOWLEDGE_RELATIONSHIP_CONTEXT_ROADMAP.md) | Deferred | Trigger-based roadmap for contextual relationship injection. Not scheduled; pick up only if one of its stated triggers fires. |

Root-level user guides (tracked): `README.md`, `CHANGELOG.md`,
`DATA_SAFETY_GUIDE.md`, `DIAGNOSTICS_GUIDE.md`, `DIAGNOSTICS_CONSOLE_GUIDE.md`.

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
| `archive/completed_plans/` | Design docs for work that shipped: backup/restore, the Diagnostics panel, lorebook auto-activation, schema validation + migrations (+ recorded perf baselines), and the interiority-lifecycle family (investigation → review round → implementation plan → v2 spec; shipped 2026-09-07). |
| `archive/superseded/` | Drafts replaced by newer docs: the combined UX/accessibility `design.md` and its review (split into the two tracked plans above), the schema plan's pre-review draft, and the relationship-context proposal (its implementation half is superseded by the deferred roadmap; the proposal remains the design record). |
| `archive/ideas/` | Unstarted proposals and reference notes: the intention self-cleaning spec, the intentions potential fix, the NPC growth blueprint, and the Aikobots-4 fork porting guide (referenced by TODO §5 fork-compat work). |

## History in one paragraph

The bug-report round (`archive/bug_reports/`) came first and was verified and
fixed. The 2026-08-02 cross-module audit (`archive/audits/`) followed; its
remediation map and the feature wishlist were folded into `docs/TODO.md`,
which became the single live queue. Plans that shipped moved to
`archive/completed_plans/`. The two current projects — the accessibility pass
and the Settings workspace — were split out of one combined draft
(`archive/superseded/design.md`) into the two tracked plans in this directory.
