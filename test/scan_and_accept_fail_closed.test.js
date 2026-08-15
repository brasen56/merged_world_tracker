/**
 * test/scan_and_accept_fail_closed.test.js — the unattended accept path.
 *
 * scanAndAccept() writes without user review, so it must fail closed. The
 * interactive UI refuses to write a proposal whose content is still a
 * placeholder; this path did not, and the result was worse than a no-op:
 * when enrichStagingItem() refuses a mismatched uid (registry says "Mikhail",
 * the entry is labelled "Marcus"), the proposal keeps its "(Fetch to see
 * changes)" text — and writing that detached the uid and created a brand-new
 * entry whose entire body was that literal string.
 *
 * Lives in its own file because it mocks runScan(), which the rest of the
 * knowledge suite needs for real.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { resetCoreStubs } from './stubs/core.js';
import { state } from '../knowledge/state.js';
import { saveSettings as saveKnowledgeSettings } from '../knowledge/settings.js';
import { _setCacheForTests, _clearCacheForTests, isStoreEntry } from '../knowledge/store.js';
import { getRegistry } from '../knowledge/registry.js';

const runScanMock = vi.fn();

vi.mock('../knowledge/lorebook.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, runScan: (...args) => runScanMock(...args) };
});

const { scanAndAccept } = await import('../knowledge/index.js');

function makeFakeWorldInfo() {
    const books = new Map();
    return {
        books,
        async loadWorldInfo(name) {
            return books.has(name) ? structuredClone(books.get(name)) : null;
        },
        async saveWorldInfo(name, wi, immediately = false) {
            if (immediately) books.set(name, structuredClone(wi));
        },
        async createNewWorldInfo(name) {
            books.set(name, { entries: {} });
            return true;
        },
    };
}

let wiFake;

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    saveKnowledgeSettings({ scope: 'global' });
    wiFake = makeFakeWorldInfo();
    state.wiScript = wiFake;
    state.stagingItems = [];
    runScanMock.mockReset();
    globalThis.document = {
        dispatchEvent: vi.fn(),
        getElementById: () => null,
        querySelectorAll: () => [],
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    _clearCacheForTests();
    state.wiScript = null;
});

function seedRegistry(registry) {
    _setCacheForTests('Knowledge Tracker', { registry });
}

function emptyScan() {
    return { new_minor: [], new_major: [], update_minor: [], update_major: [] };
}

function npcEntries() {
    const entries = wiFake.books.get('Knowledge Tracker')?.entries || {};
    return Object.values(entries).filter(e => !isStoreEntry(e));
}

describe('scanAndAccept fails closed', () => {
    test('an unverifiable uid is skipped — no placeholder entry is created', async () => {
        // The Mikhail/Marcus symptom, end to end.
        seedRegistry({ Mikhail: { uid: 3, type: 'minor', keywords: ['Mikhail'] } });
        wiFake.books.set('Knowledge Tracker', {
            entries: { 3: { uid: 3, comment: 'Marcus', key: ['Marcus'], content: 'Marcus dossier' } },
        });
        runScanMock.mockResolvedValue({
            ...emptyScan(),
            update_minor: [{ name: 'Mikhail', fields: { tone: 'calm' } }],
        });

        const items = await scanAndAccept();

        expect(items).toHaveLength(1);
        expect(items[0].accepted).toBeUndefined();
        expect(items[0].skipReason).toMatch(/could not be verified/);
        // Nothing written: Marcus untouched, and no new entry minted.
        expect(npcEntries()).toHaveLength(1);
        expect(wiFake.books.get('Knowledge Tracker').entries[3].content).toBe('Marcus dossier');
    });

    test('no entry in the book anywhere ever contains the placeholder text', async () => {
        seedRegistry({ Mikhail: { uid: 3, type: 'minor', keywords: ['Mikhail'] } });
        wiFake.books.set('Knowledge Tracker', {
            entries: { 3: { uid: 3, comment: 'Marcus', key: ['Marcus'], content: 'Marcus dossier' } },
        });
        runScanMock.mockResolvedValue({
            ...emptyScan(),
            update_minor: [{ name: 'Mikhail', fields: { tone: 'calm' } }],
        });

        await scanAndAccept();

        for (const entry of npcEntries()) {
            expect(String(entry.content)).not.toContain('(Fetch to see changes)');
        }
    });

    test('a verifiable update is still written normally', async () => {
        seedRegistry({ Mikhail: { uid: 3, type: 'minor', keywords: ['Mikhail'] } });
        wiFake.books.set('Knowledge Tracker', {
            entries: { 3: {
                uid: 3, comment: 'Mikhail', key: ['Mikhail'],
                content: 'Mikhail | Human | smith\nTone: gruff\nPerceived as: blunt\nFirst seen: forge',
            } },
        });
        runScanMock.mockResolvedValue({
            ...emptyScan(),
            update_minor: [{ name: 'Mikhail', fields: { tone: 'calm' } }],
        });

        const items = await scanAndAccept();

        expect(items[0].accepted).toBe(true);
        expect(items[0].skipReason).toBeUndefined();
        expect(wiFake.books.get('Knowledge Tracker').entries[3].content).toContain('Tone: calm');
    });

    test('accepting preserves profileUid instead of wiping it', async () => {
        // A wholesale `reg[key] = {...}` dropped profileUid, and a lost
        // profileUid makes the next profile save create a SECOND profile entry.
        seedRegistry({ Mikhail: { uid: 3, type: 'minor', keywords: ['Mikhail'], profileUid: 99 } });
        wiFake.books.set('Knowledge Tracker', {
            entries: { 3: {
                uid: 3, comment: 'Mikhail', key: ['Mikhail'],
                content: 'Mikhail | Human | smith\nTone: gruff\nPerceived as: blunt\nFirst seen: forge',
            } },
        });
        runScanMock.mockResolvedValue({
            ...emptyScan(),
            update_minor: [{ name: 'Mikhail', fields: { tone: 'calm' } }],
        });

        await scanAndAccept();

        expect(getRegistry().Mikhail.profileUid).toBe(99);
    });

    test('an orphan create adopts the existing entry rather than duplicating', async () => {
        seedRegistry({ Sophie: { uid: null, type: 'minor', keywords: ['Sophie'] } });
        wiFake.books.set('Knowledge Tracker', {
            entries: { 0: {
                uid: 0, comment: 'Sophie', key: ['Sophie'],
                content: 'Sophie | Human | front desk\nTone: brisk\nPerceived as: clerk\nFirst seen: lobby',
            } },
        });
        runScanMock.mockResolvedValue({
            ...emptyScan(),
            new_minor: [{ name: 'Sophie Simpson', tone: 'weary' }],
        });

        const items = await scanAndAccept();

        expect(items[0].accepted).toBe(true);
        expect(npcEntries()).toHaveLength(1);
        const reg = getRegistry();
        expect(Object.keys(reg)).toEqual(['Sophie']);
        expect(reg.Sophie.uid).toBe(0);
        // Merged, not overwritten with a synthesized stub.
        const content = wiFake.books.get('Knowledge Tracker').entries[0].content;
        expect(content).toContain('Tone: weary');
        expect(content).toContain('Perceived as: clerk');
    });
});
