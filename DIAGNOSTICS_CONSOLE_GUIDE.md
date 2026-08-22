# MWT.diagnostics — Console Tester Guide (Phases 0–13)

> **New to this?** Start with [`DIAGNOSTICS_GUIDE.md`](DIAGNOSTICS_GUIDE.md)
> — the beginner-friendly walkthrough (panel first, symptom table, console
> primer). This file is the deep per-command reference.

> **Status:** live now, and v1 is COMPLETE (Phase 13 shipped). The console
> bridge remains the deepest view; the **🩺 Diagnostics tab** (Phase 5) in the
> MWT modal offers a redacted **📋 Copy Report** without devtools, and its live
> sub-tabs — **❤️ Health** (Phase 6), **🌐 Environment** (Phase 7), **🗂️ Scope &
> storage** (Phase 8), **💉 Injection** (Phase 9), **📡 Last request**
> (Phase 10), **📋 Log** (Phase 11), and **🛡️ Integrity** (Phase 12) — render
> the one-table answers to "is anything broken right now?", "which
> SillyTavern am I on, and what does it expose?", "which lorebooks is this
> chat using, and why?", "what is MWT putting in the narrator's prompt,
> where, and why?", "what did the last API call look like?", "what has MWT
> been doing this session?", and "do my stores reference things that
> exist?". Phase 13 finalized the copy report (it now serializes the tab
> accessors too) and added the `MWT.diagnostics.report()` console counterpart.

## What this is

`MWT.diagnostics` is a read-only window into the in-memory capture that
Phase 0 (event ring + last-run map), Phase 1 (API call telemetry), Phase 2
(injected-payload snapshots), Phase 3 (silent-recovery counters), and
Phase 4 (settings provenance) added. It exists so testers can use the data
**now**, before the panel tab exists.

- **In-memory only.** Everything clears on page reload. Nothing is written to
  chat metadata, `localStorage`, or settings.
- **API telemetry only — for API calls.** They record *about* a call —
  model/profile id, duration, retry count, HTTP status, finish reason, token
  usage, error class — **never** the prompt, API key, custom headers, or
  response body. Safe to paste into a bug report.
- **Injection snapshots DO contain payload text.** `injections()` /
  `injection(key)` return the exact string last registered with SillyTavern
  via `setExtensionPrompt` — that is their purpose. Skim the payload before
  pasting a snapshot into a public bug report.

## Quick start

Open the browser devtools console (F12 → Console) and run:

```js
MWT.diagnostics
```

to inspect the available methods. Then:

```js
MWT.diagnostics.events()                  // event ring, newest first
MWT.diagnostics.events({ level: 'error' })   // only errors
MWT.diagnostics.events({ level: ['warn', 'error'] })
MWT.diagnostics.events({ module: 'api' })    // only one module
MWT.diagnostics.events({ since: Date.now() - 60000 })  // last 60s

MWT.diagnostics.apiCalls()                // last ~20 API calls, newest first
MWT.diagnostics.lastApiCall('world_state')   // most recent call for one module
MWT.diagnostics.lastApiCalls()            // last call per module (pointer view)
MWT.diagnostics.lastRuns()                // per-module last-run stamps
MWT.diagnostics.injections()              // last snapshot per injection key (payloads!)
MWT.diagnostics.injection('mwt_world_state_injection')  // one key's recorded payload
MWT.diagnostics.settingsProvenance()      // where each WS/SP setting resolves from
MWT.diagnostics.health()                  // the ❤️ Health tab snapshot, one row per module
MWT.diagnostics.environment()             // the 🌐 Environment tab snapshot (fork-compat probe; async)
MWT.diagnostics.scope()                   // the 🗂️ Scope & storage tab snapshot (which books + why)
MWT.diagnostics.injectionStatus()         // the 💉 Injection tab snapshot (placements + registrations + warnings)
                                          //   — redacted by default; { includeContent: true } for scrubbed payloads
MWT.diagnostics.lastRequest()             // the 📡 Last request tab snapshot (last call + short history + stats)
                                          //   — redacted by default; raw telemetry-only copies: apiCalls()
MWT.diagnostics.log()                     // the 📋 Log tab snapshot (the event ring + counts, newest first)
MWT.diagnostics.log({ level: 'warn' })    //   …data-side filtered, like events(); redacted by default
MWT.diagnostics.integrity()               // the 🛡️ Integrity tab snapshot (on-demand store checks; async)
                                          //   — read-only; repairs stay on MWT.profiles / MWT.evidence / MWT.interiority
await MWT.diagnostics.report()            // the FULL D1 Markdown report the 📋 Copy Report button copies (async)
                                          //   — content EXCLUDED by default; { includeContent: true } to include it

MWT.diagnostics.clear()                   // wipe the buffer to start a clean test
```

Each method prints a `console.table(...)` **and returns the full data**, so you
can copy the return value for the complete JSON (the table hides nested fields
like `usage` / `detail`).

## Reading the output

### `events()`

One row per recorded event, newest first. Columns: `time`, `level`
(`debug|info|warn|error`), `module`, `event`. The `api_call` events are the
per-call echoes of `apiCalls()`; Phase 3 added the **silent-recovery
counters** — `warn` events that fire whenever MWT quietly recovered via a
fallback the caller never sees:

| Event | Module | Meaning |
|---|---|---|
| `json_repaired` | `api` | Strict `JSON.parse` failed; the lenient repair pipeline recovered an object anyway. Repaired parses correlate with "weird" data (dropped or half-written fields). Recorded only on success — a repair that fails throws loudly. |
| `reasoning_content_fallback` | the calling module | `content` came back empty, so the text was taken from `reasoning_content`. The call "succeeded", but reasoning-channel output is often structured differently. |
| `output_stripped` | `api` | `normaliseOutput` removed markdown fences and/or a "Here is…" preamble before the text reached the parser. `detail.fenced` / `detail.preamble` say which. |
| `scope_fallback_global` | `knowledge` | Knowledge scope is `character`/`chat` but the identity did not resolve — data is going to the SHARED global lorebooks (`detail.scope` says which scope failed). |
| `wi_script_unavailable` | `knowledge` | SillyTavern's world-info module is unavailable — Knowledge reads come back empty and writes are blocked (`detail.stage` says whether a previous or fresh import failed). |

A quiet session is the goal: if none of these fire, no silent recovery
happened. They record sizes and flags only — never prompt or output content.

Everything else in the ring is a `record()` fired by a future phase.

### `apiCalls()`

One row per completed API request, newest first. The columns to watch when a
call "just didn't work":

| Field | Meaning |
|---|---|
| `status` | Final HTTP status (`null` on the Connection-Manager path) |
| `ok` | `true`/`false` — did it resolve without error |
| `errorClass` | Failure classifier (`HTML-response`, `no-content`, `_isLengthError`, `_noRetry`, …) — empty when `ok` |
| `retries` | How many retries happened (0 = first try succeeded) |
| `durationMs` | Wall-clock time for the whole call |
| `mode` / `model` | `custom` + model name, or `cm` + connection-profile id |
| `finish_reason` | `stop`, `length`, … from the API |

### `lastApiCalls()` / `lastRuns()`

`lastApiCalls()` is the "one row per module" pointer the Health tab will later
show. `lastRuns()` shows the last module run (start/finish, ok/error, token
counts) per module — currently empty until later phases call `setRunStart` /
`setRunResult`.

### `injections()` / `injection(key)`

One row per injection key (World State, Chronicle, Interiority, Story
Planner). The snapshot is the **frozen string MWT last registered with
SillyTavern** via `setExtensionPrompt` — overwritten only when something
re-applies it — so what you see here is that registration, not a fresh rebuild.

> **What this does and does not prove.** Calling `setExtensionPrompt` proves
> what MWT *registered* with SillyTavern — not that a generation ran
> afterwards, and not that SillyTavern placed the payload in the final prompt.
> The panel design marks placement `Unverified` for exactly this reason. Treat
> the snapshot as "registered, placement not confirmed."

| Field | Meaning |
|---|---|
| `enabled` | `false` means the last apply **cleared** the slot (empty payload) — i.e. MWT registered nothing |
| `role` | Numeric role sent: `0` system · `1` user · `2` assistant |
| `depth` | Resolved injection depth actually sent |
| `chars` | Payload length in characters |
| `appliedAt` / `ageSec` | When it was last applied, and how stale it is |

Use `injection(key)` for the full payload text of one key. The event ring also
gets a payload-free `injection_applied` echo per apply (module `injection`).

### `settingsProvenance()` (Phase 4)

One row per World State / Story Planner **behavior** setting, showing the
resolved value and the **source** it came from. Behavior keys only — inject /
auto toggles, intervals, modes — never `apiKey`, `customHeaders`, or `apiUrl`.

| Source | Meaning |
|---|---|
| `per-chat-override` | This chat's own value (module's "Use global defaults" unchecked) |
| `per-chat-legacy` | A pre-scope-feature per-chat field on the chat record |
| `builtin-default` | Local mode, key missing — the historical per-chat default |
| `global` | The shared module settings (module's settings tab) |
| `fallback` | Key unknown — the caller's fallback |

The bottom three rows (Chronicle, Knowledge, Interiority) are the asymmetry
itself: those modules have **no** per-chat/global split — their behavior
settings live only in their module tabs. Which API-config level a module's
calls use (`module-profile → module-custom → global-profile → global-custom`)
is reported by `resolveApiCall()` as a `source` field and will surface in the
panel.

Reach for this when "the setting is right but behaves wrong": the value
usually resolves from a different level than the one the user believes they
edited.

### `health()` (Phase 6)

The same snapshot the ❤️ Health tab renders — one row per module:

| Column | Meaning |
|---|---|
| `on` | The per-tracker enable flag (`enable<ModuleKey>`) — right-click a module's floating button to flip it |
| `gate` | `injectionAllowed()`: may this module inject/scan right now? Collapses the panic switch and the per-module disable into one boolean |
| `busy` | A generation/refresh/scan is in flight right now |
| `tokens` | That module's estimated injected token load (same number as its floating-button badge) |
| `auto` | Countdown to the next auto-run in messages; `every turn` for Interiority (its dormant-poll state rides along); `off` when auto-run is disabled |
| `lastRun` | The module's most recent API call: time · ok/FAILED · duration. `never` is normal right after a reload — the capture is in-memory only |

The return value adds the header (`mwtVersion`, `totalTokens`,
`injectionMasterOff`) and per-row detail (auto schedule, last-run source /
model / HTTP status / retries, and `errors` where an accessor failed). If the
panic switch is on, the call also prints a loud `console.warn` — that state
explains most "nothing is injecting" reports on its own.

Since Phase 6, API telemetry is stamped with the calling module's key
(`world_state`, `chronicle`, `knowledge`, `story_planner`, `interiority`), so
`lastApiCall('<module>')` finally keys per-module.

### `environment()` (Phase 7) — the fork-compat probe

The same snapshot the 🌐 Environment tab renders. **Async** — it awaits the
`shared.js` import behind connection-profile calls before answering. It
prints three tables (features, versions/context, raw context fields) and
returns the whole snapshot. The headline is the **chat-ID premise** verdict on
the `getCurrentChatId()` assumption behind `core/scope.js`:

| Level | Meaning |
|---|---|
| `ok` | `getCurrentChatId()` is exposed and answering — the premise holds |
| `fallback` | No usable `getCurrentChatId()`; scope is running on its `ctx.chatId` fallback. Include this row when reporting from this build |
| `fail-closed` | No usable chat id at all — identity compares fail closed and chat-switch detection leans on the epoch counter alone. Expected nowhere; report it |
| `unknown` | No SillyTavern context object was resolvable at all |

The feature table covers `getCurrentChatId`, `ctx.chatId`, the tokenizer
(which of `estimateTokens()`'s three sources answered, verified with a live
call), `ConnectionManagerRequestService` on the context object, and the
world-info module behind Knowledge's lorebook reads/writes (the same
tri-state the `wi_script_unavailable` warns watch). A separate row reports
the `shared.js` `ConnectionManagerRequestService` — the exact import
`core/api.js` uses — with `constructPrompt` as its own line item (the member
some forks remove; MWT feature-detects around it, so "missing" is a state to
note, not a failure). The raw context-field table is the same eleven rows
`MWT.scope.diagnose()` prints, with the same `(absent)` sentinels.

**When to capture it:** any report from a non-reference SillyTavern build or
fork, any "tokens look wrong" report (it shows whether a real tokenizer
answered), any Knowledge write failure, and any scoping/identity issue.
Context field values can contain your character's name and avatar filename —
skim before pasting publicly.

### `scope()` (Phase 8) — which lorebooks, and why

The same snapshot the 🗂️ Scope & storage tab renders, **synchronous** and
**read-only** (it re-derives the resolution without saving anything — no
binding is persisted by looking). It prints a resolution table (scope setting,
character/chat identity, the identity the scope keys on, the three book
names), a books table (hydration · dirty · store version), and the bindings
table (the same rows `MWT.scope.bindings()` prints, with `current: true` on
the one this chat resolves to), then warns on every finding. The headline is
the **resolution mode**:

| Mode | Meaning |
|---|---|
| `global` | Scope is `global` (or an invalid value, normalized) — one shared set of books, the default |
| `saved-binding` | This identity has a saved binding — books survive a card rename |
| `newly-derived` | No binding yet; these are the names the next resolve will derive **and save** |
| `collision-disambiguated` | Two cards share a display name — a stable discriminator from the identity key is appended |
| `sanitize-fallback-global` | The card/chat name cannot become a filename — GLOBAL books in use, deliberately unbound |
| `fallback-global` | Scope is `character`/`chat` but the identity could not be resolved — **silently using the GLOBAL books** (the amber banner; the classic "why is my data weird across chats" cause) |

The one **red** finding is an un-hydrated Knowledge store (`loaded: NOT
LOADED`): creating entries is blocked in that state — the deliberate
duplicate-entry guard. The footer also counts every `scope_fallback_global`
warn recorded this session, including fallbacks on chats you have since
switched away from.

**When to capture it:** any "my data is weird across chats/characters"
report, any scoping or binding question, and any Knowledge write failure.
Pair it with `MWT.scope.diagnose()` for the raw context fields. Identity
values contain your card/chat names — skim before pasting publicly.

### `injectionStatus()` (Phase 9) — what is actually registered

The same snapshot the 💉 Injection tab renders, **synchronous** and
**read-only**. One row per module: `on` (the module's own flag; Knowledge is
`n/a` — its gates govern scanning), `gate`, `depth`/`role` **with
provenance** — `global` (the Settings-tab override won), `module` (the
module's own setting; for Chronicle that is *this chat's* `injectDepth`), or
`builtin` (the hardcoded default) — `tokens` with its kind (`est.` while
nothing is registered this session, `stored` for Knowledge's lorebook
corpus), and `registered` (time · age · chars of the exact `setExtensionPrompt`
registration, or `cleared …`). A second table prints the registered
depth/role per live key. It then warns on every finding:

| Warning | Meaning |
|---|---|
| `knowledge-lorebook-caveat` | Always present, amber: Knowledge injects through lorebook entries (World Info keyword activation), which no MWT switch controls. Red + "NOT stopped by the panic switch" wording when the panic switch is on. |
| `panic-master-off` | The panic switch is on — nothing new can register, and SillyTavern keeps whatever was registered before the flip. |
| `flag-on-registered-empty` | Flag on + gate open, but the last registration was a CLEAR — usually "nothing to inject yet"; if data exists, a toggle/re-apply was missed. |
| `flag-off-registered-live` | Module off or gated, but a live payload is STILL registered — the narrator keeps seeing it until the next apply or reload. |
| `placement-drift` | The settings now resolve to a different depth/role than the live registration — re-apply to move it. |

**When to capture it:** every "the model ignored my world state / chronicle /
plan" report, every depth/role question ("why is it injecting at 4?"), and
anything involving the panic switch.

**Safe by default (the redaction contract):** what `injectionStatus()`
RETURNS is already redacted — payload text gated to `[content excluded — N
chars]` size markers, and every string secret-scrubbed (embedded URLs cut to
scheme+host, key/bearer shapes, this install's live key values) — so the
return value can be pasted without auditing it. Two deliberate escapes:

- `MWT.diagnostics.injectionStatus({ includeContent: true })` — includes the
  payload text, **still secret-scrubbed** (opting into content never opts
  into secrets).
- `MWT.diagnostics.injection(key)` — one key's EXACT recorded text, raw.
  This is the deliberate path for when you truly need the byte-exact string
  (e.g. reproducing a prompt with the same model); it is NOT redacted, so
  skim before pasting publicly. `injections()` lists all keys' raw snapshots
  the same way.

### `lastRequest()` (Phase 10) — what the last call looked like

The same snapshot the 📡 Last request tab renders, **synchronous** and safe
to paste: `lastRequest()` returns a redacted snapshot with the most recent
captured call (`last` — module · mode · model/profile · HTTP status ·
duration · retries · `finish_reason` · token usage · error class), the short
history (`history`, newest first, every retained call — the store keeps 20),
and window stats (`stats` — ok/failed, retries, token totals, avg/max
duration). It warns on the one finding the tab also banners: the most recent
call FAILED.

**Telemetry by construction** — the Phase 1 capture records *about* a call
and NEVER the prompt, API key, custom headers, or response body, so there is
no content to gate here (the panel's content checkbox changes nothing on
this tab). What redaction still does: every string in the RETURN VALUE
(model/profile ids, finish reasons, error classes) is secret-scrubbed —
embedded URLs cut to scheme+host, key/bearer shapes, and this install's live
key values — so it pastes without auditing. Want the raw telemetry-only
copies anyway? Those never carried content either:
`MWT.diagnostics.apiCalls()` / `lastApiCall(module)`.

**When to capture it:** every "the model isn't responding / is responding
weird" report, every timeout, retry, or token-accounting question, and as
the companion to `MWT.diagnostics.health()`'s last-run column — that shows
WHEN each module last ran; this shows WHAT that call actually did.

### `log()` (Phase 11) — what MWT has been doing this session

The same snapshot the 📋 Log tab renders, **synchronous** and safe to paste:
`log()` returns a redacted view of the Phase 0 event ring — every captured
toast, API-call echo, and silent-recovery warn, newest first — with
per-level and per-module counts, each event stamped with its age and the
operation epoch (`chat` column; the raw return value also carries the
resolved chat identity per event). It warns on the one finding the tab also
banners: error-level events are in the ring.

Unlike the tab's level/module chips (view toggles over rendered rows),
`log()`'s `{ level, module }` arguments are **data-side filters** taking the
same shapes `events()` accepts — `log({ level: ['warn', 'error'] })`,
`log({ module: 'api' })` — and the counts still describe the whole ring.

**Not telemetry by construction** — unlike `apiCalls()`, the ring carries
chat content: every toast is recorded with its message body, and error
details can quote upstream bodies. So the RETURN VALUE is redacted by
default: message bodies collapse to `[content excluded — N chars]` markers,
raw error text to `[error excluded — N chars]`, and every string is
secret-scrubbed. `log({ includeContent: true })` includes the (still
scrubbed) full details — opting into content never opts into secrets. The
RAW ring (unredacted, includes everything) stays on `MWT.diagnostics.events()`
— skim before pasting that one.

**When to capture it:** "my data is weird" reports (pair with
`events({ level: 'warn' })` for the raw silent-recovery list), "a toast
flashed and disappeared", and any report where the sequence of what MWT did
matters — the epoch stamps make cross-chat-switch corruptions visible as a
row-by-row timeline.

### `integrity()` (Phase 12) — do my stores reference things that exist?

The same snapshot the 🛡️ Integrity tab renders when its **▶ Run** button is
pressed — **async** (it reads the NPC Profiles lorebook) and, like the tab,
meant for on-demand use. Read-only checks with counts + top-5 samples per
check: duplicate profile entries, dangling `profileUid` pointers,
evidence↔profile orphans in both directions, `validateSection()` per store
(the same records a backup import would refuse), and Interiority ledger
reference integrity (duplicate ledger ids, deleted intentions that came
back, duplicate tombstone ids). It warns on every finding and tables both
the per-check counts and the per-store validation rows.

**Safe to paste as-is** — safer than any other method here, in fact: the
snapshot carries no chat prose by construction (names, uids, counts, and
the validators' own reason strings — never previews, quotes, or quarantined
records), and every string is still secret-scrubbed. No repair is offered
on purpose: cleanup stays on `MWT.profiles.{duplicates,pruneDuplicates,relink}`
/ `MWT.evidence.clear*` / `MWT.interiority.clearDeletions`, which all have
dry-run guards.

Two readings that are NOT faults: "evidence with no profile" (capture ran,
the profile has not been generated yet — ordinary mid-pipeline) and absent
store sections (a store that has never written this chat). And one flag to
know: if the profile-book read comes back empty while registry pointers are
set, the affected checks report `unreliable` instead of flooding false
findings — check `MWT.scope.diagnose()` for which book this chat resolves
to.

**When to capture it:** any "my data is weird" report — duplicate NPC
profiles, profiles that regenerate oddly ("never generated" despite an
entry existing), backup imports that refuse records, or intentions that
reappear after you deleted them. Pair with `MWT.scope.diagnose()` when the
unreliable flag shows.

## How to capture a report

1. **The easy way (no devtools):** open the MWT modal → 🩺 Diagnostics tab →
   **📋 Copy Report**. The report lands on your clipboard as Markdown —
   secrets redacted, content (prompt bodies / payload text / full error
   bodies) EXCLUDED unless you tick the opt-in checkbox above the button
   (its state is never persisted; every session starts excluded). It now
   includes everything: global settings + provenance, last runs, API calls,
   the event ring, injected payloads (content-gated), and the Health /
   Environment / Scope / Injection / Integrity tab snapshots. The console
   counterpart is `await MWT.diagnostics.report()` (same sections, same
   redaction — the return value is the Markdown string; `copy(await
   MWT.diagnostics.report())` puts it on the clipboard).
2. Reproduce the problem first, then capture — the buffer is in-memory only
   and clears on reload.
3. For a deeper drill-down, add the individual accessors: `MWT.diagnostics.lastRequest()`
   (the tab-shaped view with window stats; redacted by default),
   `MWT.diagnostics.injectionStatus()` (placements + registrations; payloads
   content-gated), `MWT.diagnostics.injection(key)` for one key's byte-exact
   recorded string (RAW — skim before pasting), `MWT.diagnostics.log({ level: 'warn' })`
   for the silent-recovery ring with counts (redacted), or
   `MWT.diagnostics.settingsProvenance()` for "the setting is right but
   behaves wrong". For anything on a non-reference build/fork, the report's
   Environment section (or `MWT.diagnostics.environment()`) states the
   fork-compat verdict.
4. Paste into the bug report. Identity strings (character / chat names in
   scope keys) can still appear even with content excluded — skim the report
   before pasting it somewhere public.

## Limitations

- Content opt-in: the panel's checkbox (and `report({ includeContent: true })`)
  is the ONLY way payload / prompt / captured-toast / error-body text enters
  a report, and it is never persisted — every session starts with content
  excluded. Secrets are redacted in BOTH modes.
- No repair actions — read-only except `clear()`, which only empties the
  in-memory buffer.
- The buffer is per-session; a reload clears it. Reproduce, then capture before
  reloading.
