/**
 * core/revision.js — Document revision guards for same-chat async safety.
 *
 * Tier 0.3 shared primitive. Scope identity alone (core/scope.js) does NOT
 * stop a slow LLM response from clobbering an edit the user made in the *same*
 * chat while the request was in flight. This module provides a generic guard
 * with two supported strategies:
 *
 * 1. `captureRevision()` / `sameRevision()` — for immutable snapshots or
 *    serialized metadata. Capture with the operation input; on commit, abort
 *    or rebase on mismatch.
 *
 * 2. `createRevisionClock()` — for stores whose canonical mutators can
 *    reliably advance a counter. `bump()` on every mutation; the captured
 *    revision is compared at commit time.
 *
 * A counter alone is insufficient if a write path bypasses it; a digest alone
 * does not identify which fields may safely be merged. The module adapter
 * must choose the strategy and define its merge policy. When rebasing,
 * preserve user-controlled fields and deletion tombstones. History snapshots
 * must record the *pre-operation* revision, not whatever is current when the
 * API returns.
 */

// ─── Strategy 1: Immutable snapshot / digest ─────────────────────────────────

/**
 * A normalizer function that transforms a value into a stable, comparable
 * representation before hashing. The default serializes to JSON with sorted
 * keys so that objects with the same keys in different insertion order
 * produce the same digest.
 *
 * @template T
 * @param {T} value
 * @returns {string}
 */
export function defaultNormalize(value) {
    if (value === null || value === undefined) return 'null';

    // Stable stringify: sort object keys recursively so {a:1,b:2} and
    // {b:2,a:1} produce the same digest.
    return JSON.stringify(value, (_key, val) => {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            return Object.keys(val).sort().reduce((sorted, k) => {
                sorted[k] = val[k];
                return sorted;
            }, {});
        }
        return val;
    });
}

/**
 * A lightweight FNV-1a hash that produces a short, deterministic string.
 * Not cryptographic — it just needs to detect changes reliably.
 *
 * @param {string} str
 * @returns {string}
 */
function fnv1a(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    // Force unsigned and convert to base-36 for compact representation.
    return (hash >>> 0).toString(36);
}

/**
 * @typedef {Object} RevisionToken
 * @property {string} digest     — hash of the normalized value at capture time
 * @property {number} capturedAt — Date.now() for diagnostics
 */

/**
 * Capture a revision snapshot of an immutable value (object, string, etc.).
 *
 * The value is normalized (default: stable JSON stringify) and hashed into a
 * compact digest. Compare later with `sameRevision(token, currentValue)`.
 *
 * @param {*} value — the value to snapshot
 * @param {function(*): string} [normalize] — custom normalizer
 * @returns {RevisionToken}
 */
export function captureRevision(value, normalize = defaultNormalize) {
    const normalized = normalize(value);
    return {
        digest: fnv1a(normalized),
        capturedAt: Date.now(),
    };
}

/**
 * Check whether the current value matches the captured revision.
 *
 * @param {RevisionToken} token — from `captureRevision()`
 * @param {*} currentValue — the current value to compare against
 * @param {function(*): string} [normalize] — must match the normalizer used in captureRevision
 * @returns {boolean} true if the value is unchanged since capture
 */
export function sameRevision(token, currentValue, normalize = defaultNormalize) {
    if (!token) return false;
    return token.digest === fnv1a(normalize(currentValue));
}

// ─── Strategy 2: Revision clock (monotonic counter) ──────────────────────────

/**
 * Create a revision clock — a mutable counter that increments on every
 * mutation via `bump()`.
 *
 * Suitable for stores whose canonical mutators can reliably advance a counter.
 * If ANY write path bypasses `bump()`, the clock is compromised and the
 * snapshot strategy should be used instead.
 *
 * @param {number} [initial=0]
 * @returns {{ get: function(): number, bump: function(): number, capture: function(): RevisionToken, sameAs: function(RevisionToken): boolean }}
 */
export function createRevisionClock(initial = 0) {
    let counter = initial;

    return {
        /** Current revision number. */
        get() { return counter; },

        /** Advance the clock. Call from every canonical mutator. */
        bump() { return ++counter; },

        /**
         * Capture the current revision as a token.
         * @returns {RevisionToken}
         */
        capture() {
            return {
                digest: `rev:${counter}`,
                capturedAt: Date.now(),
            };
        },

        /**
         * Check whether the current revision matches the captured token.
         * @param {RevisionToken} token
         * @returns {boolean}
         */
        sameAt(token) {
            return !!token && token.digest === `rev:${counter}`;
        },
    };
}

// ─── Commit policy helper ────────────────────────────────────────────────────

/**
 * Evaluate a commit decision given a revision check result.
 *
 * This centralizes the three valid commit policies so module adapters don't
 * each reinvent the same branching:
 *
 * - `'commit'` — revision matches; safe to write.
 * - `'discard'` — revision changed; silently discard the stale result.
 * - `'rebase'` — revision changed; attempt a merge (adapter-defined).
 *
 * @param {boolean} unchanged — result of `sameRevision()` or `.sameAt()`
 * @param {boolean} [canRebase=false] — whether the adapter supports rebasing
 * @returns {{ action: 'commit'|'discard'|'rebase' }}
 */
export function decideCommit(unchanged, canRebase = false) {
    if (unchanged) return { action: 'commit' };
    return { action: canRebase ? 'rebase' : 'discard' };
}