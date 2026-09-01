/**
 * core/version.js — The extension's own version string.
 *
 * KEEP IN SYNC with `manifest.json` and `package.json` when bumping a release.
 * A constant (rather than a runtime manifest fetch) keeps pure/test callers
 * synchronous and dependency-free; the release checklist owns the sync.
 */

export const MWT_VERSION = '2.0.0';