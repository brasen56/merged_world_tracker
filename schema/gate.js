/**
 * schema/gate.js — The synchronous fast load gate (design §7.1, Part 3).
 *
 * ONE pure, O(stores) classification that runs on every startup and every
 * chat switch: for each PRESENT chat-metadata store it reads only the schema
 * manifest's version marker and the root container's TYPE. Nothing here walks
 * records — that is the whole point of the two-level split:
 *
 *   - `ready`    the manifest stamps the CURRENT version and the root is an
 *                object: the store may take the fast path, because every
 *                post-2.0 write and import seam enforces the schema before
 *                persisting (design §7.1/§8).
 *   - `prepare`  the version marker is missing (legacy v0) or older than the
 *                current version: deep validation/migration must run before
 *                the store is canonical.
 *   - `blocked`  the version is from a NEWER MWT, or the root container is
 *                unreadable: the store pauses locally, untouched (§3.5
 *                category 4); it never blocks another store.
 *   - `unknown`  the manifest itself is from a newer MWT: its section
 *                versions cannot be trusted either way, so no present store
 *                may take the fast path on its say-so.
 *
 * The Knowledge lorebook store is deliberately NOT gated here: it keeps its
 * own asynchronous, store-local, fail-closed hydration boundary (design
 * §7.4), and its version lives inside the `[MWT:store]` entry, not in the
 * chat-metadata manifest.
 *
 * Part 3 ships this gate PURE plus benchmarked (§7.2); Part 6 wires it into
 * startup and CHAT_CHANGED. Pure by contract: imports only the manifest
 * helpers and the registry — no DOM, no SillyTavern runtime, no feature
 * barrels. `normalizeManifest()` is itself O(stores), so the whole gate stays
 * O(stores) — `test/schema_perf_harness.test.js` pins the §7.2 p95 budget.
 */
import { CHAT_METADATA_SCHEMA_IDS, STORE_SCHEMAS } from './registry.js';
import { MANIFEST_VERSION, normalizeManifest } from './manifest.js';

/** Per-store gate outcomes (see the module docblock). */
export const GATE_STORE_STATES = Object.freeze({
    READY: 'ready',
    PREPARE: 'prepare',
    BLOCKED: 'blocked',
    UNKNOWN: 'unknown',
});

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Classify every chat-metadata store against the schema manifest.
 *
 * @param {object}  options
 * @param {object}  [options.manifest]  the RAW `chat_metadata.mwt_schema_manifest`
 *   value (any shape; it is normalized here — a future manifest passes through
 *   unchanged and flags every present store `unknown`)
 * @param {object}  [options.stores]    the RAW chat-metadata store roots by
 *   section id, e.g. `{ worldState: meta.world_state_tracker_metadata, ... }`.
 *   Values are only TYPE-checked, never walked.
 * @returns {{
 *   manifestVersion: number|null,
 *   manifestFromFuture: boolean,
 *   stores: Record<string, {state: string, present: boolean, version: number|null, currentVersion: number, reason: string|null}>,
 *   allReady: boolean,
 * }} stable, JSON-shaped result (one entry per registered chat-metadata store).
 */
export function runFastLoadGate({ manifest = null, stores = {} } = {}) {
    const manifestFromFuture = isPlainObject(manifest)
        && Number.isInteger(manifest.manifestVersion)
        && manifest.manifestVersion > MANIFEST_VERSION;
    const normalized = manifestFromFuture ? manifest : normalizeManifest(manifest);

    const result = {
        manifestVersion: manifestFromFuture ? null : normalized.manifestVersion,
        manifestFromFuture,
        stores: {},
        allReady: true,
    };

    for (const id of CHAT_METADATA_SCHEMA_IDS) {
        const descriptor = STORE_SCHEMAS[id];
        const root = stores[id];
        const present = root !== undefined && root !== null;
        const entry = {
            state: GATE_STORE_STATES.READY,
            present,
            version: null,
            currentVersion: descriptor.currentVersion,
            reason: null,
        };
        if (!present) {
            // An absent store stays absent — it is never manufactured just to
            // be stamped (design §3.3), and nothing needs preparing.
            entry.reason = 'absent';
        } else if (!isPlainObject(root)) {
            entry.state = GATE_STORE_STATES.BLOCKED;
            entry.reason = 'root-not-object';
        } else if (manifestFromFuture) {
            // A manifest from a newer MWT was refused unchanged; its section
            // versions can neither clear nor condemn a store, so no present
            // store may take the fast path on its say-so (§3.5 category 4).
            entry.state = GATE_STORE_STATES.UNKNOWN;
            entry.reason = 'manifest-from-future';
        } else {
            const version = normalized.sections[id];
            entry.version = version ?? 0;
            if (version === undefined || version === 0) {
                // A MISSING section version means legacy version 0 (§3.3):
                // deep preparation must run, but this is expected legacy
                // state, never a fault.
                entry.state = GATE_STORE_STATES.PREPARE;
                entry.reason = 'version-missing';
            } else if (version > descriptor.currentVersion) {
                entry.state = GATE_STORE_STATES.BLOCKED;
                entry.reason = 'future-version';
            } else if (version < descriptor.currentVersion) {
                entry.state = GATE_STORE_STATES.PREPARE;
                entry.reason = 'version-older';
            } else {
                entry.state = GATE_STORE_STATES.READY;
            }
        }
        result.stores[id] = entry;
        if (entry.state !== GATE_STORE_STATES.READY) result.allReady = false;
    }

    return result;
}
