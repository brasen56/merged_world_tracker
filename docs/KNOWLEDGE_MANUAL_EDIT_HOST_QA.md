# Knowledge Tracker manual edit — host QA checklist (Phases 1–2)

**Scope doc:** [KNOWLEDGE_MANUAL_EDIT_SCOPE.md](KNOWLEDGE_MANUAL_EDIT_SCOPE.md) §13.
Both phase completion records end with *"SillyTavern host QA is pending"* — this
checklist is that QA. Phase 2 is the priority: its accept check changed live
behavior for every NPC proposal before any Edit UI exists (§13, "the one
exception to not independently releasable"), so it gets checked against real
proposals now, not at Phase 5.

**Build under test:** branch `testing` @ `e4d3ad8` (includes Phase 1 `73e5cb3`
and Phase 2 `e4d3ad8`).
**Tester / date:** ______________________

| Section | Area | Status |
| --- | --- | --- |
| A–D | Phase 2 — proposal acceptance (live path) | ☐ |
| P1-A | Phase 1 — cache-conflict wording via cleanup (checkable now) | ☐ |
| P1-B | Phase 1 — manual-edit service via console | ☐ BLOCKED (no console surface) |
| P1-C | Phase 1 — items legitimately left pending | ☐ pending |

An item **passes** when the observed behavior matches its *Expect* line. On
mismatch, record what actually happened plus console/network evidence; do not
mark the section passed with open failures.

---

## Setup (once, before any checklist item)

1. Run SillyTavern with this checkout installed as the MWT extension, on a
   **disposable chat and lorebook** — several checks deliberately write, refuse
   writes, and delete entries. Do not run this against a book you care about.
2. The chat must resolve to a lorebook scope with a few tracked NPCs (scan, or
   📚 From Lorebooks import). At least one Minor and one Major NPC; one with a
   managed relationship block (check the entry for the
   `<!-- mwt:relationships:start -->` marker in ST's World Info editor).
3. Stage proposals: run a Knowledge scan (needs the model), or use
   Promote/Demote items, which stage without a model call.
4. Open devtools (F12) and keep three things visible:
   - **Network** filtered on `api/worldinfo/edit` — every lorebook write is a
     POST here. This is the most reliable signal: a successful accept shows
     exactly one new POST, and "nothing was written" claims are verified by
     *no new request*.
   - **MWT's own status bar** (inside the extension panel, not devtools) —
     the *Expect* messages in this checklist (`"X" written to lorebook.`, the
     stale warning, …) render there. The devtools Console is **not** expected
     to show anything during a successful accept: `[MWT:Knowledge]` console
     lines are warnings only (B7's refusal, identity mismatch). Console
     silence on success is normal.
   - **Application → Local Storage** — per-entry history lives under
     `kt_history_<bookName>_<uid>`. Two gotchas: the *key list* rarely changes
     (a save adds a record **inside** an existing key's value, and creating a
     brand-new NPC pushes no history at all — only overwrites do), and the
     panel does not auto-refresh values. Instead of eyeballing it, paste this
     into the devtools **Console** — it tables every history key sorted by
     most recent activity, so after an accept the affected uid jumps to the
     top with a fresh timestamp:

     ```js
     console.table(Object.keys(localStorage).filter(k => k.startsWith('kt_history_')).map(k => {
         const h = JSON.parse(localStorage.getItem(k) || '[]');
         return { key: k, records: h.length,
             newest: h[0] ? new Date(h[0].ts).toLocaleTimeString() : '—', ts: h[0]?.ts || 0 };
     }).sort((a, b) => b.ts - a.ts));
     ```

     For a single known uid, the count one-liner is (space in the book name
     is fine inside the quotes):

     ```js
     JSON.parse(localStorage.getItem('kt_history_<bookName>_<uid>') || '[]').length
     ```

5. **The staleness trick** (used throughout Phase 2): with no Edit UI yet, the
   way to change an entry "underneath" a pending proposal is to edit it in
   ST's World Info editor and save there. The scope doc is explicit that this
   check also protects ST-editor edits (§6.2), so this is not a workaround —
   it is the real race.

6. **Reading an outcome at a glance:** the item **left the pending list** plus
   one POST = accepted. The item **stayed pending** plus a warning banner at
   the top of its detail pane plus no POST = stale (the B-section behavior
   working as designed — start the next item from a *fresh* proposal). No
   visible change at all and no console/network activity = something to
   investigate before continuing.

Before each Phase 2 item, note the entry's current history count so a
"pushed / not pushed" claim is checkable afterwards.

---

## Phase 2 — proposal acceptance (live path, no special tooling)

### A. Regression — normal accepts still behave

Nothing in this section is new behavior; it proves the Phase 2 changes did not
disturb the existing path.

- [x] **A1. Single Accept, ordinary Update/Scan proposal.**
  Accept one proposal for a tracked NPC.
  *Expect:* status `"${name}" written to lorebook.`; one POST to
  `api/worldinfo/edit`; the item leaves the pending list and its notification;
  the WI editor shows the new content (reload the editor view if needed);
  history count +1.
  Result: ____PASS________

- [X] **A2. State Tracker proposal.**
  Accept a State Tracker item.
  *Expect:* identical to pre-Phase-2 behavior (this path is deliberately
  untouched — no freshness check applies to it).
  Result: _____PASS_______

- [X] **A3. Accept All, fresh batch.**
  Accept All with only fresh, enriched proposals.
  *Expect:* every item accepted; the status bar reports honest counts in the
  shape `N accepted · 0 stale/pending (…) · 0 failed · 0 skipped.`; no item is
  lost or double-counted.
  Result: _____Pass_______

### B. Stale detection (the new behavior)

- [X] **B1. Stale entry → first Accept writes nothing.**
  Stage an update for NPC X (a scan update, or a Promote item — both freeze
  their baseline: scan items at scan time, promote items at promote-click
  time). Then, in order:
  1. Click the item in the staging list and read the **Current** section —
     note a distinctive line (the frozen baseline).
  2. In ST's WI editor, change X's entry **content** — a fact line in the
     body, not the relationship block, not whitespace-only. Make it
     distinctive (e.g. add the word `QAEDIT`).
  3. **Confirm ST actually saved the edit** — this is the step that most
     easily goes wrong: watch the Network tab for the WI editor's own POST
     to `api/worldinfo/edit`, and/or switch to another entry in the editor
     and back to see `QAEDIT` persist. An edit sitting unsaved in the
      editor's form is not a persisted edit: the acceptance freshness check
      reads the saved book directly, bypassing ST's cache. Wait for the save
      POST to finish successfully before accepting.
  4. Back in MWT, click the item again (this does **not** refresh the
     baseline — the Current pane should still show the old text from step 1)
     and press Accept.
  *Expect:* **no POST**; the item stays pending; the detail pane shows the
  stale warning at the top — "The entry changed since this proposal was
  built. Nothing was written. Review the refreshed Current entry and diff,
  then Accept again if appropriate." — and the Current section / diff now
  shows the real (ST-edited) entry, not the old baseline; history count
  unchanged.
  *If it writes anyway:* confirm the sequence above was exact (baseline
  clicked before the edit; ST save POST observed) and retry once. If it
  still writes, record B1 as **failed** with the item type, the exact
  sequence, and whether the ST save POST appeared. The acceptance check now
  reads `/api/worldinfo/get` directly; automated regression tests also cover
  a newer saved entry while ST's cached loader still returns the baseline.
  Result (run 1): _____FAIL — it was written to lorebook according to MWT;
  checking ST WI entry, MWT overwrote. Suspect: ST editor edit not confirmed
  saved before Accept, or baseline captured after the edit; retest with the
  steps above before calling it a code failure._______
  Result (retest): _____PASS - commit fca5b7c59dddcd5dd8c5eff0f1644caf2fdd8816 fixed_______

  Implementation follow-up (November 1, 2026): reproduced an overwrite in
  automated tests with a stale host cache, for both Accept and Accept All.
  Acceptance verification and stale-proposal re-merge now bypass that cache.
  This is not a host-QA pass; B1 still needs a fresh run in SillyTavern.

- [X] **B2. Second Accept is informed and writes.**
  Continuing from B1, Accept again without changing anything.
  *Expect:* the write succeeds through the normal path; the entry ends up
  holding the proposal text; history +1 (one push for the real overwrite).
  Result: ____PASS________

- [X] **B3. Re-staling re-warns (no one-time bypass).**
  Stage another update, stale the entry again in the WI editor, Accept (warns),
  then stale it a **second** time before accepting again.
  *Expect:* the second Accept warns again and writes nothing — the check runs
  on every Accept, it is not silenced by a prior warning.
  Result: ____PASS________

- [X] **B4. Promote/Demote item, stale.**
  Promote (or demote) an NPC to stage the item, then stale the entry via the
  WI editor, then Accept.
  *Expect:* nothing written; the proposal text is **rebuilt from the current
  entry** (the dedicated promote/demote builder — the change survives the
  staleness); the Current section shows the fresh entry; warning shown.
  Result: ____PASS - Warning shown________

- [X] **B5. Hand-edited proposal, stale.**
  Stage an update, **edit the proposal text** in the detail pane first, then
  stale the entry via the WI editor, then Accept.
  *Expect:* nothing written; **your edited text is preserved** (not rebuilt,
  not reverted to the model's version); the comparison baseline is refreshed
  so the diff shows only real changes; warning shown. A following Accept
  writes your text.
  Result: ______PASS______

- [X] **B6. Relationship-only change is NOT stale.**
  Stage an update for an NPC whose entry carries the managed relationship
  block. In the WI editor, change only text **between** the
  `mwt:relationships:start/end` markers, save, then Accept.
  *Expect:* no stale warning; the accept proceeds through the normal path —
  the comparison strips managed blocks on both sides, so a background
  relationship sync must not trip the check.
  Result: _____PASS_______

- [X] **B7. Unverifiable entry refuses.**
  Stage an update for a throwaway NPC, then **delete that entry** in the WI
  editor (or rename its comment to a different NPC's name), then Accept.
  *Expect:* no write; status `Accept failed: cannot load or verify the current
  entry for "${name}". Proposal kept pending.`; the item remains pending and
  reviewable.
  Result: _____PASS_______

### C. Accept All — honest mixed outcomes

- [X] **C1. Mixed batch.**
  Build a pending list mixing at least: one fresh enriched proposal, one stale
  (WI-editor-edited) item, and one unenriched scan placeholder (a scan item
  never clicked, still showing the "Fetch to see changes" placeholder).
  Optionally also one deleted-entry item (B7 style). Then Accept All.
  *Expect:* each population counted separately and truthfully —
  `N accepted · N stale/pending (review the refreshed diff before accepting
  again) · N failed · N skipped (click the item to load its content first).`;
  stale and failed items **remain in the list**, still clickable and
  reviewable, with their notifications/selection bookkeeping intact; exactly
  the accepted items produced POSTs.
  Result: ____PASS________

### D. Keywords (partial — reachable subset)

- [X] **D1. Reviewer keywords on a normal accept.**
  Type comma-separated keywords into the keyword field of a normal (fresh)
  accept.
  *Expect:* the entry's `key` array in the WI editor matches exactly what was
  typed; nothing else regressed.
  Result: _____PASS_______

> Note: Phase 1's pending-keyword synchronization (a keywords-only manual save
> updating staged items) is **not reachable** without the Edit UI. It is
> re-verified when Phase 3 lands, or via P1-B below if a console surface is
> added.

---

## Phase 1 — manual-edit service

The service (`knowledge/manual_edit.js`) has no caller in the product yet: no
UI, and no `window.MWT` console surface (unlike, e.g., `window.MWT.cleanupRecovery`).
One Phase 1 change *is* user-visible today: the cache-conflict refusal wording
(`cleanup_persistence.js`) that previously read "Cleanup refused".

### P1-A. Cache-conflict wording via cleanup (checkable now)

- [ ] **P1-A1. Staged conflict produces the neutral message.**
  In tab 1, view an NPC or open the WI editor on the book (so tab 1's
  `worldInfoCache` holds it). In a **second ST tab**, edit that book and save
  (disk is now ahead of tab 1's cache). Back in tab 1, run a cleanup that
  writes (the cleanup review flow's Apply/commit).
  *Expect:* the write is refused — no POST from tab 1 — with the message
  starting `Write refused: World Info holds unsaved changes to "${book}"`
  (no "Cleanup refused" wording anywhere); after reloading tab 1, the same
  cleanup succeeds.
  Result: ____________

### P1-B. Service via console — BLOCKED

No code path reaches `loadForManualEdit` / `saveManualEdit` in the host today.
To run this section, either ask for a small `window.MWT.manualEdit` console
surface in `index.js` (same precedent as `window.MWT.cleanupRecovery`) or wait
for Phase 3's UI. The checklist is written now so it is ready either way.

- [X] **P1-B1. Load returns a stripped baseline.**
  Load a session for an NPC whose entry carries a relationship block.
  *Expect:* session baseline body equals the entry content **minus** the
  managed block; keys equal the entry's `key` array; book/scope captured.
- [X] **P1-B2. No-op save writes nothing.**
  Save with the identical body and keywords.
  *Expect:* `noOp` result; **no POST**; history count unchanged.
  Test: Shows 'No changes to save. Nothing written.'
- [X] **P1-B3. CRLF entry no-op.**
  Same as P1-B2 on an entry whose content uses CRLF line endings.
  *Expect:* still a no-op (newline normalization), no POST, no history push.
- [X] **P1-B4. Body edit persists.**
  Save a changed body.
  *Expect:* entry updated on disk and in ST's cache; an open WI editor on that
  book reloads the new content; history +1.
- [X] **P1-B5. Keyword-only save.**
  Save with the body unchanged and keywords changed.
  *Expect:* body byte-identical; `key` array updated; reported as a real save
  (not a no-op); history behavior per service result.
- [X] **P1-B6. Emptied keywords fall back.**
  Clear the keywords field entirely and save.
  *Expect:* entry saves with `key: [name]`, not `[]`.
- [X] **P1-B7. Empty body refused.**
  Save whitespace-only content.
  *Expect:* refusal `empty-body`; nothing written; nothing pushed.
  Test: Wont even allow you to save, button disables
- [X] **P1-B8. Cache conflict refuses.**
  Stage the two-tab conflict from P1-A1, then save a manual edit in tab 1.
  *Expect:* refusal `host-unsaved-edits` with the neutral wording; draft and
  session retained for retry.
- [X] **P1-B9. HTTP failure is honest, retry succeeds.**
  Stop the ST server (or set devtools to Offline) before saving.
  *Expect:* failure surfaced honestly; ST's cache and the entry unchanged;
  draft retained; after the server recovers, the same save succeeds.
- [X] **P1-B10. Chat switch mid-session refuses.**
  Load a session, switch chats, then save.
  *Expect:* refusal `scope-changed`; the **new** chat's registry and staged
  proposals untouched.
  Test: Cant do this. Trying to click out of MWT panel will force a warning about discarding edits.
    Cant change chats without discarding or cancelling
- [X] **P1-B11. Bookkeeping uid refused.**
  Attempt a save targeting the `[MWT:store]` entry's uid.
  *Expect:* refusal `bookkeeping-entry`; nothing written.
  Test: MWT:store is read only. Cant change it from MWT; would have to change it in ST WI editor
- [X] **P1-B12. Pending proposals receive saved keywords.**
  With a staged NPC proposal for that uid, perform a keywords-only save, then
  accept the proposal.
  *Expect:* the accept uses the saved keywords, not the originally staged
  array.

### P1-C. Legitimately pending (record as pending, do not force)

- [ ] **P1-C1. Lost response after a landed write** (reconciled success) and
  **keyword-only save that never landed** (honestly reported failed). Staging
  a severed response mid-flight is not practical by hand; automated tests
  cover the logic. Carry to Phase 5's host pass.
- [ ] **P1-C2.** Any P1-B items not run because no console surface exists.
  Record as pending in the Phase 1 completion record; the scope doc explicitly
  allows pending host-only checks.

---

## Recording results

- Paste per-section outcomes (and any pending items) into the Phase 1 and
  Phase 2 completion records in
  [KNOWLEDGE_MANUAL_EDIT_SCOPE.md](KNOWLEDGE_MANUAL_EDIT_SCOPE.md) §13, or
  hand this file to the implementing author to record.
- Phase 2's changelog line is still missing (latest entry is 2.51.1). Per §13
  it gets written when this check passes — that write-up belongs to the
  implementing author with the tester's sign-off.
- Nothing here marks the feature released: Phase 3–4 are unimplemented, no
  Edit UI exists, and the doc's exit gates want both authors' sign-off on
  host results before any release claim.
