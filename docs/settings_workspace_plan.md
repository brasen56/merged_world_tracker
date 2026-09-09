# MWT Settings workspace — deferred plan

**Project:** B (information architecture).
**Status:** Parked. Do not start until Project A
([`accessibility_plan.md`](./accessibility_plan.md)) has merged and had real
use.
**Origin:** split out of the combined 2026-09-08 UX/accessibility plan, which
bundled this redesign with the `TODO.md` §4 accessibility pass.

---

## 1. Why this is a separate project

This is an information-architecture redesign, not an accessibility repair. It
carries its own risks — settings persistence, duplicate configuration surfaces,
responsive navigation, and module ownership — and none of them need to be
resolved to satisfy `TODO.md` §4.

Keeping it separate means a stalled or reverted IA branch does not also stall
the accessibility work.

**Entry conditions:**

- Project A merged, including the shared `wireTablist()` helper with its
  orientation option (this project needs the vertical variant).
- Some real use of the accessibility changes, so the workspace is designed
  against a keyboard-operable baseline rather than alongside one.
- An explicit decision to proceed. This project is optional; the goal is less
  scrolling, not a correctness fix.

The `TODO.md` §4 item for an explicit auto-generation trigger setting should
stay a separate feature unless there is a concrete reason to fold it in here.

---

## 2. The problem

The Settings tab is a long linear form containing connection/API defaults,
automation and concurrency controls, injection placement, floating-button
visibility, per-tracker enable switches, and Backup/Restore. Module-specific
settings live in module tabs, usually behind a ⚙ button or a `details` element.
Finding any given setting means scrolling past unrelated ones.

---

## 3. The one invariant that must not be lost

`index.js:572` reads **every** global setting off the whole modal, each with a
silent fallback:

```js
worldStateDepth: depthOr('#mwt-s-ws-depth', 4),
worldStateRole: modal.querySelector('#mwt-s-ws-role')?.value || 'system',
```

If any section is conditionally rendered rather than hidden, Save from a
different section writes depth 4, role `system`, concurrency 2, and the rest of
the defaults over the user's real values — with no error and no status message.
The settings simply revert.

**Therefore: every Settings section stays in the DOM at all times.** Visibility
changes via the `hidden` attribute or CSS; section content is never
conditionally rendered. Preserving element IDs does not prevent this failure —
only DOM presence does.

The regression test is **not** "IDs are present in the appropriate section" —
that passes under conditional rendering. It is: *Save with section A active
produces a structurally equal patch to Save with section B active.*

---

## 4. Target information architecture

Keep the existing top-level feature tabs. Settings becomes a workspace with
section navigation: a persistent left nav on desktop, a labeled native
`<select>` or equivalent compact picker below the mobile breakpoint.

Sections:

1. **Overview** — a short orientation panel: active scope, connection source,
   and **links** to the surfaces that already own the detail. It must not
   recompute or restate what Diagnostics (Health / Scope & storage / Injection)
   and Budget already report — two surfaces that can disagree about injection or
   token state is exactly the failure §6 warns about. If Overview cannot be
   built without duplicating those reports, drop it and let API & Connection be
   the landing section.
2. **API & Connection** — Connection Manager profile, custom API fields, model,
   generation defaults, advanced options, headers, Save, Sync.
3. **Automation** — history exclusion, concurrency, background-job behavior,
   and the auto-generation trigger setting if it lands here.
4. **Injection** — role/depth placement, structural boundaries, injection
   behavior, and the Knowledge lorebook caveat.
5. **Modules** — enable/disable state, concise status, Configure actions.
6. **Appearance & Floating Buttons** — visibility, style, collapse behavior,
   reset-position actions.
7. **Backup & Restore** — export, restore, undo, and recovery-data actions in
   clearly separated groups; destructive actions never in the same
   undifferentiated row as Export.
8. **Accessibility** — reduced-motion and future presentation preferences.

Section summaries in the navigation (`Configured`, `4 enabled`, `Review`) must
not communicate state through color alone.

The navigation uses Project A's `wireTablist()` with
`aria-orientation="vertical"` and Up/Down keys. Do not fork the helper.

---

## 5. Phases

### Phase 1 — Workspace shell

`index.js`, `core/style.css`.

1. Replace the linear Settings body with the navigation/content shell.
2. Split existing controls into the eight sections.
3. Keep **all** sections in the DOM; hide inactive ones with `hidden` (§3).
4. Preserve existing control IDs and save/sync event wiring.
5. Wire the navigation with `wireTablist()`, vertical orientation.
6. Add the responsive mobile section selector.
7. Section headings, descriptions, fieldsets, help text, status summaries.
8. Move Backup/Restore into its own section without changing its engine or
   two-step restore behavior.
9. Persist the active section across the `CHAT_CHANGED` re-render, the way the
   active top-level tab already is.
10. Keep module-specific forms in their module tabs for now.
11. Build Overview as links, or drop it.

**Exit:** every global setting reachable without scrolling past unrelated ones;
mobile section selection works without a tall secondary strip; **Save produces a
structurally equal patch regardless of which section is active**; Save, Sync,
Backup, and module wiring all still work; a chat switch returns to the same
section.

### Phase 2 — Module discoverability

1. One row or card per module in the Modules section.
2. Enabled state, injection/automation state where relevant, concise
   description.
3. A labeled Configure action per module.
4. Configure activates the module's top-level tab and **moves focus** to its
   settings area — not merely changes what is visible.
5. Text status for disabled modules; never gray or an icon alone.

**Exit:** every module's configuration is discoverable from Settings, even
though the detailed forms still live in module tabs.

### Phase 3 — Module settings consolidation (optional)

Follows real use of Phase 2. Leaving this undone leaves the
duplicate-source-of-truth question permanently open; that is an acceptable
outcome, but it should be a decision rather than a drift.

1. Decide: embed module forms in Settings, or keep them in module tabs with
   deep links.
2. If embedding, extract render functions without duplicating state ownership.
3. Ensure module event wiring survives section changes and modal rebuilds.
4. Preserve unsaved-edit guards, chat-scope behavior, per-module save rules.
5. Make global defaults versus module overrides explicit in the help text.

**Exit:** one predictable path to every setting, with no duplicate controls that
can disagree about the source of truth.

---

## 6. Risks

| Risk | Mitigation |
| --- | --- |
| **Conditionally rendered sections make Save write defaults silently** | Hard invariant §3: all sections stay in the DOM. Pin with the cross-section Save-parity test, not an ID-presence test. |
| Renaming or moving controls breaks save wiring | Preserve existing IDs and test selectors before refactoring. |
| The `CHAT_CHANGED` rebuild loses the active section | Persist and restore it alongside the active top-level tab. |
| Overview duplicates Diagnostics/Budget status | Overview links out; it never recomputes injection, scope, or token state. |
| Duplicate global and module settings disagree | Phase 2 links to existing module settings; consolidate only after ownership is explicit. |
| Mobile navigation consumes more vertical space | Native labeled section selector below the breakpoint. |
| The tab helper gets forked for the vertical strip | Orientation is already a `wireTablist()` parameter from Project A. |

---

## 7. Design constraints carried over

- Native HTML controls over clickable `div` elements: `button`, `nav`,
  `section`, `fieldset`, `legend`, `details`, `select`.
- No state communicated by color, emoji, or `title` alone.
- Shared classes rather than more inline styles: `.mwt-settings-layout`,
  `-nav`, `-nav-btn`, `-sections`, `-section`, `-section-header`, `-card`,
  `-help`, `-warning`, `-actions`.
- Save available in a sticky action area; the status message and Save must stay
  usable when section content is scrolled.
- Existing dark/light theme variables and responsive breakpoints preserved.
- Layout must survive: desktop ~960px, narrow two-column tablet widths, mobile
  below 768px, long or user-provided label text, and browser zoom.
- No UI framework, no new runtime dependency.
