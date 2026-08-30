/**
 * test/schema_status_surface.test.js — Schema plan Part 5: the visible
 * paused-state surface (§5.4), the schema-status diagnostics (§9.1/§9.2), the
 * §9.3 diagnostic events, and the §5.3 recovery surface.
 *
 * Layers under test:
 *   1. core/schema_status.js — the pause registry (one owner of the reason),
 *      the content-safe schema events, the one-notification-per-chat/scope
 *      rule, the Retry seam, and the module-banner builder.
 *   2. diagnostics_panel/schema_status.js — the §9.1 collector (registry-
 *      enumerated rows through the REAL pure fast gate over injected chat
 *      metadata) + its redaction gate.
 *   3. diagnostics_panel/health.js + render.js — the paused reason reaching
 *      the ❤️ Health row/banner and the 🗂️ Scope & storage schema section.
 *   4. backup/recovery.js — the §5.3 export (downloaded through the stubbed
 *      barrel seam) and the confirmed clear.
 *   5. knowledge/store.js — the LIVE pause wiring: a blocked hydration pauses
 *      the knowledgeStore with the same reason the banner shows, and a later
 *      successful load resumes it.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The pause registry + events (real singletons — the whole point of Part 5).
import {
    SCHEMA_DIAGNOSTIC_EVENTS,
    MODULE_STORE_IDS,
    STORE_MODULE_IDS,
    moduleId,
    pauseStore,
    resumeStore,
    getPauseState,
    getPausedStores,
    isPauseForCurrentScope,
    setStoreRetryHandler,
    retryStore,
    renderPausedStoresBanner,
    recordSchemaEvent,
    _setScopeKeyResolver,
    _resetPausedStores,
} from '../core/schema_status.js';
import { _resetDiagnostics, getEvents } from '../core/diagnostics.js';
import { bumpEpoch, _resetEpoch } from '../core/scope.js';

// The §9.1 collector + renderer + the Health surface.
import { collectSchemaStatusSnapshot, redactSchemaStatusSnapshot } from '../diagnostics_panel/schema_status.js';
import { collectHealthSnapshot } from '../diagnostics_panel/health.js';
import { renderHealthSnapshot, renderSchemaStatusSnapshot } from '../diagnostics_panel/render.js';

// The §5.3 recovery surface.
import {
    readChatQuarantineContainer,
    collectRecoveryItems,
    collectQuarantineStatus,
    exportRecoveryData,
    clearQuarantineData,
    QUARANTINE_CLEAR_CONFIRM,
} from '../backup/recovery.js';
// The one wording owner both export buttons render (§5.3/§5.4).
import { describeRecoveryExportResult } from '../backup/render.js';

// The live Knowledge hydration wiring (Part 4's blocked paths now pause).
import {
    STORE_COMMENT,
    STORE_SENTINEL,
    STORE_VERSION,
    hydrateBook,
    hydrateCurrentBooks,
    isHydrated,
    peekStore,
    peekStoreData,
    getHydratedBooks,
    getStoreQuarantineItems,
    clearStoreQuarantine,
    writeField,
    _clearCacheForTests,
    _setCacheForTests,
} from '../knowledge/store.js';
import { state, LOREBOOK_NAME, STATE_LOREBOOK_NAME } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';

// Registry/manifest/quarantine primitives the assertions reason about.
import { CHAT_METADATA_SCHEMA_IDS, STORE_SCHEMAS } from '../schema/registry.js';
import { MANIFEST_METADATA_KEY, MANIFEST_VERSION } from '../schema/manifest.js';
import { QUARANTINE_METADATA_KEY, makeQuarantineItem } from '../core/quarantine.js';

// The stubbed barrel seams (fake meta, fake downloads, captured toasts).
import {
    resetCoreStubs,
    setFakeContextExtras,
    getFakeMeta,
    getFakeDownloadJsonCalls,
    getFakeNotifications,
} from './stubs/core.js';

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** The real notify() records module:'notify' events — count the ring, newest first. */
const notifyEvents = () => getEvents({ module: 'notify' });

/** Events by NAME — the ring's filter takes level/module only (the Phase 0 shape). */
const eventsOf = (name) => getEvents().filter((e) => e.event === name);

/** A fixed scope key so "per chat/scope" is deterministic in tests. */
const scope = (key) => _setScopeKeyResolver(() => key);

/** One quarantine item for the fake chat container. */
const item = (store, raw, fingerprint) => makeQuarantineItem({
    store, reasonCode: 'test-reason', message: 'Test reason.', raw, fingerprint,
});

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
    _resetDiagnostics();
    _resetPausedStores();
    _clearCacheForTests();
    state.wiScript = undefined;
    saveSettings({ scope: 'global' });
    scope('chat:part5');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    _resetPausedStores();
    _clearCacheForTests();
    state.wiScript = null;
    _setScopeKeyResolver(null);
});

// ─── §9.3 — content-safe schema events ────────────────────────────────────────

describe('recordSchemaEvent (§9.3)', () => {
    test('records the allowlisted fields and drops everything else — no prose rides along', () => {
        recordSchemaEvent(SCHEMA_DIAGNOSTIC_EVENTS.MIGRATED, {
            store: 'chronicle',
            fromVersion: 0,
            toVersion: 1,
            count: 3,
            // Everything below is NOT metadata and must be dropped:
            raw: { snapshot: { content: 'The duke swept out of the room.' } },
            message: 'user prose',
            error: new Error('boom'),
        });
        const [evt] = eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.MIGRATED);
        expect(evt.module).toBe('schema');
        expect(evt.detail).toEqual({
            store: 'chronicle', fromVersion: 0, toVersion: 1, count: 3,
        });
    });

    test('never throws, whatever it is handed', () => {
        expect(() => recordSchemaEvent('schema_migrated', null)).not.toThrow();
        expect(() => recordSchemaEvent('schema_migrated', undefined)).not.toThrow();
        expect(() => recordSchemaEvent('schema_quarantined', 'a string')).not.toThrow();
    });
});

// ─── §5.4 — the pause registry ────────────────────────────────────────────────

describe('pauseStore / resumeStore (§5.4)', () => {
    test('registers the pause, records schema_store_paused, and fires exactly one notification', () => {
        const state1 = pauseStore('knowledgeStore', {
            reasonCode: 'future-version',
            message: 'its lorebook was saved by a NEWER MWT. Your data was not changed.',
            version: 2,
        });
        expect(state1).toMatchObject({
            store: 'knowledgeStore',
            module: 'knowledge',
            reasonCode: 'future-version',
            version: 2,
            scopeKey: 'chat:part5',
        });
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.STORE_PAUSED)).toHaveLength(1);
        expect(notifyEvents()).toHaveLength(1);
        expect(notifyEvents()[0].detail.title).toBe('MWT: Knowledge is paused');
    });

    test('ONE notification per chat/scope: re-detections never repeat the toast', () => {
        pauseStore('chronicle', { reasonCode: 'fatal-issue', message: 'a' });
        pauseStore('chronicle', { reasonCode: 'fatal-issue', message: 'a' }); // retry re-detected
        pauseStore('chronicle', { reasonCode: 'other-issue', message: 'b' }); // different block, same chat
        expect(getPausedStores()).toHaveLength(1);
        expect(notifyEvents()).toHaveLength(1);
        // A transition event per NEW reason, but still one toast.
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.STORE_PAUSED)).toHaveLength(2);
    });

    test('a different chat/scope is notified again — one PER chat/scope', () => {
        pauseStore('chronicle', { reasonCode: 'fatal-issue', message: 'a' });
        scope('chat:other');
        pauseStore('chronicle', { reasonCode: 'fatal-issue', message: 'a' });
        expect(notifyEvents()).toHaveLength(2);
        // The banner only paints the CURRENT scope's pause.
        expect(isPauseForCurrentScope(getPauseState('chronicle'))).toBe(true);
        scope('chat:part5');
        expect(isPauseForCurrentScope(getPauseState('chronicle'))).toBe(false);
    });

    test('a repeated same-block pause keeps the original since and records nothing new', () => {
        const first = pauseStore('interiority', { reasonCode: 'fatal-issue', message: 'x' });
        const again = pauseStore('interiority', { reasonCode: 'fatal-issue', message: 'x' });
        expect(again.since).toBe(first.since);
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.STORE_PAUSED)).toHaveLength(1);
    });

    test('resumeStore clears the pause and records schema_store_resumed only when one existed', () => {
        expect(resumeStore('worldState')).toBe(false);
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.STORE_RESUMED)).toHaveLength(0);
        pauseStore('worldState', { reasonCode: 'future-version', message: 'x' });
        expect(resumeStore('worldState', { via: 'retry' })).toBe(true);
        expect(getPauseState('worldState')).toBeNull();
        const [evt] = eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.STORE_RESUMED);
        expect(evt.detail).toEqual({ store: 'worldState', via: 'retry' });
    });

    test('the store↔module mapping is total over the registry and hyphen ids normalise', () => {
        expect(moduleId('world-state')).toBe('world_state');
        for (const id of Object.keys(STORE_SCHEMAS)) {
            expect(STORE_MODULE_IDS[id]).toBeDefined();
        }
        expect(MODULE_STORE_IDS.knowledge.sort()).toEqual(
            ['knowledgeCounters', 'knowledgeEvidence', 'knowledgeStore'].sort(),
        );
    });
});

// ─── §5.4 — the Retry seam ────────────────────────────────────────────────────

describe('retryStore (the §5.4 Retry seam)', () => {
    test('without a registered handler it reports no-retry-path and changes nothing', async () => {
        pauseStore('storyPlanner', { reasonCode: 'future-version', message: 'x' });
        const result = await retryStore('storyPlanner');
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('no-retry-path');
        expect(getPauseState('storyPlanner')).not.toBeNull();
    });

    test('a successful handler clears the pause (it may resume it itself)', async () => {
        pauseStore('storyPlanner', { reasonCode: 'future-version', message: 'x' });
        setStoreRetryHandler('storyPlanner', () => {
            resumeStore('storyPlanner', { via: 'retry' });
            return true;
        });
        expect(await retryStore('storyPlanner')).toMatchObject({ ok: true, resumed: true });
    });

    test('a handler that reports success without resuming is resumed by the seam', async () => {
        pauseStore('storyPlanner', { reasonCode: 'future-version', message: 'x' });
        setStoreRetryHandler('storyPlanner', () => true);
        const result = await retryStore('storyPlanner');
        expect(result.ok).toBe(true);
        expect(getPauseState('storyPlanner')).toBeNull();
    });

    test('a failing handler leaves the pause and reports still-paused', async () => {
        pauseStore('storyPlanner', { reasonCode: 'future-version', message: 'x' });
        setStoreRetryHandler('storyPlanner', () => false);
        const result = await retryStore('storyPlanner');
        expect(result.ok).toBe(false);
        expect(result.reason).toBe('still-paused');
        expect(getPauseState('storyPlanner')).not.toBeNull();
    });

    test('a throwing handler is reported, never thrown', async () => {
        pauseStore('storyPlanner', { reasonCode: 'future-version', message: 'x' });
        setStoreRetryHandler('storyPlanner', () => { throw new Error('boom'); });
        await expect(retryStore('storyPlanner')).resolves.toMatchObject({
            ok: false, reason: 'retry-failed', message: 'boom',
        });
    });
});

// ─── §5.4 — the module banner ─────────────────────────────────────────────────

describe('renderPausedStoresBanner (§5.4 — the module\'s own tab)', () => {
    test('empty for a healthy module — a healthy tab renders exactly as before', () => {
        expect(renderPausedStoresBanner('knowledge')).toBe('');
        expect(renderPausedStoresBanner('chronicle')).toBe('');
    });

    test('a paused store paints the banner with its reason, Retry, and the recovery export', () => {
        pauseStore('knowledgeStore', {
            reasonCode: 'future-version',
            message: 'its lorebook was saved by a NEWER MWT. Your data was not changed.',
        });
        const html = renderPausedStoresBanner('knowledge'); // Health-tab spelling
        expect(html).toContain('mwt-pause-banner');
        expect(html).toContain('Knowledge is paused for this chat');
        expect(html).toContain('saved by a NEWER MWT');
        expect(html).toContain('data-mwt-pause-retry="knowledgeStore"');
        expect(html).toContain('data-mwt-pause-export="1"');
        expect(html).toContain('Download recovery data');
    });

    test('another chat\'s pause does not paint this chat\'s banner', () => {
        scope('chat:other');
        pauseStore('knowledgeStore', { reasonCode: 'future-version', message: 'x' });
        scope('chat:part5');
        expect(renderPausedStoresBanner('knowledge')).toBe('');
    });

    test('the reason text is escaped', () => {
        pauseStore('chronicle', { reasonCode: 'x', message: '<script>alert(1)</script>' });
        const html = renderPausedStoresBanner('chronicle');
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });

    test('one banner row per paused store of the module', () => {
        pauseStore('knowledgeEvidence', { reasonCode: 'a', message: 'first' });
        pauseStore('knowledgeCounters', { reasonCode: 'b', message: 'second' });
        const html = renderPausedStoresBanner('knowledge');
        expect((html.match(/mwt-pause-banner-row/g) || []).length).toBe(2);
    });
});

// ─── §9.1 — the schema-status collector ───────────────────────────────────────

/** Default collector deps: injected chat metadata + knowledge, real gate. */
function schemaDeps(meta, over = {}) {
    return {
        now: () => 1_700_000_000_000,
        version: '9.9.9-test',
        chatMeta: () => meta,
        knowledge: {
            // The store spans BOTH books (Knowledge + State Tracker) — the
            // resolver's shape, mirrored here.
            books: () => ({
                books: [
                    { name: 'Knowledge Tracker', role: 'knowledge' },
                    { name: 'State Tracker', role: 'state' },
                ],
                mode: 'global',
            }),
            peek: () => null,
            peekData: () => ({}),
            currentVersion: STORE_SCHEMAS.knowledgeStore.currentVersion,
        },
        ...over,
    };
}

describe('collectSchemaStatusSnapshot (§9.1)', () => {
    test('enumerates every registry chat-metadata store plus BOTH Knowledge lorebook books', () => {
        const snap = collectSchemaStatusSnapshot(schemaDeps({}));
        expect(snap.rows.map((r) => r.id)).toEqual([...CHAT_METADATA_SCHEMA_IDS]);
        expect(snap.knowledgeStore.id).toBe('knowledgeStore');
        // The store spans the Knowledge AND the State Tracker book: one
        // inspection each, aggregated into the single knowledgeStore row.
        expect(snap.knowledgeStore.books.map((b) => b.book)).toEqual(['Knowledge Tracker', 'State Tracker']);
        expect(snap.knowledgeStore.books.map((b) => b.role)).toEqual(['knowledge', 'state']);
        expect(snap.totals.stores).toBe(CHAT_METADATA_SCHEMA_IDS.length + 2);
        // An empty chat is quiet: absent stores, not faults.
        expect(snap.bannerLevel).toBe('ok');
        expect(snap.warnings).toEqual([]);
    });

    test('classifies ready/prepare/blocked through the REAL fast gate over the manifest', () => {
        const meta = {
            [MANIFEST_METADATA_KEY]: {
                manifestVersion: MANIFEST_VERSION,
                sections: { worldState: 1, chronicle: 99, storyPlanner: 1 },
            },
            // A present worldState root stamped current by the manifest → ready,
            // and its migration is provably persisted.
            [STORE_SCHEMAS.worldState.metadataKey]: { text: 'x' },
            // A present chronicle root stamped 99 → blocked (future version).
            [STORE_SCHEMAS.chronicle.metadataKey]: { snapshots: [] },
            // interiority present but unstamped → legacy 0 → prepare.
            [STORE_SCHEMAS.interiority.metadataKey]: { ledger: [] },
        };
        const snap = collectSchemaStatusSnapshot(schemaDeps(meta));
        const byId = Object.fromEntries(snap.rows.map((r) => [r.id, r]));
        expect(byId.worldState.state).toBe('ready');
        expect(byId.worldState.migrationPersisted).toBe(true);
        expect(byId.worldState.storedVersion).toBe(1);
        expect(byId.chronicle.state).toBe('blocked');
        expect(byId.chronicle.reason).toBe('future-version');
        expect(byId.storyPlanner.state).toBe('ready');
        expect(byId.interiority.state).toBe('prepare');
        expect(byId.interiority.migrationPersisted).toBe(false);
        // A blocked store is a fail-level warning, unmistakable.
        expect(snap.bannerLevel).toBe('fail');
        expect(snap.warnings.some((w) => w.id === 'store-blocked:chronicle')).toBe(true);
    });

    test('a manifest from a newer MWT flags every present store unknown', () => {
        const meta = {
            [MANIFEST_METADATA_KEY]: { manifestVersion: 99, sections: { worldState: 1 } },
            [STORE_SCHEMAS.worldState.metadataKey]: { text: 'x' },
        };
        const snap = collectSchemaStatusSnapshot(schemaDeps(meta));
        expect(snap.manifestFromFuture).toBe(true);
        const world = snap.rows.find((r) => r.id === 'worldState');
        expect(world.state).toBe('unknown');
        expect(snap.warnings.some((w) => w.id === 'manifest-from-future')).toBe(true);
    });

    test('counts quarantined records per store from the chat container', () => {
        const meta = {
            [QUARANTINE_METADATA_KEY]: {
                version: 1,
                items: [item('chronicle', { id: 1 }), item('chronicle', { id: 2 }), item('interiority', { x: 1 })],
            },
        };
        const snap = collectSchemaStatusSnapshot(schemaDeps(meta));
        const byId = Object.fromEntries(snap.rows.map((r) => [r.id, r]));
        expect(byId.chronicle.quarantineCount).toBe(2);
        expect(byId.interiority.quarantineCount).toBe(1);
        expect(byId.worldState.quarantineCount).toBe(0);
        expect(snap.totals.quarantine).toBe(3);
    });

    test('carries the SAME pause reason as the module banner — surfaces cannot disagree', () => {
        pauseStore('interiority', {
            reasonCode: 'fatal-issue',
            message: 'its saved data could not be safely prepared. Your data was not changed.',
        });
        const snap = collectSchemaStatusSnapshot(schemaDeps({}));
        const row = snap.rows.find((r) => r.id === 'interiority');
        expect(row.paused).toMatchObject({
            reasonCode: 'fatal-issue',
            message: 'its saved data could not be safely prepared. Your data was not changed.',
        });
        expect(snap.bannerLevel).toBe('fail');
        expect(snap.warnings.some((w) => w.id === 'store-paused:interiority' && w.level === 'fail')).toBe(true);
    });

    test('Knowledge hydration rows: loaded / failed / not-attempted, per book', () => {
        const loaded = collectSchemaStatusSnapshot(schemaDeps({}, {
            knowledge: {
                books: () => ({
                    books: [
                        { name: 'Knowledge Tracker', role: 'knowledge' },
                        { name: 'State Tracker', role: 'state' },
                    ],
                    mode: 'global',
                }),
                peek: () => ({ hydrated: true, dirty: false, version: STORE_SCHEMAS.knowledgeStore.currentVersion }),
                peekData: (name) => name === 'Knowledge Tracker'
                    ? { version: 1, quarantine: { version: 1, items: [item('knowledgeStore', {})] } }
                    : { version: 1, quarantine: { version: 1, items: [item('knowledgeStore', {}), item('knowledgeStore', {})] } },
                currentVersion: STORE_SCHEMAS.knowledgeStore.currentVersion,
            },
        }));
        expect(loaded.knowledgeStore.books.every((b) => b.hydration === 'loaded')).toBe(true);
        expect(loaded.knowledgeStore.hydration).toBe('loaded');
        // Embedded quarantine counts PER BOOK, summed into the aggregate —
        // a State-book container is no longer invisible in the totals.
        expect(loaded.knowledgeStore.books[0].quarantineCount).toBe(1);
        expect(loaded.knowledgeStore.books[1].quarantineCount).toBe(2);
        expect(loaded.knowledgeStore.quarantineCount).toBe(3);
        expect(loaded.bannerLevel).toBe('ok');
        // A loaded book counts as READY in the totals — the banner must not
        // read "0 ready" beside two healthy books. `blocked` already counted
        // failed books; `ready` used to ignore the healthy side entirely.
        expect(loaded.totals.ready).toBe(2);

        // One book failing fails the aggregate, names the book in its own
        // warning, and counts toward the blocked total — even when the
        // failing book is the State Tracker.
        const failed = collectSchemaStatusSnapshot(schemaDeps({}, {
            knowledge: {
                books: () => ({
                    books: [
                        { name: 'Knowledge Tracker', role: 'knowledge' },
                        { name: 'State Tracker', role: 'state' },
                    ],
                    mode: 'global',
                }),
                peek: (name) => name === 'State Tracker'
                    ? { hydrated: false, dirty: false, version: null }
                    : { hydrated: true, dirty: false, version: STORE_SCHEMAS.knowledgeStore.currentVersion },
                peekData: () => ({}),
                currentVersion: STORE_SCHEMAS.knowledgeStore.currentVersion,
            },
        }));
        expect(failed.knowledgeStore.hydration).toBe('failed');
        expect(failed.bannerLevel).toBe('fail');
        expect(failed.totals.blocked).toBe(1);
        // Only the healthy book counts as ready; the failed one is blocked.
        expect(failed.totals.ready).toBe(1);
        expect(failed.warnings.some((w) => w.id === 'knowledge-store-failed:State Tracker' && w.level === 'fail')).toBe(true);
        expect(failed.warnings.some((w) => w.id === 'knowledge-store-failed:Knowledge Tracker')).toBe(false);

        // Resolution degraded: one anonymous not-attempted row, never a fault.
        const early = collectSchemaStatusSnapshot(schemaDeps({}, {
            knowledge: {
                books: () => null,
                peek: () => null,
                peekData: () => ({}),
                currentVersion: STORE_SCHEMAS.knowledgeStore.currentVersion,
            },
        }));
        expect(early.knowledgeStore.hydration).toBe('not-attempted');
        expect(early.knowledgeStore.books).toHaveLength(1);
        expect(early.knowledgeStore.books[0].book).toBeNull();
    });

    test('a failed Knowledge book reports the observed on-disk version, never the blank placeholder', () => {
        // A failed slot's `version` is the blank placeholder's — an on-disk
        // v99 store must render "99 / 1" beside its pause, not "1 / 1".
        const observed = collectSchemaStatusSnapshot(schemaDeps({}, {
            knowledge: {
                books: () => ({
                    books: [
                        { name: 'Knowledge Tracker', role: 'knowledge' },
                        { name: 'State Tracker', role: 'state' },
                    ],
                    mode: 'global',
                }),
                peek: (name) => (name === 'Knowledge Tracker'
                    ? { hydrated: false, dirty: false, version: 1, fields: [], observedVersion: 99 }
                    : { hydrated: true, dirty: false, version: 1, fields: [] }),
                peekData: () => ({}),
                currentVersion: STORE_SCHEMAS.knowledgeStore.currentVersion,
            },
        }));
        const failed = observed.knowledgeStore.books.find((b) => b.book === 'Knowledge Tracker');
        expect(failed.hydration).toBe('failed');
        expect(failed.storedVersion).toBe(99);

        // Without an observed version (corrupt JSON, failed load) a failed
        // book reports null — "1 / 1" must never render from the placeholder.
        const unknowable = collectSchemaStatusSnapshot(schemaDeps({}, {
            knowledge: {
                books: () => ({
                    books: [
                        { name: 'Knowledge Tracker', role: 'knowledge' },
                        { name: 'State Tracker', role: 'state' },
                    ],
                    mode: 'global',
                }),
                peek: (name) => (name === 'Knowledge Tracker'
                    ? { hydrated: false, dirty: false, version: 1, fields: [], observedVersion: null }
                    : { hydrated: true, dirty: false, version: 1, fields: [] }),
                peekData: () => ({}),
                currentVersion: STORE_SCHEMAS.knowledgeStore.currentVersion,
            },
        }));
        expect(unknowable.knowledgeStore.books.find((b) => b.book === 'Knowledge Tracker').storedVersion).toBeNull();
    });

    test('redactSchemaStatusSnapshot returns a scrubbed copy with no shared references', () => {
        pauseStore('worldState', { reasonCode: 'future-version', message: 'paused after sk-SECRET-VALUE' });
        const snap = collectSchemaStatusSnapshot(schemaDeps({}));
        const redacted = redactSchemaStatusSnapshot(snap, { knownSecrets: ['sk-SECRET-VALUE'] });
        expect(redacted).not.toBe(snap);
        expect(JSON.stringify(redacted)).not.toContain('sk-SECRET-VALUE');
        expect(JSON.stringify(snap)).toContain('sk-SECRET-VALUE'); // input untouched
    });
});

// ─── ❤️ Health + rendering — the paused reason reaches every surface ─────────

describe('Health + Scope & storage surfaces (§5.4/§9.1)', () => {
    const healthDeps = (extra = {}) => ({
        modules: {},
        settings: {},
        allowed: () => true,
        diagnostics: { lastApiCall: () => undefined, lastRun: () => undefined },
        version: '9.9.9-test',
        now: () => 1_700_000_000_000,
        ...extra,
    });

    test('a paused module\'s Health row carries the banner\'s exact message', () => {
        pauseStore('knowledgeStore', {
            reasonCode: 'store-json-invalid',
            message: 'the tracker entry is not valid JSON. Your data was not changed.',
        });
        const snap = collectHealthSnapshot(healthDeps());
        const knowledge = snap.modules.find((m) => m.id === 'knowledge');
        expect(knowledge.paused).toMatchObject({
            store: 'knowledgeStore',
            reasonCode: 'store-json-invalid',
            message: 'the tracker entry is not valid JSON. Your data was not changed.',
        });
        // Healthy modules stay unpaused — one blocked store blocks only its own module.
        for (const other of snap.modules.filter((m) => m.id !== 'knowledge')) {
            expect(other.paused).toBeNull();
        }
    });

    test('renderHealthSnapshot paints the PAUSED badge and the banner', () => {
        pauseStore('knowledgeStore', { reasonCode: 'future-version', message: 'saved by a NEWER MWT.' });
        const html = renderHealthSnapshot(collectHealthSnapshot(healthDeps()), { formatTime: () => 'T' });
        expect(html).toContain('PAUSED');
        expect(html).toContain('Knowledge is PAUSED');
        expect(html).toContain('saved by a NEWER MWT.');
        expect(html).toContain('mwt-diag-paused');
    });

    test('renderSchemaStatusSnapshot renders the section with the paused reason and quarantine footer', () => {
        pauseStore('chronicle', { reasonCode: 'future-version', message: 'saved by a NEWER MWT.' });
        const meta = {
            [QUARANTINE_METADATA_KEY]: { version: 1, items: [item('chronicle', { id: 1 })] },
        };
        const html = renderSchemaStatusSnapshot(
            collectSchemaStatusSnapshot(schemaDeps(meta)),
            { formatTime: () => 'T' },
        );
        expect(html).toContain('Schema status');
        expect(html).toContain('saved by a NEWER MWT.');
        expect(html).toContain('1 quarantined record(s)');
        expect(html).toContain('Download recovery data');
        expect(html).toContain('read-only');
    });

    test('a quiet chat renders the ok banner and the no-quarantine footer', () => {
        const html = renderSchemaStatusSnapshot(
            collectSchemaStatusSnapshot(schemaDeps({})),
            { formatTime: () => 'T' },
        );
        expect(html).toContain('Schema status: 0 ready');
        expect(html).toContain('No quarantined records');
    });

    test('a future-version chat quarantine container warns instead of asserting absence', () => {
        const meta = { [QUARANTINE_METADATA_KEY]: { version: 99, records: { not: 'an items array' } } };
        const snap = collectSchemaStatusSnapshot(schemaDeps(meta));
        // The container's own state survives the snapshot (§5.3): unknown +
        // containerIssues are preserved instead of collapsing to items.length.
        expect(snap.chatQuarantine).toMatchObject({ present: true, items: 0, unknown: true });
        expect(snap.chatQuarantine.containerIssues).toBeGreaterThan(0);
        const warning = snap.warnings.find((w) => w.id === 'chat-quarantine-unreadable');
        expect(warning?.level).toBe('warn');
        expect(warning?.text).toContain('NEWER');
        // The rendered panel must not say "No quarantined records." — the
        // count is unavailable, not zero.
        const html = renderSchemaStatusSnapshot(snap, { formatTime: () => 'T' });
        expect(html).not.toContain('No quarantined records');
        expect(html).toContain('Quarantine count unavailable');
        expect(html).toContain('NEWER');
    });

    test('a malformed same-version container with zero readable items warns the same way', () => {
        const meta = { [QUARANTINE_METADATA_KEY]: { version: 1, items: 'not-an-array' } };
        const snap = collectSchemaStatusSnapshot(schemaDeps(meta));
        expect(snap.chatQuarantine).toMatchObject({ present: true, items: 0, unknown: false });
        expect(snap.chatQuarantine.containerIssues).toBeGreaterThan(0);
        expect(snap.warnings.some((w) => w.id === 'chat-quarantine-container-invalid' && w.level === 'warn')).toBe(true);
        const html = renderSchemaStatusSnapshot(snap, { formatTime: () => 'T' });
        expect(html).not.toContain('No quarantined records');
        expect(html).toContain('Quarantine count unavailable');
    });

    test('a malformed container with zero readable items and a NON-ZERO total qualifies the footer too', () => {
        // The Knowledge book holds records while the chat container's items
        // were ALL dropped by validation: the total is non-zero, so the
        // "N quarantined record(s)" footer renders — and must carry the same
        // caveat the future-version case gets, never assert completeness.
        const meta = { [QUARANTINE_METADATA_KEY]: { version: 1, items: 'not-an-array' } };
        const snap = collectSchemaStatusSnapshot(schemaDeps(meta, {
            knowledge: {
                books: () => ({
                    books: [
                        { name: 'Knowledge Tracker', role: 'knowledge' },
                        { name: 'State Tracker', role: 'state' },
                    ],
                    mode: 'global',
                }),
                peek: () => ({ hydrated: true, dirty: false, version: STORE_SCHEMAS.knowledgeStore.currentVersion }),
                peekData: (name) => name === 'Knowledge Tracker'
                    ? { version: 1, quarantine: { version: 1, items: [item('knowledgeStore', { bad: true })] } }
                    : { version: 1 },
                currentVersion: STORE_SCHEMAS.knowledgeStore.currentVersion,
            },
        }));
        expect(snap.totals.quarantine).toBe(1);
        const html = renderSchemaStatusSnapshot(snap, { formatTime: () => 'T' });
        // The >0-total footer — the total still shows…
        expect(html).toContain('1 quarantined record');
        // …but now qualified: the chat container's records could not be read,
        // so the total is not a complete one. Not the zero-total variant.
        expect(html).toContain('NONE of its records could be read');
        expect(html).not.toContain('Quarantine count unavailable');
    });

    test('a malformed container WITH readable records warns — the count is a known minimum, not a total', () => {
        // One valid item beside one malformed one: validation DROPPED the
        // malformed entry, so the displayed count is a lower bound the
        // snapshot must not present as complete.
        const meta = { [QUARANTINE_METADATA_KEY]: { version: 1, items: [item('chronicle', { id: 1 }), 'junk'] } };
        const snap = collectSchemaStatusSnapshot(schemaDeps(meta));
        expect(snap.chatQuarantine).toMatchObject({ present: true, items: 1, unknown: false });
        expect(snap.chatQuarantine.containerIssues).toBeGreaterThan(0);
        const warning = snap.warnings.find((w) => w.id === 'chat-quarantine-container-invalid');
        expect(warning?.level).toBe('warn');
        expect(warning?.text).toContain('known minimum');
        const html = renderSchemaStatusSnapshot(snap, { formatTime: () => 'T' });
        // The readable count still shows…
        expect(html).toContain('1 quarantined record');
        // …but the footer qualifies it as a floor, never as a complete total.
        expect(html).toContain('known minimum');
    });

    test('a fail verdict renders the FAIL banner style, not the warn one', () => {
        pauseStore('knowledgeStore', { reasonCode: 'future-version', message: 'saved by a NEWER MWT.' });
        const html = renderSchemaStatusSnapshot(
            collectSchemaStatusSnapshot(schemaDeps({})),
            { formatTime: () => 'T' },
        );
        expect(html).toContain('mwt-diag-scope-banner--fail');
        expect(html).not.toContain('mwt-diag-scope-banner--warn');
        expect(html).not.toContain('mwt-diag-scope-banner--ok');
    });

    test('renders one table row per Knowledge-store book, naming both', () => {
        const html = renderSchemaStatusSnapshot(
            collectSchemaStatusSnapshot(schemaDeps({})),
            { formatTime: () => 'T' },
        );
        expect(html).toContain('(Knowledge Tracker)');
        expect(html).toContain('State Tracker book');
        expect(html).toContain('(State Tracker)');
        // Both rows carry the store label.
        expect((html.match(/Knowledge lorebook store/g) || []).length).toBe(2);
    });
});

// ─── §5.3 — the recovery surface ──────────────────────────────────────────────

describe('backup/recovery.js (§5.3)', () => {
    test('readChatQuarantineContainer: absent, present, and malformed containers', () => {
        expect(readChatQuarantineContainer({})).toMatchObject({ present: false, items: [], containerIssues: 0 });
        const meta = {
            [QUARANTINE_METADATA_KEY]: { version: 1, items: [item('chronicle', { id: 1 })] },
        };
        expect(readChatQuarantineContainer(meta)).toMatchObject({ present: true, items: [expect.any(Object)], containerIssues: 0 });
        const broken = { [QUARANTINE_METADATA_KEY]: { version: 1, items: 'not-an-array' } };
        const read = readChatQuarantineContainer(broken);
        expect(read.present).toBe(true);
        expect(read.containerIssues).toBeGreaterThan(0);
    });

    test('collectQuarantineStatus lists per-store counts across both homes', () => {
        getFakeMeta()[QUARANTINE_METADATA_KEY] = {
            version: 1,
            items: [item('chronicle', { id: 1 }), item('chronicle', { id: 2 })],
        };
        // A hydrated book with an embedded container — the second home (§5.1).
        _setCacheForTests('Knowledge Tracker', {
            version: 1,
            registry: {},
            quarantine: { version: 1, items: [item('knowledgeStore', { bad: true })] },
        });
        const status = collectQuarantineStatus({ now: () => 1 });
        expect(status.total).toBe(3);
        const chronicle = status.stores.find((s) => s.id === 'chronicle');
        expect(chronicle).toMatchObject({ count: 2, embedded: false });
        const knowledge = status.stores.find((s) => s.id === 'knowledgeStore');
        expect(knowledge).toMatchObject({ count: 1, embedded: true });
        expect(status.knowledgeBooks).toContain('Knowledge Tracker');
    });

    test('exportRecoveryData downloads a repairable envelope with full metadata', async () => {
        const raw = { id: 'snap-1', text: 'The duke swept out of the room.' };
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 1, items: [item('chronicle', raw)] };
        // The resolved Knowledge/State books must be loaded: the export
        // inspects every currently resolved book (the unified-backup guard)
        // and refuses while any of them cannot be read.
        _setCacheForTests('Knowledge Tracker', { version: 1, registry: {} });
        _setCacheForTests('State Tracker', { version: 1, stateRegistry: {} });

        const result = await exportRecoveryData();

        expect(result.ok).toBe(true);
        expect(result.count).toBe(1);
        expect(getFakeDownloadJsonCalls()).toHaveLength(1);
        const [download] = getFakeDownloadJsonCalls();
        expect(download.filename).toMatch(/^mwt-recovery-.*\.json$/);
        // §5.3: enough metadata to repair externally and re-import through the
        // validated path — the RAW record rides along.
        expect(download.data.kind).toBe('mwt-quarantine-export');
        expect(download.data.items[0]).toMatchObject({
            store: 'chronicle',
            reasonCode: 'test-reason',
            raw,
            sourceVersion: null,
        });
        expect(typeof download.data.items[0].fingerprint).toBe('string');
        expect(getFakeNotifications().some((n) => n.title === 'MWT: recovery data downloaded')).toBe(true);
    });

    test('exportRecoveryData with zero records refuses rather than downloading an empty box', async () => {
        _setCacheForTests('Knowledge Tracker', { version: 1, registry: {} });
        _setCacheForTests('State Tracker', { version: 1, stateRegistry: {} });
        const result = await exportRecoveryData();
        expect(result).toMatchObject({ ok: false, empty: true, count: 0 });
        // The plain zero-count refusal — not one of the unreadable/invalid
        // guards, which carry their own markers.
        expect(result.unreadable).toBeUndefined();
        expect(result.invalid).toBeUndefined();
        expect(getFakeDownloadJsonCalls()).toHaveLength(0);
    });

    test('collectRecoveryItems dedupes the same record across both homes', () => {
        const shared = item('knowledgeStore', { bad: true }, 'deadbeef');
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 1, items: [shared] };
        _setCacheForTests('Knowledge Tracker', {
            version: 1,
            registry: {},
            quarantine: { version: 1, items: [{ ...shared }] },
        });
        expect(collectRecoveryItems()).toHaveLength(1);
    });

    test('clearQuarantineData refuses without the literal confirmation', async () => {
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 1, items: [item('chronicle', { id: 1 })] };
        const refused = await clearQuarantineData({ confirm: 'yes' });
        expect(refused).toMatchObject({ ok: false, reason: 'confirmation-required' });
        expect(refused.message).toContain(QUARANTINE_CLEAR_CONFIRM);
        // Nothing was touched.
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY].items).toHaveLength(1);
    });

    test('the confirmed clear empties the chat container and records the event', async () => {
        getFakeMeta()[QUARANTINE_METADATA_KEY] = {
            version: 1,
            items: [item('chronicle', { id: 1 }), item('interiority', { x: 1 })],
        };
        const result = await clearQuarantineData({ confirm: QUARANTINE_CLEAR_CONFIRM });
        expect(result).toMatchObject({ ok: true, clearedRecords: 2, chatContainerCleared: true });
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY]).toBeUndefined();
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.QUARANTINE_CLEARED)).toHaveLength(1);
    });

    test('a per-store clear keeps the other stores\' records', async () => {
        getFakeMeta()[QUARANTINE_METADATA_KEY] = {
            version: 1,
            items: [item('chronicle', { id: 1 }), item('interiority', { x: 1 })],
        };
        const result = await clearQuarantineData({ confirm: QUARANTINE_CLEAR_CONFIRM, store: 'chronicle' });
        expect(result.clearedRecords).toBe(1);
        const remaining = getFakeMeta()[QUARANTINE_METADATA_KEY].items;
        expect(remaining).toHaveLength(1);
        expect(remaining[0].store).toBe('interiority');
    });

    test('a per-store clear is REFUSED on a container a newer MWT wrote (never downgraded)', async () => {
        const future = { version: 99, items: [item('chronicle', { id: 1 })] };
        getFakeMeta()[QUARANTINE_METADATA_KEY] = future;
        const result = await clearQuarantineData({ confirm: QUARANTINE_CLEAR_CONFIRM, store: 'chronicle' });
        expect(result).toMatchObject({ ok: false, reason: 'quarantine-version-future', clearedRecords: 0 });
        // Untouched — same reference, same future version, records intact.
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY]).toBe(future);
        expect(future.version).toBe(99);
        expect(future.items).toHaveLength(1);
        // Nothing was cleared, so no event was recorded.
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.QUARANTINE_CLEARED)).toHaveLength(0);
    });

    test('a per-store clear is REFUSED when validation would drop malformed items — other stores\' records survive', async () => {
        // The container holds one canonical item plus a malformed one
        // ('junk') that canonical validation reports and OMITS: rewriting the
        // container from the canonical items would silently delete it.
        getFakeMeta()[QUARANTINE_METADATA_KEY] = {
            version: 1,
            items: [item('interiority', { x: 1 }), 'junk'],
        };
        const result = await clearQuarantineData({ confirm: QUARANTINE_CLEAR_CONFIRM, store: 'chronicle' });
        expect(result).toMatchObject({ ok: false, reason: 'quarantine-container-invalid', clearedRecords: 0 });
        expect(result.message).toContain('left unchanged');
        // The malformed raw record is still exactly where it was.
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY].items).toEqual([expect.any(Object), 'junk']);
    });

    test('the same lossy container still clears WITHOUT a store filter (delete-everything was confirmed)', async () => {
        getFakeMeta()[QUARANTINE_METADATA_KEY] = {
            version: 1,
            items: [item('chronicle', { id: 1 }), 'junk'],
        };
        const result = await clearQuarantineData({ confirm: QUARANTINE_CLEAR_CONFIRM });
        expect(result).toMatchObject({ ok: true, clearedRecords: 1, chatContainerCleared: true });
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY]).toBeUndefined();
    });

    test('a future-version chat container reads array-safe with the unknown marker', () => {
        // A newer MWT's container may not even use an `items` array —
        // validation returns it UNCHANGED (§3.5 cat 4), so the reader must
        // not assume validated.data.items exists.
        const future = { version: 99, records: [{ not: 'the items shape' }] };
        getFakeMeta()[QUARANTINE_METADATA_KEY] = future;

        const read = readChatQuarantineContainer();
        expect(read.present).toBe(true);
        expect(read.unknown).toBe(true);
        expect(Array.isArray(read.items)).toBe(true);
        expect(read.items).toHaveLength(0);
        expect(read.containerIssues).toBeGreaterThan(0);
        // The container itself is untouched — reading is not rewriting.
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY]).toBe(future);
    });

    test('status and collection tolerate the future-version container instead of throwing', () => {
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 99, records: { not: 'an items array' } };

        const status = collectQuarantineStatus({ now: () => 1 });
        expect(status.chatContainer).toMatchObject({ present: true, unknown: true, items: 0 });
        expect(status.total).toBe(0);

        expect(collectRecoveryItems()).toEqual([]);
    });

    test('export refuses honestly when the only home is an unreadable container', async () => {
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 99, records: { not: 'an items array' } };

        const result = await exportRecoveryData();
        expect(result).toMatchObject({ ok: false, empty: true, unreadable: true, count: 0 });
        expect(result.message).toContain('NEWER');
        // The refusal downloads nothing.
        expect(getFakeDownloadJsonCalls()).toHaveLength(0);
    });

    test('export also refuses when readable records exist beside the unreadable container', async () => {
        // The refusal must not depend on the readable count: Knowledge
        // quarantine records alongside a future chat container would export a
        // file that looks complete while silently omitting the unreadable
        // records — the §5.3 contract says EVERY quarantined record is
        // included, so nothing is downloaded at all.
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 99, records: { not: 'an items array' } };
        _setCacheForTests('Knowledge Tracker', {
            version: 1,
            registry: {},
            quarantine: { version: 1, items: [item('knowledgeStore', { bad: true })] },
        });

        const result = await exportRecoveryData();
        expect(result).toMatchObject({ ok: false, empty: true, unreadable: true, count: 0 });
        // The refusal names the held-back readable records — it must never
        // read as "nothing was rejected".
        expect(result.message).toContain('NEWER');
        expect(result.message).toContain('1 readable quarantined record');
        expect(getFakeDownloadJsonCalls()).toHaveLength(0);
    });

    test('export refuses on a malformed chat container that still has readable records — the file would look complete', async () => {
        // One canonical item plus a malformed one ('junk'): canonical
        // validation reports and DROPS the malformed item, so the export
        // would carry 1 record while presenting itself as complete.
        _setCacheForTests('Knowledge Tracker', { version: 1, registry: {} });
        _setCacheForTests('State Tracker', { version: 1, stateRegistry: {} });
        getFakeMeta()[QUARANTINE_METADATA_KEY] = {
            version: 1,
            items: [item('chronicle', { id: 1 }), 'junk'],
        };

        const result = await exportRecoveryData();
        expect(result).toMatchObject({ ok: false, empty: true, invalid: true, count: 0 });
        expect(result.message).toContain('malformed');
        // The held-back readable records are named — never "nothing was rejected".
        expect(result.message).toContain('1 readable quarantined record');
        expect(getFakeDownloadJsonCalls()).toHaveLength(0);
        // The UI wording owner surfaces it as an error, never the info line.
        const described = describeRecoveryExportResult(result);
        expect(described.tone).toBe('error');
        expect(described.message).toContain('malformed');
    });

    test('export refuses on an all-malformed chat container instead of reporting "nothing was rejected"', async () => {
        _setCacheForTests('Knowledge Tracker', { version: 1, registry: {} });
        _setCacheForTests('State Tracker', { version: 1, stateRegistry: {} });
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 1, items: 'not-an-array' };

        const result = await exportRecoveryData();
        expect(result).toMatchObject({ ok: false, empty: true, invalid: true, count: 0 });
        expect(result.message).toContain('malformed');
        expect(getFakeDownloadJsonCalls()).toHaveLength(0);
    });

    test('export refuses while a resolved book\'s store cannot load — completeness over optimism', async () => {
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 1, items: [item('chronicle', { id: 1 })] };
        // The export hydrates first now (see the next test), so "un-hydrated"
        // alone no longer refuses it. Force the load to GENUINELY fail: no
        // world-info module at all (the tried-and-failed state), so both
        // books stay un-hydrated no matter how often the export retries.
        state.wiScript = null;

        const result = await exportRecoveryData();
        expect(result).toMatchObject({ ok: false, empty: true, unreadable: true, count: 0 });
        expect(result.blockedBooks.map((b) => b.book)).toEqual(['Knowledge Tracker', 'State Tracker']);
        expect(result.message).toContain('not loaded');
        // The readable chat records are held back and named, never exported alone.
        expect(result.message).toContain('1 readable quarantined record');
        expect(getFakeDownloadJsonCalls()).toHaveLength(0);
    });

    test('export refuses when a book is blocked by a future STORE version — its embedded records are invisible', async () => {
        const wi = makeFakeWorldInfo();
        state.wiScript = wi;
        wi.books.set('Knowledge Tracker', {
            entries: {
                0: {
                    uid: 0, comment: STORE_COMMENT, key: [], disable: true,
                    content: JSON.stringify({ version: 99, registry: {} }),
                },
            },
        });
        // The blocked hydration leaves the book un-hydrated (and pauses the
        // store) — exactly the state collection cannot see through.
        await hydrateBook('Knowledge Tracker', {});
        expect(isHydrated('Knowledge Tracker')).toBe(false);
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 1, items: [item('chronicle', { id: 1 })] };

        const result = await exportRecoveryData();
        expect(result).toMatchObject({ ok: false, empty: true, unreadable: true, count: 0 });
        expect(result.blockedBooks.some((b) => b.book === 'Knowledge Tracker')).toBe(true);
        expect(result.message).toContain('Knowledge Tracker');
        expect(getFakeDownloadJsonCalls()).toHaveLength(0);
    });

    test('the export hydrates first in the post-chat-switch window instead of falsely refusing', async () => {
        // reloadStores('chat change') is deliberately fire-and-forget, so
        // right after a switch both books are un-hydrated while their loads
        // are still in flight — and treating that transient window as a
        // blocker refused every export issued in it ("a load that has not
        // finished yet"). Both books exist and are readable, so the export
        // must hydrate them itself and proceed (the backup/collect.js
        // pattern) rather than demand a retry.
        wiFake = makeFakeWorldInfo();
        state.wiScript = wiFake;
        setBookStore('Knowledge Tracker', {
            version: STORE_VERSION,
            registry: {},
            quarantine: { version: 1, items: [item('knowledgeStore', { bad: true })] },
        });
        setBookStore('State Tracker', { version: STORE_VERSION, stateRegistry: {} });
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 1, items: [item('chronicle', { id: 1 })] };
        // No cache slots — exactly the state the chat switch leaves behind.
        expect(isHydrated('Knowledge Tracker')).toBe(false);
        expect(isHydrated('State Tracker')).toBe(false);

        const result = await exportRecoveryData();

        // The export's hydrate-first step loaded both books itself…
        expect(isHydrated('Knowledge Tracker')).toBe(true);
        expect(isHydrated('State Tracker')).toBe(true);
        // …so the completeness guard found every home readable and proceeded.
        expect(result.ok).toBe(true);
        expect(result.count).toBe(2);
        expect(getFakeDownloadJsonCalls()).toHaveLength(1);
    });

    test('a CHARACTER scope export covers the character\'s own books, never the global ones', async () => {
        // Regression for the resolver's identity source: the pre-move home
        // fed the explainer core/scope.js identities — whose
        // getCharacterIdentity requires a ctx argument (called with none it
        // returned null → fallback-global) and whose getChatIdentity returns
        // {chatId,…} with no .key/.name. Under character scope that resolved
        // the GLOBAL books, which this chat never hydrates — the export would
        // have refused forever. The scoped books must be the ones inspected.
        saveSettings({ scope: 'character' });
        setFakeContextExtras({
            characterId: 0,
            characters: [{ name: 'Seraphina', avatar: 'sera.png' }],
        });
        // The character's derived books, hydrated and holding a record…
        _setCacheForTests('Knowledge Tracker - Seraphina', {
            version: 1,
            registry: {},
            quarantine: { version: 1, items: [item('knowledgeStore', { bad: true })] },
        });
        _setCacheForTests('State Tracker - Seraphina', { version: 1, stateRegistry: {} });
        // …while the GLOBAL books deliberately have NO cache slot: the old,
        // mis-resolved path would have blocked on them and refused.
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 1, items: [item('chronicle', { id: 1 })] };

        const result = await exportRecoveryData();

        expect(result.ok).toBe(true);
        expect(result.count).toBe(2);
        expect(result.blockedBooks).toBeUndefined();
        expect(getFakeDownloadJsonCalls()).toHaveLength(1);
    });

    test('export refuses when a hydrated book\'s embedded container was written by a newer MWT', async () => {
        _setCacheForTests('Knowledge Tracker', {
            version: 1,
            registry: {},
            quarantine: { version: 99, items: [item('knowledgeStore', { bad: true })] },
        });
        _setCacheForTests('State Tracker', { version: 1, stateRegistry: {} });

        const result = await exportRecoveryData();
        expect(result).toMatchObject({ ok: false, empty: true, unreadable: true, count: 0 });
        expect(result.blockedBooks).toEqual([
            { book: 'Knowledge Tracker', role: 'knowledge', reason: 'quarantine-version-future' },
        ]);
        expect(result.message).toContain('NEWER');
        expect(getFakeDownloadJsonCalls()).toHaveLength(0);
    });

    test('status names resolved books whose embedded records cannot be seen (knowledgeBookBlocks)', () => {
        _setCacheForTests('Knowledge Tracker', { version: 1, registry: {} });

        const status = collectQuarantineStatus({ now: () => 1 });
        expect(status.knowledgeBookBlocks.map((b) => b.book)).toEqual(['State Tracker']);
        expect(status.knowledgeBookBlocks[0].reason).toBe('store-not-hydrated');
    });

    test('the unfiltered clear removes a future-version container whole, without parsing it', async () => {
        const future = { version: 99, records: { not: 'an items array' } };
        getFakeMeta()[QUARANTINE_METADATA_KEY] = future;

        const result = await clearQuarantineData({ confirm: QUARANTINE_CLEAR_CONFIRM });
        expect(result).toMatchObject({ ok: true, chatContainerCleared: true });
        expect(getFakeMeta()[QUARANTINE_METADATA_KEY]).toBeUndefined();
    });
});

// ─── The one wording owner for both export buttons (§5.3/§5.4) ───────────────

describe('describeRecoveryExportResult', () => {
    test('an unreadable refusal surfaces its message as an error', () => {
        const { message, tone } = describeRecoveryExportResult({
            ok: false, empty: true, unreadable: true, exportedAt: 1, count: 0,
            message: 'Refused: the chat recovery container was written by a NEWER version of MWT.',
        });
        expect(tone).toBe('error');
        expect(message).toContain('NEWER');
    });

    test('an unreadable refusal without a message still fails loudly', () => {
        const { message, tone } = describeRecoveryExportResult({ ok: false, unreadable: true });
        expect(tone).toBe('error');
        expect(message).toContain('Refused');
    });

    test('a malformed-container refusal (invalid) surfaces its message as an error', () => {
        const { message, tone } = describeRecoveryExportResult({
            ok: false, empty: true, invalid: true, exportedAt: 1, count: 0,
            message: 'Refused: the chat recovery container is malformed.',
        });
        expect(tone).toBe('error');
        expect(message).toContain('malformed');
    });

    test('a plain empty result stays the info "nothing was rejected" line', () => {
        const { message, tone } = describeRecoveryExportResult({ ok: false, empty: true, count: 0 });
        expect(tone).toBe('info');
        expect(message).toContain('No quarantined records to export');
    });

    test('a successful export stays the success line', () => {
        const { message, tone } = describeRecoveryExportResult({ ok: true, count: 3 });
        expect(tone).toBe('success');
        expect(message).toContain('3 quarantined record(s)');
    });
});

// ─── The live wiring: Knowledge hydration pauses and resumes ─────────────────

/** Fake world-info (the knowledge_store_hydration.test.js contract). */
function makeFakeWorldInfo() {
    const books = new Map();
    return {
        books,
        async loadWorldInfo(name) {
            return books.has(name) ? structuredClone(books.get(name)) : null;
        },
        async saveWorldInfo(name, wi) {
            books.set(name, structuredClone(wi));
        },
        async createNewWorldInfo(name) {
            books.set(name, { entries: {} });
            return true;
        },
    };
}

let wiFake;

/** Install a store entry with the given data in a fake book. */
function setBookStore(bookName, data) {
    wiFake.books.set(bookName, {
        entries: {
            0: {
                uid: 0, comment: STORE_COMMENT, key: [], disable: true,
                content: JSON.stringify({ ...data }),
            },
        },
    });
}

describe('Knowledge hydration pause wiring (the live blocked paths)', () => {
    beforeEach(() => {
        wiFake = makeFakeWorldInfo();
        state.wiScript = wiFake;
    });

    test('a future-version store pauses knowledgeStore with the banner\'s reason', async () => {
        setBookStore(LOREBOOK_NAME, { version: 99, registry: { Mara: { uid: 1 } } });

        await hydrateBook(LOREBOOK_NAME, {});

        expect(isHydrated(LOREBOOK_NAME)).toBe(false);
        const pause = getPauseState('knowledgeStore');
        expect(pause).toMatchObject({
            module: 'knowledge',
            reasonCode: 'future-version',
            version: 99,
        });
        expect(pause.message).toContain('NEWER version of MWT');
        // The §9.3 events: the preparation event (module knowledge) AND the
        // pause transition (module schema).
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.BLOCKED_FUTURE_VERSION)).toHaveLength(1);
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.STORE_PAUSED)).toHaveLength(1);
        // The banner is live for the module's own tab.
        expect(renderPausedStoresBanner('knowledge')).toContain('Knowledge is paused');
    });

    test('a corrupt store entry pauses with store-json-invalid', async () => {
        wiFake.books.set(LOREBOOK_NAME, {
            entries: {
                0: { uid: 0, comment: STORE_COMMENT, key: [], disable: true, content: '{not json' },
            },
        });

        await hydrateBook(LOREBOOK_NAME, {});

        expect(isHydrated(LOREBOOK_NAME)).toBe(false);
        expect(getPauseState('knowledgeStore')).toMatchObject({ reasonCode: 'store-json-invalid' });
    });

    test('a failed future-version hydration preserves the observed on-disk version on the slot', async () => {
        setBookStore(LOREBOOK_NAME, { version: 99, registry: { Mara: { uid: 1 } } });

        await hydrateBook(LOREBOOK_NAME, {});

        const peek = peekStore(LOREBOOK_NAME);
        expect(peek.hydrated).toBe(false);
        // `version` is the blank placeholder's (the blocked source is never
        // adopted into the cache); observedVersion is what was on disk.
        expect(peek.version).toBe(STORE_VERSION);
        expect(peek.observedVersion).toBe(99);
    });

    test('a corrupt-JSON failure reports observedVersion null — the version could not be read', async () => {
        wiFake.books.set(LOREBOOK_NAME, {
            entries: {
                0: { uid: 0, comment: STORE_COMMENT, key: [], disable: true, content: '{not json' },
            },
        });

        await hydrateBook(LOREBOOK_NAME, {});

        expect(peekStore(LOREBOOK_NAME).hydrated).toBe(false);
        expect(peekStore(LOREBOOK_NAME).observedVersion).toBeNull();
    });

    test('a successful load clears the observed version — the canonical version is live again', async () => {
        setBookStore(LOREBOOK_NAME, { version: 99, registry: {} });
        await hydrateBook(LOREBOOK_NAME, {});
        expect(peekStore(LOREBOOK_NAME).observedVersion).toBe(99);

        // Repair the book on disk and retry: the slot hydrates and the
        // failure breadcrumb must not survive the successful load.
        setBookStore(LOREBOOK_NAME, { version: STORE_VERSION, registry: { Mara: { uid: 1 } } });
        await hydrateBook(LOREBOOK_NAME, {});
        const peek = peekStore(LOREBOOK_NAME);
        expect(peek.hydrated).toBe(true);
        expect(peek.observedVersion).toBeNull();
        expect(peek.version).toBe(STORE_VERSION);
    });

    test('the live snapshot shows the observed version beside the pause — never the placeholder', async () => {
        setBookStore(LOREBOOK_NAME, { version: 99, registry: {} });
        setBookStore(STATE_LOREBOOK_NAME, { version: STORE_VERSION, stateRegistry: {} });
        await hydrateBook(LOREBOOK_NAME, {});
        await hydrateBook(STATE_LOREBOOK_NAME, {});

        // Default deps — the real read-only resolver + real peekStore: an
        // on-disk v99 Knowledge book renders "99 / 1" beside its pause, not
        // the blank placeholder's "1 / 1".
        const snap = collectSchemaStatusSnapshot();
        const row = snap.knowledgeStore.books.find((b) => b.book === LOREBOOK_NAME);
        expect(row.hydration).toBe('failed');
        expect(row.storedVersion).toBe(99);
        expect(snap.knowledgeStore.paused).toMatchObject({ reasonCode: 'future-version' });
        const html = renderSchemaStatusSnapshot(snap, { formatTime: () => 'T' });
        expect(html).toContain('99 / 1');
    });

    test('a later successful load of BOTH books resumes the store (§5.4)', async () => {
        setBookStore(LOREBOOK_NAME, { version: 99, registry: {} });
        setBookStore(STATE_LOREBOOK_NAME, { version: 1, stateRegistry: {} });
        await hydrateBook(LOREBOOK_NAME, {});
        expect(getPauseState('knowledgeStore')).not.toBeNull();

        // The data is fixed out-of-band, then the books reload.
        setBookStore(LOREBOOK_NAME, { version: 1, registry: { Mara: { uid: 1 } } });
        await hydrateCurrentBooks();

        expect(isHydrated(LOREBOOK_NAME)).toBe(true);
        expect(isHydrated(STATE_LOREBOOK_NAME)).toBe(true);
        expect(getPauseState('knowledgeStore')).toBeNull();
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.STORE_RESUMED)).toHaveLength(1);
        expect(renderPausedStoresBanner('knowledge')).toBe('');
    });

    test('one book hydrating must not clear the OTHER book\'s pause', async () => {
        setBookStore(LOREBOOK_NAME, { version: 99, registry: {} }); // blocked
        setBookStore(STATE_LOREBOOK_NAME, { version: 1, stateRegistry: {} });
        await hydrateBook(LOREBOOK_NAME, {});
        expect(getPauseState('knowledgeStore')).not.toBeNull();

        // The healthy State book hydrates alone — the pause must survive.
        await hydrateBook(STATE_LOREBOOK_NAME, {});
        expect(isHydrated(STATE_LOREBOOK_NAME)).toBe(true);
        expect(getPauseState('knowledgeStore')).not.toBeNull();
    });

    test('peekStoreData hands back a deep copy — a consumer cannot mutate the cache', async () => {
        setBookStore(LOREBOOK_NAME, { version: 1, registry: { Mara: { uid: 1 } } });
        await hydrateBook(LOREBOOK_NAME, {});

        const copy = peekStoreData(LOREBOOK_NAME);
        copy.registry.Mara.uid = 999;
        expect(peekStore(LOREBOOK_NAME).version).toBe(1);
        expect(peekStoreData(LOREBOOK_NAME).registry.Mara.uid).toBe(1);
        expect(getHydratedBooks()).toContain(LOREBOOK_NAME);
    });

    test('clearStoreQuarantine empties a hydrated book\'s embedded container', async () => {
        setBookStore(LOREBOOK_NAME, { version: 1, registry: { g: 'junk' } });
        await hydrateBook(LOREBOOK_NAME, {});
        expect(getStoreQuarantineItems(LOREBOOK_NAME)).toHaveLength(1);

        const result = await clearStoreQuarantine(LOREBOOK_NAME);
        expect(result).toMatchObject({ ok: true, cleared: true });
        expect(getStoreQuarantineItems(LOREBOOK_NAME)).toHaveLength(0);
    });

    test('clearStoreQuarantine rolls the cache back when the flush fails — records survive', async () => {
        setBookStore(LOREBOOK_NAME, { version: 1, registry: { g: 'junk' } });
        await hydrateBook(LOREBOOK_NAME, {});
        expect(getStoreQuarantineItems(LOREBOOK_NAME)).toHaveLength(1);

        // The next save of this book fails (the request is rejected).
        const baseSave = wiFake.saveWorldInfo.bind(wiFake);
        let failing = true;
        wiFake.saveWorldInfo = async (name, wi) => {
            if (failing) throw new Error('save rejected');
            await baseSave(name, wi);
        };

        const result = await clearStoreQuarantine(LOREBOOK_NAME);
        expect(result).toMatchObject({ ok: false, reason: 'flush-failed', cleared: false });
        // The live cache still reports the records — a recovery export run
        // after the failed clear must see them, not an empty container.
        expect(getStoreQuarantineItems(LOREBOOK_NAME)).toHaveLength(1);

        // And a later flush must not persist the deletion: the rolled-back
        // slot is clean, so nothing re-writes the emptied container.
        failing = false;
        const { flushAll } = await import('../knowledge/store.js');
        await flushAll();
        const entry = Object.values(wiFake.books.get(LOREBOOK_NAME).entries)
            .find((e) => typeof e?.comment === 'string' && e.comment.startsWith(STORE_SENTINEL));
        expect(JSON.parse(entry.content).quarantine.items).toHaveLength(1);
    });

    test('clearStoreQuarantine preserves a concurrent write that lands during its failed flush', async () => {
        setBookStore(LOREBOOK_NAME, { version: 1, registry: { g: 'junk' } });
        await hydrateBook(LOREBOOK_NAME, {});
        expect(getStoreQuarantineItems(LOREBOOK_NAME)).toHaveLength(1);

        // The clear's flush fails, and while it is in flight an ordinary
        // writeField() lands on ANOTHER field of the same book — withStoreLock
        // serializes lock users, not synchronous writes.
        const baseSave = wiFake.saveWorldInfo.bind(wiFake);
        let failing = true;
        wiFake.saveWorldInfo = async (name, wi) => {
            if (failing) {
                writeField(LOREBOOK_NAME, 'relationships', { Mara: { Bren: 'allies' } });
                throw new Error('save rejected');
            }
            await baseSave(name, wi);
        };

        const result = await clearStoreQuarantine(LOREBOOK_NAME);
        expect(result).toMatchObject({ ok: false, reason: 'flush-failed', cleared: false });

        // The interleaved write survived the rollback and is still DIRTY —
        // not stranded in memory marked clean, which a reload would lose.
        expect(peekStoreData(LOREBOOK_NAME).relationships).toEqual({ Mara: { Bren: 'allies' } });
        expect(peekStore(LOREBOOK_NAME).dirty).toBe(true);

        // So the next flush persists it — together with the rolled-back
        // quarantine records, which must still be there.
        failing = false;
        const { flushAll } = await import('../knowledge/store.js');
        await flushAll();
        const entry = Object.values(wiFake.books.get(LOREBOOK_NAME).entries)
            .find((e) => typeof e?.comment === 'string' && e.comment.startsWith(STORE_SENTINEL));
        expect(JSON.parse(entry.content).relationships).toEqual({ Mara: { Bren: 'allies' } });
        expect(JSON.parse(entry.content).quarantine.items).toHaveLength(1);
    });

    test('a hydration failure that lands after a chat switch does NOT pause the new chat', async () => {
        // The book load stalls; while it is pending the chat switches and the
        // cache is reset — the slot this hydration captured is retired. When
        // the OLD book's load then fails, the failure must be abandoned, not
        // paused: the pause registry is scope-keyed and would notify the NEW
        // chat about a book it no longer reads.
        let releaseLoad;
        let announceEntry;
        const entered = new Promise((resolve) => { announceEntry = resolve; });
        const gate = new Promise((resolve) => { releaseLoad = resolve; });
        wiFake.loadWorldInfo = async () => {
            announceEntry();
            await gate;
            throw new Error('load exploded');
        };

        const pending = hydrateBook(LOREBOOK_NAME, {});
        await entered;              // the hydration is parked on the load
        _clearCacheForTests();      // the chat switch retires the slot mid-IO
        releaseLoad();
        await pending;

        expect(isHydrated(LOREBOOK_NAME)).toBe(false);
        expect(getPauseState('knowledgeStore')).toBeNull();
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.STORE_PAUSED)).toHaveLength(0);
        expect(notifyEvents()).toHaveLength(0);
        expect(eventsOf('schema_hydration_abandoned')).toHaveLength(1);
    });

    test('a stale corrupt-JSON hydration is abandoned the same way — no pause, no notify', async () => {
        wiFake.books.set(LOREBOOK_NAME, {
            entries: {
                0: { uid: 0, comment: STORE_COMMENT, key: [], disable: true, content: '{not json' },
            },
        });
        let releaseLoad;
        let announceEntry;
        const entered = new Promise((resolve) => { announceEntry = resolve; });
        const gate = new Promise((resolve) => { releaseLoad = resolve; });
        const baseLoad = wiFake.loadWorldInfo.bind(wiFake);
        wiFake.loadWorldInfo = async (name) => {
            announceEntry();
            await gate;
            return baseLoad(name);
        };

        const pending = hydrateBook(LOREBOOK_NAME, {});
        await entered;
        _clearCacheForTests();      // the chat switch retires the slot mid-IO
        releaseLoad();
        await pending;

        expect(getPauseState('knowledgeStore')).toBeNull();
        expect(eventsOf('schema_hydration_abandoned')).toHaveLength(1);
    });

    test('a failure in the epoch window before the cache reset does NOT pause the new chat', async () => {
        // CHAT_CHANGED bumps the scope epoch synchronously;
        // resetStoreCache() only clears the cache once it acquires the store
        // lock. In that window the captured slot still looks current, so only
        // the scope capture says this failure belongs to the OLD chat — the
        // pause registry is scope-keyed and would notify the NEW one.
        let releaseLoad;
        let announceEntry;
        const entered = new Promise((resolve) => { announceEntry = resolve; });
        const gate = new Promise((resolve) => { releaseLoad = resolve; });
        wiFake.loadWorldInfo = async () => {
            announceEntry();
            await gate;
            throw new Error('load exploded');
        };

        const pending = hydrateBook(LOREBOOK_NAME, {});
        await entered;              // the hydration is parked on the load
        bumpEpoch();                // the switch fired; the reset is still queued
        releaseLoad();
        await pending;

        expect(isHydrated(LOREBOOK_NAME)).toBe(false);
        expect(getPauseState('knowledgeStore')).toBeNull();
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.STORE_PAUSED)).toHaveLength(0);
        expect(notifyEvents()).toHaveLength(0);
        expect(eventsOf('schema_hydration_abandoned')).toHaveLength(1);
    });
});

// ─── The report carries the schema-status section (§9.3 safe output) ─────────

describe('collectReportSections includes the schema-status section', () => {
    test('the section exists alongside the other tab accessors', async () => {
        const { collectReportSections } = await import('../diagnostics_panel/report.js');
        const sections = await collectReportSections();
        const ids = sections.map((s) => s.id);
        expect(ids).toContain('schemaStatus');
        expect(ids).toContain('scope');
        expect(ids).toContain('integrity');
    });
});




