# Knowledge Tracker — manual entry editing in-module

**Status:** Revised draft, checked against the code; not an implementation commitment.
**Date:** 2026-11-01
**Area:** Knowledge Tracker NPC list UI (Minor/Major sub-tabs), the lorebook write path, and the staging accept path.
**Purpose:** Agree on the editing affordance, safety boundaries, and first-release scope before implementation.

## 1. Problem

Users report that fixing a tracked NPC entry today requires leaving MWT and
navigating SillyTavern's World Info editor. With many lorebooks installed,
finding the right book and the right entry inside ST's editor is the pain
point: books are listed flat, entries are mixed with non-MWT content, and the
user must know which scope-resolved book name MWT wrote to. MWT already solves
the discovery half of this — the Minor/Major sub-tabs list exactly these
entries, resolve the correct book per chat scope, and load content with
label verification. The View modal (`openNpcViewModal`, `knowledge/render.js`)
is read-only, so the last mile — the write-back — sends users back to ST.

Parity note: users can already edit these same entries free-form in ST's
World Info editor with no validation and no awareness of MWT's guards. An
in-module editor is not a new risk class; it is the same edit performed
through a path that can verify identity, record history, and avoid known
save-data-loss pitfalls.

**Guiding principle:** the manual editor is a convenience write path, not a
new authority. It must route through the same guarded seam the module's
model-driven writes use, on that seam's checked branch (§5), inherit every
existing protection, and add nothing that weakens them. A hand edit cannot be
regenerated, so it gets the same save guarantees as a ledger cleanup.

## 2. Proposed scope at a glance

| Workstream | Proposed behavior | Consent boundary |
| --- | --- | --- |
| Edit affordance | The existing View modal gains an explicit Edit mode (see §3) | Read-only remains the default; editing starts only on an explicit action |
| Write-back | Manual saves route through the checked `beforeWrite` branch of `writeToLorebook` (§5) | Disk read, cache-conflict refusal, pre-mutation guard, and a status-checked save; no new unguarded write path |
| Recoverability | Prior content is pushed to per-entry history before overwrite (automatic), and the modal gains one **Restore previous version** action (§5.5) | No change to history retention (50 snapshots, localStorage) |
| Concurrent edits | Freshness check inside the write: if the entry body changed since Edit loaded it, refuse and offer reload (§6.1) | Never silently clobber a background update; the user's draft is preserved |
| Pending proposals | Accepting a staged proposal first checks it was built from the current entry (§6.2) | A stale proposal never silently reverts a hand edit |
| Relationship block | The textarea holds the entry body only; the managed block is read-only and re-attached on save (§5.4) | The relationship graph stays the block's only source |
| Validation | Advisory lint (header line, dossier shape, ledger shape, suspicious sizes); empty content is the one blocking case (§7) | Lint warnings never block save |
| Keywords | Comma-separated trigger keywords field alongside content (§8) | Registry stays in sync with the entry's `key` array; an emptied field falls back to the NPC name |
| Cost | None — pure UI/write-path feature, no model calls, no prompts, no settings | No new API spend, nothing generated |

## 3. Affordance decision: Edit-in-View (chosen) vs. card button

Two candidate UX shapes were raised:

**A. Edit button on the NPC card (Minor/Major sub-tab).** A dedicated button
opens an edit modal directly. Cost: the cards already carry up to eight
actions on a dossier-mode Major NPC (Update, Enrich, Fields, Condense, Growth,
Demote, View, Identity, Remove — see `renderNpcListContent`,
`knowledge/render.js`), and a ninth competes for attention on small screens.

**B. Edit mode inside the existing View modal (chosen).** The View modal
opens exactly as today: read-only. An **Edit** control in the modal header
swaps the read-only `<pre>` for a monospace `<textarea>` holding the entry
body, shows the managed relationship block read-only beneath it (§5.4),
reveals **Save / Revert / Cancel**, and the close button gains an
unsaved-changes guard. After a successful save the modal returns to read-only
view showing the persisted content, so the user sees the committed result,
not their own draft echoed back. That holds because the checked branch
updates ST's cache only after the save succeeds (§5.1).

Edit is opt-in per caller: `createKnowledgeViewModal` is shared with the State
Tracker View path, which gets no Edit control in this slice.

Why B: zero new card clutter; the edit happens where the content is already
loaded and identity-verified (`loadEntryContent` performs the same
label-alias check as the write path); it matches the reported workflow
("I'm looking at Sophie, her Role is wrong, fix it here"); and the explicit
mode switch keeps accidental mutation harder than in ST's editor, where the
textarea is always live.

If power users want a one-click path later, a card-level Edit shortcut that
opens the same modal already in edit mode is a cheap follow-up and does not
change the design.

## 4. User flow (edit-in-View)

1. On a Minor or Major card, press **View** (unchanged from today).
2. The modal loads content via the label-verified read path, exactly as it does
   today.
3. Press **Edit**. The edit session re-reads the entry, captures the scope token
   and resolved book, and takes the entry body, with the managed relationship
   block stripped, as its **baseline snapshot**. Loading here rather than at
   View means a modal left open cannot start an edit from stale text, and View
   itself stays unchanged. If the read fails, the modal stays read-only and
   explains. Otherwise the body becomes an editable textarea, with the
   relationship block read-only beneath it, and an optional keywords field
   (comma-separated) pre-fills the entry's current `key` array.
4. Press **Save**:
   - Empty or whitespace-only content is blocked (§7). If the draft is not
     dirty (see below), the modal returns to read-only without writing.
   - Write through the checked branch (§5). The guard verifies scope, identity,
     and freshness against a disk read before anything changes (§5.2, §6.1).
     If any check fails, refuse the save, keep the draft, and explain. Prior
     content is snapshotted to entry history automatically.
   - On success: status toast, modal returns to read-only showing the saved
     content, the registry keywords update, pending proposals for this entry
     take the saved keywords (§6.2), and the NPC list re-renders (keywords
     shown on the card can change).
   - On failure: the error is surfaced honestly and the outcome is reconciled
     (§6.3); the draft is kept so the user can retry or copy their text out.
5. **Cancel/Revert** discards edits (with an unsaved-changes confirm when
   text was touched); **Escape**/close behaves the same.
6. A chat change closes the modal without a prompt and discards the draft
   (§6.4).

**Dirty rule:** a draft is dirty when its text differs from the baseline after
both are newline-normalized, or when its parsed keywords differ from the loaded
`key` array run through the same parser. Textareas normalize CRLF to LF, so raw
text would read as changed when nothing was touched. The comparison is against
the baseline, not the textarea's initial value, so a restored draft (§5.5)
counts as a change. This rule drives both the no-op Save and the
unsaved-changes confirm.

## 5. Write path and inherited safety properties

Manual saves call `writeToLorebook(name, content, keywords, uid, { bookName,
beforeWrite })` in `knowledge/lorebook.js`. This is the checked branch cleanup
already uses, not the seam's default path.

### 5.1 Why not the default path

The default path ends in `saveBookNow`, which awaits ST's
`saveWorldInfo(name, data, true)`. That call updates `worldInfoCache` before
the POST, and ST's `_save` never checks `response.ok`. So on the default path:

- an HTTP error returns `{ success: true }`, and a re-read shows the draft from
  the cache as if it had been saved;
- after a network failure the cache already holds the draft, so a retry fails
  the staleness check with a false "entry changed";
- a change from another tab is invisible, because `loadWorldInfo` answers from
  the cache;
- a stale uid or store-entry collision is not refused. The seam detaches the
  uid and falls through to adopt or create, which would land the user's text
  on a different entry.

The `beforeWrite` branch closes all four. It:

- reads the book from disk (`loadCleanupBook`);
- refuses when ST's cache differs from disk (`hostCacheConflict`, code
  `host-unsaved-edits`), which catches a pending World Info editor edit, an
  earlier failed save, and another tab's write;
- runs a synchronous guard on the final loaded object before any mutation,
  history push, or save;
- saves through `saveCleanupBook`, which checks the response and updates ST's
  cache only after success.

Two small seam changes are needed:

1. `writeToLorebook` skips keywords when `beforeWrite` is set, because cleanup
   owns content only. Add an explicit `writeKeywords` option, off by default, so
   a manual save can write them while cleanup keeps its rule.
2. `hostCacheConflict` says "Cleanup refused". Make the text neutral or
   caller-supplied.

### 5.2 The manual-save guard

The `beforeWrite` guard is this feature's refusal point. It refuses unless all
of these hold:

- the scope token and resolved book still match the edit session;
- the store is hydrated (`assertHydrated`);
- `entries[uid]` exists and is not the `[MWT:store]` entry or a cleanup-recovery
  entry;
- the entry's label verifies through `isSameNpcByName`, the alias-aware rule
  `loadEntryContent` uses. Cleanup's stricter `labelMatches` would refuse
  entries that carry an alias spelling;
- the entry body still equals the baseline snapshot (§6.1).

Because the guard runs first, a manual save always takes the seam's update
branch and can never adopt or create.

### 5.3 Inherited properties

- **Identity verification (KNOWLEDGE-01):** the guard applies the same shared
  NPC identity rule, but refuses instead of detaching. Alias spellings still
  verify.
- **Bookkeeping protection:** a uid that resolves to the `[MWT:store]` entry or
  a cleanup-recovery entry is refused; an NPC can never be written over module
  bookkeeping.
- **History snapshot:** the previous content is pushed to the per-entry
  history record before overwrite. `pushHistory` runs before the save, so a
  failed save leaves a redundant snapshot, which §5.5 skips.
- **Checked save:** `saveCleanupBook` fails on a non-2xx response, and the store
  still folds into the same write (`applyStoreToWorldInfo`, then
  `markStoreClean` after the save resolves).
- **ST editor coexistence:** every checked save refreshes ST's World Info
  editor when it is showing this book, so a user editing the same entry on the
  ST side reloads the new content instead of clobbering it with a stale copy
  on their next keystroke. This is a strict improvement over editing in ST
  alone, where two open editors race blindly.
- **Scope correctness:** the modal outlives any single write, so resolving the
  book inside the seam is not enough. The edit session captures the scope token
  and book when Edit loads the entry and passes `bookName`, the guard re-checks
  both, and the scope is checked again after the write before the registry
  keywords update, because `saveRegistry` resolves the book itself.

The editor itself only ever writes content and keywords. It never creates
entries, deletes entries, or touches type/promote/demote — those remain
existing actions with their own flows. (The seam also re-asserts the entry
label as the registry key, as every write does.)

### 5.4 Managed relationship block

An entry can end with a managed block between `<!-- mwt:relationships:start -->`
and `<!-- mwt:relationships:end -->`. It is a projection of the relationship
graph, rewritten by `syncRelationshipsToLorebook`, and presets match its
`Stance toward {{user}}:` label. View shows raw content, so without special
handling the block would land in the textarea, where:

- edits inside it are replaced on the next sync, with no warning;
- deleting one marker, which looks like junk to a user, makes
  `stripRelationshipBlock` a no-op, so the next sync appends a second block;
- a background sync during an edit would fail a whole-entry staleness check
  over text the user never touched.

Rule: the textarea holds the stripped body. The block is shown read-only with
a pointer to the Relationships sub-tab. On save the block is rebuilt from the
graph with `formatRelationshipBlock(name)` and attached with
`injectRelationshipBlock`, so the newest block always wins. An empty result
leaves the body with no block, matching the sync.

### 5.5 Restore previous version

History today is not recoverable by a user: `getHistory`'s only caller is the
export. Read-only mode therefore gains one **Restore previous version** action.
It finds the newest history record whose stripped body differs from the current
entry's body, and opens that body in edit mode as an unsaved draft labelled with
the record's timestamp. The newest record alone is not enough: every
relationship sync that changes the block pushes history, and a failed save
leaves a copy of the current text, so the newest record often holds the same
body. The user saves the draft through the normal path, so every check above
still applies, and the baseline stays the live entry. History stores content,
not keywords, so the keywords stay as they are. The action is hidden when no
such record exists.

This is one step, not a browser. Saving pushes the current text to history, so
restoring twice toggles between two versions.

Known, pre-existing gap: history caps at 50 snapshots in localStorage,
relationship syncs use up that cap too, and quota failures are silently ignored.
This feature does not worsen that gap. The timestamp shows the user when the
newest usable record is older than they expected. A full history browser remains
a separate workstream, not a dependency.

## 6. Concurrent edits and staleness

`writeToLorebook` verifies *identity* but not *freshness*: it will happily
overwrite a newer entry with an older snapshot. A long-lived edit session makes
that matter in both directions.

### 6.1 A change lands during an edit session

A background scan's auto-approved update could land while the user is typing,
and the user's save would silently revert it.

Rule: the §5.2 guard runs against the final disk load and requires
`stripRelationshipBlock(entries[uid].content) === baselineSnapshot`. On
mismatch, do not save; keep the user's draft in the textarea, and explain that
the entry changed underneath (a background update, another tab, or an edit in
ST's editor) with an option to reload the fresh content. Rebasing/merging is
explicitly out of scope — the user re-applies their change knowingly.

The comparison excludes the relationship block, so a background relationship
sync does not refuse the save (§5.4). When ST's cache differs from disk,
`hostCacheConflict` refuses first with its own wait-or-reload message.

### 6.2 A stale proposal lands after the edit

Staged proposals hold text merged from the entry as it was when they were
built. `handleAccept` and Accept All write that text with no freshness check.
So a scan stages an update, the user hand-fixes the entry, the user accepts,
and the fix is silently reverted. The diff still shows the old entry as
Current, so nothing warns the reviewer. People fix entries while reviewing
proposals, so this is the likeliest race in the feature.

Rule: in `handleAccept`, for an NPC item with a non-null `existingContent`, load
the entry and compare it to `existingContent` with the relationship block
stripped and whitespace trimmed on both sides, because scan items store raw
text and per-NPC items store stripped text. An unenriched scan item reads the
fresh entry when it is enriched, so it cannot be stale.

On a mismatch the first Accept writes nothing:

| Proposal | Response |
| --- | --- |
| Scan or Update item, not hand-edited (no `item.edited`, no `refreshFields`) | Clear `existingContent`, rerun `enrichStagingItem`, and show the new diff. If the re-merge cannot load the entry, restore the previous `existingContent`, because a null baseline would skip this check on the next Accept |
| Promote or demote item | Rebuild with `buildPromotedContent` / `buildDemotedContent`. Never use `enrichStagingItem`: its final branch sets `mergedContent` to the existing text and would drop the change |
| Enrich or Fields item (`refreshFields` set), or any hand-edited proposal | Keep its text, set `existingContent` to the current entry with the relationship block handled the same way as the proposal text, so the diff shows only real changes, and warn |

A later Accept is then an informed choice, because the diff shows the real
entry. If the entry cannot be loaded or verified, refuse.

Accept All needs an outcome from `handleAccept`. Today the loop counts every
call as accepted, because `handleAccept` reports failures through the status
bar rather than throwing. Stale items stay pending and are counted separately;
the existing "click the item" skip message does not apply to them.

The content check cannot see a keywords-only edit, and proposals carry keywords
captured when they were staged. So a successful manual save also sets `keywords`
on every pending item for that uid.

This check also protects content edits made in ST's editor, which have the same
exposure today.

### 6.3 Failed saves and retries

A refusal (guard or cache conflict) means nothing changed: keep the draft and
explain.

A save error is different, because the server may have written the book before
the response was lost. Disk is then ahead of ST's cache, so a retry would hit
`hostCacheConflict` before the guard runs. After a save error, re-read the entry
from disk and compare it to what was sent, as cleanup's `reconcileOutcome` does.
Compare `key` as well as the body, because a keyword-only save leaves the body
unchanged whether or not it landed. Compare bodies in stripped form, taken from
the exact content sent rather than the draft, because re-attaching the block
trims whitespace:

- body and `key` both match what was sent: the write landed. Copy the disk book
  into ST's cache, as `saveCleanupBook` does after success, refresh the editor,
  and continue as a successful save. Leave the store dirty: `markStoreClean`
  only clears a flag, a dirty store simply flushes again, and clearing it could
  hide registry changes made after the save was sent;
- body equals the baseline and `key` equals the loaded keywords: nothing landed.
  Stay in edit mode; a retry is safe;
- anything else, or the read fails: say the outcome is uncertain and keep the
  draft available to copy.

### 6.4 Chat changes and closing

The chat-change sweep closes `#kt-view-modal` through `_closeModal`, which runs
`onClose`. So the unsaved-changes guard must check scope first and allow the
close when scope has changed, as `cleanup_review_ui.js` does. Otherwise a
confirm fires during the switch, and pressing Cancel keeps an old-chat editor
alive, which is what the sweep exists to prevent.

A chat change cannot be vetoed, so it discards the draft. That is accepted for
this slice.

While a save is pending, close is blocked the same way cleanup blocks it during
Apply, because a closed modal would hide the outcome. A scope change still
closes it.

## 7. Validation and format guidance

Entry shapes the module parses downstream (scan projection, identity
extraction, minor/major content merges, ledger parsing in
`knowledge/lorebook.js`):

- Minor: header line `Name | Species | descriptor` (a pipe line with ≥3
  segments), then `Tone:` / `Perceived as:` / `First seen:` lines.
- Major: as Minor, plus a `Knowledge Ledger:` section of
  `- fact via source — date` lines.
- Dossier mode: a marker-prefixed header plus labeled fields and the ledger.

Any of these can be followed by the managed relationship block, which the
textarea does not show (§5.4).

A hand edit that mangles a header or ledger line degrades those parses — but
the same is true today of any ST-editor edit, which has no validation at
all. So: **advisory lint only**, computed live or on save, on the body:

- header line missing or malformed (`isHeaderLine` fails on the first line);
- `Knowledge Ledger:` section present but no parseable ledger lines;
- a non-`- ` line inside the ledger with more `- ` lines after it, because the
  section ends at the first such line and the rest drop out of ledger handling;
- dossier marker present but labeled fields gone;
- labeled dossier fields present but `[Dossier]` not at the very start, because
  `isDossierEntry` is a strict `startsWith`, so a leading blank line or deleted
  marker silently changes which merger runs;
- a suspiciously large paste, meaning a draft ~50k characters longer than the
  baseline, as a fat-finger guard. Compare to the baseline, not an absolute
  size, because real ledgers already exceed 50k characters.

Warnings display near the Save control and never block.

The one blocking case is empty or whitespace-only content. An empty entry is
almost never intended, is indistinguishable from an accidental
select-all-delete, and cannot be repaired in-module: `openNpcViewModal` returns
silently on empty content and `runNpcUpdate` throws on it.

## 8. Keywords

Trigger keywords are the second most common manual fix (misspelled names
that never fire), and they are included in v1. Every MWT write sets the entry's
`key` from the registry's keywords, so a keyword fix made in ST's editor is
overwritten by the next write. The in-module path is the only one that lasts.

The field pre-fills from the entry's `key` array, which is what ST actually
matches. `loadEntryContent` returns content only, so the edit session needs a
read that also returns `key`.

A save writes the entry's `key` through the option in §5.1, then updates
`registry[name].keywords` through `registerEntry`, after the scope re-check in
§5.3. An emptied field falls back to `[name]`, as the staging accept path does.
Without the fallback the entry saves with `key: []` and silently stops firing.

## 9. Delivery slices and explicit exclusions

1. **Slice 1 (this scope):** Edit-in-View for NPC entries on the Minor and
   Major sub-tabs — edit mode UI, keywords field, checked save with freshness
   guard, failure reconciliation, stale-proposal check at accept, relationship
   block handling, Restore previous version, advisory lint, status/error
   surfacing, tests.
2. **Natural follow-ups (not committed here):**
   - State Tracker sub-tab entries (the read path `kt-state-view` and the
     write seam `writeStateTracker` both exist, but that seam has no label
     check and uses the unchecked default save, so it needs the §5 treatment
     first).
   - NPC Profiles entries (`writeProfileToLorebook` exists, but it records no
     history and also uses the unchecked default save).
   - Card-level Edit shortcut opening the modal in edit mode.
   - A per-entry history browser (independent of this feature; would also
     serve condensation recovery).

Not included: creating new entries from the editor, deleting lorebook
entries (Remove remains registry-only, as today), editing arbitrary
non-MWT lorebooks from inside MWT, structured per-field form editing, bulk
edit or batch operations, diff/merge tooling for stale saves, rebasing
hand-edited proposals, editing the managed relationship block, keeping a draft
across a chat change, and any change to promote/demote, dossier enrichment, or
growth ownership rules.

## 10. Decisions

1. **Affordance:** Edit-in-View modal only. A card shortcut stays a follow-up
   (§9).
2. **Keywords:** included in v1 (§8).
3. **Lint:** empty or whitespace-only content is the single blocking case;
   everything else is advisory (§7).
4. **Unsaved-changes guard:** native confirm, consistent with Remove's confirm,
   after the scope check in §6.4.
5. **History attribution:** not in v1. `validateHistoryRecords` keeps only `ts`,
   `content`, and `msgIdx`, so an actor field needs a schema change, and nothing
   displays history beyond §5.5 yet.
6. **Follow-up ordering:** confirmed as in §9. State Tracker editing may trail
   rather than ship together.

## 11. Acceptance criteria and validation

- Editing and saving an entry from either sub-tab persists to the correct
  scope-resolved book; the modal, the NPC card list, and a re-opened View
  all reflect the saved content.
- With ST's World Info editor open on that book, an MWT save causes the ST
  editor to show the new content, and a subsequent ST-side save does not
  revert the MWT edit.
- Every save pushes the prior content to that entry's history record. A Save
  with no changes writes nothing and pushes nothing, including on an entry with
  CRLF line endings. A restored draft counts as a change (§4 dirty rule).
- If the entry body changes between Edit and save (background update,
  second tab, ST editor), the save is refused with an explanation, and the
  user's draft text is preserved verbatim.
- A background relationship sync during an edit does not refuse the save, and
  the saved entry holds exactly one relationship block, the newest.
- With a proposal pending for an NPC, a hand edit followed by Accept or Accept
  All writes nothing on the first pass, and each §6.2 response applies. A
  keywords-only edit survives the proposal's accept.
- A non-2xx save response surfaces as a failure, ST's cache and View still hold
  the previous content, and a retry succeeds once the server recovers.
- A save whose response is lost after the write landed is reported as saved,
  including when the draft ends in whitespace. A keyword-only save that never
  landed is not reported as saved.
- Cancel, Revert, Escape, and close-with-unsaved-changes never write.
- A chat change with an unsaved draft closes the modal without a prompt, writes
  nothing, and leaves no live handlers.
- Close is blocked while a save is pending, except on a scope change.
- Empty or whitespace-only content cannot be saved.
- An emptied keywords field saves `[name]`.
- Restore previous version opens the newest history record whose body differs
  from the live entry as an unsaved draft with its timestamp, skipping records
  that differ only in the relationship block, and is hidden when none exists.
- If the entry cannot be loaded when Edit is pressed, the modal stays read-only
  and explains.
- Orphaned records (uid null) offer no edit path, matching View/Update today.
- The State Tracker View path shows no Edit control.
- `world-info.js` unavailable or a failed save surfaces an honest error and
  loses no draft text.
- Keyboard-accessible edit mode; busy states on Save; single modal instance
  (no stacked dialogs); screen-reader labels per the accessibility plan.
- Unit tests: staleness comparison (block stripped, whitespace trimmed), lint
  checks, keyword parsing/fallback/registry sync, and §6.2 response selection.
  Integration tests: guarded write success and each refusal branch (stale
  content, stale uid, store-entry collision, cache conflict, scope change), a
  non-2xx save, each §6.3 reconciliation outcome, and stale accept for every
  §6.2 row, including Accept All's counts.
- Manual verification in the host: edit on desktop and mobile layouts, with
  dossier mode on and off.

## 12. Implementation orientation (not a finalized design)

Paths relative to the repository root:

- `knowledge/render.js` — `openNpcViewModal` / `createKnowledgeViewModal`
  (~line 1841): the modal gains edit mode, opt-in for the NPC path only, and
  View's own load stays unchanged; follow the existing singleton
  (`#kt-view-modal`), `decorateModalShell` (with the §6.4 `onClose`), and
  `setControlBusy` busy-pair conventions. `handleAccept`
  (~line 90) and Accept All (~line 492): the §6.2 check, with `handleAccept`
  returning an outcome. Card list re-render after save.
- `knowledge/lorebook.js` — `writeToLorebook` (~line 186): add the keywords
  option (§5.1). `loadEntryContent` (~line 398): reuse for label-verified reads.
  Add a thin load-for-edit/save-manual-edit pair owning the baseline snapshot,
  the §5.2 guard, and §6.3 reconciliation so the policy lives in one place.
  `isHeaderLine` and `isDossierEntry` support the lint. `enrichStagingItem`,
  `buildPromotedContent`, and `buildDemotedContent` serve §6.2.
- `knowledge/relationships.js` — reuse `stripRelationshipBlock`,
  `injectRelationshipBlock`, and `formatRelationshipBlock`.
- `knowledge/cleanup_persistence.js` — neutral `hostCacheConflict` text;
  `loadCleanupBook` and `saveCleanupBook` are reused.
- `knowledge/registry.js` — `registerEntry` (~line 40): keyword sync after
  a keywords edit (pattern exists in `knowledge/staging.js` apply path).
- `knowledge/store.js` — no changes expected; `applyStoreToWorldInfo`,
  `markStoreClean`, and `refreshWorldInfoEditor` already serve the checked
  branch.
- `knowledge/style.css` — textarea and lint styling consistent with
  existing modal styles.
- `test/` — new unit and integration suites per §11; no changes to prompt
  or model-call tests (none are involved). `test/busy_state_handlers.test.js`
  pins the source shape of `openNpcViewModal` with a regex; View's load stays
  unchanged, so that test should keep passing.

## 13. Implementation phases

**Planning record:** 2026-11-01. All phases below are **not started**. This
breakdown sequences Slice 1 (§9); it does not claim implementation approval or
expand the scope. Sections 1–12 remain the behavior contract. Each phase should
land with its own tests, review, and a short completion record here.

### Phase overview

| Phase | Deliverable | Depends on |
| --- | --- | --- |
| 1 | Checked manual-edit load/save service and keyword support | None |
| 2 | Stale-proposal protection and honest Accept All outcomes | None; integrate with 1 |
| 3 | NPC-only Edit-in-View workflow | 1 and 2 |
| 4 | Restore previous version and advisory lint | 3; pure lint work can start any time |
| 5 | Cross-path regression coverage and host release verification | 1–4 |

Phases are implementation checkpoints, not independently releasable feature
slices. Do not expose manual editing to users before stale-proposal protection
is integrated, and do not release Slice 1 without restore, lint, and host QA.
There is no new user setting, feature configuration, or model call.

Phase 2 is the one exception to "not independently releasable". Its accept check
changes every NPC proposal as soon as it lands, before any Edit UI exists, so it
gets its own changelog line and its own check against real proposals at that
point, not at Phase 5.


### Phase 1 — implement the guarded manual-edit service

**Goal:** establish a tested persistence boundary independent of modal events.

- Extend `writeToLorebook` with the `writeKeywords` option (§5.1); make
  `hostCacheConflict` wording neutral. Keep cleanup's defaults intact.
- Add the thin load-for-edit/save-manual-edit pair described in §12. Capture
  entry keys and identity together with the scope/book baseline; verify scope
  after asynchronous loading before handing the session to a caller.
- Save only through the checked `beforeWrite` branch. Enforce every §5.2 guard
  before mutation or history: hydration, scope/book, target existence,
  bookkeeping exclusion, alias-aware identity, and body freshness. A refusal
  must never fall through to adoption, creation, or a different uid.
- Strip the managed relationship block for editing/comparison and rebuild it
  from the graph on save. Preserve all non-owned entry metadata.
- Parse comma-separated keywords, applying `[name]` when empty. After confirmed
  success and a scope re-check, synchronize registry keywords and every pending
  proposal for that uid. Never update the new chat's registry after a switch.
- Implement §6.3 disk reconciliation, comparing `key` as well as the body.
  Restore host cache/editor coherence only when the observed disk result proves
  success; retain the draft for unchanged or uncertain results. Leave the store
  dirty when a lost response is reconciled as success.
- Return persisted results for the View UI, not an unverified draft echo.
  Empty-body rejection and the §4 dirty rule must be testable outside the DOM.

**Tests / exit gate:** guarded success, every refusal, alias acceptance, uid `0`,
no-op including CRLF entries, blank-body rejection, keyword-only
save/fallback/synchronization, relationship-only background changes,
history-before-overwrite, checked HTTP failure, and every reconciliation
outcome, including a keyword-only save that never landed and a draft with
trailing whitespace. Simulate scope changes during load, save, and
reconciliation. Refusals produce no target mutation or history push;
save failures may leave the redundant history snapshot described in §5.3.
Existing cleanup commit/recovery tests still pass. No Edit control is exposed.

### Phase 2 — protect proposal acceptance from stale content

**Goal:** prevent a subsequent Accept from silently undoing a manual edit.

- Add the §6.2 NPC freshness check when `existingContent` is non-null. Strip
  managed blocks and trim both sides; refuse unverifiable or failed reads.
  Preserve the existing State Tracker path and genuine new-entry behavior.
- On mismatch, write nothing and implement every response row: re-enrich
  ordinary Scan/Update, restoring the old baseline if the re-merge cannot load
  the entry; rebuild Promote/Demote with their dedicated builders; preserve
  Enrich/Fields and hand-edited text while updating the comparison baseline and
  warning the reviewer.
- Refresh the displayed diff. A later Accept is a separate, informed action,
  and must re-check freshness rather than bypassing the check once warned.
- Return explicit outcomes from `handleAccept`, including failure branches.
  Update Accept All to retain stale items and report accepted, stale/pending,
  failed, and existing skipped outcomes honestly. Preserve selection and
  notification bookkeeping for items that remain pending.
- Integrate Phase 1's pending-keyword synchronization and verify the later
  acceptance uses the saved keywords, not the originally staged array.

**Tests / exit gate:** table-driven coverage for all §6.2 rows, matching content,
null baselines/unenriched items, relationship-only differences, failed reads,
failed re-merges, second Accept, a second intervening edit, and mixed Accept All
outcomes. Include hand-edited proposals, Promote/Demote, and keyword-only saves. Stale
items remain reviewable and cause no write on the first stale Accept.

### Phase 3 — wire the NPC-only Edit-in-View workflow

**Goal:** connect the safe services to the existing singleton modal.

- Make editing opt-in at `createKnowledgeViewModal`'s NPC caller. State Tracker
  remains read-only; orphaned NPC records retain no View/Edit path.
- Keep View read-only by default and leave its load unchanged. Add explicit Edit,
  which starts the session through Phase 1's load, a labeled monospace body
  textarea, keywords input, and a read-only managed relationship section with
  guidance toward Relationships. Escape all displayed stored text.
- Add Save, Revert, and Cancel using the §4 dirty rule. Preserve
  the draft on refusal, failure, and uncertainty; offer explicit reload after a
  stale refusal without silently replacing the draft.
- Route saves only through Phase 1. On success show persisted content, return
  to View, update status, and re-render cards. A no-op performs no write and
  adds no history.
- Preserve the shared in-flight/singleton guard and busy-pair conventions.
  Prevent duplicate Save and close during a pending save, except on scope
  change. Check scope before native unsaved-changes confirmation; chat change
  must close without a prompt and clean up handlers. Late results must not
  reopen the old modal or update the new chat's UI.
- Add styles, keyboard focus transitions, accessible labels/status feedback,
  and mobile layout support.

**Tests / exit gate:** jsdom workflow tests for View → Edit → Save/View,
keyword-only and no-op saves, Revert/Cancel/Escape/backdrop/close confirmation,
stale reload, a failed load at Edit, double clicks, errors retaining drafts,
missing host support, scope changes during loading/saving, handler cleanup, and
the shared modal's State Tracker exclusion. Phases 1 and 2 pass together before exposing Edit.

### Phase 4 — complete recovery and non-blocking guidance

**Goal:** finish the remaining mandatory Slice 1 affordances, not a follow-up
history browser or structured editor.

- In View, show Restore previous version only when a history record's stripped
  body differs from the current body. Load the newest such record as a
  timestamp-labeled, unsaved body draft. Keep the current live entry as the
  freshness baseline, so the §4 dirty rule counts the draft as a change.
  History stores content, not keyword versions: do not invent historical keys.
- Save a restored draft through the same Phase 1 service. Never write merely
  by opening Restore. Verify repeated restores toggle versions through the
  existing history mechanism without changing retention or schema.
- Add every advisory check in §7: malformed header, empty/unparseable ledger,
  ledger interruption, dossier fields missing, missing/misplaced dossier
  marker, and a paste roughly 50k characters larger than the baseline.
- Display warnings near Save without blocking nonempty drafts. Empty or
  whitespace-only content remains the sole content-validation blocker;
  concurrency and identity refusals still apply independently.

**Tests / exit gate:** history absent/present, newest differing record (skipping
block-only and redundant records), a restored draft saving as a real change,
restore without write, guarded restore after an intervening edit, two-save
toggle, current keywords preserved, all lint cases, and valid large pre-existing
ledgers without an absolute-size warning. Nonempty malformed drafts remain saveable.

### Phase 5 — verify the complete feature and record release readiness

**Goal:** prove the combined workflow, especially failures between subsystems.

- Map every §11 acceptance criterion to an automated test or explicit host QA
  record. Add end-to-end integration cases for edit → stale proposal → review
  → later Accept, keyword-only edit → Accept, and restore → guarded save.
- Run focused manual-edit, staging, busy-handler, cleanup, identity, and store
  suites, then `npm test`, `npm run lint`, and `git diff --check`. Record actual
  commands and outcomes, not inherited test counts from another roadmap.
- In SillyTavern, test both NPC sub-tabs, dossier on/off, desktop/mobile,
  keyboard-only operation, correct scope-resolved books, and World Info editor
  coexistence. Verify an ST-side save after MWT's save does not revert it.
- Exercise HTTP failure/retry, a response lost after a landed write, stale
  content/cache, scope switching with a dirty draft and during Save, and a
  relationship sync during editing. Verify uncertain outcomes remain honest
  and drafts remain copyable while the original scope is active.
- Record any host-only checks not yet run as pending. Update the documentation
  map, user-facing guidance, and changelog only with verified behavior; do not
  mark the feature released solely because automated tests pass.

**Exit gate:** all §11 criteria pass, automated regressions are clean, and both
authors sign off on host results or explicitly keep the feature unreleased.
State Tracker/Profile editing and all other §9 exclusions remain deferred.