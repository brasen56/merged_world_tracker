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

- [x] **Consolidate/bulk-delete click opens the editor instead of toggling selection**
  `chronicle/index.js` → `bindMainEvents()`: `selectedSnapshotId` now only set in the `else` (non-selection-mode) branch.

- [x] **Main-generation busy check reads properties that don't exist**
  `chronicle/index.js` → `generateSnapshot()`: now uses `ctx?.streamingProcessor && !ctx.streamingProcessor.isFinished` instead of non-existent `processingRequest`/`inApiCall`.

- [x] **Knowledge scan status is wiped immediately after being set**
  `knowledge/index.js`: status message persisted in `_lastKtStatusMsg`/`_lastKtStatusLevel` and re-applied after `renderNpcsSubTab()` rebuilds the DOM.

- [x] **Player persona is never excluded from NPC scans**
  `knowledge/index.js` → `getPlayerNames()`: now reads `ctx.name1`, `ctx.name2`, and group member names from `ctx.characters`. `core/context.js` `getPlayerNames()` now returns a lower-cased `Set` as its JSDoc always claimed.

- [x] **"Knowledge Tracker" / "State Tracker" lorebooks must already exist**
  `knowledge/index.js` → `writeToLorebook()`: auto-creates the lorebook via `createNewWorldInfo()` (or fallback) on first write if it doesn't exist.

- [x] **`hasValidSettings()` requires an API key**
  `core/settings.js`: now requires only `apiUrl` + `modelName`, allowing keyless local backends (Ollama, LM Studio, llama.cpp).

## Minor / polish

- [x] **`setStatus` auto-clear timers race** — `core/modal.js`: each call with `clearAfterMs` now stores and clears the previous timeout handle on the status element (`_clearTimer`), so an old timer can't fade out a newer message.

- [x] **Character extraction off-by-one** — `chronicle/index.js` → `getCharactersInRange()`: `slice` end is now `toIndex + 1` since `slice` end is exclusive but `toIndex` is inclusive.

- [x] **Auto-refresh counter never survives reload/switch** — `world_state/index.js`: `onChatChanged()` now restores the counter from the incoming chat's metadata (`autoRefreshCounter`) instead of calling `resetAutoRefreshCounter()`.

- [x] **Escape closes stacked modals at once** — `core/modal.js` → escape handler now queries all visible `.mwt-modal` elements and only closes the topmost (last in DOM order) one.

- [x] **`buildInlineDiff` has no size guard** — `core/diff.js`: added `maxWords` parameter (default 2000); falls back to plain escaped `<pre>` side-by-side when word count exceeds the cap.

- [x] **Keywords input not HTML-escaped** — `knowledge/index.js` → `renderDetailForItem()`: keyword values now wrapped in `escapeHtml(...)` before being inserted into the `value="..."` attribute.

- [x] **HTML error pages skip the 5xx retry** — `core/api.js` → `fetchFromApi()`: moved HTML detection to after the 5xx/429 retry branch so a proxy returning 502 HTML retries before failing.

- [x] **`restoreDeletedEntry` doesn't recompute `lastAnchor`** — `chronicle/index.js`: `restoreDeletedEntry` now recomputes `lastAnchor` from the full snapshot list (including the restored entry).

- [x] **API keys mirrored to localStorage in plaintext** — `core/settings.js` → `saveSettings()`: localStorage write is now inside the `else` branch (fallback only), so API keys aren't mirrored when `extension_settings` is available.
