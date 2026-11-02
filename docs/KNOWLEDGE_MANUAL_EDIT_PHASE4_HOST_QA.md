# Knowledge manual edit — Phase 4 host QA

**Implementation checkpoint:** 2026-11-01. **Host results:** pending.
Use a disposable chat/lorebook, alongside the original Phases 1–2 checklist
and the Phase 3 UI checklist. This adds a UI route for recovery and advisory
guidance; no console API is required. Existing tester results are not replaced.
Record host/browser version, tested commit, outcome, and evidence for each item.

## Recovery through NPC View

1. On both Minor and Major sub-tabs, View an NPC without history. **Restore
   previous version** must be hidden. History containing only the current body
   or relationship-block changes must also leave it hidden. FAILED: Its visible on clicking View
2. Edit and save a body change. View must now offer Restore. Click it: the old
   body opens as a timestamp-labeled **unsaved draft**, current keywords remain,
   and managed relationships remain read-only. Opening Restore must issue no
   edit POST and add no history. Redundant/block-only records must be skipped in
   favor of the newest differing body. PASS
3. Cancel/Revert/Escape/backdrop/close must treat a restored draft as dirty.
   Declining discard keeps it. Revert returns to the loaded live body and removes
   the historical-draft label. Cancel returns to View without writing. PASS
4. Restore and Save. Expect one edit POST, the restored body persisted, current
   keys preserved, and the displaced live content added to history. Restore and
   Save again: the two body versions toggle using ordinary history. The current
   graph, not historical relationships, must supply the managed block. PASS
5. Open Restore, then change the live body in another host window/tab. Saving
   must refuse stale/cache-conflicting content and preserve the draft. Explicit
   reload remains available after a stale-source refusal. Offline failures must
   likewise retain the restored draft and permit retry.
6. Switch chats during Restore loading or saving. The modal closes without
   prompting and late results cannot alter the new chat's UI. Throttled-network
   double clicks must not duplicate loads/saves. State Tracker remains read-only.

## Advisory guidance

In Edit, warnings appear near Save and update as the body changes. Test each:

- Missing/malformed first header line, including a leading blank line.
- `Knowledge Ledger:` with no items, the empty-ledger placeholder, or an
  unsupported heading/boundary.
- A non-item line interrupting the ledger with additional `- ` items below it.
  Blank lines between items alone must not warn.
- `[Dossier]` retained but all labeled dossier fields removed. Individual dossier
  fields are optional; a valid partial dossier must not warn about missing fields.
- Dossier fields retained but the marker deleted or moved away from the exact
  start (including a leading blank line or space).
- A paste at least 50,000 characters larger than the loaded baseline. A valid
  pre-existing ledger larger than 50,000 characters must not warn just for size.

Every nonempty malformed draft must remain saveable; verify an actual save on
the disposable entry. Whitespace-only content still disables Save. Revert should
recompute warnings for the baseline. Verify keyboard focus, warning readability,
and header/action wrapping on desktop and narrow/mobile layouts.

## Full browser storage

Run on a browser whose `localStorage` is full, or fill a disposable one. Trimming
permanently removes old snapshots from that browser's history; it must never
change a lorebook entry. Export the lorebook first if you want a copy.

1. Edit and save a body change on an NPC with no history. The save lands, the
   status has no "could not be kept" text, Restore appears, and free space grows.
2. If only repeats were trimmed, no toast appears. If real versions went, one
   yellow warning appears per page load, says entries are not affected, and names
   exporting the lorebook.
3. Compare the book before and after: only the edited NPC changed. Other
   `localStorage` keys and any unreadable `kt_history_*` key stay byte-identical.
4. An NPC whose history holds another NPC's text must not offer that text. With
   no other differing version, Restore stays hidden.
5. In Edit mode, the Edit and Restore buttons must both be hidden.

## Remaining boundary

This checkpoint does not mark host QA passed or the feature released. Original
forged-uid/retained-session service probes still have no UI route; see the Phase 3
checklist for that distinction. Lost-response reconciliation and combined release
readiness remain Phase 5 host work. Do not mark those passed from automated tests.