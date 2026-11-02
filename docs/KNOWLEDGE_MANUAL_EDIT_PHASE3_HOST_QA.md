# Knowledge manual edit — Phase 3 host QA entry point

**Implementation checkpoint:** 2026-11-01. **Host results:** pending.
Use this alongside `KNOWLEDGE_MANUAL_EDIT_HOST_QA.md`, whose Phase 2 checks
and in-progress results remain applicable. No new console API is required for
the ordinary Phase 1 manual-save checks now that NPC View exposes **Edit**.
Use the original checklist's disposable chat/lorebook setup and Network/history
observability. Never interpret automated test results as host sign-off.

## UI path

1. Open a tracked Minor or Major NPC's **View**. It must initially be read-only.
2. Choose **Edit**. It re-reads the current entry; the body excludes the managed
   relationship block, keywords show current keys, and relationships appear
   read-only with guidance to the Relationships sub-tab.
3. Change the body and Save. Confirm exactly one edit POST, persisted disk/cache
   content, history increment, read-only View showing the saved text, and updated
   cards. Check an already-open World Info editor refreshes in the real host.
4. Edit keywords only; Save, then accept a pending proposal for that NPC.
   Confirm saved keywords survive acceptance. Clear non-default keywords and
   Save to verify fallback to the NPC name.
5. Save unchanged content/keywords (also try a CRLF source entry). Confirm no
   edit POST and no new history. Whitespace-only content disables Save;
   nonempty malformed content remains saveable (advisory lint is Phase 4).
6. Exercise Revert, Cancel, Escape, close, and backdrop with a changed body and
   with keywords-only changes. Declining discard preserves the draft; accepting
   discards it. Revert stays in Edit with the loaded baseline; Cancel returns
   to View. Keyboard focus stays usable in both modes and returns after close.
7. While editing, save a newer body through another host window/tab. Attempt
   Save: stale refusal must retain the draft. **Reload current entry** requires
   explicit discard confirmation; declining keeps the draft, accepting loads
   the new baseline. A failed reload must also preserve the draft.
8. Run the original cache-conflict and offline-save checks through this UI.
   Failures must be honest, with draft retained and retry available. Slow the
   network: double clicks must not duplicate saves, and close/Escape/backdrop
   must not dismiss a pending save.
9. Switch chats during View loading, Edit loading, and Save. The old modal must
   close without discard confirmation, never reopen on completion, and never
   refresh the new chat's cards/status. Verify the page is not left inert and
   later modals have only their own Escape handling.
10. Check State Tracker View has no Edit control, orphan NPC cards have no View,
    and narrow/mobile layout permits editing, scrolling, and reaching actions.

## Checks still requiring a different surface or later host work

- Original P1-B10's retained-session service call after chat switch is not
  directly invocable through UI: closing on scope change is intentional. Use
  the UI lifecycle checks above; the service refusal has automated coverage.
- P1-B11's deliberately forged bookkeeping uid has no UI route. Do not expose
  one merely for QA; keep the service's automated refusal coverage recorded.
- Original P1-C's severed-response/reconciliation scenarios remain pending for
  the later host pass. Automated uncertain-outcome coverage is not host proof.
- Restore and advisory lint remain Phase 4; combined release readiness remains
  Phase 5. Record browser/host version, tested commit, outcomes, and evidence
  before marking any host checklist item passed.