# MWT accessibility pass — implementation plan

**Project:** A (accessibility). Project B (Settings workspace) is parked in
[`settings_workspace_plan.md`](./settings_workspace_plan.md).
**Status:** Scope agreed; ready to implement.
**Original plan:** 2026-09-08. **Reconciled:** 2026-09-08 after two
code-grounded reviews.
**Original scope:** `TODO.md` §4 — UX / accessibility / polish.
**Primary sources:** `index.js`, `core/modal.js`, `core/ui.js`,
`core/style.css`, `knowledge/render.js`, `knowledge/index.js`,
`diagnostics_panel/render.js`, `vitest.config.js`.

> An earlier draft cited `Audit_Reports/Potential_Improvements.md` as a primary
> source. That file is not in the checkout — `Audit_Reports/` holds the seven
> `AUDIT_*.md` files and `REMEDIATION_MAP.md`. `TODO.md` §4's "(Source: PI UX)"
> tags refer to it, so treat TODO §4 itself as the requirement of record.

---

## 0. How this document came to be

The first plan combined two projects: the accessibility pass `TODO.md` §4 asks
for, and a redesign of the global Settings interface. Two reviews against the
live tree agreed they should not be implemented or reviewed as one change. This
document is the accessibility half only. The Settings redesign keeps its own
plan, its own branch, and starts only after this work has landed and had real
use.

Everything below has been checked against the tree at `d9a16fb`. Inventory
figures are exact counts, not estimates, and are re-checkable with the commands
in §2.

---

## 1. Scope

In scope:

- modal semantics, initial focus, focus containment, and focus restoration;
- accessible main-tab and Diagnostics-tab navigation through one shared helper;
- visible keyboard focus, scoped to MWT's own surfaces;
- accessible names and descriptions for controls;
- status announcements and correctly owned busy states;
- reduced-motion behavior for nonessential animation;
- keyboard and screen-reader access to cards and relationship data;
- automated interaction tests, plus a written manual QA checklist.

Out of scope, deliberately:

- the Settings workspace, module discoverability, and module settings
  consolidation — see `settings_workspace_plan.md`;
- the explicit auto-generation trigger setting (`TODO.md` §4) — a separate
  feature, not an accessibility repair;
- any UI framework or runtime dependency. One dev-only test dependency
  (`jsdom`) is required; see §6.

---

## 2. Verified baseline

| Measurement | Value |
| --- | --- |
| `aria-*` attributes in production JavaScript | 0 |
| `@media (prefers-reduced-motion)` rules in the repo | 0 |
| `title="…"` attributes in production JavaScript | 147 |
| Buttons whose entire label is an emoji | ~31 |
| `outline: none` declarations | 19 |
| `createModal()` consumer call sites | 11 |
| `hideModal()` call sites outside the helper and tests | 18 |
| Test files / tests / lint | 82 / 2,200 / clean |
| `main` and `testing` | both at `d9a16fb` |

Both reduced motion and ARIA are **new construction**, not repair. The
`:focus-visible` rule at `core/style.css:121` is the one pre-existing piece, and
it needs narrowing rather than extending (§4.3).

Re-check commands:

```bash
grep -rn "aria-" --include=*.js . | grep -v node_modules | grep -v ./test/ | wc -l
grep -rn "prefers-reduced-motion" --include=*.css --include=*.js . | grep -v node_modules | wc -l
grep -rho 'title="' --include=*.js . | grep -v node_modules | wc -l
grep -rc "outline: *none" --include=*.css . | grep -v node_modules | grep -v ":0"
```

---

## 3. What the code does today

Four facts shape every decision below.

**The modal body is rebuilt wholesale, not patched.** `renderModal()`
(`index.js:450`) renders all eight tabs into one string and assigns it to
`.mwt-modal-body.innerHTML`. It runs on every open *and* on every
`CHAT_CHANGED` while the modal is open (`index.js:770`), after which it restores
the active tab with a programmatic `.click()`. Existing listeners survive only
because they are bound to elements `innerHTML` just recreated.

**Secondary tab navigation already exists.** `diagnostics_panel/render.js:210`
ships a 7-item `mwt-diag-tab-btn` / `mwt-diag-tab-pane` strip. Any shared tab
helper has two consumers on day one, not one.

**MWT ships a global stylesheet into SillyTavern's page.** Unscoped element
selectors restyle the host application — see §4.3.

**Modal lifecycles are not uniform.** This is the inventory that replaces the
earlier draft's estimate of "roughly 13 direct `style.display` close paths."
That figure was produced by a grep that swept in ordinary panel visibility
toggles (for example `index.js:563`, which shows and hides the API fields when a
connection profile is selected) and should not be used.

| Modal | Built by | Close paths | Escape | Backdrop closes | On close |
| --- | --- | --- | --- | --- | --- |
| `#mwt-modal` | `createModal`, `index.js:466` | ×, backdrop, Escape, `onClose` veto | yes | yes | hide (`display:none`), node reused |
| 10 other `createModal` consumers (backup ×1, chronicle ×1, story_planner ×4, world_state ×4) | `createModal` | ×, backdrop, Escape, plus **18** `hideModal()` calls | yes | yes | hide, node reused |
| `#kt-growth-modal` | hand-rolled, `knowledge/render.js:972` | ×, Escape | yes | **no — deliberate** | `.remove()` |
| `#kt-identity-modal` | hand-rolled, `knowledge/render.js:1716` | ×, backdrop, Escape | yes | yes | `.remove()` |
| `#kt-dossier-refresh-modal` | hand-rolled, `knowledge/render.js:~1911` | ×, backdrop, Escape | yes | yes | `.remove()` |
| `#kt-view-modal` | hand-rolled at **two** sites, `knowledge/render.js:855` and `:1687` | `✕`, backdrop | **none** | yes | `.remove()` |
| chat-change sweep | `knowledge/index.js:608`, `:650` | `_cleanupKeyHandler?.()` then `.remove()` on all four `kt-` ids | — | — | destroy |

Three consequences:

- The Growth modal's backdrop behavior is intentional and documented in place —
  "easy to dismiss by accident, so require the × button or Escape." Do not
  normalize it away.
- `#kt-view-modal` is the outlier: two construction sites, **no Escape handler
  at either**, a bare `✕` with no accessible name, and it uses a `kt-history-*`
  shell rather than `mwt-modal`, so it inherits nothing from either helper.
- The four `kt-` modals destroy their node on close where `createModal` hides
  and reuses one. Any convergence must preserve that.

---

## 4. Accessibility contracts

### 4.1 Modal lifecycle

The helper needs **one authoritative close operation**, not a patched
`hideModal`. It must:

- honor an `onClose` veto;
- close or destroy the correct modal, per that modal's policy;
- clean up document-level handlers (the existing `_cleanupKeyHandler`
  convention);
- update which stacked MWT modal is currently the modal one;
- restore focus to the opener, or to a logical fallback when the opener is gone
  or no longer focusable;
- work identically for the × button, backdrop, Escape, programmatic
  (`hideModal`), and chat-change cleanup paths.

`createModal` should remember the element that opened each modal at show time.

**Convergence, with options.** Bringing the four `kt-` modals onto the helper
requires `closeOnBackdrop` and `destroyOnClose` options, because their policies
genuinely differ (§3). A decorator that adds the shared accessibility behavior
while leaving each modal's existing close policy intact is an equally acceptable
outcome — the requirement is one accessibility contract, not one code path.
`#kt-view-modal` additionally needs an Escape handler and a named close button,
and its two construction sites should be collapsed into one function.

**Where the role goes.** `role="dialog"` and `aria-labelledby` belong on
`.mwt-modal-panel` — the element that is the dialog surface — not on the outer
`.mwt-modal`, which also owns the backdrop.

**`aria-modal` is a declaration, not an implementation.** Setting it does not
make anything outside the dialog non-interactive; that has to be implemented
(inerting or hiding the rest of the page while the dialog is open). Set it on
the topmost visible MWT modal only — two stacked `aria-modal="true"` dialogs are
undefined behavior in assistive technology.

**The chat-change rebuild is not a close path** and must not be filed as one.
`index.js:770` rebuilds the body while the dialog stays open, destroying focus.
Today that is a minor annoyance; with a focus trap and a modal declaration, it
strands the user on `document.body` while the rest of the page is unavailable.
The re-render must return focus into the dialog — the active tab is an
acceptable target.

**Handlers must not accumulate.** `renderModal()` runs on every open and every
chat change, so anything bound to a persistent node (`modal`, `document`) gains
a copy per call. The current code is safe only by accident. Bind once at
creation, or guard with an explicit flag, following the `_cleanupKeyHandler`
precedent.

Preserve the existing topmost-visible-modal Escape rule, and do not intercept
dialogs owned by SillyTavern or other extensions.

### 4.2 Tab navigation

One shared helper in `core/ui.js` — for example `wireTablist(container, opts)` —
owning the roving `tabindex`, the key contract, and the
`aria-selected` / `hidden` bookkeeping.

Markup contract:

- container: `role="tablist"` plus an explicit `aria-orientation`;
- buttons: `role="tab"`, stable `id`, `aria-selected`, `aria-controls`;
- panels: `role="tabpanel"`, `aria-labelledby`, a stable `id`;
- inactive tabs: `tabindex="-1"`; active tab: `tabindex="0"`;
- inactive panels: `hidden` — out of the tab order, still in the DOM.

**Orientation is a parameter, not a constant.** The main tab bar and the
Diagnostics strip are horizontal (Left/Right). Project B's Settings navigation
is vertical and will need `aria-orientation="vertical"` with Up/Down. Build the
option now so the later consumer does not fork the helper. Home and End apply in
both orientations.

**Activation is automatic.** All panels are rendered locally, so activation is
immediate and there is no reason to require a second keypress. Decided here
rather than left open.

Consumers in this project: the main tab bar and the Diagnostics sub-tabs.

### 4.3 Focus visibility

`core/style.css:121` defines `:focus-visible` with bare element selectors
(`button:focus-visible`, `input:focus-visible`, …). Because the stylesheet is
loaded into SillyTavern's page, that rule currently restyles focus across the
whole host application.

Scope it **down**, not up: move it under `.mwt-modal`, `.mwt-btn`, `.mwt-input`,
the floating-button classes, and the `kt-` surfaces. Accept that it is
authoritative only inside MWT. Do not add unscoped element selectors to any MWT
stylesheet.

Then pair the 19 `outline: none` declarations — `knowledge/style.css` (10),
`chronicle/style.css` (4), `story_planner/style.css` (4), `core/style.css` (1) —
each with a `:focus-visible` outline of clear contrast and, where practical, a
2px offset.

Focus indicators must work for buttons and links; inputs, selects and
textareas; expandable summaries; cards and graph controls; and draggable
controls, which additionally need a non-drag keyboard path.

### 4.4 Names, status, and busy state

- `aria-label` on icon-only buttons; decorative emoji inside
  `aria-hidden="true"` spans, including the eight top-level tab labels.
- Visible labels associated through `for`/`id`.
- Persistent help text in preference to tooltip-only explanations, especially
  for destructive or privacy-relevant behavior.

**Status and busy state have different owners.** `setStatus()` can own a polite
live region — `role="status"`, `aria-live="polite"`, `aria-atomic="true"` — for
announcing a result. It cannot know which control is doing asynchronous work.
Each async handler sets and clears its own `disabled` and `aria-busy`,
**including on error and cancellation paths**.

Use assertive announcements only where a message genuinely demands immediate
attention. Do not make frequently-changing values (the auto-refresh countdown,
token counters) live regions — that produces continuous screen-reader
interruption.

### 4.5 Reduced motion

Add a `@media (prefers-reduced-motion: reduce)` block; there is none today.

**Scope it past the modal.** The floating button bar and its drag behavior, the
World State auto-refresh countdown badge, and the Knowledge pending/evidence
pulses (`core/style.css:1467`, `:1485`) all live outside `.mwt-modal`. A block
scoped to `.mwt-modal *` misses every one of them.

```css
@media (prefers-reduced-motion: reduce) {
    [class^="mwt-"], [class*=" mwt-"],
    [class^="kt-"],  [class*=" kt-"],
    .mwt-modal *, .mwt-modal *::before, .mwt-modal *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
    }
}
```

**Target motion, not timers.** Reduced motion suppresses nonessential
transitions, pulses, smooth movement, and graph animation. It must not stop
functional bookkeeping — the auto-refresh countdown keeps counting; it simply
stops animating. JavaScript needs a `prefers-reduced-motion` check only where
JavaScript itself produces visual movement (the force-directed graph layout, any
smooth scroll).

### 4.6 Cards and relationship views

Cards use real headings and real buttons. A whole card is never a clickable
`div`. State — pinned, stale, selected, busy — is textual or an accessible state
attribute, never color alone.

**The relationship list view already exists.** `knowledge/render.js:2137` ships
a `🕸️ Graph` / `📋 List` toggle (`data-view`), and the list branch renders every
edge with from/type/to, notes, and the reverse relationship. The equivalent
text representation is already in the product; do not build a second one. The
remaining work:

- the per-row `🔒`/`🔓` lock and `✕` remove buttons are emoji plus `title` only;
- the graph's only instructions are pointer instructions — the hint reads
  "Click a node to view • Drag to rearrange • Scroll to zoom";
- zoom and reset controls need labels;
- node selection needs a keyboard path and an announced selected-node summary;
- the view toggle should expose pressed state, not just an `active` class;
- filters, zoom level, and empty states need accessible summaries.

---

## 5. Implementation slices

Five slices, each its own commit, each passing the full suite and its manual
checks before the next begins.

### Slice 1 — Modal lifecycle

`core/modal.js`, `knowledge/render.js`, `knowledge/index.js`, `index.js`.

1. Dialog semantics on `.mwt-modal-panel`; stable title id; named close button.
2. Opener tracking at show time; focus-on-open.
3. Focus containment, implemented as a keydown handler (see §6).
4. One authoritative close operation covering ×, backdrop, Escape,
   `hideModal`'s 18 call sites, and the chat-change sweep; `onClose` veto
   preserved on every path.
5. `closeOnBackdrop` / `destroyOnClose` options, or an equivalent decorator, so
   the four `kt-` modals keep their existing policies.
6. `#kt-view-modal`: one construction site instead of two, an Escape handler,
   and a named close button.
7. `aria-modal` on the topmost visible modal only, plus actual inertness for
   content behind it.
8. **Focus restoration across the `CHAT_CHANGED` re-render** (`index.js:770`) —
   filed here explicitly because it is not a close path and would otherwise
   fall between slices.
9. **Handler-binding guard** so trap and key handlers cannot accumulate across
   repeated `renderModal()` calls.

### Slice 2 — Tab navigation

`core/ui.js`, `index.js`, `diagnostics_panel/render.js`.

1. `wireTablist()` with an orientation option and automatic activation.
2. Main tab bar adopts it.
3. Diagnostics sub-tab strip adopts it.
4. Decorative emoji in the eight tab labels hidden from assistive technology.

### Slice 3 — Focus, status, and motion

`core/style.css`, module stylesheets, `core/modal.js`, async handlers.

1. Scope the `:focus-visible` rule to MWT selectors.
2. Pair the 19 `outline: none` declarations with focus styles.
3. Live-region semantics on `setStatus()`.
4. Per-handler `disabled` / `aria-busy`, including error and cancel paths.
5. The reduced-motion block, scoped per §4.5, plus JS checks only where JS
   produces movement.

### Slice 4 — Accessible-name sweep

All six module renderers. Mechanical, high-volume, and near-certain to conflict
with concurrent module work — land it in one pass, in a quiet window.

1. `aria-label` on the ~31 emoji-only buttons; start with
   `interiority/render.js` (42 `title`s) and `knowledge/render.js` (41), which
   together hold over half the surface.
2. Decorative emoji wrapped in `aria-hidden="true"`.
3. Triage the 147 `title=` attributes: real meaning becomes visible help text or
   a proper accessible name.
4. `for`/`id` associations on form controls.
5. Remove remaining color-only state indicators.

### Slice 5 — Cards and relationship views

`knowledge/render.js`, other renderers as needed.

1. Card heading hierarchy, real action buttons, keyboard operation, focus order.
2. Names for the relationship row lock/remove buttons; pressed state on the
   Graph/List toggle.
3. Labeled zoom and reset controls; keyboard node selection; announced
   selected-node summary.
4. Replace the pointer-only graph hint with text covering the keyboard and
   list-view paths.
5. Accessible summaries for filters, zoom level, and empty states.

**Exit for the project:** no essential MWT operation requires dragging,
hovering, emoji interpretation, or color perception; every modal is fully
keyboard-operable; `TODO.md` §4's accessibility item is ticked.

---

## 6. Testing

### 6.1 Environment

`vitest.config.js` sets `environment: 'node'` and neither `jsdom` nor
`happy-dom` is installed. `test/modal_interactions.test.js` runs against a
hand-rolled fake DOM that parses `innerHTML` with a small tag scanner.

Add **`jsdom`** as a dev dependency and mark the new UI tests
`// @vitest-environment jsdom`. This is a test-only dependency, not browser
automation; the existing guidance against adding browser automation stands.

jsdom does not implement sequential focus navigation — a Tab keypress does
nothing on its own. Assert the **handler contract**: the trap's keydown handler
computes the next focusable element and calls `.focus()`, which is both the
standard implementation and the thing under test. Do not write tests that
depend on native traversal.

jsdom does not replace running the extension inside SillyTavern with a real
browser and real assistive technology. Note that the live install is **not this
repository** — QA against the clone SillyTavern actually loads.

### 6.2 Modal tests

- dialog role, `aria-modal`, and a valid label reference on the panel element;
- opening moves focus into the dialog;
- the trap handler wraps last-to-first and first-to-last;
- close restores focus to the opener — asserted on the `hideModal` path, not
  only the × path, since 18 call sites use it;
- close behavior through **every** policy: veto, destroy-on-close,
  hide-and-reuse, backdrop-suppressed (Growth), chat-change cleanup, and a
  missing or detached opener;
- Escape closes only the topmost visible MWT modal (already covered);
- only one visible modal carries `aria-modal` when two are stacked;
- the four `kt-` modals satisfy the same accessibility contract as helper-built
  ones.

### 6.3 Tab tests

Test the helper's behavior once; add focused integration assertions per
consumer rather than duplicating the contract.

- one tab selected and one panel exposed after activation;
- `aria-selected`, `aria-controls`, `aria-labelledby`, `tabindex` agree;
- inactive panels carry `hidden`; inactive tabs carry `tabindex="-1"`;
- Arrow keys follow the declared orientation; Home and End work in both;
- activation does not rebuild or lose unrelated field values;
- both the main tab bar and the Diagnostics strip use the helper;
- repeated `renderModal()` calls do not accumulate duplicate handlers.

### 6.4 Control and graph tests

- icon-only controls have accessible names;
- busy controls expose `disabled` and `aria-busy`, and clear both on the error
  path;
- status updates land in the live region;
- the list view renders the same edge set as the graph data;
- the NPC/type filters are label-associated, both views consume the same
  filtered edge set, and the visible/total count plus active filters land in
  the filter-summary live region;
- the Graph/List toggle exposes pressed state;
- card actions are keyboard-operable.

### 6.5 Not automatable

These stay manual (§7) and must not be claimed as covered: `:focus-visible`
rendering, `prefers-reduced-motion` behavior, and real browser focus traversal
— for which the automatable proxy is `hidden` on inactive panels and
`tabindex="-1"` on inactive tabs.

---

## 7. Manual QA checklist

Run per slice, against the live SillyTavern install.

- [ ] Keyboard-only: open the modal, reach every tab, operate each panel, close,
      and confirm focus returns to the opener.
- [ ] Keyboard-only at mobile width, with the tab strip horizontally scrolled.
- [ ] Every modal, including the four Knowledge ones, opens and closes without a
      mouse.
- [ ] Chat switch with the modal open: focus stays inside the dialog.
- [ ] Screen reader: dialog announced, both tab levels announced, active panel
      identified, status messages announced once.
- [ ] Visible focus on every interactive control, light and dark theme.
- [ ] Browser zoom to 200% with no clipped controls.
- [ ] OS reduced-motion on: no pulses, transitions, or graph animation; the
      countdown still counts.
- [ ] Relationship data fully reachable in list view; nothing available only by
      drag, hover, or color.
- [ ] SillyTavern's own controls are visually unchanged.

---

## 8. Risks

| Risk | Mitigation |
| --- | --- |
| Focus restoration misses the 18 `hideModal` call sites | One authoritative close operation; every path migrated onto it, including the chat-change sweep. |
| Converging the `kt-` modals silently changes their close policy | `closeOnBackdrop` / `destroyOnClose` options, or a decorator; Growth's backdrop suppression is deliberate and tested. |
| `aria-modal` shipped without real inertness | Treat the declaration and the implementation as one task; test with two stacked modals. |
| The `CHAT_CHANGED` rebuild strands focus | Filed explicitly as Slice 1 task 8, not left inside "close behavior". |
| Trap/tablist handlers accumulate across `renderModal()` calls | Bind once at creation or guard with a flag, per the `_cleanupKeyHandler` precedent. |
| The tab helper forks when Project B needs a vertical strip | Orientation is a parameter from day one. |
| MWT's unscoped `:focus-visible` rule restyles SillyTavern | Scope shared rules to `.mwt-`/`.kt-`; forbid bare element selectors; verify the host UI in manual QA. |
| Reduced motion stops functional timers | Suppress motion only; countdowns keep counting. |
| The name sweep collides with in-flight module work | Slice 4 lands in one pass, in a quiet window. |
| New UI tests assert against the hand-rolled fake DOM and prove nothing | Add `jsdom` first; assert handler contracts; keep §6.5 items in manual QA. |
| Manual QA run against the wrong checkout | The live install is a separate clone, not this repo. |

---

## 9. Branch workflow and baseline

Baseline at the start of this work: 82 test files, 2,200 tests, lint clean;
`main` and `testing` both at `d9a16fb`.

1. Branch from the agreed base for Project A only.
2. One commit per slice; full suite and lint after each.
3. Bring base-branch changes into the feature branch regularly, resolving
   conflicts there.
4. Complete the §7 checklist before merging.
5. Promote through **one** path — either feature → `main` → `testing`, or
   feature → `testing` → `main`. Pick one and keep it. Merging the same commits
   independently into both long-lived branches creates avoidable history and
   conflict confusion.

Project B branches from the updated base after this project merges. It does not
continue on this branch.
