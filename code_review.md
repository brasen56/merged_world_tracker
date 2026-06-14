# 🔍 Merged World Tracker — Code Review

A comprehensive review of the extension for bugs, issues, and potential feature improvements.

---

## 🐛 Critical Bugs (Broken Functionality)

### 1. Knowledge Module: Missing Toolbar — Scan / Import / Export Unreachable (Done)
**Files:** `knowledge/render.js`
**Severity:** 🔴 Critical

The `renderNpcsSubTab()` function wires event listeners for `#kt-scan-btn`, but **the button is never rendered in the HTML**. The same applies to the NPC import/export/import-from-lorebooks functionality — the functions `exportNpcs()`, `importNpcs()`, and `importFromLorebooks()` are imported and re-exported but never wired to any UI element.

**Impact:** Users cannot trigger an NPC scan, import/export NPC data, or import from existing lorebooks via the UI. The only way to scan is via the `/wt-scan` slash command.

**Location:**
```js
// render.js line ~146 — wires a button that doesn't exist:
el.querySelector('#kt-scan-btn')?.addEventListener('click', ...)
```

**Fix:** Add a toolbar to `renderNpcsSubTab()` containing the scan button and import/export buttons:
```js
el.innerHTML = `
    <div class="kt-toolbar mwt-flex mwt-gap-4" style="flex-wrap:wrap;margin-bottom:8px">
        <button id="kt-scan-btn" class="mwt-btn mwt-btn-primary">🔍 Scan</button>
        <button id="kt-export-btn" class="mwt-btn">📥 Export</button>
        <button id="kt-import-btn" class="mwt-btn">📤 Import</button>
        <button id="kt-import-lb-btn" class="mwt-btn">📚 Import from Lorebooks</button>
    </div>
    ...sub-tabs...
`;
```
Then wire `#kt-export-btn`, `#kt-import-btn`, `#kt-import-lb-btn` to `exportNpcs`, `importNpcs`, `importFromLorebooks`.

---

### 2. World State: `fallbackDepth` Parameter is Dead Code (Done)
**Files:** `world_state/injection.js`, `core/injection.js`
**Severity:** 🟡 Moderate

In `applyWorldStateInjection()`, the `fallbackDepth` parameter is redundant because `globalDepth` is already computed with its own fallback:

```js
// injection.js
const rawDepth = Number.isFinite(Number(s.injectionDepth))
    ? Number(s.injectionDepth)
    : Number(s.worldStateDepth);
const depth = Number.isFinite(rawDepth) ? rawDepth : 1;
// ...
applyExtensionPromptInjection({
    globalDepth: depth,
    fallbackDepth: s.injectionDepth ?? 1,  // ← never used; globalDepth always wins
});
```

In `core/injection.js`, `fallbackDepth` is only used if `globalDepth` is not finite — but the caller already guarantees it's finite. Not a runtime bug, but misleading dead code.

---

### 3. World State Injection Depth: Per-Module vs Global Disconnect (Done)
**Files:** `world_state/injection.js`, `index.js`
**Severity:** 🟡 Moderate

The World State module has its own `injectionDepth` setting (default: `1`) in `world_state/settings.js`. However, the global Settings tab in `index.js` has a separate `worldStateDepth` setting (default: `4`) that is written to the global `merged_world_tracker` settings key.

In `applyWorldStateInjection()`, the module reads its own `s.injectionDepth` first and only falls back to `s.worldStateDepth` — but the module settings object never receives `worldStateDepth` from the global settings. So the global injection depth setting **has no effect** on World State unless the user leaves the module-specific `injectionDepth` unset (which defaults to `1`).

**Impact:** Users who change the depth in the global Settings tab see no change. They must use the module-specific setting.

**Fix:** Either (a) remove the global depth control for World State and document that it's module-specific, or (b) have `applyWorldStateInjection()` prefer the global setting via `getGlobalSettings().worldStateDepth` when the module-specific depth isn't explicitly set.

---

### 4. Chronicle: `onMessageReceived` Auto-Snapshot Runs Without UI
**Files:** `chronicle/index.js`, `chronicle/snapshots.js`
**Severity:** 🟡 Moderate

When auto-snapshot triggers, `generateSnapshot()` calls `_render.renderContent()` to update the UI. However, if the modal is closed or the user hasn't opened the Chronicle tab yet, `getContentEl()` returns `null` and `renderContent()` silently does nothing. The `scSetStatus()` calls also silently fail.

This is not strictly a bug (the snapshot is still saved), but the user gets no visual feedback. The `notify()` call in `onMessageReceived` partially compensates.

**Fix:** Safe to leave as-is since the toastr notification fires. But consider not calling `renderContent()` when `getContentEl()` returns null.

---

## ⚠️ Important Bugs (Incorrect Behavior)

### 5. World State Auto-Refresh: Interval Silently Clamped, But Setting Not Updated (Done)
**Files:** `world_state/render.js` (line ~524)
**Severity:** 🟠 Important

When enabling auto-refresh, if the user enters an interval greater than `maxScanMessages`, the interval is clamped:
```js
const clamped = Math.min(n, maxScan);
if (n > maxScan) {
    setStatus(state.modal, `Auto-refresh interval clamped to ${maxScan}...`, 'warning', 5000);
}
setWorldStateData({ autoRefresh: true, autoRefreshInterval: clamped });
```

The clamped value is saved, which is correct. However, this creates a confusing UX: the user is told their interval was clamped, but there's no way to increase `maxScanMessages` from this prompt — they have to find it in the collapsed settings panel. Consider adding a direct link or increasing `maxScanMessages` automatically.

---

### 6. Chronicle Consolidation: `busy-changed` Event Not Dispatched (Done)
**Files:** `chronicle/snapshots.js` (line ~288)
**Severity:** 🟠 Important

In `consolidateEntries()`, the `finally` block resets `state.isGenerating = false` but **does not dispatch** `document.dispatchEvent(new CustomEvent('mwt:busy-changed'))`. Compare with `generateSnapshot()` (line 178) and `regenerateSnapshot()` (line 225) which do dispatch it.

**Impact:** The floating button's busy state indicator may get stuck after a consolidation.

**Fix:**
```js
} finally {
    state.isGenerating = false;
    document.dispatchEvent(new CustomEvent('mwt:busy-changed'));
}
```

---

### 7. Chronicle Regeneration: `isGenerating` Flag Set Before Validation Check (Done)
**Files:** `chronicle/snapshots.js` (line ~198)
**Severity:** 🟡 Minor

In `regenerateSnapshot()`, if `buildMessageWindow` returns empty text, the function sets `state.isGenerating = false` and returns — but this path doesn't dispatch `busy-changed` either:
```js
if (!text.trim()) { scSetStatus('No messages for regeneration.', 'error'); state.isGenerating = false; return; }
```
The `busy-changed` was already dispatched when `isGenerating` was set to `true`, so the button shows as busy but never gets the "not busy" signal.

**Fix:** Add `document.dispatchEvent(new CustomEvent('mwt:busy-changed'));` before the early return, or restructure to use a `finally` block.

---

### 8. Knowledge: `getNpcContent` Missing `await` (done)
**Files:** `knowledge/index.js` (line ~206)
**Severity:** 🟡 Minor

```js
export async function getNpcContent(name) {
    const reg = getRegistry()[name];
    if (!reg || reg.uid == null) return '';
    return loadEntryContent(reg.uid) || '';  // ← loadEntryContent is async!
}
```

`loadEntryContent` returns a Promise. The `|| ''` fallback will never trigger because a Promise is truthy. The function returns `Promise<content | ''>` — the `|| ''` is dead code.

**Fix:**
```js
const content = await loadEntryContent(reg.uid);
return content || '';
```

---

### 9. Knowledge: Staging Item Detail Doesn't Handle State Items Correctly in Diff (Done)
**Files:** `knowledge/render.js` (`renderDetailForItem`)
**Severity:** 🟡 Minor

When a staging item has `type === 'state'`, the detail view still renders a diff. State tracker updates use the full entry text as both existing and proposed content, which can produce noisy diffs. This is cosmetic but may confuse users.

---

### 10. World State Editor: `isDirty` Not Reset on External Refresh (Done)
**Files:** `world_state/render.js` (line ~404)
**Severity:** 🟡 Minor

When the user types in the editor, `state.isDirty = true` is set. If an auto-refresh fires while the modal is open, the editor value is updated and `state.isDirty = false` is set (in `scheduleAutoRefresh`). But if the user has the modal closed and reopens, `isDirty` may still be true from a previous session if they typed and didn't save.

**Fix:** Reset `isDirty` in `renderModalContent()` or when loading the editor value.

---

## 🔧 Minor Issues & Edge Cases

### 11. `estimateTokens` Fallback Uses Different Ratio (Done)
**Files:** `core/context.js`
The fallback uses `Math.ceil(text.length / 4)` (~4 chars/token), but the actual ratio for English text is closer to ~4.5-5 chars/token for many tokenizers. This may overestimate tokens. Not a bug per se, but worth noting for the "token estimate" UI.

### 12. Chronicle `buildMessageWindow` MaxChars Comment vs Code (Done)
**Files:** `chronicle/data.js` (line ~239)
```js
const MAX = 100000;
```
The comment in `getRecentMessages` in `core/context.js` says `maxChars = 400000`, but Chronicle uses `100000`. These are independent functions so not a bug, but the inconsistency is notable.

### 13. Knowledge `removeAllRelationshipsFor` — Bug in `changed` Tracking (Done)
**Files:** `knowledge/relationships.js` (line ~65)
```js
if (rels[from].length !== before) changed = true;
```
This line is reached after `rels[from]` may have been deleted (if empty). Accessing `.length` on a deleted property returns `undefined`, which `!== before` (a number), so `changed` is correctly set. But this is fragile — if the array isn't deleted, the logic works; if it is deleted, it works by accident. Consider checking before deletion.

### 14. Diff Engine: `Uint16Array` Overflow on Large Inputs (Done)
**Files:** `core/diff.js` (line ~42)
```js
const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
```
`Uint16Array` max value is 65535. For LCS lengths exceeding this (very large texts), values will overflow/wrap. The `maxLines = 500` guard makes this unlikely in practice, but a theoretical concern.

### 15. Modal Escape Key: Only Closes Topmost MWT Modal (Done)
**Files:** `core/modal.js`
The escape handler correctly checks for the topmost `.mwt-modal`, but if SillyTavern's own modals are open on top, the MWT modal won't close. This is probably the desired behavior, but could surprise users.

### 16. `getChat()` Returns Array Reference, Not Copy (Done)
**Files:** `core/context.js`
```js
export function getChat() {
    return getContextSafe()?.chat || [];
}
```
This returns the actual chat array reference. Any mutation would affect SillyTavern's internal state. The code doesn't appear to mutate it, but the function name suggests it's a getter. Consider documenting this.

### 17. Knowledge: `queueTrackerWork` Return Value Misleading (Done)
**Files:** `knowledge/lorebook.js` (line ~341)
```js
export function queueTrackerWork(fn) {
    state.trackerQueue = state.trackerQueue.then(fn).catch(...);
    return state.trackerQueue;
}
```
The returned promise resolves to the result of the *entire chain*, not just `fn`. Callers that `await` this may get unexpected results if other work is queued later.

---

## 🎨 Polish & UX Improvements

### 18. World State: "Reset Prompt" Button Doesn't Save
**Files:** `world_state/render.js` (line ~539)
Clicking "Reset Prompt" only clears the textarea. The setting isn't saved until the user also clicks "Save Settings". Consider auto-saving or clarifying the label.

### 19. Chronicle: Search Doesn't Clear on Chat Change
**Files:** `chronicle/index.js` (`onChatChanged`)
`state.pendingSearch = ''` is set on chat change, but the search input's DOM value isn't cleared until the next render. Minor cosmetic issue.

### 20. Knowledge: No Empty State for State Trackers Import
The state tracker import flow has minimal error handling. If the JSON is valid but missing expected fields, it silently imports nothing.

### 21. General: No Loading Spinner for Long Operations
All long operations (scan, refresh, snapshot) use text status ("⏳ Scanning…") but no visual spinner. A CSS spinner would improve perceived performance.

---

## 🚀 Feature Suggestions (Ranked by Value)

### Tier 1 — High Impact, Low Effort

#### F1. Add the Missing Knowledge Toolbar (Fixes Bug #1) (Done)
This is both a bug fix and a feature completion. The scan, export, import, and import-from-lorebooks functions are fully implemented — they just need UI buttons.

#### F2. Swipe/Edit/Delete Awareness (Done)
**Files:** `index.js` (event hooks), `chronicle/data.js`, `chronicle/index.js`, `world_state/index.js`, `knowledge/index.js`
Listen to `MESSAGE_SWIPED`, `MESSAGE_EDITED`, `MESSAGE_DELETED` events:
- **Swipe:** Optionally re-trigger world state refresh (the described events changed)
- **Delete:** Decrement `autoRefreshCounter` and `msgSinceSnapshot` to keep them accurate
- **Edit:** Invalidate chronicle anchors that point to edited messages

This addresses a common complaint that tracking drifts after edits/deletes.

**Implementation:**
- `index.js` registers listeners for all three events (with `extractMessageIndex()`
  normalizer for cross-ST-version signature compatibility) and delegates to
  per-module `onMessageSwiped` / `onMessageEdited` / `onMessageDeleted` hooks.
- **World State:** delete decrements `autoRefreshCounter`; swipe/edit call
  `scheduleAutoRefresh()` (gated by the existing auto-refresh toggle).
- **Chronicle:** delete decrements `msgSinceSnapshot` and flags `lastAnchor`
  stale if it referenced the deleted/at-or-after index; swipe/edit use the new
  `isAnchorStale()` helper in `chronicle/data.js` to detect content-fingerprint
  mismatches and flag `anchorStale: true` in chronicle data.
- **Knowledge:** delete decrements `messageCounter` so the auto-trigger cadence
  stays aligned with the shorter chat.

#### F3. Cancellable Generations with AbortController
**Files:** `core/api.js`
Add `AbortController` support to `fetchFromApi` and `fetchViaConnectionProfile`:
```js
export async function fetchFromApi({ ..., signal }) {
    const response = await fetch(endpoint, { ..., signal });
}
```
Then add a "Cancel" button in modal status bars when `isRefreshing`/`isGenerating` is true. This is especially valuable for slow models.

#### F4. Global Defaults for Per-Chat Toggles
**Files:** `core/settings.js`, module settings
Currently `injectEnabled`, `autoRefresh`, `autoSnapshot` live in per-chat metadata, forcing users to re-enable them every new chat. Add global defaults:
```js
// In global settings defaults:
defaultInjectWorldState: false,
defaultInjectChronicle: false,
defaultAutoRefresh: false,
defaultAutoSnapshot: false,
```
On `CHAT_CHANGED`, if the chat has no prior metadata, seed it from these defaults.

#### F5. Output Language Setting
**Files:** All three `prompts.js` files
Add a global `outputLanguage` setting. Append to each system prompt:
```
Write all output in {language}.
```
This is a 5-line change per module and addresses a common request from non-English users.

---

### Tier 2 — Medium Impact, Medium Effort

#### F6. Token Budget Caps & Auto-Consolidation
**Files:** `chronicle/injection.js`, new scheduling logic
- Add a `maxInjectTokens` setting per module (e.g., 2000)
- When the injection exceeds the budget, automatically trim oldest entries (for Chronicle) or warn (for World State)
- Optionally auto-consolidate chronicle entries older than N into era summaries

#### F7. Customizable Prompt Templates for All Modules
**Files:** Module settings panels
World State already has a custom prompt override. Extend this to Chronicle and Knowledge:
- Chronicle: custom summary/consolidation prompt
- Knowledge: custom scan/state-update prompt
Store in settings, with "Reset to Default" buttons.

#### F8. WI-Scan Option for Injected Prompts
**Files:** `core/injection.js`
Add a `scan` option to `setExtensionPrompt`:
```js
setEP(key, `${header}\n\n${body}`, 1, depth, scan ? true : undefined, role);
```
This lets world state/chronicle content trigger lorebook keywords — a one-line feature that power users frequently request.

#### F9. Configurable Lorebook Names
**Files:** `knowledge/state.js`
Make `LOREBOOK_NAME` and `STATE_LOREBOOK_NAME` configurable via settings instead of hardcoded. This allows:
- Per-character lorebooks
- Using existing lorebooks instead of creating new ones
- Avoiding conflicts with other extensions

#### F10. Connection Profile Auto-Detection
**Files:** `index.js`
If no custom API is configured and no profile is selected, automatically use the currently-active Connection Manager profile instead of throwing "settings incomplete". Add a setting: "Auto-use active ST connection (no configuration needed)".

---

### Tier 3 — Differentiators

#### F11. Relationship Graph Visualization
Add an SVG/Canvas node-edge graph in the Relationships sub-tab. Click a node to open the NPC. This is a popular feature in similar extensions.

#### F12. Vector/RAG Chronicle Injection
Instead of injecting the last N chronicle entries, use ST's Vector Storage to inject entries semantically relevant to the current scene. This dramatically improves long-term continuity.

#### F13. Usage & Cost Statistics
Token usage is already logged to `console.log`. Surface cumulative per-module token counts in the Stats panel, with an optional cost estimate based on model pricing.

#### F14. First-Run Onboarding
On first load with no settings configured:
1. Auto-detect if ST has a connection profile configured
2. Offer to use it
3. Auto-create the Knowledge Tracker and State Tracker lorebooks
4. Show a 3-step pointer tour of the main features

#### F15. Chronological Timeline View for Chronicle
A visual timeline showing chronicle entries along a time axis, with the ability to jump to entries, filter by character, and see relationship changes over time.

---

## 📊 Summary

| Category | Count |
|---|---|
| 🔴 Critical Bugs | 1 |
| 🟠 Important Bugs | 3 |
| 🟡 Moderate Issues | 6 |
| 🔧 Minor/Edge Cases | 7 |
| 🎨 UX Polish | 4 |
| 🚀 Feature Suggestions | 15 |

### Top 5 Recommended Actions (Priority Order)

1. **Fix the Knowledge toolbar** (Bug #1) — scan/import/export are completely unreachable
2. **Fix `busy-changed` dispatch in consolidation** (Bug #6) — floating button gets stuck
3. **Add the missing `await` in `getNpcContent`** (Bug #8) — silent data issue
4. **Reconcile World State injection depth settings** (Bug #3) — global setting is ignored
5. **Implement output language setting** (Feature F5) — high-value, low-effort