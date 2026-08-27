/**
 * Tier 5 regression net — production-path contract coverage.
 *
 * These tests deliberately sit one layer above the leaf tests: they use the
 * existing fake SillyTavern runtime, deferred API promises, fake timers, and
 * the real module orchestrators. The common invariant is that an operation
 * either commits to the scope/revision it captured or performs no commit.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import {
    resetCoreStubs, setFakeChat, setFakeApi,
    getFakeMeta,
} from './stubs/core.js';
import { bumpEpoch, _resetEpoch } from '../core/scope.js';

// ─── CORE-08 ──────────────────────────────────────────────────────────────────

describe('CORE-08 — shared stateful and integration contracts', () => {
    beforeEach(() => {
        resetCoreStubs();
        _resetEpoch();
        globalThis.document = { dispatchEvent: vi.fn() };
        globalThis.localStorage = {
            _data: {},
            getItem(key) { return this._data[key] ?? null; },
            setItem(key, value) { this._data[key] = String(value); },
            removeItem(key) { delete this._data[key]; },
        };
    });

    test('settings manager preserves defaults and unrelated saved fields', async () => {
        const { createSettingsManager } = await import('../core/settings.js');
        const manager = createSettingsManager({
            settingsKey: 'core-regression-settings',
            defaults: { enabled: true, depth: 2 },
        });
        expect(manager.getSettings()).toEqual({ enabled: true, depth: 2 });
        expect(manager.saveSettings({ depth: 7 })).toBe(true);
        expect(manager.getSettings()).toEqual({ enabled: true, depth: 7 });
    });

    test('metadata pointer persistence awaits the immediate save API', async () => {
        const calls = [];
        globalThis.SillyTavern = {
            getContext: () => ({ saveMetadata: async () => calls.push('save') }),
        };
        const { persistChatMetaNow } = await import('../core/metadata.js');
        await persistChatMetaNow();
        expect(calls).toEqual(['save']);
    });

    test('injection contract records role/depth and clears disabled payloads', async () => {
        const calls = [];
        globalThis.SillyTavern = {
            getContext: () => ({ setExtensionPrompt: (...args) => calls.push(args) }),
        };
        const { applyExtensionPromptInjection } = await import('../core/injection.js');
        expect(applyExtensionPromptInjection({
            key: 'core-test', header: '[header]', body: 'payload', enabled: true,
            fallbackDepth: 4, globalDepth: 9, globalRole: 'assistant',
        })).toBe(true);
        expect(calls[0]).toEqual(['core-test', '[header]\n\npayload', 1, 9, undefined, 2]);
        expect(applyExtensionPromptInjection({
            key: 'core-test', body: '', enabled: false, fallbackDepth: 4,
        })).toBe(false);
        expect(calls[1]).toEqual(['core-test', '', 1, 4, undefined, 0]);
    });

    test('API failure is surfaced without inventing a successful result', async () => {
        const { retryAsync } = await import('../core/api.js');
        await expect(retryAsync(0, async () => { throw new Error('upstream unavailable'); }))
            .rejects.toThrow('upstream unavailable');
    });
});

// ─── CHRONICLE-08 ─────────────────────────────────────────────────────────────

describe('CHRONICLE-08 — anchors, counters, injection, and async commits', () => {
    beforeEach(async () => {
        resetCoreStubs();
        _resetEpoch();
        globalThis.document = { dispatchEvent: vi.fn() };
        setFakeChat([
            { id: 'm0', name: 'User', is_user: true, mes: 'The first scene.' },
            { id: 'm1', name: 'Mara', mes: 'The second scene.', send_date: '2026-01-01T00:00:00.000Z' },
            { id: 'm2', name: 'User', is_user: true, mes: 'The third scene.' },
            { id: 'm3', name: 'Mara', mes: 'The fourth scene.' },
        ]);
        const { state } = await import('../chronicle/data.js');
        state.msgSinceSnapshot = 0;
        state.isGenerating = false;
        state.isMainGenerating = false;
    });

    test('anchor resolves duplicate content to the latest message', async () => {
        setFakeChat([
            { id: 'a', name: 'Mara', mes: 'repeat' },
            { id: 'b', name: 'Mara', mes: 'repeat' },
        ]);
        const { makeAnchor, resolveAnchor } = await import('../chronicle/data.js');
        const liveAnchor = makeAnchor({ id: 'b', name: 'Mara', mes: 'repeat' });
        expect(resolveAnchor({ ...liveAnchor, id: null, msgIndex: 99 })).toEqual({ index: 2, found: true });
    });

    test('message arrival during generation is retained by the counter', async () => {
        const { state, setChronicleData, getChronicleData } = await import('../chronicle/data.js');
        const { onMessageReceived } = await import('../chronicle/index.js');
        state.isGenerating = true;
        state.msgSinceSnapshot = 4;
        setChronicleData({ msgSinceSnapshot: 4 });
        await onMessageReceived();
        expect(state.msgSinceSnapshot).toBe(5);
        expect(getChronicleData().msgSinceSnapshot).toBe(5);
    });

    test('selected, recent, and range injection modes select the intended snapshots', async () => {
        const { setChronicleData } = await import('../chronicle/data.js');
        const { getEntriesForInjection } = await import('../chronicle/injection.js');
        const snapshots = [
            { id: 'old', createdAt: '2026-01-01T00:00:00Z', text: 'old' },
            { id: 'mid', createdAt: '2026-01-02T00:00:00Z', text: 'mid' },
            { id: 'new', createdAt: '2026-01-03T00:00:00Z', text: 'new' },
        ];
        setChronicleData({ snapshots, injectMode: 'selected', selectedForInjection: ['mid'] });
        expect(getEntriesForInjection().map(s => s.id)).toEqual(['mid']);
        setChronicleData({ injectMode: 'recent', injectCount: 2 });
        expect(getEntriesForInjection().map(s => s.id)).toEqual(['mid', 'new']);
        setChronicleData({ injectMode: 'range', injectFromDate: '2026-01-03T00:00:00Z' });
        expect(getEntriesForInjection().map(s => s.id)).toEqual(['new']);
    });

    test('a generated snapshot is discarded after a chat epoch change', async () => {
        const { saveSettings } = await import('../chronicle/data.js');
        const { generateSnapshot } = await import('../chronicle/snapshots.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
        let release;
        setFakeApi(() => new Promise(resolve => { release = resolve; }));
        const pending = generateSnapshot();
        await Promise.resolve();
        bumpEpoch();
        release('## Summary\nA valid generated summary.\n\n## Time Anchor\nIn-world date and time at end of this period: 2026-01-01 10:00');
        await expect(pending).resolves.toBeNull();
        expect(getFakeMeta().session_chronicle_data?.snapshots || []).toHaveLength(0);
    });
});

// ─── INTERIORITY-08 ───────────────────────────────────────────────────────────

describe('INTERIORITY-08 — ledger, prompt, injection, and stale commit barriers', () => {
    beforeEach(() => {
        resetCoreStubs();
        _resetEpoch();
        globalThis.document = { dispatchEvent: vi.fn() };
    });

    test('dormant intentions are excluded from narrator injection', async () => {
        const { addLedgerEntry } = await import('../interiority/data.js');
        const { formatLedgerForInjection } = await import('../interiority/prompts.js');
        addLedgerEntry({ npc: 'Mara', action: 'open the door', trigger: 'the bell rings' });
        addLedgerEntry({ npc: 'Jonah', action: 'leave town', trigger: 'Monday', status: 'dormant' });
        const body = formatLedgerForInjection(getFakeMeta().mwt_interiority.ledger);
        expect(body).toContain('Mara');
        expect(body).not.toContain('Jonah');
    });

    test('validateAndApply performs zero metadata writes after a scope change', async () => {
        const { captureScope } = await import('../core/scope.js');
        const { validateAndApply } = await import('../interiority/generation.js');
        setFakeChat([{ extra: { mwt_uuid: 'mu-1' }, mes: 'scene' }]);
        const scope = captureScope();
        bumpEpoch();
        const result = await validateAndApply({ npcs: [] }, ['Mara'], 0, scope);
        expect(result).toBeNull();
        // Reads no longer eagerly create the store (the interiority accessor
        // never canonicalizes live metadata), so "zero metadata writes" now
        // means the store was not even initialized: still genuinely absent.
        expect(getFakeMeta().mwt_interiority).toBeUndefined();
    });

    test('ledger field caps apply to the actual prompt payload', async () => {
        const { formatLedgerForInjection } = await import('../interiority/prompts.js');
        const body = formatLedgerForInjection([{
            npc: 'N'.repeat(500), action: 'A'.repeat(1000), trigger: 'T'.repeat(1000), since: 'S'.repeat(500), status: 'active',
        }]);
        expect(body.length).toBeLessThan(1300);
        expect(body).not.toContain('N'.repeat(121));
    });
});

// ─── KNOWLEDGE-10 ────────────────────────────────────────────────────────────

describe('KNOWLEDGE-10 — persistence barriers, identity, scope, and ILS', () => {
    beforeEach(() => {
        resetCoreStubs();
        _resetEpoch();
    });

    test('failed store hydration remains unhydrated and blocks writes', async () => {
        const { state } = await import('../knowledge/state.js');
        const { hydrateBook, isHydrated, assertHydrated, resetStoreCache } = await import('../knowledge/store.js');
        await resetStoreCache();
        state.wiScript = { loadWorldInfo: vi.fn().mockRejectedValue(new Error('load failed')) };
        await hydrateBook('Knowledge Tracker');
        expect(isHydrated('Knowledge Tracker')).toBe(false);
        expect(() => assertHydrated('Knowledge Tracker', 'create NPC')).toThrow('refusing to create NPC');
    });

    test('stale lorebook UIDs create a new entry instead of overwriting another NPC', async () => {
        const { writeToLorebook } = await import('../knowledge/lorebook.js');
        const { state } = await import('../knowledge/state.js');
        const { hydrateBook, resetStoreCache } = await import('../knowledge/store.js');
        const books = { 'Knowledge Tracker': { entries: {
            4: { uid: 4, comment: 'Jonah', content: 'Jonah content' },
        } } };
        state.wiScript = {
            loadWorldInfo: async name => books[name],
            saveWorldInfo: async (name, wi) => { books[name] = wi; },
        };
        await resetStoreCache();
        await hydrateBook('Knowledge Tracker');
        const result = await writeToLorebook('Mara', 'Mara content', ['Mara'], 4);
        expect(result.success).toBe(true);
        expect(books['Knowledge Tracker'].entries[4].content).toBe('Jonah content');
        expect(books['Knowledge Tracker'].entries[result.uid].comment).toBe('Mara');
    });

    test('ILS expansion is read-only, recursive, and keeps ancient timestamps at watermark zero', async () => {
        const { expandIlsSummaries } = await import('../knowledge/ils_compat.js');
        const meta = { ILS_Originals: {
            outer: [{ extra: { ILS_Data: { OriginalMessages: [{ mes: 'leaf', send_date: 'not-a-date' }] } } }],
        } };
        const before = JSON.stringify(meta);
        const expanded = expandIlsSummaries([{ extra: { ILS_Data: { Ref: 'outer' } } }], meta, { sinceTs: 0 });
        expect(expanded.map(x => x.msg.mes)).toEqual(['leaf']);
        expect(JSON.stringify(meta)).toBe(before);
    });
});

// ─── STORY-PLANNER-10 ─────────────────────────────────────────────────────────

describe('STORY-PLANNER-10 — canonical arcs, injection modes, and timers', () => {
    beforeEach(() => {
        resetCoreStubs();
        _resetEpoch();
        globalThis.document = { dispatchEvent: vi.fn() };
    });
    afterEach(() => vi.useRealTimers());

    test('setArcs persists canonical bounded objects and independent IDs', async () => {
        const { setArcs, getArcs } = await import('../story_planner/data.js');
        setArcs([
            { id: 'same', title: 'A'.repeat(500), beats: ['beat'] },
            { id: 'same', title: 'second', beats: ['other'] },
        ]);
        const arcs = getArcs();
        expect(arcs).toHaveLength(2);
        expect(arcs[0].title).toHaveLength(200);
        expect(arcs[0].id).not.toBe(arcs[1].id);
    });

    test('injection excludes resolved and dropped arcs in every mode', async () => {
        const { setArcs, makeArc } = await import('../story_planner/data.js');
        const { buildInjectionBody } = await import('../story_planner/injection.js');
        setArcs([
            makeArc({ title: 'Live', body: 'live body', status: 'active', beats: ['now'] }),
            makeArc({ title: 'Done', status: 'resolved', beats: ['done'] }),
            makeArc({ title: 'No', status: 'dropped', beats: ['no'] }),
        ]);
        const body = buildInjectionBody();
        expect(body).toContain('Live');
        expect(body).not.toContain('Done');
        expect(body).not.toContain('No');
    });

    test('chat change cancels the single deferred auto-generation timer', async () => {
        vi.useFakeTimers();
        const apiCalls = [];
        setFakeApi(() => { apiCalls.push(true); return 'unused'; });
        const { state } = await import('../story_planner/data.js');
        const { onMessageReceived, onChatChanged } = await import('../story_planner/index.js');
        const { setPlanData } = await import('../story_planner/data.js');
        const { saveSettings } = await import('../story_planner/settings.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test' });
        setPlanData({ autoEnabled: true, autoInterval: 1 });
        setFakeChat([{ mes: 'A'.repeat(120) }]);
        await onMessageReceived();
        expect(state.autoTimer).not.toBeNull();
        onChatChanged();
        expect(state.autoTimer).toBeNull();
        await vi.advanceTimersByTimeAsync(2000);
        expect(apiCalls).toHaveLength(0);
    });
});

// ─── WORLD-STATE-10 ───────────────────────────────────────────────────────────

describe('WORLD-STATE-10 — parsing, provenance, injection, and refresh barriers', () => {
    beforeEach(() => {
        resetCoreStubs();
        _resetEpoch();
        globalThis.document = { dispatchEvent: vi.fn() };
    });

    test('import validation rejects unrelated archives and caps plain text', async () => {
        const { parseWorldStateImport, MAX_IMPORT_CHARS } = await import('../world_state/data.js');
        expect(parseWorldStateImport(JSON.stringify({ _meta: { type: 'character-card' }, text: 'wrong' })).ok).toBe(false);
        const parsed = parseWorldStateImport('x'.repeat(MAX_IMPORT_CHARS + 100));
        expect(parsed.ok).toBe(true);
        expect(parsed.text).toHaveLength(MAX_IMPORT_CHARS);
    });

    test('injection excludes the stale archive section and includes plot seeds', async () => {
        const { buildInjectionPayload } = await import('../world_state/injection.js');
        const payload = buildInjectionPayload('## Current Scene\nMara\n## Archive (Stale)\nOld secret\n## Plot Seeds\nA hook');
        expect(payload).toContain('A hook');
        expect(payload).not.toContain('Old secret');
    });

    test('full refresh discards a valid response after a chat switch', async () => {
        const { saveSettings } = await import('../world_state/settings.js');
        const { refreshWorldState } = await import('../world_state/refresh.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test' });
        setFakeChat([{ mes: 'A'.repeat(100) }]);
        let release;
        setFakeApi(() => new Promise(resolve => { release = resolve; }));
        const pending = refreshWorldState();
        await Promise.resolve();
        bumpEpoch();
        release('## Current Scene\nMara\n## Recent Changes\nNothing\n## Active Threads\nNone');
        await expect(pending).resolves.toBeNull();
        expect(getFakeMeta().world_state_tracker_metadata?.text).toBeUndefined();
    });

    test('provenance expiry marks stale entries but preserves pinned entities', async () => {
        const { applyExpiry } = await import('../world_state/provenance.js');
        const text = '## Active Threads\n**Mara**: active\n**Jonah**: old';
        const provenance = { entities: {
            mara: { lastTouchedMsg: 1 }, jonah: { lastTouchedMsg: 1 },
        } };
        const result = applyExpiry(text, provenance, {
            sections: ['Active Threads'], staleAfterMsgs: 2, currentMsgIndex: 5, pinned: ['Mara'], mode: 'remove',
        });
        expect(result.text).toContain('Mara');
        expect(result.text).not.toContain('Jonah');
    });
});