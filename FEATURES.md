# Feature Roadmap — Planning Notes

Likely user requests, ranked by how often SillyTavern users ask for these in
comparable extensions (Summarize, qvink Memory, Timelines, Objective, Tracker).
API pointers verified against this ST install.

## Tier 1 — near-certain requests

- [x] **Use ST's connection / Connection Profiles instead of separate API config**
  The #1 request for any extension that makes its own LLM calls. Users don't want
  to paste an API key twice, and it instantly supports every backend ST supports
  (Claude, Gemini, NovelAI, KoboldCPP, …) instead of only OpenAI-compatible ones.
  Also moots the "keyless local backend" issue.
  *How:* `ConnectionManagerRequestService` (`scripts/extensions/shared.js:388`) for
  profile-pinned calls, or `getContext().generateQuietPrompt` to ride the current
  connection. Keep the existing custom config as an "Advanced override" per module.
  *Implemented:* `core/api.js` now supports `useSTConnection` flag via `generateQuietPrompt`.
  `core/settings.js` exposes a per-module toggle. `index.js` syncs ST connection on load.

- [x] **Slash commands / STscript integration**
  Power users automate everything and wire buttons via Quick Replies.
  Suggested: `/wt-refresh`, `/wt-snapshot`, `/wt-scan`, `/wt-inject on|off`,
  `/wt-state` (returns the world state text into the pipe so scripts can use it).
  *How:* `getContext().registerSlashCommand` or `SlashCommandParser.addCommandObject`.
  *Implemented:* All commands registered in `index.js` via `registerSlashCommand`.
  Modules export `triggerRefresh`/`triggerSnapshot`/`triggerScan` for delegation.

- [x] **Macros for placement control**
  `{{worldstate}}`, `{{chronicle}}`, `{{lastchronicle}}` — lets users put the
  content wherever they want (Author's Note, prompt manager block, char card,
  custom-depth WI entry) instead of the fixed injection. Pair with an
  "injection off / macro-only" mode per module.
  *How:* `getContext().registerMacro` (st-context.js).
  *Implemented:* All macros registered in `index.js` via `substituteParams` +
  `registerMacro`. Modules export getter functions for content.

- [x] **Mobile / touch support**
  A large share of ST users are on phones/tablets; the floating-button drag is
  mouse-only and the modal isn't responsive. Convert drag to Pointer Events
  (covers mouse + touch), make the modal full-screen under ~700px, and add an
  option to collapse the four floating buttons into one.
  *Implemented:* Floating button drag converted to Pointer Events in `index.js`.
  Responsive CSS breakpoints (768px, 480px) in `style.css`.

- [x] **Hide/relocate the floating buttons + standard settings drawer**
  Guaranteed request: "can I hide the buttons?" Convention is a drawer in the
  Extensions panel (append settings HTML to `#extensions_settings`) and an entry
  in the wand (extensions) menu to open the modal. Per-button visibility toggle.
  *Implemented:* Settings drawer appended to `#extensions_settings` in `index.js`.
  Wand menu entry added via `addWandMenuItem`. Per-button visibility toggles in
  drawer. CSS for drawer + wand button in `style.css`.

## Tier 2 — very likely

- [x] **Swipe / edit / delete awareness**
  Users will notice the world state describing a swiped-away response or counters
  drifting after deletes. Listen to `MESSAGE_SWIPED`, `MESSAGE_EDITED`,
  `MESSAGE_DELETED` (all in `scripts/events.js`): optionally re-refresh on swipe,
  adjust auto counters, and invalidate stale chronicle anchors.
  *Implemented:* `index.js` registers listeners for all three events and
  delegates to per-module `onMessageSwiped` / `onMessageEdited` /
  `onMessageDeleted` hooks.
  - **World State:** `MESSAGE_DELETED` decrements `autoRefreshCounter`;
    `MESSAGE_SWIPED` / `MESSAGE_EDITED` schedule an auto-refresh (gated by the
    existing auto-refresh toggle) since the described events changed.
  - **Chronicle:** `MESSAGE_DELETED` decrements `msgSinceSnapshot` and flags
    `lastAnchor` stale if it referenced the deleted/at-or-after index;
    `MESSAGE_SWIPED` / `MESSAGE_EDITED` use the new `isAnchorStale()` helper
    (in `chronicle/data.js`) to flag the anchor when its content fingerprint no
    longer matches the live chat message.
  - **Knowledge:** `MESSAGE_DELETED` decrements `messageCounter` so the
    "every N messages" cadence stays aligned with the shorter chat.

- [x] **NPC auto-scan toggle (Knowledge)**
  Mirror of the existing state-tracker auto-trigger: every N user messages,
  automatically run the NPC scan and stage any new/updated minor/major NPC
  proposals for review (no auto-accept). Shares the same `queueTrackerWork`
  chain and `isRunning` guard so it never collides with manual scans or state
  updates. Independent counter (`npcMessageCounter`) and cadence setting
  (`npcAutoScanEveryN`) so it can run on a different schedule than state
  trackers; `MESSAGE_DELETED` keeps both counters aligned.
  *Implemented:* Settings UI + defaults in `knowledge/settings.js`
  (`npcAutoScanEnabled`, `npcAutoScanEveryN`); counter + hook logic in
  `knowledge/state.js` / `knowledge/index.js` (`onMessageReceived`,
  `onChatChanged`, `onMessageDeleted`).

- [x] **Notification bell count fix (Knowledge)**
  The bell badge could show a stale count after proposals were accepted or
  dismissed because `notificationEntries` was only partially cleaned up.
  *Implemented:* A `reconcileNotifications()` pass runs on every render to
  prune entries whose staging item no longer exists; dismiss/batch-dismiss
  now remove the matching notification; clicking the bell navigates to the
  Staging tab and marks entries read so the badge clears.

- [ ] **Prompt/template customization for Chronicle & Knowledge + output language**
  World State already has a custom prompt; Chronicle's sections and the scan
  prompt are hardcoded. Non-English RPers will ask "can it write entries in my
  language?" — an output-language setting appended to all three system prompts is
  cheap and high-value; editable templates are the fuller version.

- [ ] **Token budgets & automatic consolidation**
  A hard cap on injected tokens per module, and auto-consolidation of chronicle
  entries older than N into era summaries (recent = detailed, old = condensed).
  The manual consolidation flow already exists — this automates it on a schedule.

- [ ] **Cancellable generations + clean queueing**
  Long LLM calls currently can't be aborted. Wire `AbortController` through
  `fetchFromApi`, add a Cancel button in the status bar, and defer module
  generations while the main chat is generating (guard exists; make it reliable
  via `ctx.streamingProcessor` and surface a "queued…" indicator).

- [ ] **Global defaults for per-chat toggles**
  Injection enabled, auto-refresh, auto-snapshot all live in chat metadata, so
  users must re-enable them every new chat. Add global default settings that new
  chats inherit (per-chat values still override).

## Tier 3 — differentiators / nice-to-have

- [x] **Relationship graph view** — visual node/edge graph for the relationships
  sub-tab (Timelines-style views are popular). SVG or canvas; clicking a node
  opens the NPC.
  *Implemented:* Force-directed SVG graph in `knowledge/render.js`
  (`computeGraphLayout`, `renderRelationshipGraph`, `wireRelationshipGraphInteractions`).
  Nodes are draggable with live edge updates; click (without drag) opens the
  NPC lorebook entry in the existing view modal. Edges are color-coded by
  relationship type with arrowheads, and bidirectional edges render as paired
  curves so both directions are visible. Includes pan/zoom (scroll wheel,
  background drag) and a color legend. A Graph/List toggle in the toolbar
  preserves the original list view. State in `knowledge/state.js`
  (`relViewMode`, `_graphData`); styles in `style.css` under
  "Relationship graph view".
- [ ] **Vector/RAG chronicle injection** — inject entries semantically relevant to
  the current scene instead of recent-N, via ST's built-in Vector Storage.
- [ ] **Configurable lorebook targets** — the "Knowledge Tracker"/"State Tracker"
  names are hardcoded; offer per-chat or character-bound lorebooks and defaults
  for entry position/depth/probability.
- [ ] **WI-scan option for injected text** — pass `scan = true` in
  `setExtensionPrompt` so world state/chronicle content can trigger lorebook
  keywords. One-line feature; power users ask for it.
- [ ] **First-run onboarding** — auto-create the lorebooks, run a connection test,
  and a three-step pointer tour. Cuts down "it doesn't do anything" reports.
- [ ] **Usage/cost statistics** — token usage is already logged to console;
  surface cumulative per-module token counts (and optional $ estimate) in Stats.
- [ ] **UI localization** — ST ships an i18n system; lowest priority until the
  user base grows.
