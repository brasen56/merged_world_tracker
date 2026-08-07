/**
 * test/stubs/world-info.js — Minimal stand-in for SillyTavern's world-info.js.
 *
 * WHY THIS EXISTS
 * ---------------
 * `knowledge/lorebook.js` does a top-level `await import('../../../../world-info.js')`
 * to grab SillyTavern's world-info API, and `knowledge/store.js` imports the same
 * module lazily. That path climbs four directories up to the SillyTavern host,
 * which exists at runtime inside SillyTavern but NOT when Vitest runs in Node.
 * Without this stub, every worker that transitively loads lorebook.js logs a
 * scary `console.warn('Could not import world-info.js')` on startup.
 *
 * `vitest.config.js` aliases `'../../../../world-info.js'` to THIS file, so the
 * side-effect import resolves cleanly instead of throwing.
 *
 * The methods here are deliberately benign no-ops: tests that actually exercise
 * lorebook/store behavior inject their OWN `state.wiScript` (see
 * `makeFakeWorldInfo` in test/store.test.js), so this stub only needs to exist
 * so the module loads. `loadWorldInfo` returns `null` (i.e. "no book found"),
 * which makes the read functions in lorebook.js return their empty defaults —
 * exactly as they do in production when no book has been created yet.
 */

export async function loadWorldInfo() { return null; }
export async function saveWorldInfo() { /* no-op: no disk under Vitest */ }
export async function createNewWorldInfo() { return true; }
