/**
 * schema/runtime.js — The runtime chat-metadata cutover (schema plan Part 6,
 * design §7).
 *
 * THE orchestration that finally makes the schema manifest authoritative at
 * runtime. Until this module, every chat-metadata store was read raw by its
 * module on CHAT_CHANGED and reconciled lazily by per-module compatibility
 * calls; from Part 6 on, NO module reads or injects an unprepared store:
 *
 *   1. `applySchemaLoadGate()` runs the pure fast gate (schema/gate.js, §7.1)
 *      synchronously on EVERY startup and chat switch — O(stores), nothing
 *      walks records. For each PRESENT store it classifies ready / prepare /
 *      blocked / unknown:
 *        - `prepare`  → `prepareStore()` runs the store's migrations
 *                      synchronously. Every 0→1 migration is an order of
 *                      magnitude under the §7.2 50 ms ceiling on the
 *                      reference fixture (SCHEMA_PERF_BASELINES.md), so none
 *                      needs the module-local preparation state on
 *                      performance grounds. The one chat-DEPENDENT migration
 *                      (Interiority's legacy per-message keys) answers
 *                      `status: 'deferred'` and takes the §7.5 path below.
 *        - `blocked` / `unknown` → the store pauses (core/schema_status.js
 *                      §5.4): its module declines events, injection, and
 *                      writes, the banner goes up in its own tab, and every
 *                      other module keeps running (§7.4 — blocking is per
 *                      store, never global).
 *   2. §7.3 atomicity: the migrated data, the manifest version bump, and any
 *      quarantine additions land in the SAME `chat_metadata` object and are
 *      flushed by the SAME save — one persist call after the whole gate run.
 *      A dropped debounced write therefore re-runs idempotently on the next
 *      open and can never leave "manifest says v1, data is v0".
 *   3. `runSchemaPreparations()` is the §7.5 privileged path for deferred
 *      stores: the conversion runs through ORCHESTRATION, never the paused
 *      module's own work queue (queueing it there would deadlock the module
 *      against the very pause it exists to clear), the conversion's single
 *      save passes the write seam through the privileged-preparation window,
 *      and the gate is re-run so a clean result commits, stamps, and resumes
 *      while a surviving deferral stays a visible preparing state.
 *
 * `CHAT_CHANGED` stays SYNCHRONOUS: applySchemaLoadGate() never awaits, and
 * the asynchronous §7.5 preparation is fired after the synchronous part.
 * Knowledge's lorebook store keeps its own store-local fail-closed hydration
 * boundary and is deliberately NOT gated here (§7.4).
 *
 * NOT a pure schema module (unlike gate.js/manifest.js/registry.js): this is
 * the persistence/pause/notification orchestration design §3.1 keeps out of
 * the engine. It must never be imported by schema/gate.js, schema/manifest.js,
 * schema/registry.js, or a module schema — test/schema_engine.test.js pins
 * that statically. The core accessors (getChatMeta/persistChatMeta/
 * preserveQuarantinedRecords) come through the core barrel so tests see the
 * stub like every feature module does; everything else is a direct import of
 * the real singleton.
 */

import { getChatMeta, persistChatMeta, preserveQuarantinedRecords } from '../core/index.js';
import { captureScope, scopeStillCurrent } from '../core/scope.js';
import { prepareStore, ISSUE_SEVERITIES } from '../core/schema.js';
import { validateQuarantineStoreData, QUARANTINE_METADATA_KEY } from '../core/quarantine.js';
import {
    pauseStore,
    resumeStore,
    getPauseState,
    getPausedStores,
    setStoreRetryHandler,
    beginPrivilegedPreparation,
    endPrivilegedPreparation,
    runStoreResumeInitializer,
    recordSchemaEvent,
    SCHEMA_DIAGNOSTIC_EVENTS,
} from '../core/schema_status.js';
import { runFastLoadGate, GATE_STORE_STATES } from './gate.js';
import { CHAT_METADATA_SCHEMA_IDS, STORE_SCHEMAS } from './registry.js';
import { MANIFEST_METADATA_KEY, stampStoreVersion } from './manifest.js';
// The one chat-dependent migration (§7.5): Interiority's legacy per-message
// key conversion needs the live chat array, message UUIDs, and the sparse-chat
// hydration guard, so it stays owned by interiority/data.js and is driven from
// HERE as privileged orchestration. Same core-to-feature direction the
// registry uses. interiority/DATA.js never imports this file, so there is no
// cycle — interiority/INDEX.js imports runSchemaPreparations() for the
// MORE_MESSAGES_LOADED retry, which only references it at call time.
import { migrateIndexKeys } from '../interiority/data.js';

/**
 * Is a scope captured before an await still current, for the privileged
 * preparation path? The §7.5 semantics live in ONE owner — core/scope.js
 * scopeStillCurrent(): the EPOCH is always checked (CHAT_CHANGED bumps it
 * synchronously, so a real chat switch can never slip through), while the
 * identity comparison runs only when the capture actually identified the
 * chat (unknown identities mint a fresh nonce per call, so strict identity
 * equality would mark every await stale on hosts without a usable chat id).
 *
 * @param {object} token — captureScope()'s value
 * @returns {boolean} false when the capture is stale
 */
function preparationScopeStillCurrent(token) {
    return scopeStillCurrent(token).ok;
}

/**
 * The §7.5 privileged converters, by store id. A deferred store without a
 * converter stays paused (preparing) — deferral is never silently degraded
 * into a partial load. Each converter receives the privileged-preparation
 * CAPABILITY beginPrivilegedPreparation() minted for this run and must present
 * it at exactly its single commit write; no other write to the paused store
 * passes the seam while the conversion is in flight.
 */
const PRIVILEGED_PREPARATIONS = Object.freeze({
    interiority: (capability) => migrateIndexKeys(capability),
});

/**
 * Deferred store ids the synchronous gate queued for the §7.5 privileged
 * path. Drained by runSchemaPreparations(); re-populated by every gate run
 * that still defers (so a sparse-chat hydration retry has something to retry).
 */
const _pendingPreparations = [];

// ─── §5.4 module-authored pause messages ─────────────────────────────────────
//
// pauseStore() resolves the owning module from the shared mapping; these
// strings are the plain-language reason the banner, 🗂️ Scope & storage, and
// ❤️ Health all render. Never put quarantined record content in them.

function futureVersionMessage(storeId, version) {
    const current = STORE_SCHEMAS[storeId].currentVersion;
    return `its saved data was written by a NEWER version of MWT (schema v${version}; this build supports up to v${current}). `
        + 'Your data was not changed — upgrade MWT to read this chat, or open it on the newer install.';
}

function blockPauseMessage(storeId, reasonCode, prepared) {
    switch (reasonCode) {
        case 'future-version':
            return futureVersionMessage(storeId, prepared?.fromVersion ?? null);
        case 'root-not-object':
            return 'its saved data could not be read (the stored value is not an object). Your data was not changed. '
                + 'Use ⬇ Download recovery data to export it, repair the chat data, then retry.';
        case 'manifest-from-future':
            return 'this chat\'s schema manifest was written by a NEWER version of MWT, so its stores stay closed rather than guess. '
                + 'Your data was not changed — upgrade MWT, then reopen this chat.';
        case 'quarantine-version-future':
        case 'quarantine-container-invalid':
        case 'quarantine-limit':
            return `the records its migration rejected could not be preserved in quarantine (${reasonCode}). `
                + 'Your data was not changed — upgrade MWT if a newer install wrote this chat, then retry.';
        default:
            return `its saved data could not be safely prepared for use (${reasonCode}). `
                + 'Your data was not changed. Use ⬇ Download recovery data to export what was kept, then retry.';
    }
}

/** Pause one store with the §5.4 message its reason code owns. */
function pauseForReason(storeId, reasonCode, { version = null, count = null, prepared = null } = {}) {
    return pauseStore(storeId, {
        reasonCode,
        version,
        count,
        message: blockPauseMessage(storeId, reasonCode, prepared),
    });
}

/**
 * The first DEFER-severity issue's user-facing message (§7.5: the deferral
 * text is module-authored and names no internal functions), or a safe
 * fallback.
 */
function deferPauseMessage(prepared) {
    const defer = (prepared?.issues ?? []).find(issue => issue?.severity === ISSUE_SEVERITIES.DEFER);
    return defer?.message
        || 'it needs a one-time compatibility update before it can be used; the saved data was left unchanged.';
}

// ─── The synchronous gate (§7.4 steps 1–4) ───────────────────────────────────

/**
 * Run the runtime load gate over the CURRENT chat's metadata, synchronously.
 *
 * Order inside one call (no awaits, by contract — CHAT_CHANGED must not gain
 * an await, §7.4):
 *
 *   1. fast-gate classify every present chat-metadata store (§7.1);
 *   2. for `prepare` stores, run `prepareStore()` synchronously (§7.2 budget
 *      conforming by measurement); blocked stores pause instead;
 *   3. commit every successful preparation — canonical data, manifest stamp,
 *      and quarantine additions — into the SAME chat_metadata object;
 *   4. ONE persist call for the whole run (§7.3: the manifest bump, the
 *      migrated data, and the quarantine additions are flushed by the same
 *      save, so the write is all-or-nothing and idempotently re-runnable).
 *
 * A `ready` store whose pause record is still up (the data was fixed
 * out-of-band and the chat reopened) resumes — a later load clearing the
 * block is one of §5.4's resume paths. Deferred stores queue for
 * {@link runSchemaPreparations} and stay paused (preparing) until it lands.
 *
 * @param {object} [options]
 * @param {function(): object} [options.chatMeta] live chat-metadata getter
 *   (defaults to the barrel getChatMeta — the test stub under vitest)
 * @param {function(): void} [options.persist] metadata flush (defaults to the
 *   debounced barrel persistChatMeta; tests inject a spy to pin §7.3's
 *   "exactly one save" contract)
 * @returns {{
 *   ran: boolean,
 *   manifestFromFuture: boolean,
 *   persisted: boolean,
 *   stores: Record<string, {action: string, version: number|null, reason: string|null, quarantined: number}>,
 *   deferred: string[],
 * }} stable, JSON-shaped summary
 */
export function applySchemaLoadGate({
    chatMeta = getChatMeta,
    persist = persistChatMeta,
} = {}) {
    const result = {
        ran: false,
        manifestFromFuture: false,
        persisted: false,
        stores: {},
        deferred: [],
    };
    const meta = typeof chatMeta === 'function' ? chatMeta() : chatMeta;
    if (!meta || typeof meta !== 'object') return result;
    result.ran = true;

    const gate = runFastLoadGate({
        manifest: meta[MANIFEST_METADATA_KEY],
        stores: Object.fromEntries(
            CHAT_METADATA_SCHEMA_IDS.map(id => [id, meta[STORE_SCHEMAS[id].metadataKey]]),
        ),
    });
    result.manifestFromFuture = gate.manifestFromFuture;

    // Quarantine-container read shared by every preparation: prepareStore's
    // ceiling check counts the merged total, and the commit-time preservation
    // (preserveQuarantinedRecords) re-validates and refuses a future/lossy
    // container — the same single refusal point every write seam uses.
    const quarantine = validateQuarantineStoreData(meta[QUARANTINE_METADATA_KEY]);

    let manifest = meta[MANIFEST_METADATA_KEY];
    let dirty = false;

    for (const id of CHAT_METADATA_SCHEMA_IDS) {
        const schema = STORE_SCHEMAS[id];
        const entry = gate.stores[id];
        const summary = {
            action: 'ready',
            version: entry.version ?? null,
            reason: entry.reason,
            quarantined: 0,
        };
        result.stores[id] = summary;

        if (entry.state === GATE_STORE_STATES.READY || !entry.present) {
            // Absent stores stay absent (§3.3 — never manufactured just to be
            // stamped). A ready store is canonical by §7.1's trust rule; a
            // stale pause from an earlier load clears now (§5.4 resume paths).
            if (entry.state === GATE_STORE_STATES.READY && getPauseState(id) !== null) {
                resumeStore(id, { via: 'load' });
            }
            continue;
        }

        if (entry.state === GATE_STORE_STATES.UNKNOWN || entry.state === GATE_STORE_STATES.BLOCKED) {
            const reasonCode = entry.state === GATE_STORE_STATES.UNKNOWN
                ? 'manifest-from-future'
                : entry.reason; // 'future-version' | 'root-not-object'
            pauseForReason(id, reasonCode, { version: entry.version });
            if (reasonCode === 'future-version') {
                recordSchemaEvent(SCHEMA_DIAGNOSTIC_EVENTS.BLOCKED_FUTURE_VERSION, {
                    store: id,
                    version: entry.version,
                }, { level: 'warn' });
            }
            summary.action = entry.state === GATE_STORE_STATES.UNKNOWN ? 'unknown' : 'blocked';
            continue;
        }

        // GATE_STORE_STATES.PREPARE — deep preparation (migration + validation).
        // O(records) is fine here: §7.1 sends a store down this path only when
        // its version is missing/older, i.e. once per legacy chat, not per switch.
        const prepared = prepareStore(schema, meta[schema.metadataKey], {
            version: entry.version ?? 0,
            existingQuarantine: quarantine.data.items,
        });

        if (prepared.status === 'blocked') {
            const code = prepared.error?.code ?? 'migration-failed';
            pauseForReason(id, code, { version: prepared.fromVersion, prepared });
            recordSchemaEvent(code === 'future-version'
                ? SCHEMA_DIAGNOSTIC_EVENTS.BLOCKED_FUTURE_VERSION
                : SCHEMA_DIAGNOSTIC_EVENTS.MIGRATION_FAILED, {
                store: id,
                code,
                fromVersion: prepared.fromVersion,
            }, { level: 'warn' });
            summary.action = 'blocked';
            summary.reason = code;
            continue;
        }

        if (prepared.status === 'deferred') {
            // §7.5: first-class outcome, not a fault. Original untouched,
            // nothing quarantined or stamped; the module pauses as PREPARING
            // and the privileged path below owns the conversion.
            pauseStore(id, {
                reasonCode: prepared.issues.find(issue => issue?.severity === ISSUE_SEVERITIES.DEFER)?.code ?? 'preparing',
                version: prepared.fromVersion,
                message: deferPauseMessage(prepared),
            });
            if (!_pendingPreparations.includes(id)) _pendingPreparations.push(id);
            summary.action = 'deferred';
            continue;
        }

        // 'valid' | 'migrated' — commit §7.3-style: quarantine preservation
        // first (a refusal means the rejected records cannot be stored, so
        // NOTHING is committed and the store blocks), then the data, then the
        // manifest stamp. All inside the same chat_metadata object; the single
        // persist at the end of the run flushes all of it together.
        const preserved = preserveQuarantinedRecords(id, prepared.issues, {
            sourceVersion: prepared.fromVersion,
        });
        if (!preserved.ok) {
            pauseForReason(id, preserved.reason ?? 'quarantine-unavailable', {
                version: prepared.fromVersion,
                count: prepared.quarantined.length,
                prepared,
            });
            recordSchemaEvent(SCHEMA_DIAGNOSTIC_EVENTS.MIGRATION_FAILED, {
                store: id,
                code: preserved.reason,
                count: prepared.quarantined.length,
                fromVersion: prepared.fromVersion,
            }, { level: 'warn' });
            summary.action = 'blocked';
            summary.reason = preserved.reason ?? 'quarantine-unavailable';
            continue;
        }

        if (prepared.changed) {
            meta[schema.metadataKey] = prepared.data;
        }
        manifest = stampStoreVersion(manifest, id, schema.currentVersion);
        dirty = true;
        summary.action = prepared.status === 'migrated' ? 'migrated' : 'committed';
        summary.version = schema.currentVersion;
        summary.quarantined = prepared.quarantined.length;
        // A successful preparation clears any pause a previous load recorded
        // for this store (the §7.5 deferred store's privileged conversion
        // lands here, and an out-of-band fix + reopen lands here too).
        if (getPauseState(id) !== null) {
            resumeStore(id, { via: 'load' });
        }
        if (prepared.status === 'migrated') {
            recordSchemaEvent(SCHEMA_DIAGNOSTIC_EVENTS.MIGRATED, {
                store: id,
                fromVersion: prepared.fromVersion,
                toVersion: prepared.toVersion,
            });
        }
        if (prepared.quarantined.length > 0) {
            recordSchemaEvent(SCHEMA_DIAGNOSTIC_EVENTS.QUARANTINED, {
                store: id,
                count: prepared.quarantined.length,
            }, { level: 'warn' });
        }
    }

    if (dirty) {
        // The one §7.3 save: every store's migrated data, every manifest
        // stamp, and every quarantine addition from this run ride together.
        meta[MANIFEST_METADATA_KEY] = manifest;
        try {
            persist();
            result.persisted = true;
        } catch (err) {
            // persistChatMeta() is a debounced fire-and-forget, so a throw is
            // unexpected — but it must never break the load: chat_metadata is
            // already updated in memory, the host owns flushing, and a dropped
            // write re-runs this gate idempotently on the next open (§7.3).
            recordSchemaEvent(SCHEMA_DIAGNOSTIC_EVENTS.PERSIST_FAILED, {
                store: 'chatMetadata',
                code: 'gate-persist-failed',
            }, { level: 'error' });
            console.warn('[MWT:schema] Metadata flush after preparation failed (it will re-run on the next open):', err?.message || err);
        }
    }

    result.deferred = [..._pendingPreparations];
    return result;
}

// ─── Collecting a gate run's resumes (the Part 6 out-of-band re-init seam) ────

/**
 * Snapshot the currently paused store ids before a gate run, so every store
 * the run RESUMES can be initialized afterwards. One applySchemaLoadGate()
 * call can resume several stores at once — repairing a future-version
 * manifest makes every affected store ready by §7.1's trust rule — and each
 * resumed store's owning module needs its out-of-band re-initialization, not
 * just the one whose Retry button was clicked. Otherwise those modules stay
 * unpaused with the stale in-memory state their skipped chat-change hydration
 * left behind, and their next event persists it over the repaired store.
 */
function snapshotPausedStores() {
    return getPausedStores().map((pause) => pause.store);
}

/**
 * Run the resume initializer for every store that was paused in the snapshot
 * and is no longer paused now. runStoreResumeInitializer()'s
 * run-once-per-pause-generation memo is keyed by OWNING MODULE, keeping each
 * module's onChatChanged() to a single re-run even when several paths observe
 * the same resume (the Retry wrapper, the §7.5 re-gate, and this collector
 * can all see one resume) or when one resume reports several store ids of the
 * same module — this loop visits each of knowledge's store ids, and they
 * share one initializer, so the dedupe must be by module or the same
 * asynchronous re-hydration starts once per store id and overlaps itself.
 */
async function initializeResumedStores(pausedBefore) {
    for (const storeId of pausedBefore) {
        if (getPauseState(storeId) === null) {
            await runStoreResumeInitializer(storeId);
        }
    }
}

// ─── The §7.5 privileged preparation path ────────────────────────────────────

/**
 * Run the privileged preparation for every store the last gate deferred.
 *
 * This — never the paused module's own work queue — is what clears a
 * deferral (§7.5: a queued recovery job would be declined by the very pause
 * it exists to clear). For each deferred store: capture the scope, open the
 * privileged-preparation window so the conversion's ONE save passes the write
 * seam, run the converter, re-run the gate synchronously (a clean result
 * commits data + manifest atomically and resumes the module; a surviving
 * deferral stays a visible preparing state), and discard everything if the
 * chat switched while the conversion ran.
 *
 * Idempotent: nothing to do when no store is deferred.
 *
 * @param {object} [options] — forwarded to applySchemaLoadGate()
 * @returns {Promise<string[]>} the store ids that were attempted
 */
export async function runSchemaPreparations(options = {}) {
    const ids = [...new Set(_pendingPreparations.splice(0))];
    if (ids.length === 0) return ids;
    const scope = captureScope();
    for (const id of ids) {
        const converter = PRIVILEGED_PREPARATIONS[id];
        if (typeof converter !== 'function') {
            // No privileged path for this deferral: it stays a visible
            // preparing state (never a partial load or a quarantine drop).
            continue;
        }
        // §7.5 window: a scope-bound CAPABILITY, not an open flag. While the
        // converter awaits hydration the store's write seam stays closed to
        // every other write — UI work, cleanup, a newly switched chat; the
        // converter presents exactly this capability at its single commit.
        const capability = beginPrivilegedPreparation(id);
        try {
            await converter(capability);
        } catch (err) {
            console.warn(`[MWT:schema] Privileged preparation for "${id}" failed; the store stays paused:`, err?.message || err);
            recordSchemaEvent(SCHEMA_DIAGNOSTIC_EVENTS.MIGRATION_FAILED, {
                store: id,
                code: 'privileged-preparation-failed',
            }, { level: 'warn' });
        } finally {
            endPrivilegedPreparation(capability);
        }
        // The converter awaited: a chat switch in that window (the epoch
        // bumped, or a known identity changed) means whatever it wrote
        // belongs to the outgoing chat. The new chat's own CHAT_CHANGED gate
        // re-derives everything — stop here.
        if (!preparationScopeStillCurrent(scope)) return ids;
        // Re-run the gate: conversion done, the store either prepares clean
        // (commits + stamps + resumes) or defers again (stays paused).
        const pausedBefore = snapshotPausedStores();
        applySchemaLoadGate(options);
        // Part 6: a resume HERE happens out of band — CHAT_CHANGED already ran
        // past every still-paused module's onChatChanged() hydration while its
        // store was paused. And ONE gate run can resume several stores, not
        // just the deferred one being converted (a repaired manifest clears
        // every affected store's stale pause). Re-initialize EVERY resumed
        // store's owning module from the now-canonical store (run-once per
        // pause generation), so no module persists the stale in-memory state
        // over the repaired data.
        await initializeResumedStores(pausedBefore);
    }
    return ids;
}

// ─── The §5.4 Retry seam for chat-metadata stores ────────────────────────────

/**
 * Register the Retry handler for every chat-metadata store: re-run the
 * synchronous gate and the privileged preparations, then report whether this
 * store's block cleared. retryStore() records the resume event when the
 * handler resolves true; a store that re-blocks keeps its banner. The handler
 * also re-initializes every OTHER store the same gate run resumed (one
 * repaired manifest can release several blocks at once), so no module keeps
 * the stale in-memory state its skipped chat-change hydration left behind.
 *
 * Idempotent; index.js calls it once at startup.
 */
export function registerSchemaGateRetryHandlers() {
    for (const id of CHAT_METADATA_SCHEMA_IDS) {
        setStoreRetryHandler(id, async () => {
            const pausedBefore = snapshotPausedStores();
            applySchemaLoadGate();
            await runSchemaPreparations();
            // One gate run can resume SEVERAL stores — repairing a
            // future-version manifest makes every affected store ready — and
            // retryStore() re-initializes only the store whose Retry button
            // was clicked. Collect every store this run resumed and
            // initialize each owning module once (the run-once memo absorbs
            // the overlap with retryStore()'s own initializer run).
            await initializeResumedStores(pausedBefore);
            return getPauseState(id) === null;
        });
    }
}

// ─── Test-only seams ─────────────────────────────────────────────────────────

/**
 * Clear the pending-preparation queue and unregister the Retry handlers.
 * @internal — test isolation only; production code must not call this.
 */
export function _resetSchemaRuntime() {
    _pendingPreparations.length = 0;
    for (const id of CHAT_METADATA_SCHEMA_IDS) {
        setStoreRetryHandler(id, null);
    }
}

