# Story Planner Phase 7 decision and QA record

**Date:** 2026-09-24
**Status:** Instrumentation and documentation implemented; manual SillyTavern matrix pending. Opt-in automatic progress-check cadence deferred.

This record tracks Phase 7 of the baseline roadmap, not V3 Phase 7 (which does
not exist). V3 Phases 0–5 amend the generation, subjects, cast, author-context,
and quality contracts; §7 of V3 is a separate set of gated future proposals.
Do not treat an automated test pass as host/model verification of either roadmap.

## Defaults retained

- **Progress checking remains manual.** Phase 7 now records checks, verified proposals, accepted/ignored proposals, no-evidence results, stale results, and request sizes. No opt-in automatic cadence is added until real campaign observations establish a tolerable false-positive/false-negative rate and acceptable API cost.
- **`activateWhen` remains a human note.** Park/Resume is explicit. Automatic wake evaluation would require a new evidence contract and is not justified by current measurements.
- **The Story Palette does not silently alter auto-generation defaults.** Auto-generation uses the per-chat palette the user selected; an empty palette remains balanced/current behavior.
- **Closed-memory ranking remains pin plus recency.** Exact normalized-title recurrence is now suppressed and counted. Broader fuzzy suppression remains deliberately manual because false matches could hide legitimately distinct arcs.

## Measurements now available

Per-chat, content-free `phase7Metrics` records:

- full-plan and targeted generation counts, plus targeted proposals applied;
- scoped Add/Refresh request counts and sizes (a reviewed proposal is not a committed full-plan generation);
- progress checks, verified suggestions, no-evidence results, accepts, and ignores;
- exact-title closed recurrences suppressed at the merge boundary;
- request count, cumulative/average/max characters, and last request kind/size/time;
- last progress-check time, proposal/no-evidence counts, up-to-date result, and stale result.

Diagnostics also records the exact Story Planner injection selection: active, selected, focused, pinned, and Ready counts; omissions caused by mode, Park, or closure; and the final post-Budget payload token count/action.

## Manual QA matrix

The following host-runtime checks cannot be honestly completed by the Node/jsdom suite. Record the SillyTavern build/fork, chat fixture, result, and any diagnostic snapshot when run.

| Scenario | Required checks | Result |
|---|---|---|
| Short chat | Generate, targeted proposal, progress check, accept/ignore, injection preview | Pending |
| Long campaign | Bounded request size, watermarks, closed recurrence suppression, history performance | Pending |
| Group chat | Active-cast context, aliases, focused injection, no cross-character private context | Pending |
| Custom prompt | Full-plan tokens resolve; targeted/progress safety prompts remain fixed | Pending |
| Narrow/mobile | Card controls, beat editor, proposal dialogs, help text, touch targets | Pending |
| Migrated v1 history | v1→v2 preparation, history restore, backup/restore, stable beat IDs | Pending |
| V3 scoped Add/Refresh | One/two arcs, omitted sections retained, proposal review/apply/discard, retry count and diagnostics | Pending |
| V3 subjects and cast policy | Selected/off-screen NPC ownership, rename/merge, allowed/proposed newcomers and entrance beats | Pending |
| V3 author context and arc quality | Opt-in private dossier review, human spoiler check, quiet and restrained plans without forced outcomes | Pending |

Also verify chat switching, swipes, edits/deletes, panic switch, disabled trackers, Budget enforce/observe, and backup restore while each new workflow is open or in flight.

### Observation worksheet (fill after host runs)

For each run, record date, SillyTavern build/fork, MWT version, model/provider,
prompt type (built-in/custom), chat fixture, request count/size, injected tokens,
and the outcome. Use counts and paraphrases only; do not copy private dossiers,
chat text, or raw API prompts into diagnostics or this record.

| Measure | Record per run | Decision evidence still needed |
| --- | --- | --- |
| Progress false positives | Verified proposals rejected by a human as not actually happened / all verified proposals reviewed | Pending; manually inspect source and decision, not just the Accept/Ignore counter |
| Progress false negatives | Missed events found by human review / all eligible events reviewed | Pending; no-evidence counts alone cannot establish this |
| Closed recurrence | Exact-title suppressions and distinct near-miss ideas manually inspected | Pending; suppression count is not a semantic recall rate |
| Request cost | Full/scoped/targeted/progress requests, retries, character counts, model/provider cost if available | Pending; characters are not tokens or API billing |
| Injection size | Pre/post Budget token counts, mode, Park/closed omissions, action | Pending; compare preview with host injection |
| Targeted vs full use | Targeted/scoped/full generation attempts and applied proposals | Pending; scoped requests include retries and discarded reviews, while generation counters reflect commits |

Keep automatic progress checking **off** until these host observations and the
remaining Phase 7 QA are reviewed. The other retained defaults above are not
claims that the pending matrix or V3 model evaluation has passed.