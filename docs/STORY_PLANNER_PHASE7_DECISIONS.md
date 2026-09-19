# Story Planner Phase 7 decision and QA record

**Date:** 2026-09-19  
**Status:** Instrumentation and documentation implemented; manual SillyTavern matrix pending

## Defaults retained

- **Progress checking remains manual.** Phase 7 now records checks, verified proposals, accepted/ignored proposals, no-evidence results, stale results, and request sizes. No opt-in automatic cadence is added until real campaign observations establish a tolerable false-positive/false-negative rate and acceptable API cost.
- **`activateWhen` remains a human note.** Park/Resume is explicit. Automatic wake evaluation would require a new evidence contract and is not justified by current measurements.
- **The Story Palette does not silently alter auto-generation defaults.** Auto-generation uses the per-chat palette the user selected; an empty palette remains balanced/current behavior.
- **Closed-memory ranking remains pin plus recency.** Exact normalized-title recurrence is now suppressed and counted. Broader fuzzy suppression remains deliberately manual because false matches could hide legitimately distinct arcs.

## Measurements now available

Per-chat, content-free `phase7Metrics` records:

- full and targeted generation counts, plus targeted proposals applied;
- progress checks, verified suggestions, no-evidence results, accepts, and ignores;
- exact-title closed recurrences suppressed at the merge boundary;
- request count, cumulative/average/max characters, last request kind/size/time;
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

Also verify chat switching, swipes, edits/deletes, panic switch, disabled trackers, Budget enforce/observe, and backup restore while each new workflow is open or in flight.