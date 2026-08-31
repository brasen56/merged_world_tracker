/**
 * test/schema_runtime_gate.test.js — Schema plan Part 6: the runtime
 * chat-metadata cutover (design §7).
 *
 * Layers under test:
 *   1. schema/runtime.js — the synchronous fast load gate on startup and chat
 *      change (§7.1/§7.4): migration + manifest stamp + quarantine additions
 *      committed in ONE save (§7.3), per-store blocking, and the §7.5
 *      privileged preparation for deferred Interiority.
 *   2. core/event_router.js + the write/injection seams — a paused store's
 *      module declines its own work while every other module keeps running.
 *   3. The lazy-migration retirements: Chronicle's getSnapshots() and Story
 *      Planner's getArcs() never persist from a read path anymore.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// The module under test + its seams.
import {
    applySchemaLoadGate,
    runSchemaPreparations,
    registerSchemaGateRetryHandlers,
    _resetSchemaRuntime,
} from '../schema/runtime.js';
import {
    SCHEMA_DIAGNOSTIC_EVENTS,
    pauseStore,
    getPauseState,
    isStorePausedForCurrentScope,
    isModulePausedForCurrentScope,
    isStoreWriteBlocked,
    beginPrivilegedPreparation,
    endPrivilegedPreparation,
    retryStore,
    setStoreResumeInitializer,
    _setScopeKeyResolver,
    _resetPausedStores,
} from '../core/schema_status.js';
import { _resetDiagnostics, getEvents } from '../core/diagnostics.js';
import { bumpEpoch, _resetEpoch } from '../core/scope.js';
import { CHAT_METADATA_SCHEMA_IDS, STORE_SCHEMAS } from '../schema/registry.js';
import { MANIFEST_METADATA_KEY, MANIFEST_VERSION } from '../schema/manifest.js';
import { QUARANTINE_METADATA_KEY } from '../core/quarantine.js';
import {
    routeMessageReceived,
    routeMessageDeleted,
} from '../core/event_router.js';
import { setChronicleDataChecked, getSnapshots } from '../chronicle/data.js';
import { getArcs } from '../story_planner/data.js';
import { saveInteriorityData } from '../interiority/data.js';

// The stubbed barrel seam (fake chat metadata lives here).
import { resetCoreStubs, setFakeChat, getFakeMeta } from './stubs/core.js';

// ─── Shared helpers ───────────────────────────────────────────────────────────

const eventsOf = (name) => getEvents().filter((e) => e.event === name);
const scope = (key) => _setScopeKeyResolver(() => key);

/** Metadata keys by store id, straight from the registry. */
const KEY = Object.fromEntries(
    CHAT_METADATA_SCHEMA_IDS.map(id => [id, STORE_SCHEMAS[id].metadataKey]),
);

/** A v1-ready manifest with the given ids stamped current. */
const stampedManifest = (ids) => ({
    manifestVersion: MANIFEST_VERSION,
    sections: Object.fromEntries(ids.map(id => [id, STORE_SCHEMAS[id].currentVersion])),
});

/** A persist spy that snapshots chat metadata AT the moment of the save. */
function persistSpy() {
    const calls = [];
    const fn = vi.fn(() => {
        calls.push(JSON.parse(JSON.stringify(getFakeMeta())));
    });
    return { fn, calls };
}

beforeEach(() => {
    resetCoreStubs();
    _resetEpoch();
    _resetDiagnostics();
    _resetPausedStores();
    _resetSchemaRuntime();
    scope('chat:part6');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    _resetPausedStores();
    _resetSchemaRuntime();
    _setScopeKeyResolver(null);
});

/** One legacy (v0) chat: every store present at legacy version 0. */
function legacyChatMeta() {
    return {
        [KEY.worldState]: { text: 'The market smells of rain.' },
        [KEY.chronicle]: { snapshots: [{ text: 's1', createdAt: '2026-01-01' }] },
        [KEY.knowledgeEvidence]: { Mara: { npc: 'Mara', raw: [], consolidated: [], meta: {} } },
        [KEY.knowledgeCounters]: { messageCounter: 3 },
        [KEY.storyPlanner]: { text: '## Immediate Hooks\n- [x] One arc title\n  body' },
        [KEY.interiority]: {
            enabled: true, ledger: [], deletedIntentions: [], turnCounter: 0,
            perMessage: {}, // canonical keys only — no §7.5 deferral in this fixture
        },
    };
}

// ─── §7.1/§7.3/§7.4 — the synchronous gate ───────────────────────────────────

describe('applySchemaLoadGate — startup and chat change (§7.4)', () => {
    test('initial startup prepares every legacy store before module injection (§7.1)', () => {
        Object.assign(getFakeMeta(), legacyChatMeta());
        const { fn } = persistSpy();

        const result = applySchemaLoadGate({ persist: fn });

        expect(result.ran).toBe(true);
        expect(result.persisted).toBe(true);
        // Every present store migrated 0 → 1 and stamped.
        const meta = getFakeMeta();
        expect(meta[MANIFEST_METADATA_KEY]).toEqual(stampedManifest(CHAT_METADATA_SCHEMA_IDS));
        for (const id of CHAT_METADATA_SCHEMA_IDS) {
            expect(result.stores[id].action, id).toBe('migrated');
            expect(result.stores[id].version).toBe(STORE_SCHEMAS[id].currentVersion);
        }
        // The committed value is the canonical migration product (chronicle's
        // trash container defaulted, story planner's text parsed into arcs…).
        expect(Array.isArray(meta[KEY.storyPlanner].arcs)).toBe(true);
        expect(Array.isArray(meta[KEY.chronicle]._deletedBin)).toBe(true);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('data, manifest, and quarantine commit in the SAME single save (§7.3)', () => {
        const meta = getFakeMeta();
        // A chronicle v0 whose invalid snapshot gets quarantined out by the
        // canonicalization — recovery data must ride the same save.
        meta[KEY.chronicle] = { snapshots: [{ text: 'ok', createdAt: 't' }, 'NOT-A-SNAPSHOT'] };
        meta[KEY.worldState] = { text: 'x' };
        const { fn, calls } = persistSpy();

        applySchemaLoadGate({ persist: fn });

        expect(fn).toHaveBeenCalledTimes(1);
        const saved = calls[0];
        // At the moment of THE save: stamped manifest + migrated data + the
        // quarantine container all present together — never a manifest stamp
        // racing ahead of its data.
        expect(saved[MANIFEST_METADATA_KEY].sections.chronicle).toBe(1);
        expect(saved[MANIFEST_METADATA_KEY].sections.worldState).toBe(1);
        expect(Array.isArray(saved[QUARANTINE_METADATA_KEY]?.items)).toBe(true);
        expect(saved[QUARANTINE_METADATA_KEY].items.length).toBeGreaterThan(0);
        expect(saved[QUARANTINE_METADATA_KEY].items[0].store).toBe('chronicle');
        // And the canonical store no longer carries the rejected record.
        expect(saved[KEY.chronicle].snapshots).toHaveLength(1);
    });

    test('a READY chat (stamped + canonical) writes nothing — the fast path adds no save (§7.2)', () => {
        const meta = getFakeMeta();
        meta[MANIFEST_METADATA_KEY] = stampedManifest(['chronicle']);
        meta[KEY.chronicle] = { snapshots: [{ id: 's1', text: 'ok', createdAt: 't' }], _deletedBin: [] };
        const { fn } = persistSpy();

        const result = applySchemaLoadGate({ persist: fn });

        expect(result.persisted).toBe(false);
        expect(fn).not.toHaveBeenCalled();
        expect(result.stores.chronicle.action).toBe('ready');
        expect(result.stores.chronicle.version).toBe(1);
        // Absent stores stay absent — never manufactured to be stamped (§3.3).
        expect(meta[KEY.worldState]).toBeUndefined();
        expect(result.stores.worldState.reason).toBe('absent');
        expect(meta[MANIFEST_METADATA_KEY].sections.worldState).toBeUndefined();
    });

    test('the gate is SYNCHRONOUS — CHAT_CHANGED gains no await (§7.4)', () => {
        Object.assign(getFakeMeta(), legacyChatMeta());
        // The call returns a plain summary object, never a promise, and the
        // migration commit has already landed by the time it returns.
        const result = applySchemaLoadGate({ persist: () => {} });
        expect(result instanceof Promise).toBe(false);
        expect(typeof result.then).toBe('undefined');
        expect(getFakeMeta()[MANIFEST_METADATA_KEY].sections.chronicle).toBe(1);
    });

    test('a future-version store pauses ONLY its module; the other stores still commit', () => {
        const meta = getFakeMeta();
        meta[MANIFEST_METADATA_KEY] = { manifestVersion: 1, sections: { chronicle: 99 } };
        meta[KEY.chronicle] = { snapshots: [] };
        meta[KEY.worldState] = { text: 'x' };
        const originalChronicle = meta[KEY.chronicle];
        const { fn } = persistSpy();

        const result = applySchemaLoadGate({ persist: fn });

        // Chronicle: refused untouched, paused with the future-version reason.
        expect(result.stores.chronicle.action).toBe('blocked');
        expect(meta[KEY.chronicle]).toBe(originalChronicle);
        const pause = getPauseState('chronicle');
        expect(pause).toMatchObject({ store: 'chronicle', reasonCode: 'future-version', version: 99 });
        expect(pause.message).toContain('NEWER version of MWT');
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.BLOCKED_FUTURE_VERSION)).toHaveLength(1);
        // The OTHER module kept running: world state migrated and stamped.
        expect(result.stores.worldState.action).toBe('migrated');
        expect(meta[MANIFEST_METADATA_KEY].sections.worldState).toBe(1);
        expect(meta[MANIFEST_METADATA_KEY].sections.chronicle).toBe(99); // untouched
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('a manifest from a NEWER MWT pauses every present store and stamps nothing', () => {
        const meta = getFakeMeta();
        const futureManifest = { manifestVersion: MANIFEST_VERSION + 1, sections: { chronicle: 1 } };
        meta[MANIFEST_METADATA_KEY] = futureManifest;
        meta[KEY.chronicle] = { snapshots: [] };
        meta[KEY.worldState] = { text: 'x' };
        const { fn } = persistSpy();

        const result = applySchemaLoadGate({ persist: fn });

        expect(result.manifestFromFuture).toBe(true);
        expect(result.stores.chronicle.action).toBe('unknown');
        expect(result.stores.worldState.action).toBe('unknown');
        for (const id of ['chronicle', 'worldState']) {
            expect(getPauseState(id).reasonCode).toBe('manifest-from-future');
        }
        // Refused unchanged: no migration, no stamp, no save.
        expect(meta[MANIFEST_METADATA_KEY]).toBe(futureManifest);
        expect(meta[KEY.worldState]).toEqual({ text: 'x' });
        expect(fn).not.toHaveBeenCalled();
    });

    test('an unreadable root blocks the store untouched (fatal-root policy)', () => {
        const meta = getFakeMeta();
        meta[KEY.worldState] = 'CORRUPT ROOT';
        const { fn } = persistSpy();

        const result = applySchemaLoadGate({ persist: fn });

        expect(result.stores.worldState.action).toBe('blocked');
        expect(meta[KEY.worldState]).toBe('CORRUPT ROOT');
        expect(getPauseState('worldState').reasonCode).toBe('root-not-object');
        expect(meta[MANIFEST_METADATA_KEY]).toBeUndefined();
        expect(fn).not.toHaveBeenCalled();
    });

    test('re-running the gate is idempotent — no duplicate quarantine, no manifest churn', () => {
        const meta = getFakeMeta();
        meta[KEY.chronicle] = { snapshots: ['NOT-A-SNAPSHOT'] };
        const { fn } = persistSpy();

        applySchemaLoadGate({ persist: fn });
        const firstItems = meta[QUARANTINE_METADATA_KEY].items;
        const manifestAfterFirst = JSON.parse(JSON.stringify(meta[MANIFEST_METADATA_KEY]));

        const second = applySchemaLoadGate({ persist: fn });

        // The second run sees the committed v1 store: ready, nothing new.
        expect(second.stores.chronicle.action).toBe('ready');
        expect(second.persisted).toBe(false);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(meta[QUARANTINE_METADATA_KEY].items).toEqual(firstItems);
        expect(meta[MANIFEST_METADATA_KEY]).toEqual(manifestAfterFirst);
        // Fingerprint dedup: no repeated detections appended.
        const fingerprints = firstItems.map((i) => i.fingerprint);
        expect(new Set(fingerprints).size).toBe(fingerprints.length);
    });

    test('a throwing persist is recorded, never fatal — the in-memory commit stands', () => {
        Object.assign(getFakeMeta(), legacyChatMeta());
        const boom = vi.fn(() => { throw new Error('disk on fire'); });

        const result = applySchemaLoadGate({ persist: boom });

        expect(boom).toHaveBeenCalledTimes(1);
        expect(result.persisted).toBe(false);
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.PERSIST_FAILED)).toHaveLength(1);
        // chat_metadata still holds the committed preparation; the host owns
        // flushing, and a dropped write re-runs idempotently next open.
        expect(getFakeMeta()[MANIFEST_METADATA_KEY].sections.chronicle).toBe(1);
    });

    test('a healthy load clears a stale pause from an earlier blocked load (§5.4 resume paths)', () => {
        const meta = getFakeMeta();
        meta[MANIFEST_METADATA_KEY] = stampedManifest(['chronicle']);
        meta[KEY.chronicle] = { snapshots: [], _deletedBin: [] };
        // An earlier load paused this store (the data was fixed out-of-band).
        pauseStore('chronicle', { reasonCode: 'future-version', message: 'stale' });
        expect(isStorePausedForCurrentScope('chronicle')).toBe(true);

        const result = applySchemaLoadGate({ persist: () => {} });

        expect(result.stores.chronicle.action).toBe('ready');
        expect(getPauseState('chronicle')).toBeNull();
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.STORE_RESUMED)).toHaveLength(1);
    });
});

// ─── §7.5 — the privileged preparation for deferred stores ───────────────────

describe('runSchemaPreparations — the §7.5 privileged path (Interiority)', () => {
    function deferredInteriorityMeta() {
        return {
            [KEY.interiority]: {
                enabled: true, ledger: [], deletedIntentions: [], turnCounter: 0,
                perMessage: { '0': { reactions: [], generatedAt: 1 } }, // legacy numeric key
            },
        };
    }

    test('a deferred store pauses as PREPARING, untouched and unstamped', () => {
        Object.assign(getFakeMeta(), deferredInteriorityMeta());
        const { fn } = persistSpy();

        const result = applySchemaLoadGate({ persist: fn });

        expect(result.stores.interiority.action).toBe('deferred');
        expect(result.deferred).toEqual(['interiority']);
        const pause = getPauseState('interiority');
        expect(pause.reasonCode).toBe('per-message-legacy-pending');
        // §7.5's user-facing wording: preparing, never corrupt/quarantined.
        expect(pause.message).toContain('one-time compatibility update');
        expect(pause.message).not.toContain('migrateIndexKeys');
        // The ORIGINAL stays untouched; nothing stamped, nothing saved for it.
        expect(getFakeMeta()[KEY.interiority].perMessage).toEqual({ '0': { reactions: [], generatedAt: 1 } });
        expect(getFakeMeta()[MANIFEST_METADATA_KEY]).toBeUndefined();
        expect(fn).not.toHaveBeenCalled();
    });

    test('the privileged conversion commits, stamps, and resumes the module', async () => {
        Object.assign(getFakeMeta(), deferredInteriorityMeta());
        setFakeChat([{ mes: 'hi', name: 'Mara', is_user: false, extra: {} }]);
        applySchemaLoadGate({ persist: () => {} });
        const { fn, calls } = persistSpy();

        const attempted = await runSchemaPreparations({ persist: fn });

        expect(attempted).toEqual(['interiority']);
        const meta = getFakeMeta();
        // The conversion rewrote the legacy key to a stable mu-<uuid> key…
        const perMessage = meta[KEY.interiority].perMessage;
        expect(Object.keys(perMessage)).toHaveLength(1);
        expect(Object.keys(perMessage)[0]).toMatch(/^mu-/);
        expect(perMessage[Object.keys(perMessage)[0]]).toEqual({ reactions: [], generatedAt: 1 });
        // …and the re-run gate committed data + manifest together (§7.3) and
        // cleared the pause.
        expect(meta[MANIFEST_METADATA_KEY].sections.interiority).toBe(1);
        expect(getPauseState('interiority')).toBeNull();
        expect(isStorePausedForCurrentScope('interiority')).toBe(false);
        expect(eventsOf(SCHEMA_DIAGNOSTIC_EVENTS.STORE_RESUMED)).toHaveLength(1);
        // Every save of this run carried the whole chat_metadata object; the
        // manifest never out-ran its data.
        expect(calls.length).toBeGreaterThanOrEqual(1);
        for (const saved of calls) {
            if (saved[MANIFEST_METADATA_KEY]?.sections?.interiority === 1) {
                expect(Object.keys(saved[KEY.interiority].perMessage)[0]).toMatch(/^mu-/);
            }
        }
    });

    test('a chat switch during the conversion abandons it BEFORE the write — the new chat re-derives', async () => {
        Object.assign(getFakeMeta(), deferredInteriorityMeta());
        setFakeChat([{ mes: 'hi', name: 'Mara', is_user: false, extra: {} }]);
        applySchemaLoadGate({ persist: () => {} });

        // The chat switches while the privileged conversion is in flight
        // (inside its hydration await).
        const pending = runSchemaPreparations({ persist: () => {} });
        bumpEpoch(); // exactly what CHAT_CHANGED does, synchronously
        await pending;

        // The converter verified its captured scope right after the await and
        // abandoned BEFORE reading the new chat or committing anything: the
        // outgoing chat's original stays byte-for-byte, nothing stamped, and
        // the pause stays — the new chat's own gate re-derives everything.
        expect(getFakeMeta()[KEY.interiority].perMessage).toEqual({ '0': { reactions: [], generatedAt: 1 } });
        expect(getFakeMeta()[KEY.interiority].keyMigrationDone).toBeUndefined();
        expect(getFakeMeta()[MANIFEST_METADATA_KEY]).toBeUndefined();
        expect(getPauseState('interiority')).not.toBeNull();

        // The next open (a real CHAT_CHANGED runs the gate AND its privileged
        // preparation — index.js fires both) completes it.
        applySchemaLoadGate({ persist: () => {} });
        await runSchemaPreparations({ persist: () => {} });
        expect(getFakeMeta()[MANIFEST_METADATA_KEY].sections.interiority).toBe(1);
        expect(getPauseState('interiority')).toBeNull();
    });

    test('an orphaned legacy entry drops during the privileged conversion and the store still completes', async () => {
        Object.assign(getFakeMeta(), deferredInteriorityMeta());
        // An EMPTY chat: the legacy key references a message that does not
        // exist, so the conversion drops it as orphaned — through the §7.5
        // privileged window, not the module's declined write seam.
        setFakeChat([]);
        applySchemaLoadGate({ persist: () => {} });
        expect(getPauseState('interiority')).not.toBeNull();

        await runSchemaPreparations({ persist: () => {} });

        // Orphan dropped + keyMigrationDone stamped: the re-gate migrates,
        // commits, stamps, and resumes.
        expect(getFakeMeta()[KEY.interiority].perMessage).toEqual({});
        expect(getFakeMeta()[KEY.interiority].keyMigrationDone).toBe(true);
        expect(getFakeMeta()[MANIFEST_METADATA_KEY].sections.interiority).toBe(1);
        expect(getPauseState('interiority')).toBeNull();
    });

    test('with nothing deferred the run is a no-op', async () => {
        const attempted = await runSchemaPreparations();
        expect(attempted).toEqual([]);
    });

    test('the §7.5 resume fires the store\'s resume initializer — the skipped hydration re-runs', async () => {
        Object.assign(getFakeMeta(), deferredInteriorityMeta());
        setFakeChat([{ mes: 'hi', name: 'Mara', is_user: false, extra: {} }]);
        applySchemaLoadGate({ persist: () => {} });
        // index.js registers the module's onChatChanged() here; CHAT_CHANGED
        // skipped it while the store was paused (preparing).
        let rehydrated = 0;
        setStoreResumeInitializer('interiority', () => { rehydrated += 1; });

        await runSchemaPreparations({ persist: () => {} });

        expect(getPauseState('interiority')).toBeNull();
        expect(rehydrated).toBe(1);
        // A second run with nothing deferred re-runs nothing.
        await runSchemaPreparations({ persist: () => {} });
        expect(rehydrated).toBe(1);
    });
});

// ─── §7.4 — the decline surface (events, writes, lazy reads) ─────────────────

describe('a paused store\'s module declines its own work (§7.4)', () => {
    test('the message-event router skips ONLY the paused module and says so', () => {
        pauseStore('chronicle', { reasonCode: 'future-version', message: 'blocked' });
        const routed = {
            WorldState: { onMessageReceived: vi.fn(), onMessageDeleted: vi.fn() },
            Chronicle: { onMessageReceived: vi.fn(), onMessageDeleted: vi.fn() },
            Knowledge: { onMessageReceived: vi.fn(), onMessageDeleted: vi.fn() },
            StoryPlanner: { onMessageReceived: vi.fn(), onMessageDeleted: vi.fn() },
            Interiority: { onMessageReceived: vi.fn(), onMessageDeleted: vi.fn() },
        };

        routeMessageReceived(routed, {}, 3, isModulePausedForCurrentScope);
        routeMessageDeleted(routed, {}, 3, isModulePausedForCurrentScope);

        // The paused module declined BOTH events…
        expect(routed.Chronicle.onMessageReceived).not.toHaveBeenCalled();
        expect(routed.Chronicle.onMessageDeleted).not.toHaveBeenCalled();
        // …while every other module kept running (nothing globally queued or
        // discarded — each healthy module was dispatched normally).
        expect(routed.WorldState.onMessageReceived).toHaveBeenCalledTimes(1);
        expect(routed.Knowledge.onMessageReceived).toHaveBeenCalledTimes(1);
        expect(routed.StoryPlanner.onMessageReceived).toHaveBeenCalledTimes(1);
        expect(routed.Interiority.onMessageReceived).toHaveBeenCalledTimes(1);
        // The decline is said out loud.
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Chronicle declined MESSAGE_RECEIVED'));
    });

    test('isModulePausedForCurrentScope maps every router key spelling', () => {
        pauseStore('storyPlanner', { reasonCode: 'x', message: 'y' });
        expect(isModulePausedForCurrentScope('StoryPlanner')).toBe(true);
        expect(isModulePausedForCurrentScope('story_planner')).toBe(true);
        expect(isModulePausedForCurrentScope('story-planner')).toBe(true);
        expect(isModulePausedForCurrentScope('WorldState')).toBe(false);
        // Knowledge maps through its three stores.
        pauseStore('knowledgeCounters', { reasonCode: 'x', message: 'y' });
        expect(isModulePausedForCurrentScope('Knowledge')).toBe(true);
    });

    test('the write seams refuse while paused; the capability — not an open window — passes the privileged write', () => {
        const meta = getFakeMeta();
        meta[KEY.chronicle] = { snapshots: [], _deletedBin: [] };
        meta[KEY.interiority] = { enabled: true, ledger: [], deletedIntentions: [], perMessage: {}, turnCounter: 0 };
        pauseStore('chronicle', { reasonCode: 'future-version', message: 'blocked' });
        pauseStore('interiority', { reasonCode: 'per-message-legacy-pending', message: 'preparing' });
        expect(isStoreWriteBlocked('chronicle')).toBe(true);

        // A module write against the paused store is refused, value kept.
        const refused = setChronicleDataChecked({ msgSinceSnapshot: 2 });
        expect(refused.ok).toBe(false);
        expect(refused.reason).toBe('store-paused');
        expect(meta[KEY.chronicle].msgSinceSnapshot).toBeUndefined();

        // The §7.5 window is a CAPABILITY: while the conversion's window is
        // open, a write that does NOT present it — UI work, cleanup, or a
        // newly switched chat's write — is still refused…
        const capability = beginPrivilegedPreparation('interiority');
        try {
            expect(isStoreWriteBlocked('interiority')).toBe(true);
            const keptCapabilityless = saveInteriorityData({ ...meta[KEY.interiority], turnCounter: 7 });
            expect(keptCapabilityless.turnCounter).toBe(0);
            expect(meta[KEY.interiority].turnCounter).toBe(0);
            // …and only the conversion's own commit, presenting the capability,
            // passes.
            expect(isStoreWriteBlocked('interiority', capability)).toBe(false);
            saveInteriorityData({ ...meta[KEY.interiority], turnCounter: 5 }, { privileged: capability });
            expect(meta[KEY.interiority].turnCounter).toBe(5);
        } finally {
            endPrivilegedPreparation(capability);
        }
        // And the window closed: the seam declines again — even when the
        // already-spent capability is presented.
        const kept = saveInteriorityData({ ...meta[KEY.interiority], turnCounter: 9 }, { privileged: capability });
        expect(kept.turnCounter).toBe(5);
        expect(meta[KEY.interiority].turnCounter).toBe(5);
    });

    test('overlapping §7.5 conversions keep their own privilege; a chat switch retires the capability', () => {
        const meta = getFakeMeta();
        meta[KEY.interiority] = { enabled: true, ledger: [], deletedIntentions: [], perMessage: {}, turnCounter: 0 };
        pauseStore('interiority', { reasonCode: 'per-message-legacy-pending', message: 'preparing' });

        // Two conversions in flight for the same store: releasing the FIRST
        // one's privilege must not close the second's window.
        const first = beginPrivilegedPreparation('interiority');
        const second = beginPrivilegedPreparation('interiority');
        endPrivilegedPreparation(first);
        expect(isStoreWriteBlocked('interiority', first)).toBe(true);
        expect(isStoreWriteBlocked('interiority', second)).toBe(false);
        saveInteriorityData({ ...meta[KEY.interiority], turnCounter: 3 }, { privileged: second });
        expect(meta[KEY.interiority].turnCounter).toBe(3);
        endPrivilegedPreparation(second);

        // The capability is scope-bound: an epoch bump (exactly what
        // CHAT_CHANGED does) retires it even while the pause still matches the
        // resolver's scope key — a conversion left over from the outgoing chat
        // can never unlock the newly switched chat's seam.
        const stale = beginPrivilegedPreparation('interiority');
        bumpEpoch();
        expect(isStoreWriteBlocked('interiority', stale)).toBe(true);
        endPrivilegedPreparation(stale);
    });
});

describe('the lazy compatibility writes are retired (Part 6 checklist)', () => {
    test('chronicle getSnapshots() backfills in memory but never persists from a read', () => {
        const meta = getFakeMeta();
        meta[KEY.chronicle] = { snapshots: [{ text: 's1', createdAt: 't' }] };
        const { fn } = persistSpy();

        const snapshots = getSnapshots();

        // The read still surfaces backfilled ids…
        expect(snapshots[0].id).toEqual(expect.any(String));
        // …but the store in metadata is unchanged, and no save was scheduled —
        // the runtime gate owns the persisted repair.
        expect(meta[KEY.chronicle].snapshots[0].id).toBeUndefined();
        expect(fn).not.toHaveBeenCalled();
    });

    test('story planner getArcs() parses legacy text read-only; the gate owns the persisted conversion', () => {
        const meta = getFakeMeta();
        meta[KEY.storyPlanner] = { text: '## Immediate Hooks\n- [x] One arc title\n  body' };
        const { fn } = persistSpy();

        const arcs = getArcs();

        expect(arcs.length).toBeGreaterThan(0);
        expect(meta[KEY.storyPlanner].arcs).toBeUndefined();
        expect(meta[KEY.storyPlanner]._migratedFromText).toBeUndefined();
        expect(fn).not.toHaveBeenCalled();
    });
});

// ─── The §5.4 Retry seam for chat-metadata stores ────────────────────────────

describe('registerSchemaGateRetryHandlers (the Retry button)', () => {
    test('Retry re-runs the gate and clears a block the fixed data released', async () => {
        const meta = getFakeMeta();
        meta[MANIFEST_METADATA_KEY] = { manifestVersion: 1, sections: { chronicle: 99 } };
        meta[KEY.chronicle] = { snapshots: [] };
        registerSchemaGateRetryHandlers();

        applySchemaLoadGate({ persist: () => {} });
        expect(getPauseState('chronicle')).not.toBeNull();

        // The user repairs the data out-of-band, then presses Retry.
        meta[MANIFEST_METADATA_KEY] = stampedManifest(['chronicle']);
        const result = await retryStore('chronicle');

        expect(result).toMatchObject({ ok: true, resumed: true });
        expect(getPauseState('chronicle')).toBeNull();
    });

    test('Retry keeps the banner up when the block survives the re-run', async () => {
        const meta = getFakeMeta();
        meta[MANIFEST_METADATA_KEY] = { manifestVersion: 1, sections: { chronicle: 99 } };
        meta[KEY.chronicle] = { snapshots: [] };
        registerSchemaGateRetryHandlers();

        applySchemaLoadGate({ persist: () => {} });
        const result = await retryStore('chronicle');

        expect(result).toMatchObject({ ok: false, reason: 'still-paused' });
        expect(getPauseState('chronicle')).not.toBeNull();
    });

    test('a successful Retry re-runs the resumed module\'s chat-change hydration, exactly once', async () => {
        const meta = getFakeMeta();
        meta[MANIFEST_METADATA_KEY] = { manifestVersion: 1, sections: { chronicle: 99 } };
        meta[KEY.chronicle] = { snapshots: [] };
        registerSchemaGateRetryHandlers();

        applySchemaLoadGate({ persist: () => {} });
        expect(getPauseState('chronicle')).not.toBeNull();
        // index.js registers the module's onChatChanged() as the resume
        // initializer — CHAT_CHANGED skipped it while the store was paused,
        // so the stale in-memory counters must NOT survive the resume.
        const rehydrated = [];
        setStoreResumeInitializer('chronicle', () => { rehydrated.push('chronicle'); });

        // The user repairs the data out-of-band, then presses Retry.
        meta[MANIFEST_METADATA_KEY] = stampedManifest(['chronicle']);
        const result = await retryStore('chronicle');

        expect(result).toMatchObject({ ok: true, resumed: true });
        // Exactly once: the retry handler and the §7.5 re-gate can both
        // observe one resume — the initializer runs once per pause
        // generation, never twice.
        expect(rehydrated).toEqual(['chronicle']);

        // A retry against a now-healthy store (not-paused) re-runs nothing.
        const again = await retryStore('chronicle');
        expect(again).toMatchObject({ ok: true, reason: 'not-paused' });
        expect(rehydrated).toEqual(['chronicle']);
    });

    test('a Retry whose gate run resumes OTHER stores re-initializes their modules too', async () => {
        const meta = getFakeMeta();
        // One future-version manifest blocks BOTH stores in the same gate run.
        meta[MANIFEST_METADATA_KEY] = { manifestVersion: 1, sections: { chronicle: 99, storyPlanner: 99 } };
        meta[KEY.chronicle] = { snapshots: [] };
        meta[KEY.storyPlanner] = { text: '## Immediate Hooks\n- [x] One arc title\n  body' };
        registerSchemaGateRetryHandlers();

        applySchemaLoadGate({ persist: () => {} });
        expect(getPauseState('chronicle')).not.toBeNull();
        expect(getPauseState('storyPlanner')).not.toBeNull();

        const rehydrated = [];
        setStoreResumeInitializer('chronicle', () => { rehydrated.push('chronicle'); });
        setStoreResumeInitializer('storyPlanner', () => { rehydrated.push('storyPlanner'); });

        // The manifest is repaired out-of-band — every affected store becomes
        // ready in ONE gate run — but the user pressed Retry on Chronicle's
        // banner only. Story Planner's module must not stay unpaused with the
        // stale in-memory state its skipped chat-change hydration left behind.
        meta[MANIFEST_METADATA_KEY] = stampedManifest(['chronicle', 'storyPlanner']);
        const result = await retryStore('chronicle');

        expect(result).toMatchObject({ ok: true, resumed: true });
        expect(getPauseState('chronicle')).toBeNull();
        expect(getPauseState('storyPlanner')).toBeNull();
        // BOTH owning modules were re-hydrated — each exactly once (the
        // run-once memo absorbs the overlap with retryStore()'s own call).
        expect(rehydrated.slice().sort()).toEqual(['chronicle', 'storyPlanner']);
    });

    test('one resume of SEVERAL stores of the SAME module re-initializes it exactly once', async () => {
        const meta = getFakeMeta();
        // One future-version manifest blocks BOTH knowledge chat-metadata
        // stores — one module — in the same gate run.
        meta[MANIFEST_METADATA_KEY] = { manifestVersion: 1, sections: { knowledgeEvidence: 99, knowledgeCounters: 99 } };
        meta[KEY.knowledgeEvidence] = { Mara: { npc: 'Mara', raw: [], consolidated: [], meta: {} } };
        meta[KEY.knowledgeCounters] = { messageCounter: 3 };
        registerSchemaGateRetryHandlers();

        applySchemaLoadGate({ persist: () => {} });
        expect(getPauseState('knowledgeEvidence')).not.toBeNull();
        expect(getPauseState('knowledgeCounters')).not.toBeNull();

        // index.js registers the module's onChatChanged() as the resume
        // initializer for EVERY store id Knowledge owns — one shared
        // initializer across all three.
        let runs = 0;
        const sharedInitializer = () => { runs += 1; };
        for (const storeId of ['knowledgeEvidence', 'knowledgeCounters', 'knowledgeStore']) {
            setStoreResumeInitializer(storeId, sharedInitializer);
        }

        // The manifest is repaired out-of-band — both stores become ready in
        // ONE gate run — and the user presses Retry on either banner.
        meta[MANIFEST_METADATA_KEY] = stampedManifest(['knowledgeEvidence', 'knowledgeCounters']);
        const result = await retryStore('knowledgeEvidence');

        expect(result).toMatchObject({ ok: true, resumed: true });
        expect(getPauseState('knowledgeEvidence')).toBeNull();
        expect(getPauseState('knowledgeCounters')).toBeNull();
        // initializeResumedStores() visits BOTH resumed store ids and
        // retryStore() re-invokes the clicked one's — every one of those
        // calls resolves to Knowledge.onChatChanged(), so the module-keyed
        // run-once memo must collapse them into ONE re-hydration (a
        // store-keyed memo would start the same async reset/hydration twice,
        // overlapping itself).
        expect(runs).toBe(1);
    });
});
