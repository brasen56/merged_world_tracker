/**
 * test/import_export_roundtrip.test.js — TODO §6 "Import/export validation +
 * round trips" (the §1 backup/restore it depended on shipped in v1.5.0).
 *
 * The backup envelope round trip and the quarantining standalone-import paths
 * are pinned in test/backup_schema_roundtrip.test.js and
 * test/restore_quarantine_integrity.test.js. What this file adds:
 *
 *   1. Chronicle — the EXPORT side (payload shape, filename, status, and the
 *      Markdown export), a real export → import round trip into a fresh
 *      store, the invalid-input statuses, and the injection-settings
 *      confirm() branch;
 *   2. Knowledge — exportNpcs() embedding entry content + history and
 *      redacting the API key; a real export → import round trip into a WIPED
 *      destination (empty lorebook + cleared history) that must re-create the
 *      dossier and restore the history under the assigned uid; and the
 *      same-install branch where a content-verified uid is reused.
 *
 * Harness conventions mirror the two backup test files (stub-core +
 * setPickTextFileStub + the fake world-info from
 * test/knowledge_store_hydration.test.js).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import {
    resetCoreStubs,
    setFakeChat,
    setFakeContextExtras,
    getFakeMeta,
    getFakeDownloadJsonCalls,
    getFakeDownloadBlobCalls,
    setPickTextFileStub,
} from './stubs/core.js';
import { _resetEpoch } from '../core/scope.js';
import { canonicalizeRegistryIdentityClaims } from '../knowledge/schema.js';

// ─── Chronicle fixtures ───────────────────────────────────────────────────────

const SNAPS = [
    { id: 's1', text: 'first snapshot', createdAt: '2025-01-01T10:00:00.000Z' },
    { id: 's2', text: 'second snapshot', createdAt: '2025-01-02T10:00:00.000Z' },
];

const ANCHOR = { id: 'm1', msgIndex: 1, name: 'Mara', start: 'The harbour office', end: 'the manifest', length: 42 };

/**
 * Soft-deleted snapshots (the `_deletedBin` trash). The source install keeps
 * one and the round-trip destination another — the export deliberately omits
 * the bin (deleted entries must not resurrect via import), and the import
 * must leave the DESTINATION's own trash untouched (merge, not replace).
 */
const TRASH = [
    { id: 't1', text: 'deleted snapshot', createdAt: '2024-12-31T10:00:00.000Z' },
    { id: 't2', text: 'older deleted snapshot', createdAt: '2024-12-30T10:00:00.000Z' },
];

describe('Chronicle export/import', () => {
    let chronicleState, chronicleRender, exportChronicle, exportMarkdown, triggerImport;

    beforeEach(async () => {
        resetCoreStubs();
        _resetEpoch();
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-io' }) };
        setFakeContextExtras({ getCurrentChatId: () => 'chat-io' });
        setFakeChat([{ mes: 'hello' }]);
        // render.js wires these in production; the import path calls them.
        ({ _render: chronicleRender, state: chronicleState } = await import('../chronicle/data.js'));
        ({ exportChronicle, exportMarkdown, triggerImport } = await import('../chronicle/import-export.js'));
        chronicleRender.renderContent = () => {};
        chronicleState._lastStatusMsg = '';
        chronicleState._lastStatusLevel = '';
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.SillyTavern;
        delete globalThis.confirm;
    });

    /** Seed a fully-populated chronicle store (snapshots + settings + anchor). */
    function seedFullStore() {
        getFakeMeta().session_chronicle_data = {
            snapshots: SNAPS.map(s => ({ ...s })),
            _deletedBin: [TRASH[0]],
            injectEnabled: true,
            injectCount: 3,
            injectDepth: 4,
            lastAnchor: { ...ANCHOR },
        };
        chronicleState.msgSinceSnapshot = 5;
    }

    test('exportChronicle writes the whole module state to a dated file', async () => {
        const { SC_VERSION } = await import('../chronicle/data.js');
        seedFullStore();

        exportChronicle();

        const calls = getFakeDownloadJsonCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0].filename).toMatch(/^chronicle-\d+\.json$/);
        expect(calls[0].data).toMatchObject({
            snapshots: [{ id: 's1' }, { id: 's2' }],
            lastAnchor: ANCHOR,
            injectEnabled: true,
            injectCount: 3,
            injectDepth: 4,
            msgSinceSnapshot: 5,
            version: SC_VERSION,
        });
        expect(calls[0].data.snapshots.map(s => s.text)).toEqual(['first snapshot', 'second snapshot']);
        // The trash bin does NOT ride along — a deleted snapshot must not
        // resurrect on another install through the export.
        expect(calls[0].data).not.toHaveProperty('_deletedBin');
        expect(calls[0].data.exportedAt).toBeTruthy();
        expect(chronicleState._lastStatusMsg).toBe('Exported.');
        expect(chronicleState._lastStatusLevel).toBe('success');
    });

    test('export → import round trip: a fresh store becomes the exported one, ids stable', async () => {
        seedFullStore();
        exportChronicle();
        const file = JSON.stringify(getFakeDownloadJsonCalls()[0].data);

        // Destination: an empty chronicle in a fresh chat (same stub session).
        // resetCoreStubs() wipes the fake context, so re-seed it exactly like
        // the beforeEach — the checked write is scope-guarded.
        resetCoreStubs();
        setFakeContextExtras({ getCurrentChatId: () => 'chat-io' });
        setFakeChat([{ mes: 'hello' }]);
        getFakeMeta().session_chronicle_data = { snapshots: [], _deletedBin: [{ ...TRASH[1] }] };
        chronicleState.msgSinceSnapshot = 0;
        chronicleState._lastStatusMsg = '';
        // The export carries injection settings, so the import asks confirm()
        // — decline: the destination chat must keep its own session config.
        globalThis.confirm = vi.fn(() => false);
        setPickTextFileStub(async () => file);

        await triggerImport();

        const data = getFakeMeta().session_chronicle_data;
        expect(data.snapshots).toHaveLength(2);
        expect(data.snapshots.map(s => s.id)).toEqual(['s1', 's2']); // ids ride along — no re-minting
        expect(data.snapshots.map(s => s.text)).toEqual(['first snapshot', 'second snapshot']);
        expect(data.lastAnchor).toEqual(ANCHOR);
        expect(data.msgSinceSnapshot).toBe(5);
        expect(chronicleState.msgSinceSnapshot).toBe(5); // module state follows the commit
        // The destination's own trash survived the import untouched — the
        // patch never mentions the bin, and the checked write merges rather
        // than replacing the store around it.
        expect(data._deletedBin).toEqual([TRASH[1]]);
        expect(data.injectEnabled).toBeUndefined(); // declined confirm kept the destination's config
        expect(chronicleState._lastStatusMsg).toContain('Imported 2 entries');
        expect(chronicleState._lastStatusLevel).toBe('success');
    });


    test('an unparseable file fails with an error status and keeps the current chronicle', async () => {
        getFakeMeta().session_chronicle_data = {
            snapshots: [{ id: 'keep', text: 'kept snapshot', createdAt: '2025-01-01T00:00:00.000Z' }],
            _deletedBin: [],
        };
        setPickTextFileStub(async () => '{not valid json');

        await triggerImport();

        expect(chronicleState._lastStatusLevel).toBe('error');
        expect(chronicleState._lastStatusMsg).toContain('Import failed');
        expect(getFakeMeta().session_chronicle_data.snapshots).toHaveLength(1); // untouched
    });

    test('a file without a snapshots array is rejected up front', async () => {
        getFakeMeta().session_chronicle_data = { snapshots: [], _deletedBin: [] };
        setPickTextFileStub(async () => JSON.stringify({ somethingElse: true }));

        await triggerImport();

        expect(chronicleState._lastStatusLevel).toBe('error');
        expect(chronicleState._lastStatusMsg).toContain('missing snapshots');
        expect(getFakeMeta().session_chronicle_data.snapshots).toHaveLength(0);
    });

    test('injection settings restore only when the user confirms', async () => {
        const file = JSON.stringify({
            snapshots: [{ id: 'inj1', text: 'imported', createdAt: '2025-01-01T00:00:00.000Z' }],
            injectEnabled: false,
            injectCount: 5,
            injectDepth: 4,
        });

        globalThis.confirm = vi.fn(() => true);
        getFakeMeta().session_chronicle_data = { snapshots: [], _deletedBin: [], injectEnabled: true, injectCount: 2, injectDepth: 2 };
        setPickTextFileStub(async () => file);
        await triggerImport();

        expect(globalThis.confirm).toHaveBeenCalled();
        expect(getFakeMeta().session_chronicle_data.injectEnabled).toBe(false);
        expect(getFakeMeta().session_chronicle_data.injectCount).toBe(5);
        expect(getFakeMeta().session_chronicle_data.injectDepth).toBe(4);

        // …and a declined confirm leaves the session config exactly as it was.
        globalThis.confirm = vi.fn(() => false);
        getFakeMeta().session_chronicle_data = { snapshots: [], _deletedBin: [], injectEnabled: true, injectCount: 2, injectDepth: 2 };
        setPickTextFileStub(async () => file);
        await triggerImport();

        expect(getFakeMeta().session_chronicle_data.injectEnabled).toBe(true);
        expect(getFakeMeta().session_chronicle_data.injectCount).toBe(2);
        expect(getFakeMeta().session_chronicle_data.injectDepth).toBe(2);
    });

    test('a file without lastAnchor keeps the destination anchor (merge, not replace)', async () => {
        getFakeMeta().session_chronicle_data = {
            snapshots: [],
            _deletedBin: [],
            lastAnchor: { ...ANCHOR },
        };
        setPickTextFileStub(async () => JSON.stringify({
            snapshots: [{ id: 'noanchor', text: 'x', createdAt: '2025-01-01T00:00:00.000Z' }],
        }));

        await triggerImport();

        expect(getFakeMeta().session_chronicle_data.lastAnchor).toEqual(ANCHOR);
    });

    test('exportMarkdown downloads a dated .md, sorted by date with labeled entries', async () => {
        getFakeMeta().session_chronicle_data = {
            snapshots: [
                { id: 'a', text: 'plain entry', createdAt: '2025-03-01T00:00:00.000Z' },
                { id: 'b', text: 'manual entry', createdAt: '2025-01-01T00:00:00.000Z', manual: true },
                { id: 'c', text: 'consolidated entry', createdAt: '2025-02-01T00:00:00.000Z', consolidated: true },
            ],
            _deletedBin: [],
        };

        exportMarkdown();

        const calls = getFakeDownloadBlobCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0].filename).toMatch(/^chronicle-\d{4}-\d{2}-\d{2}\.md$/);
        expect(calls[0].blob.type).toBe('text/markdown');

        const md = await calls[0].blob.text();
        expect(md).toContain('# Session Chronicle');
        // Sorted by createdAt regardless of store order: manual (Jan) before
        // consolidated (Feb) before the plain entry (Mar — numbered "#3", the
        // template renders `## #${i + 1}:` for plain snapshots).
        const iManual = md.indexOf('## Manual:');
        const iConsolidated = md.indexOf('## Consolidated:');
        const iPlain = md.indexOf('## #3:');
        expect(iManual).toBeGreaterThan(-1);
        expect(iConsolidated).toBeGreaterThan(iManual);
        expect(iPlain).toBeGreaterThan(iConsolidated);
        expect(chronicleState._lastStatusMsg).toBe('Exported as Markdown.');
        expect(chronicleState._lastStatusLevel).toBe('success');
    });
});


// ─── Knowledge export/import ──────────────────────────────────────────────────

/** Fake world-info (same contract as test/knowledge_store_hydration.test.js):
 *  `books` is the DISK — a non-immediate save must not touch it. */
function makeFakeWorldInfo() {
    const books = new Map();
    let pending = null;
    return {
        books,
        async loadWorldInfo(name) {
            return books.has(name) ? structuredClone(books.get(name)) : null;
        },
        async saveWorldInfo(name, wi, immediately = false) {
            if (!immediately) {
                pending = { name, wi: structuredClone(wi) };
                return;
            }
            pending = null;
            books.set(name, structuredClone(wi));
        },
        async createNewWorldInfo(name) {
            books.set(name, { entries: {} });
            return true;
        },
        flushDebounce() {
            if (!pending) return;
            books.set(pending.name, pending.wi);
            pending = null;
        },
    };
}

describe('Knowledge export/import', () => {
    let wiFake, knowledgeState, saveSettings, getSettings, exportNpcs, importNpcs;

    beforeEach(async () => {
        resetCoreStubs();
        _resetEpoch();
        globalThis.localStorage = {
            _data: {},
            getItem(key) { return key in this._data ? this._data[key] : null; },
            setItem(key, value) { this._data[key] = String(value); },
            removeItem(key) { delete this._data[key]; },
        };
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-kt' }) };
        const store = await import('../knowledge/store.js');
        store._clearCacheForTests();
        wiFake = makeFakeWorldInfo();
        ({ state: knowledgeState } = await import('../knowledge/state.js'));
        ({ saveSettings, getSettings } = await import('../knowledge/settings.js'));
        // Import staging.js BEFORE seeding state.wiScript: loading it pulls in
        // knowledge/lorebook.js, whose top-level await assigns state.wiScript
        // to the world-info stub — anything set earlier is clobbered on first
        // import. (test/knowledge_store_hydration.test.js avoids this by never
        // importing lorebook.js; this file needs staging's export/import.)
        ({ exportNpcs, importNpcs } = await import('../knowledge/staging.js'));
        knowledgeState.wiScript = wiFake;
        saveSettings({
            scope: 'global',
            apiKey: 'sk-secret',
            apiUrl: 'https://example.test/v1',
            modelName: 'test-model',
        });
        // Never overwrite settings during importNpcs unless a test confirms.
        globalThis.confirm = () => false;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        delete globalThis.SillyTavern;
        delete globalThis.confirm;
        delete globalThis.localStorage;
    });

    /** A populated install: one NPC with a lorebook entry + scan history. */
    async function populatedInstall() {
        const { _setCacheForTests, isStoreEntry } = await import('../knowledge/store.js');
        wiFake.books.set('Knowledge Tracker', {
            entries: { 7: { uid: 7, comment: 'Mara', content: 'Mara dossier text', key: [] } },
        });
        _setCacheForTests('Knowledge Tracker', {
            registry: {
                Mara: {
                    uid: 7, type: 'major', keywords: ['Mara'], lastUpdated: 123,
                    // Identity layer (TODO §1): a bare pre-identity record
                    // cannot see the round trip dropping it — this is the
                    // fixture that catches a hardcoded export/import field
                    // list silently re-minting the NPC as a different entity.
                    entityId: 'mwt_fixed_id',
                    aliases: ['The Vixen'],
                    mergedFrom: [{ entityId: 'mwt_sophie', name: 'Sophie', at: 99 }],
                },
            },
        });
        globalThis.localStorage.setItem(
            'kt_history_Knowledge Tracker_7',
            JSON.stringify([{ ts: 1, content: 'scan happened', msgIdx: 3 }]),
        );
        return { _setCacheForTests, isStoreEntry };
    }


    test('exportNpcs embeds entry content + history and never the API key', async () => {
        await populatedInstall();

        await exportNpcs();

        const calls = getFakeDownloadJsonCalls();
        expect(calls).toHaveLength(1);
        expect(calls[0].filename).toMatch(/^knowledge-tracker-/);
        const data = calls[0].data;
        expect(data.type).toBe('knowledge_tracker');
        expect(data.version).toBe(1);
        expect(data.lorebook).toBe('Knowledge Tracker');
        // Self-contained: the actual lorebook entry text and the scan history
        // ride along, not just the registry row.
        expect(data.entries.Mara).toMatchObject({
            uid: 7,
            type: 'major',
            keywords: ['Mara'],
            lastUpdated: 123,
            // The identity layer rides along too: the entity id (stable
            // across renames/merges), user-approved aliases, and the merge
            // audit trail — without them the destination install re-mints
            // the NPC as a different entity.
            entityId: 'mwt_fixed_id',
            aliases: ['The Vixen'],
            mergedFrom: [{ entityId: 'mwt_sophie', name: 'Sophie', at: 99 }],
            content: 'Mara dossier text',
        });
        expect(data.entries.Mara.history).toEqual([{ ts: 1, content: 'scan happened', msgIdx: 3 }]);
        // The API key must never leave the install.
        expect(data.settings).not.toHaveProperty('apiKey');
        expect(data.settings.apiUrl).toBe('https://example.test/v1');
        expect(knowledgeState._lastKtStatusLevel).toBe('success');
        expect(knowledgeState._lastKtStatusMsg).toContain('API key excluded');
    });

    test('export → import round trip: a wiped destination recreates the dossier and history under the assigned uid', async () => {
        const { _setCacheForTests, isStoreEntry } = await populatedInstall();
        await exportNpcs();
        const file = JSON.stringify(getFakeDownloadJsonCalls()[0].data);

        // Destination: the install WIPED — empty lorebook (no uid 7, no store
        // entry), empty registry, no scan history. An earlier version of this
        // test only emptied the registry, so the import "verified" the
        // exported uid against the still-present source entry and never
        // re-created the dossier or restored the history a round trip claims
        // to move.
        wiFake.books.set('Knowledge Tracker', { entries: {} });
        _setCacheForTests('Knowledge Tracker', { registry: {} });
        globalThis.localStorage.removeItem('kt_history_Knowledge Tracker_7');
        setPickTextFileStub(async () => file);

        await importNpcs();

        const { getRegistry } = await import('../knowledge/registry.js');
        const registry = getRegistry();
        expect(registry.Mara).toBeTruthy();
        expect(registry.Mara.type).toBe('major');
        // The exported uid 7 points at nothing in the empty destination book,
        // so it was dropped and the creating write assigned the first free uid.
        expect(registry.Mara.uid).toBe(0);
        // The identity layer survived the round trip: SAME entity id, aliases,
        // and merge audit trail — not a re-minted NPC that shares the name.
        expect(registry.Mara.entityId).toBe('mwt_fixed_id');
        expect(registry.Mara.aliases).toEqual(['The Vixen']);
        expect(registry.Mara.mergedFrom).toEqual([{ entityId: 'mwt_sophie', name: 'Sophie', at: 99 }]);

        // The dossier CONTENT was re-created under the ASSIGNED uid.
        const restored = wiFake.books.get('Knowledge Tracker').entries[registry.Mara.uid];
        expect(restored).toBeTruthy();
        expect(restored.comment).toBe('Mara');
        expect(restored.content).toBe('Mara dossier text');
        expect(restored.key).toEqual(['Mara']);

        // The scan HISTORY was restored under the ASSIGNED uid's localStorage key.
        expect(JSON.parse(globalThis.localStorage.getItem(`kt_history_Knowledge Tracker_${registry.Mara.uid}`)))
            .toEqual([{ ts: 1, content: 'scan happened', msgIdx: 3 }]);

        // Settings were NOT imported (the confirm was declined).
        expect(getSettings().apiKey).toBe('sk-secret');
        // The registry was persisted into the book's store entry. writeField
        // schedules a DEBOUNCED flush; force it through the immediate seam.
        const { flushBook } = await import('../knowledge/store.js');
        await flushBook('Knowledge Tracker');
        const entry = Object.values(wiFake.books.get('Knowledge Tracker').entries).find(isStoreEntry);
        expect(entry).toBeTruthy();
        expect(JSON.parse(entry.content).registry.Mara.type).toBe('major');
        expect(JSON.parse(entry.content).registry.Mara.uid).toBe(0);
        // …and the persisted record kept the identity layer with it.
        expect(JSON.parse(entry.content).registry.Mara.entityId).toBe('mwt_fixed_id');
    });

    test('import into the SAME install reuses a uid whose entry content still matches', async () => {
        const { _setCacheForTests, isStoreEntry } = await populatedInstall();
        await exportNpcs();
        const file = JSON.stringify(getFakeDownloadJsonCalls()[0].data);

        // Destination: the same install — the book still holds uid 7 with the
        // exported dossier and the history key is still populated; only the
        // registry is emptied. This is deliberately NOT the round trip above:
        // it pins the reconcile branch that verifies an exported uid against
        // the local book and reuses it rather than re-minting and rewriting.
        _setCacheForTests('Knowledge Tracker', { registry: {} });
        setPickTextFileStub(async () => file);

        await importNpcs();

        const { getRegistry } = await import('../knowledge/registry.js');
        const registry = getRegistry();
        expect(registry.Mara).toBeTruthy();
        expect(registry.Mara.type).toBe('major');
        expect(registry.Mara.uid).toBe(7); // verified against the local book — reused, not re-minted
        expect(registry.Mara.entityId).toBe('mwt_fixed_id'); // same entity — the id was carried, not re-stamped
        // Settings were NOT imported (the confirm was declined).
        expect(getSettings().apiKey).toBe('sk-secret');
        // The registry was persisted into the book's store entry. writeField
        // schedules a DEBOUNCED flush; force it through the immediate seam.
        const { flushBook } = await import('../knowledge/store.js');
        await flushBook('Knowledge Tracker');
        const entry = Object.values(wiFake.books.get('Knowledge Tracker').entries).find(isStoreEntry);
        expect(entry).toBeTruthy();
        expect(JSON.parse(entry.content).registry.Mara.type).toBe('major');
    });

    test('a chronicle-shaped file is refused with the invalid-format status', async () => {
        await populatedInstall();
        // The realistic user error: the NPC importer fed a Chronicle export
        // (snapshots, not entries). The symmetric "missing snapshots" branch
        // on the Chronicle side is pinned in the describe above.
        setPickTextFileStub(async () => JSON.stringify({
            snapshots: [{ id: 's1', text: 'first snapshot', createdAt: '2025-01-01T10:00:00.000Z' }],
            injectEnabled: true,
            version: 3,
        }));

        await importNpcs();

        expect(knowledgeState._lastKtStatusLevel).toBe('error');
        expect(knowledgeState._lastKtStatusMsg).toContain('Invalid format: missing "entries" object');
        // The refused import never touched the registry.
        const { getRegistry } = await import('../knowledge/registry.js');
        expect(getRegistry().Mara).toMatchObject({ uid: 7, entityId: 'mwt_fixed_id' });
    });

    test('an import claiming a tracked NPC\'s entityId and alias canonicalizes the combined registry instead of persisting both conflicts', async () => {
        await populatedInstall(); // Mara: uid 7, entityId 'mwt_fixed_id', aliases ['The Vixen']

        // Sophie's record passes every per-record shape check — the conflict
        // only exists in the COMBINED registry: she claims Mara's entityId
        // and an alias equal to Mara's canonical key. The old import
        // committed both conflicting records as-is and the duplicate id /
        // colliding alias stayed persisted until the next store hydration.
        setPickTextFileStub(async () => JSON.stringify({
            type: 'knowledge_tracker',
            version: 1,
            entries: {
                Sophie: {
                    uid: null, type: 'minor', keywords: ['Sophie'], lastUpdated: 200,
                    entityId: 'mwt_fixed_id', // Mara's id — duplicate claim
                    aliases: ['Mara', 'Soph'], // 'Mara' collides with the canonical key
                    content: 'Sophie dossier text',
                },
            },
        }));

        await importNpcs();

        const { getRegistry } = await import('../knowledge/registry.js');
        const registry = getRegistry();
        expect(registry.Sophie).toBeTruthy();
        // The earlier claimant (Mara, insertion order) keeps her entity id…
        expect(registry.Mara.entityId).toBe('mwt_fixed_id');
        // …Sophie's conflicting claim was dropped and a FRESH id re-stamped
        // by the save seam — not two records sharing one entity identity.
        expect(registry.Sophie.entityId).toMatch(/^mwt_/);
        expect(registry.Sophie.entityId).not.toBe('mwt_fixed_id');
        // The colliding alias was stripped; the safe one survives.
        expect(registry.Sophie.aliases).toEqual(['Soph']);
        // The user was told the import repaired identity conflicts.
        expect(knowledgeState._lastKtStatusLevel).toBe('success');
        expect(knowledgeState._lastKtStatusMsg).toContain('canonicalized');
    });
});

// ─── canonicalizeRegistryIdentityClaims (schema) ──────────────────────────────

describe('canonicalizeRegistryIdentityClaims', () => {
    // Pure function — no SillyTavern stubs needed, but silence the console so
    // nothing depends on the spies the Knowledge describe installs.
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => vi.restoreAllMocks());

    test('first claimant keeps the entityId; later claimants lose the claim with the store issue code', () => {
        const registry = {
            Mara: { uid: 1, entityId: 'mwt_same', aliases: [] },
            Sophie: { uid: 2, entityId: 'mwt_same', aliases: [] },
        };
        const issues = canonicalizeRegistryIdentityClaims(registry);
        expect(registry.Mara.entityId).toBe('mwt_same');
        expect(registry.Sophie.entityId).toBeUndefined();
        expect(issues).toHaveLength(1);
        expect(issues[0].code).toBe('registry-duplicate-entity-id');
        expect(issues[0].path).toEqual(['registry', 'Sophie', 'entityId']);
    });

    test('aliases colliding with a canonical key or another alias are stripped (first claim wins)', () => {
        const registry = {
            Mara: { uid: 1, entityId: 'mwt_a', aliases: ['The Vixen'] },
            Sophie: { uid: 2, entityId: 'mwt_b', aliases: ['Mara', 'the vixen', 'Soph'] },
        };
        const issues = canonicalizeRegistryIdentityClaims(registry);
        // 'Mara' hits the canonical key; 'the vixen' collides (normalized) with
        // Mara's alias. Sophie keeps only 'Soph'; Mara's own alias is untouched.
        expect(registry.Sophie.aliases).toEqual(['Soph']);
        expect(registry.Mara.aliases).toEqual(['The Vixen']);
        expect(issues.map(i => i.code)).toEqual(['registry-alias-collision', 'registry-alias-collision']);
    });

    test('a malformed merge trail is stripped while the record stays live', () => {
        const registry = {
            Mara: { uid: 1, entityId: 'mwt_a', aliases: [], mergedFrom: 'not-a-trail' },
        };
        const issues = canonicalizeRegistryIdentityClaims(registry);
        expect(registry.Mara.mergedFrom).toBeUndefined();
        expect(registry.Mara.entityId).toBe('mwt_a'); // rest of the record intact
        expect(issues.map(i => i.code)).toEqual(['registry-merged-from-invalid']);
    });
});

