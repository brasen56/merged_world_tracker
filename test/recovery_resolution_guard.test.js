/**
 * test/recovery_resolution_guard.test.js — the §5.3 completeness guard when
 * book RESOLUTION itself fails (the fail-closed rule).
 *
 * resolveKnowledgeBooks() returns null when settings, identity, or the
 * resolution explainer degrade. The guard in backup/recovery.js used to turn
 * that null into an empty book list (`?.books ?? []`), so the export proceeded
 * as though every Knowledge/State book were readable — despite not knowing
 * which books must be inspected. This suite pins the fix: a null resolution is
 * an explicit 'book-resolution-failed' blocker on the same surfaces
 * ('knowledgeBookBlocks' / 'blockedBooks') the per-book blockers use.
 *
 * The null is forced through vi.mock (the repo's established passthrough
 * pattern — see test/scan_and_accept_fail_closed.test.js) on
 * knowledge/scope.js, the resolver's ONE-OWNER home (backup/recovery.js
 * imports it from there, beside resolveBookNames() whose read-only mirror it
 * builds on): every other export of the module stays real. The per-book
 * blocker paths that DO resolve are covered against the real resolver in
 * test/schema_status_surface.test.js.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../knowledge/scope.js', async (importOriginal) => ({
    ...await importOriginal(),
    resolveKnowledgeBooks: () => null,
}));

import {
    collectKnowledgeBookBlocks,
    collectQuarantineStatus,
    exportRecoveryData,
} from '../backup/recovery.js';
import { QUARANTINE_METADATA_KEY, makeQuarantineItem } from '../core/quarantine.js';
import { _clearCacheForTests } from '../knowledge/store.js';
import { resetCoreStubs, getFakeMeta, getFakeDownloadJsonCalls } from './stubs/core.js';

/** One quarantine item for the fake chat container (the sibling suite's shape). */
const item = (store, raw) => makeQuarantineItem({
    store, reasonCode: 'test-reason', message: 'Test reason.', raw,
});

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('resolution failure is an explicit export blocker (fail-closed)', () => {
    test('collectKnowledgeBookBlocks names the failure instead of listing nothing', () => {
        expect(collectKnowledgeBookBlocks()).toEqual([
            { book: '(unresolved)', role: 'knowledge', reason: 'book-resolution-failed' },
        ]);
    });

    test('export refuses — nothing downloads, readable records are held back and named', async () => {
        getFakeMeta()[QUARANTINE_METADATA_KEY] = { version: 1, items: [item('chronicle', { id: 1 })] };

        const result = await exportRecoveryData();
        expect(result).toMatchObject({ ok: false, empty: true, unreadable: true, count: 0 });
        expect(result.blockedBooks).toEqual([
            { book: '(unresolved)', role: 'knowledge', reason: 'book-resolution-failed' },
        ]);
        expect(result.message).toContain('could not be resolved');
        // The readable chat record is held back and named, never exported alone.
        expect(result.message).toContain('1 readable quarantined record');
        expect(getFakeDownloadJsonCalls()).toHaveLength(0);
    });

    test('MWT.recovery.status() surfaces the same blocker (knowledgeBookBlocks)', () => {
        const status = collectQuarantineStatus({ now: () => 1 });
        expect(status.knowledgeBookBlocks).toEqual([
            { book: '(unresolved)', role: 'knowledge', reason: 'book-resolution-failed' },
        ]);
    });
});