# TODO — Known Issues

Remaining findings from the 2026-06-09 code review, ordered by priority.
Line numbers are approximate (search for the quoted code/function names).

## Fixed already (for reference)

- ✅ Chronicle/Knowledge tabs broke on second modal open (stale cached content element + one-time init) — wire-events now resets the cache and re-renders.
- ✅ Chronicle was missing imports for `buildInlineDiff`, `createModal`, `showModal`, `hideModal`, `setStatus` (Regenerate diff + Preview crashed with ReferenceError).
- ✅ World State injection moved from position 0 (IN_PROMPT) to 1 (IN_CHAT) so the Depth/Role settings actually apply.
- ✅ Unsaved-changes confirm on modal close was dead code (duplicate unconditional close handler); `onClose` can now cancel the close by returning `false`. Float buttons no longer rebuild the modal body while it's open (was silently wiping unsaved edits).
- ✅ Knowledge staging IDs are now unique across scans (were colliding: wrong detail shown, dismiss removed two items, notifications overwrote each other).
- ✅ `uid 0` (first entry in a fresh lorebook) no longer treated as "no uid" in enrich/promote/demote; `handleAccept` refuses to write placeholder text like `(Fetch to see changes)` over a real entry.

## Medium

- [ ] **Consolidate/bulk-delete click opens the editor instead of toggling selection**
  `chronicle/index.js` → `bindMainEvents()`, the `.sc-entry` click handler sets `selectedSnapshotId = id` unconditionally; `renderContent()` then shows the entry editor before the checkbox toggle is ever visible.
  Fix: only set `selectedSnapshotId` in the `else` (non-selection-mode) branch.

- [ ] **Main-generation busy check reads properties that don't exist**
  `chronicle/index.js` → `generateSnapshot()`: `ctx?.processingRequest || ctx?.inApiCall` — neither exists on SillyTavern's context, so the check always concludes the flag is stale and proceeds.
  Fix: use `ctx.streamingProcessor` (exists on context, e.g. `ctx.streamingProcessor && !ctx.streamingProcessor.isFinished`) or drop the double-check and trust the GENERATION_STARTED/ENDED events.

- [ ] **Knowledge scan status is wiped immediately after being set**
  `knowledge/index.js` → scan click handler in `renderNpcsSubTab()`: success/error `ktSetStatus(...)` is followed by `finally { renderNpcsSubTab(); }`, which rebuilds `#kt-status` empty. Only the toastr survives.
  Fix: set the status *after* the final re-render, or persist the last status message and re-apply it on render (like chronicle's `_lastStatusMsg`).

- [ ] **Player persona is never excluded from NPC scans**
  `knowledge/index.js` → `getPlayerNames()`: reads `ctx.character` and `ctx.user`, which don't exist on ST's context (it exposes `name1`/`name2`/`characters`). Only `chat[0]?.name` (usually the AI character's greeting) works, so your persona can be proposed as an NPC.
  Fix: add `ctx.name1`; consider group member names too. Also: `core/context.js` has an unused `getPlayerNames()` whose JSDoc claims "a Set ... lower-cased" but returns a plain array — fix or delete it.

- [ ] **"Knowledge Tracker" / "State Tracker" lorebooks must already exist**
  `knowledge/index.js` → `writeToLorebook()` throws `Lorebook "Knowledge Tracker" not found` and nothing ever creates it.
  Fix: auto-create via `createNewWorldInfo(LOREBOOK_NAME)` (exported from `world-info.js`) on first write, or document the manual setup step in the README.

- [ ] **`hasValidSettings()` requires an API key**
  `core/settings.js`: blocks keyless local backends (Ollama, LM Studio, llama.cpp) that the README advertises support for.
  Fix: require only `apiUrl` + `modelName`.

## Minor / polish

- [ ] **`setStatus` auto-clear timers race** — `core/modal.js`: each call with `clearAfterMs` sets a new timeout without cancelling the previous one, so an old timer can fade out a newer message. Store and clear the timeout handle.

- [ ] **Character extraction off-by-one** — `chronicle/index.js` → `generateSnapshot()`: `getCharactersInRange(actualFrom, toIndex)` — `slice` end is exclusive while `toIndex` is inclusive, so the last message's speaker is dropped. Use `toIndex + 1`.

- [ ] **Auto-refresh counter never survives reload/switch** — `world_state/index.js`: the counter is persisted to chat metadata, but `onChatChanged()` always calls `resetAutoRefreshCounter()` (CHAT_CHANGED also fires on initial chat load), clobbering the saved value. Restore from the incoming chat's metadata instead of zeroing.

- [ ] **Escape closes stacked modals at once** — every `createModal` adds its own document-level keydown; pressing Esc with a sub-modal open (revert diff, history, preview) also closes the parent. Only close the topmost visible modal.

- [ ] **`buildInlineDiff` has no size guard** — `core/diff.js`: word-level LCS is O(n²); a max-size (~2000-word) chronicle entry means a ~16M-cell DP table and can freeze the tab during Regenerate preview. Add a word-count cap with a plain side-by-side fallback (mirror `computeLcsDiff`'s `maxLines`).

- [ ] **Keywords input not HTML-escaped** — `knowledge/index.js` → `renderDetailForItem()`: `value="${(item.keywords || [item.name]).join(', ')}"` — a keyword containing `"` breaks the attribute. Wrap in `escapeHtml(...)`.

- [ ] **HTML error pages skip the 5xx retry** — `core/api.js` → `fetchFromApi()`: the HTML-detection throw happens before the 5xx/429 retry branch, so a proxy returning a 502 HTML page fails immediately instead of retrying.

- [ ] **`restoreDeletedEntry` doesn't recompute `lastAnchor`** — `chronicle/index.js`: `deleteEntry`/`bulkDeleteEntries` recompute `lastAnchor` from the remaining snapshots, but restoring from trash doesn't — restoring the newest entry leaves the anchor stale, so the next snapshot re-covers the same messages.

- [ ] **API keys mirrored to localStorage in plaintext** — `core/settings.js` → `saveSettings()` always writes a localStorage copy even when `extension_settings` succeeded; that copy outlives an uninstall. Consider skipping the mirror when `extRef` is available.
