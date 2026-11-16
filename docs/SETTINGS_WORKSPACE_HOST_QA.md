# MWT Settings workspace — host QA by slice

**Source of truth:** `settings_workspace_plan.md` §5 (slice exit gates) and §6
("Host/manual release gate"). This file is that host checklist broken out per
slice so it can be worked through and annotated as each slice ships; the
jsdom suites cover the automated gates and prove nothing on this page.

**Status:** Slices 1–2 implemented 2026-11-16. Slice 1 host result is recorded
below; Slice 2 host QA is pending. Slice 3 is not started.

**Conventions:** when testing an item, append `PASS` or `FAILED: <evidence>`;
note the date. Record the tested commit, SillyTavern version, browser +
version, and theme(s) used for each session. Never mark a host item passed
from automated tests. Use a disposable chat; Backup items explicitly need
disposable chat data.

## General — re-run after every slice

1. Global Save persists all global fields and fires every side effect: Ledger
   strip refresh, floating-button visibility/style/state, coordinator pumping,
   injection reapplication, and panic-related Ambient/Calendar clears.
2. Sync reads the current API form including unsaved values, invokes only the
   five LLM modules' sync callbacks, and does not save the global form.
3. Reset positions acts only on floating-button placement.
4. Close/reopen the modal and switch chats while it is open: the rebuild
   restores the main tab, persisted values, and focus, with no prior-chat
   data leakage.
5. Repeated open/close/reopen does not stack handlers: one save per Save
   click, one status announcement per action.

## Slice 1 — Form seam (behavior-preserving)

Implemented 2026-11-16. Layout is unchanged, so compare directly against
pre-slice behavior; automated coverage lives in `test/settings_form.test.js`.
**Pass: tested 2fd76cf on chrome, ST v1.19.0 on 202/11/16**

1. All six disclosures (API Connection, Stable History, Generation
   Coordinator, Injection Settings, Floating Buttons, Per-Tracker Enable)
   render, collapse, and expand; Save/Sync/reset sit outside them.
2. Save with some groups collapsed: collapsed controls still save their
   values (the handler reads the whole form).
3. Selecting the Custom connection profile reveals URL/key/model; switching
   away hides them; a missing saved profile does not break the form.
4. Clear **Messages to defer** and **Max parallel API calls**, then Save: both
   persist as 2 (empty → default), not 0 or 1. Enter out-of-range values and
   confirm the clamps 0–10 and 1–8.
5. Save once with non-default values spread across groups and confirm the
   persisted settings in the host (full patch parity is pinned in jsdom; this
   checks live persistence and side effects only).

## Slice 2 — Workspace shell and responsive navigation

Implemented 2026-11-16. Host QA **Pass: tested 26411cd on chrome, ST v1.19.0 on 202/11/16**.

1. Only the selected section is visible in the real host stylesheet stack:
   the `[hidden]` rule holds against both MWT and SillyTavern `display` rules.
2. Keyboard only: vertical tablist Up/Down (wrapping), Home/End, roving
   tabindex, selected/hidden consistency; the nested main, Diagnostics, and
   Ledger tablists stay independent; the mobile picker is operable and stays
   synchronized with desktop selection.
3. Screen reader: sections announce their names; on mobile, panels are named
   by the hidden tab; Save scope is announced; exactly one live status
   announcement per action, via the modal's existing statusbar.
4. Overview → Coordinator and Overview → Ambient links land on the owning
   section (`automation` / `ambient`), reset body scroll, and scroll the
   target anchor into view — on desktop and mobile, and from any previously
   selected section.
5. Layout matrix at the modal's 960px maximum, tablet, the 768px boundary and
   narrower mobile, long labels, 200% zoom, both themes: no clipped controls,
   hidden focus, oversized secondary strip, or sticky action overlay; the
   sticky Save area never covers the last field or the focused item.
6. Resize across the 768px boundary while either navigation has focus; chat
   switch while a field has focus; close/reopen: selection and visible focus
   survive, with safe focus fallback, and no draft leakage across chats.
7. The six global disclosures are gone; each former group is a headed block
   (Automation holds two); `#mwt-settings-generation-coordinator` still
   anchors; the two stale strings ("Replace the 4 floating buttons", the
   module-settings closing paragraph) are replaced.
8. Ambient and Backup sections show exactly one visible heading each
   (omit-chrome); their forms, own Save/immediate actions, and per-chat scope
   wording still work after section switching.
9. Global Save versus Ambient's own Save stay separate; the Ambient section
   carries conspicuous "This chat" / separate-save wording.
10. Ledger switches stay synchronized in both directions; module enable and
    floating visibility remain independent.
11. Backup export/preview/cancel/confirm/undo/recovery on disposable chat
    data, including after section switching; restore scope and busy-state
    guards intact.
12. Reduced-motion behavior and host styles unchanged.

## Slice 3 — Module discoverability

Blocked until implemented.

1. Each Configure action activates that module's real entry point (plan §2
   table) and reveals + focuses the target, not merely the tab: World State
   and Story Planner disclosures open; Chronicle's and Knowledge's in-place
   settings views open; Interiority's lazy panel opens via an exposed open
   function, never a toggle click; Ledger focuses its switch strip.
2. Every Configure destination is reachable by keyboard alone.
3. Repeat Configure on an already-open target: it stays open (idempotent).
4. Configure works while the tracker is disabled and never enables it as a
   side effect.
5. Chronicle's and Knowledge's settings views replace tab content: Configure
   respects whatever unsaved-edit guard the current view has and never
   discards an in-progress view silently. Confirm which Knowledge sub-tab
   must be active first.
6. Ambient's owner link selects the Settings `ambient` section; Calendar's
   uses its existing top-level panel; neither gains invented global controls.

## Release bookkeeping (when the workspace UI ships)

- Update `USER_GUIDE.md` and the setup guide's control-location instructions
  in the change that ships the UI, not earlier (plan §6).
- Before marking the host gate passed, confirm every item above is PASS or
  has a recorded N/A reason, and that the tested commit matches what ships.
