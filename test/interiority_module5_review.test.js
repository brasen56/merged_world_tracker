/**
 * test/interiority_module5_review.test.js — Module 5 review probes.
 *
 * DEFECT-DOCUMENTATION TESTS: every assertion below pins CURRENT (defective)
 * behavior found during the NPC Interiority file-by-file review. They are not
 * evidence that anything is fixed. If a defect is repaired, the paired
 * assertion should be updated to the fixed contract (see Module5_Review.md).
 *
 * Probes:
 *   A. markLedgerEntryDone() reports success (non-null record) while the
 *      write seam refuses everything — the ledger keeps the entry and no
 *      lifecycle record persists. Manual panel lifecycle actions have no
 *      store-pause guard (only generation does, interiority/index.js:266).
 *   B. wakeLedgerEntryTracked() returns a staged object claiming
 *      status:'active' after its save refused; the live store still says
 *      'dormant', and the diagnostics ring still recorded an
 *      intention_lifecycle event for a transition that never landed
 *      (interiority/lifecycle.js:148-179 records unconditionally).
 *   C. DELETED (2026-09-27): the mu-/sd- duplicate-key asymmetry probe pinned
 *      M5-3, which the docs/TODO.md §0 verification ruled not-a-bug — sd-
 *      last-wins is by design, matching migrateIndexKeys
 *      (interiority/data.js:1756).
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
    addLedgerEntry, setLedgerEntryDormant, getLedger,
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

describe('M5-1/A: manual lifecycle close reports success over a refused write', () => {
    test('markLedgerEntryDone returns a record while the entry survives and nothing persists', () => {
        setFakeChat(CHAT);
        const entry = addLedgerEntry({ npc: 'Mara', action: 'rob the caravan', trigger: 'new moon' }, 'day 1', 0);
        expect(getLedger()).toHaveLength(1);

        pauseStore('interiority', { reasonCode: 'future-version', message: 'blocked' });

        const recorded = markLedgerEntryDone(entry.id);
        // DEFECT: non-null "success" return…
        expect(recorded).not.toBeNull();
        expect(recorded.outcome).toBe('completed');
        // …over a seam that refused both writes: the entry is still live…
        expect(getLedger().some(e => e.id === entry.id)).toBe(true);
        // …and no lifecycle record persisted.
        expect(getLifecycleHistory()).toHaveLength(0);
    });
});

describe('M5-1/B + M5-2: phantom wake result and diagnostics over refused writes', () => {
    test('wakeLedgerEntryTracked returns an "active" staged object while the store keeps it dormant', () => {
        setFakeChat(CHAT);
        const entry = addLedgerEntry({ npc: 'Derek', action: 'guard the door', trigger: 'dawn' }, 'day 1', 0);
        setLedgerEntryDormant(entry.id, 'dawn');
        expect(getLedger().find(e => e.id === entry.id)?.status).toBe('dormant');

        pauseStore('interiority', { reasonCode: 'future-version', message: 'blocked' });
        _resetDiagnostics();

        const woken = wakeLedgerEntryTracked(entry.id, 0);
        // DEFECT: the returned (staged, unsaved) object claims the wake…
        expect(woken?.status).toBe('active');
        // …while the live store still holds the entry as dormant…
        expect(getLedger().find(e => e.id === entry.id)?.status).toBe('dormant');
        // …and the audit ring still recorded a transition that never happened.
        expect(getEvents().some(ev => ev?.event === 'intention_lifecycle')).toBe(true);
    });
});
