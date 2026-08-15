# MWT.diagnostics — Console Tester Guide (Phases 0–3)

> **Status:** live now. This is the console-only bridge until the diagnostics
> panel UI ships (Phase 5+).

## What this is

`MWT.diagnostics` is a read-only window into the in-memory capture that
Phase 0 (event ring + last-run map), Phase 1 (API call telemetry), Phase 2
(injected-payload snapshots), and Phase 3 (silent-recovery counters) added. It
exists so testers can use the data **now**, before the panel tab exists.

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

## How to capture a report

1. Reproduce the problem.
2. In the console, run `MWT.diagnostics.apiCalls()` (or `lastApiCall(...)`).
   For injection bugs ("the model ignored my world state"), add
   `MWT.diagnostics.injections()`. For "my data is weird" reports, add
   `MWT.diagnostics.events({ level: 'warn' })` — it shows every silent
   recovery (repaired JSON, reasoning fallback, stripped fences, scope
   fallback, missing world-info) from the session.
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
