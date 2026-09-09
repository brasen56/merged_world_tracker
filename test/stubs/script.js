/**
 * test/stubs/script.js — Minimal stand-in for SillyTavern's
 * public/scripts/script.js.
 *
 * WHY THIS EXISTS
 * ---------------
 * `interiority/data.js` does a lazy `await import('../../../../../script.js')`
 * inside a try/catch to pick up the FORK's `isChatFullyHydrated()`; on upstream
 * SillyTavern that export doesn't exist and the module falls back to "always
 * hydrated". The path climbs five directories to the SillyTavern host, which
 * exists at runtime inside SillyTavern but NOT when Vitest runs.
 *
 * In the default Node environment the unresolvable specifier is harmless (the
 * import only runs lazily), but Vitest's jsdom environment resolves literal
 * dynamic specifiers at TRANSFORM time — a missing host file fails the whole
 * module graph (first hit by test/tab_navigation.test.js, whose import of the
 * Diagnostics panel reaches interiority via health.js). Same reason
 * `'../../../../world-info.js'` is aliased: `vitest.config.js` maps
 * `'../../../../../script.js'` to THIS file so the import resolves cleanly.
 *
 * It deliberately exports NO `isChatFullyHydrated`, reproducing the documented
 * upstream-ST behavior; tests that exercise the fork's hydration gating inject
 * their own checker rather than relying on this stub.
 */

export default {};
