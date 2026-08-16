# MWT.diagnostics — Console Tester Guide (Phases 0–4 + Health)

> **Status:** live now. The console bridge remains the deepest view; the
> **🩺 Diagnostics tab** (Phase 5) in the MWT modal now also offers a
> redacted **📋 Copy Report** without devtools, and its first live sub-tab —
> **❤️ Health** (Phase 6) — renders the one-table answer to "is anything
> broken right now?". Tabs 2–7 (Phases 7–12) are still being built.

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

## How to capture a report

1. Reproduce the problem.
2. In the console, run `MWT.diagnostics.apiCalls()` (or `lastApiCall(...)`).
   For injection bugs ("the model ignored my world state"), add
   `MWT.diagnostics.injections()`. For "my data is weird" reports, add
   `MWT.diagnostics.events({ level: 'warn' })` — it shows every silent
   recovery (repaired JSON, reasoning fallback, stripped fences, scope
   fallback, missing world-info) from the session. For "the setting is right
   but behaves wrong", add `MWT.diagnostics.settingsProvenance()`. For "is
   anything even running", start with `MWT.diagnostics.health()`.
3. Copy the **returned object**: right-click → *Copy object*, or run
   `copy(MWT.diagnostics.apiCalls())` in Chrome/Edge.
4. Paste into the bug report. Add `MWT.diagnostics.lastRuns()` and, for
   scoping/identity issues, `MWT.scope.diagnose()`.

## Limitations (until the panel ships)

- No redaction toggle exists yet: API telemetry never captures content, but
  injection snapshots DO include payload text (by design). The Phase 5 panel
  adds the opt-in redaction layer for those.
- No repair actions — read-only except `clear()`, which only empties the
  in-memory buffer.
- The buffer is per-session; a reload clears it. Reproduce, then capture before
  reloading.
