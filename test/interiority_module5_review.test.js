/**
 * test/interiority_module5_review.test.js — Module 5 review probes.
 *
 * Regression tests for refused Interiority writes from the module review.
 *
 * M5-1/A: refused lifecycle closes preserve the entry and history.
 * M5-1/B + M5-2: refused wakes preserve the dormant entry and emit no
 * lifecycle diagnostics. The M5-3 duplicate-key probe was removed: sd-
 * last-wins is intentional (docs/TODO.md §0).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
    pauseStore,
    _setScopeKeyResolver,
    _resetPausedStores,
} from '../core/schema_status.js';
import { _resetDiagnostics, getEvents } from '../core/diagnostics.js';
import { _resetEpoch } from '../core/scope.js';

import {
    addLedgerEntry, setLedgerEntryDormant, getLedger, removeLedgerEntries,
} from '../interiority/data.js';
import {
    markLedgerEntryDone, wakeLedgerEntryTracked, getLifecycleHistory,
} from '../interiority/lifecycle.js';

import { resetCoreStubs, setFakeChat } from './stubs/core.js';

const CHAT = [
    { name: 'User', is_user: true, mes: 'What will you do at the festival?', extra: {} },
    { name: 'Mara', mes: 'Mara glances toward the square.', extra: {} },
    { name: 'Derek', mes: 'Derek wipes his hands on a rag.', extra: {} },
];

beforeEach(() => {
    resetCoreStubs();
    _resetDiagnostics();
    _setScopeKeyResolver(() => 'chat:m5-review');
    globalThis.document = {
        dispatchEvent: vi.fn(),
        getElementById: () => null,
        querySelectorAll: () => [],
    };
});

afterEach(() => {
    _resetPausedStores();
    _resetEpoch();
    delete globalThis.document;
});

describe('M5-1/A: refused lifecycle closes preserve the ledger', () => {
    test('a refused tombstoned removal reports failure and preserves the entry', () => {
        setFakeChat(CHAT);
        const entry = addLedgerEntry({ npc: 'Mara', action: 'wait', trigger: 'dawn' }, 'day 1', 0);
        pauseStore('interiority', { reasonCode: 'future-version', message: 'blocked' });
        expect(removeLedgerEntries([entry.id], { tombstone: true })).toBe(false);
        expect(getLedger().some(item => item.id === entry.id)).toBe(true);
    });

    test('markLedgerEntryDone returns null while the entry survives and nothing persists', () => {
        setFakeChat(CHAT);
        const entry = addLedgerEntry({ npc: 'Mara', action: 'rob the caravan', trigger: 'new moon' }, 'day 1', 0);
        expect(getLedger()).toHaveLength(1);

        pauseStore('interiority', { reasonCode: 'future-version', message: 'blocked' });

        const recorded = markLedgerEntryDone(entry.id);
        expect(recorded).toBeNull();
        // The refused close leaves the entry live.
        expect(getLedger().some(e => e.id === entry.id)).toBe(true);
        // …and no lifecycle record persisted.
        expect(getLifecycleHistory()).toHaveLength(0);
    });
});

describe('M5-1/B + M5-2: refused wakes leave state and diagnostics unchanged', () => {
    test('wakeLedgerEntryTracked returns null while the store keeps the entry dormant', () => {
        setFakeChat(CHAT);
        const entry = addLedgerEntry({ npc: 'Derek', action: 'guard the door', trigger: 'dawn' }, 'day 1', 0);
        setLedgerEntryDormant(entry.id, 'dawn');
        expect(getLedger().find(e => e.id === entry.id)?.status).toBe('dormant');

        pauseStore('interiority', { reasonCode: 'future-version', message: 'blocked' });
        _resetDiagnostics();

        const woken = wakeLedgerEntryTracked(entry.id, 0);
        expect(woken).toBeNull();
        // The live store still holds the entry as dormant.
        expect(getLedger().find(e => e.id === entry.id)?.status).toBe('dormant');
        expect(getEvents().some(ev => ev?.event === 'intention_lifecycle')).toBe(false);
    });
});
