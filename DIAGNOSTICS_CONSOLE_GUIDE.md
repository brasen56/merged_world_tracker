# MWT.diagnostics — Console Tester Guide (Phases 0–1)

> **Status:** live now. This is the console-only bridge until the diagnostics
> panel UI ships (Phase 5+).

## What this is

`MWT.diagnostics` is a read-only window into the in-memory capture that
Phase 0 (event ring + last-run map) and Phase 1 (API call telemetry) added. It
exists so testers can use the data **now**, before the panel tab exists.

- **In-memory only.** Everything clears on page reload. Nothing is written to
  chat metadata, `localStorage`, or settings.
- **Telemetry only.** It records *about* a call — model/profile id, duration,
  retry count, HTTP status, finish reason, token usage, error class — **never**
  the prompt, API key, custom headers, or response body. Safe to paste into a
  bug report.

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

MWT.diagnostics.clear()                   // wipe the buffer to start a clean test
```

Each method prints a `console.table(...)` **and returns the full data**, so you
can copy the return value for the complete JSON (the table hides nested fields
like `usage` / `detail`).

## Reading the output

### `events()`

One row per recorded event, newest first. Columns: `time`, `level`
(`debug|info|warn|error`), `module`, `event`. The `api_call` events are the
per-call echoes of `apiCalls()`; everything else is a `record()` fired by a
future phase (e.g. the silent-recovery counters from Phase 3).

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

## How to capture a report

1. Reproduce the problem.
2. In the console, run `MWT.diagnostics.apiCalls()` (or `lastApiCall(...)`).
3. Copy the **returned object**: right-click → *Copy object*, or run
   `copy(MWT.diagnostics.apiCalls())` in Chrome/Edge.
4. Paste into the bug report. Add `MWT.diagnostics.lastRuns()` and, for
   scoping/identity issues, `MWT.scope.diagnose()`.

## Limitations (until the panel ships)

- No redaction toggle is needed because prompts/content are never captured.
- No repair actions — read-only except `clear()`, which only empties the
  in-memory buffer.
- The buffer is per-session; a reload clears it. Reproduce, then capture before
  reloading.
