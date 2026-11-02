/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetCoreStubs } from './stubs/core.js';
import { installCleanupFetch } from './stubs/cleanup-fetch.js';
import { state } from '../knowledge/state.js';
import { saveSettings } from '../knowledge/settings.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { getRegistry } from '../knowledge/registry.js';
import * as lorebook from '../knowledge/lorebook.js';
import { formatRelationshipBlock, injectRelationshipBlock, setStance, stripRelationshipBlock } from '../knowledge/relationships.js';
import { loadForManualEdit, saveManualEdit } from '../knowledge/manual_edit.js';
import { renderNpcsSubTab } from '../knowledge/render.js';
import { captureHistoryContext, prepareVectFoxHistory } from '../knowledge/vectfox_history.js';

vi.mock('../knowledge/lorebook.js', async importOriginal => {
    const actual = await importOriginal();
    return { ...actual, loadEntryContent: vi.fn(actual.loadEntryContent),
        enrichStagingItem: vi.fn(actual.enrichStagingItem),
        writeStateTracker: vi.fn(actual.writeStateTracker),
        writeToLorebook: vi.fn(actual.writeToLorebook) };
});

const BOOK = 'Knowledge Tracker';
const NAME = 'Mara Voss';
const BODY = `${NAME} | Human | harbourmaster\nTone: brisk\nFirst seen: quay`;
const FRESH = `${BODY}\nManual correction`;
let host, disk, el;
const entry = () => disk.entries[0];

function proposal(overrides = {}) {
    return { id: 'proposal', type: 'minor', action: 'update', name: NAME, uid: 0,
        existingContent: BODY, mergedContent: BODY.replace('brisk', 'wry'),
        proposedContent: BODY.replace('brisk', 'wry'), keywords: [NAME],
        fields: { tone: 'wry' }, newKnowledge: [], ...overrides };
}

function show(items) {
    state.stagingItems = items;
    state.activeItemId = items[0]?.id;
    state.activeSubTab = 'staging';
    for (const item of items) state.notificationEntries[item.id] = { item, ts: 1, read: false };
    renderNpcsSubTab();
}

async function click(selector = '#kt-accept') {
    const button = el.querySelector(selector);
    button.click();
    await vi.waitFor(() => expect(button.isConnected && button.disabled).toBe(false));
}

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    saveSettings({ scope: 'global' });
    _setCacheForTests(BOOK, { registry: { [NAME]: { uid: 0, entityId: 'mara', type: 'minor', keywords: [NAME] } } });
    disk = { entries: { 0: { uid: 0, comment: NAME, content: FRESH, key: [NAME] } } };
    host = { worldInfoCache: new Map(),
        loadWorldInfo: vi.fn(async () => structuredClone(disk)),
        saveWorldInfo: vi.fn(async (_name, wi) => { disk = structuredClone(wi); }) };
    state.wiScript = host;
    installCleanupFetch(host);
    state.notificationEntries = {};
    state._lastKtStatusMsg = '';
    el = document.createElement('div');
    document.body.append(el);
    state.npcsContentEl = el;
    state.modal = document.body;
    localStorage.clear();
    vi.stubGlobal('confirm', vi.fn(() => true));
});

afterEach(() => {
    _clearCacheForTests();
    state.wiScript = null;
    state.npcsContentEl = null;
    state.modal = null;
    state.stagingItems = [];
    state.notificationEntries = {};
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('NPC proposal freshness', () => {
    test.each(['#kt-accept', '#kt-batch-accept'])('%s checks disk even when the host cache still holds the baseline', async selector => {
        const cached = structuredClone(disk);
        cached.entries[0].content = BODY;
        host.worldInfoCache.set(BOOK, cached);
        host.loadWorldInfo.mockImplementation(async () => structuredClone(cached));
        const fallback = globalThis.fetch;
        vi.stubGlobal('fetch', vi.fn(async (path, options) => {
            if (path === '/api/worldinfo/get') {
                return { ok: true, status: 200, json: async () => structuredClone(disk) };
            }
            return fallback(path, options);
        }));
        const item = proposal();
        show([item]);
        await click(selector);
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        expect(lorebook.getHistory(0, BOOK)).toEqual([]);
        expect(state.stagingItems).toEqual([item]);
        expect(item.existingContent).toBe(FRESH);
        expect(item.mergedContent).toBe(FRESH.replace('brisk', 'wry'));
        expect(el.querySelector('.kt-detail-current').textContent).toBe(FRESH);
        expect(el.textContent).toContain('Nothing was written');
        expect(entry().content).toBe(FRESH);
        expect(host.worldInfoCache.get(BOOK)).toEqual(cached);
    });

    test.each([
        ['Scan', {}], ['Update', { data: {} }],
        ['Promote', { type: 'promote' }], ['Demote', { type: 'demote' }],
        ['Enrich', { refreshFields: ['tone'] }], ['Fields', { refreshFields: [] }],
        ['hand-edited Scan', { edited: true }], ['hand-edited Promote', { type: 'promote', edited: true }],
    ])('%s stays pending on first stale Accept and accepts only after review', async (_label, overrides) => {
        const item = proposal(overrides);
        const original = item.mergedContent;
        show([item]);
        await click();
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        expect(lorebook.getHistory(0, BOOK)).toEqual([]);
        expect(state.stagingItems).toEqual([item]);
        expect(state.activeItemId).toBe(item.id);
        expect(state.notificationEntries[item.id].read).toBe(false);
        expect(stripRelationshipBlock(item.existingContent)).toBe(FRESH);
        expect(el.querySelector('.kt-detail-current').textContent).toBe(FRESH);
        expect(el.textContent).toContain('Nothing was written');
        if (item.edited || item.refreshFields) expect(item.mergedContent).toBe(original);
        else if (item.type === 'promote') expect(item.mergedContent).toBe(lorebook.buildPromotedContent(FRESH));
        else if (item.type === 'demote') expect(item.mergedContent).toBe(lorebook.buildDemotedContent(FRESH));
        else expect(item.mergedContent).toBe(FRESH.replace('brisk', 'wry'));
        const reviewed = item.mergedContent;
        await click();
        expect(state.stagingItems).toEqual([]);
        expect(entry().content).toBe(reviewed);
        expect(state.notificationEntries[item.id]).toBeUndefined();
    });

    test('a second intervening edit requires another review, not a warning bypass', async () => {
        const item = proposal();
        show([item]);
        await click();
        entry().content += '\nAnother edit';
        await click();
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        expect(item.existingContent).toContain('Another edit');
        await click();
        expect(entry().content).toContain('Another edit');
        expect(state.stagingItems).toEqual([]);
    });

    test.each(['matching', 'relationship-only', 'trimmed'])('%s baseline accepts without a stale warning', async kind => {
        entry().content = kind === 'relationship-only' ? injectRelationshipBlock(BODY, 'new relationship') : BODY;
        const baseline = kind === 'relationship-only' ? injectRelationshipBlock(BODY, 'old relationship')
            : kind === 'trimmed' ? ` \n${BODY}\n ` : BODY;
        show([proposal({ existingContent: baseline })]);
        await click();
        expect(state.stagingItems).toEqual([]);
        expect(host.saveWorldInfo).toHaveBeenCalledOnce();
    });

    test.each(['missing', 'identity', 'failed read', 'missing uid', 'HTTP failure', 'invalid response'])('%s refuses an unverifiable baseline', async kind => {
        const item = proposal();
        if (kind === 'missing') delete disk.entries[0];
        if (kind === 'identity') entry().comment = 'Other NPC';
        if (kind === 'failed read') host.loadWorldInfo.mockRejectedValue(new Error('offline'));
        if (kind === 'missing uid') item.uid = null;
        if (kind === 'HTTP failure') vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })));
        if (kind === 'invalid response') vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
        show([item]);
        await click();
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        expect(state.stagingItems).toEqual([item]);
        expect(item.existingContent).toBe(BODY);
        expect(state._lastKtStatusMsg).toContain('cannot load or verify');
    });

    test.each(['unavailable', 'throws'])('failed re-merge (%s) restores the old non-null baseline and proposal', async kind => {
        const item = proposal();
        const original = { ...item };
        if (kind === 'throws') lorebook.enrichStagingItem.mockRejectedValueOnce(new Error('merge failed'));
        else lorebook.enrichStagingItem.mockResolvedValueOnce(undefined);
        show([item]);
        await click();
        expect(item).toEqual(original);
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        await click();
        expect(item.existingContent).toBe(FRESH);
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
    });

    test.each(['unenriched', 'new'])('%s null baseline preserves the existing acceptance path', async kind => {
        const item = proposal({ existingContent: null,
            ...(kind === 'new' ? { uid: null, action: 'create', name: 'Tam', keywords: ['Tam'] } : {}) });
        show([item]);
        await click();
        expect(state.stagingItems).toEqual([]);
        expect(lorebook.loadEntryContent).not.toHaveBeenCalled();
        expect(host.saveWorldInfo).toHaveBeenCalledOnce();
    });

    test('editor input is preserved while the comparison and diff are refreshed', async () => {
        const item = proposal();
        show([item]);
        const editor = el.querySelector('#kt-proposal-editor');
        editor.value = `${BODY}\nReviewer draft`;
        editor.dispatchEvent(new Event('input'));
        await click();
        expect(item.edited).toBe(true);
        expect(el.querySelector('#kt-proposal-editor').value).toContain('Reviewer draft');
        expect(el.querySelector('.kt-detail-diff').textContent).toContain('Manual correction');
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
    });

    test.each(['#kt-accept', '#kt-batch-accept'])('Phase 1 keyword-only save is used by later %s', async selector => {
        entry().content = BODY;
        const item = proposal();
        show([item]);
        const { session } = await loadForManualEdit({ name: NAME, uid: 0 });
        expect((await saveManualEdit({ session, body: BODY, keywords: 'port, harbour' })).ok).toBe(true);
        expect(item.keywords).toEqual(['port', 'harbour']);
        await click(selector);
        expect(entry().key).toEqual(['port', 'harbour']);
        expect(getRegistry()[NAME].keywords).toEqual(['port', 'harbour']);
        expect(state.stagingItems).toEqual([]);
    });

    test('explicit reviewer keyword changes still override synchronized keywords', async () => {
        entry().content = BODY;
        const item = proposal();
        show([item]);
        item.keywords = ['synchronized'];
        el.querySelector('#kt-keyword-input').value = 'reviewer, choice';
        await click();
        expect(entry().key).toEqual(['reviewer', 'choice']);
    });

    test('State Tracker bypasses NPC freshness checks and reports a failed write honestly', async () => {
        const item = proposal({ type: 'state' });
        lorebook.writeStateTracker.mockResolvedValueOnce({ success: false, error: 'offline' });
        show([item]);
        await click('#kt-batch-accept');
        expect(lorebook.loadEntryContent).not.toHaveBeenCalled();
        expect(lorebook.writeStateTracker).toHaveBeenCalledOnce();
        expect(state.stagingItems).toEqual([item]);
        expect(state._lastKtStatusMsg).toContain('0 accepted · 0 stale/pending');
        expect(state._lastKtStatusMsg).toContain('1 failed');
    });

    test.each(['refusal', 'throw'])('NPC write %s stays pending and is counted as failed', async kind => {
        entry().content = BODY;
        if (kind === 'refusal') lorebook.writeToLorebook.mockResolvedValueOnce({ success: false, error: 'refused' });
        else lorebook.writeToLorebook.mockRejectedValueOnce(new Error('write failed'));
        show([proposal()]);
        await click('#kt-batch-accept');
        expect(state.stagingItems).toHaveLength(1);
        expect(state._lastKtStatusMsg).toContain('1 failed');
        expect(state._lastKtStatusMsg).toContain('0 accepted');
    });

    test('mixed Accept All counts accepted, stale, failed and skipped without removing pending bookkeeping', async () => {
        const items = [proposal({ id: 'accepted', existingContent: FRESH }),
            proposal({ id: 'stale' }),
            proposal({ id: 'failed', uid: 99 }),
            proposal({ id: 'skipped', mergedContent: '', proposedContent: '(Fetch to see changes)' })];
        show(items);
        state.activeItemId = 'stale';
        renderNpcsSubTab();
        await click('#kt-batch-accept');
        expect(state._lastKtStatusMsg).toContain('1 accepted · 1 stale/pending');
        expect(state._lastKtStatusMsg).toContain('1 failed · 1 skipped');
        expect(state.stagingItems.map(item => item.id)).toEqual(['stale', 'failed', 'skipped']);
        expect(state.activeItemId).toBe('stale');
        expect(Object.keys(state.notificationEntries)).toEqual(['stale', 'failed', 'skipped']);
        expect(host.saveWorldInfo).toHaveBeenCalledOnce();
    });
});

describe('VectFox proposals with manual-edit acceptance safeguards', () => {
    const historyBody = `[Dossier] ${BODY}\nBackground: Unknown`;
    let sourceStatus, scopeToken;

    beforeEach(() => {
        entry().content = historyBody;
        getRegistry()[NAME].type = 'major';
        sourceStatus = 'verified';
        scopeToken = 'history-scope';
        window.VectFoxAPI = {
            version: 1,
            getStatus: () => ({ ready: true, scope_token: scopeToken,
                capabilities: { history: { available: true }, source_resolution: { available: true } } }),
            findEvents: async () => ({ ok: true, scope_token: scopeToken, coverage: { partial: true },
                events: [{ event_ref: 'vf:introduction', event_type: 'character_introduction',
                    summary: 'Mara served at the northern port.', characters: [NAME],
                    source_refs: [{ ref: 'source:introduction', event_ref: 'vf:introduction' }] }] }),
            resolveSources: async ({ sources }) => ({ ok: true, scope_token: scopeToken,
                sources: sources.map(source => ({ ...source, status: sourceStatus, current_fingerprint: 'original' })) }),
        };
    });

    afterEach(() => { delete window.VectFoxAPI; });

    async function historicalProposal() {
        const historyEvidence = await prepareVectFoxHistory(captureHistoryContext(NAME, 0), ['background']);
        const text = historyBody.replace('Background: Unknown', 'Background: Served at the northern port.');
        return proposal({ type: 'major', dossierMode: true, existingContent: historyBody,
            proposedContent: text, mergedContent: text, fields: { background: 'Served at the northern port.' },
            refreshFields: ['background'], historyEvidence, historyRevision: historyBody });
    }

    test.each(['#kt-accept', '#kt-batch-accept'])('%s keeps the relationship graph current through the final guarded read', async selector => {
        const item = await historicalProposal();
        setStance(NAME, 'wary');
        let reads = 0;
        host.loadWorldInfo.mockImplementation(async () => {
            if (++reads === 2) setStance(NAME, 'friendly');
            return structuredClone(disk);
        });
        show([item]);
        expect(el.textContent).toContain('VectFox supporting history');
        expect(el.textContent).toContain('Partial archive coverage');
        await click(selector);
        expect(state.stagingItems).toEqual([]);
        expect(host.saveWorldInfo).toHaveBeenCalledOnce();
        expect(entry().content).toBe(injectRelationshipBlock(item.mergedContent, formatRelationshipBlock(NAME)));
        expect(entry().content).toContain('friendly');
        expect(lorebook.getHistory(0, BOOK).map(record => record.content)).toEqual([historyBody]);
    });

    test('Accept All counts a changed historical source as failed and retains the proposal', async () => {
        const item = await historicalProposal();
        sourceStatus = 'changed';
        show([item]);
        await click('#kt-batch-accept');
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        expect(state.stagingItems).toEqual([item]);
        expect(state._lastKtStatusMsg).toContain('0 accepted · 0 stale/pending');
        expect(state._lastKtStatusMsg).toContain('1 failed');
        expect(lorebook.getHistory(0, BOOK)).toEqual([]);
    });

    test.each(['revision', 'scope'])('the final history guard still refuses a %s change after the freshness check', async kind => {
        const item = await historicalProposal();
        let reads = 0;
        host.loadWorldInfo.mockImplementation(async () => {
            if (++reads === 2) {
                if (kind === 'revision') entry().content += '\nManual correction';
                else scopeToken = 'different-scope';
            }
            return structuredClone(disk);
        });
        show([item]);
        await click();
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        expect(state.stagingItems).toEqual([item]);
        expect(state._lastKtStatusMsg).toMatch(kind === 'revision' ? /revision/ : /scope changed/);
        expect(lorebook.getHistory(0, BOOK)).toEqual([]);
    });

    test('reviewing a stale proposal cannot bypass its original history revision guard', async () => {
        const item = await historicalProposal();
        entry().content += '\nManual correction';
        show([item]);
        await click();
        expect(item.staleWarning).toContain('Nothing was written');
        expect(item.mergedContent).toContain('Served at the northern port');
        await click();
        expect(host.saveWorldInfo).not.toHaveBeenCalled();
        expect(state.stagingItems).toEqual([item]);
        expect(state._lastKtStatusMsg).toContain('revision');
        expect(lorebook.getHistory(0, BOOK)).toEqual([]);
    });
});
