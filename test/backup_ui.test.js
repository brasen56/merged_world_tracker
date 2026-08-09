/**
 * backup_ui.test.js — Phase 4 pure-presenter tests.
 *
 * The DOM-coupled handlers in backup/render.js can't run under Vitest (no
 * browser), but the pure presenters (describeSectionSummary, summarizePreview,
 * buildRestoreModes, readRestoreControlValues) are plain functions over plain
 * objects and a tiny fake-DOM root. This locks in the mapping between the
 * planner's output shape and what the UI shows the user.
 */

import { describe, test, expect } from 'vitest';

import {
    describeSectionSummary,
    summarizePreview,
    buildRestoreModes,
    readRestoreControlValues,
    SECTION_ORDER,
    SECTION_LABELS,
} from '../backup/render.js';

function mergeSummary(overrides = {}) {
    return { added: 0, updated: 0, skipped: [], conflicts: 0, ...overrides };
}

describe('describeSectionSummary', () => {
    test('normalises a merge-mode section into a structured description', () => {
        const desc = describeSectionSummary('chronicle', mergeSummary({ added: 3, updated: 1, skipped: [{ record: 'x', reason: 'bad' }], conflicts: 2 }));
        expect(desc).toEqual({
            label: SECTION_LABELS.chronicle,
            kind: 'merge',
            added: 3,
            updated: 1,
            skippedCount: 1,
            conflicts: 2,
            skipped: [{ record: 'x', reason: 'bad' }],
        });
    });

    test('normalises an exact-mode section (built by previewExactRestore)', () => {
        const desc = describeSectionSummary('worldState', {
            mode: 'exact',
            action: 'replaced',
            replaced: 1,
            removed: 0,
            unchanged: 0,
            skipped: [],
            conflicts: 0,
        });
        expect(desc.kind).toBe('exact');
        expect(desc.action).toBe('replaced');
        expect(desc.added).toBe(1); // exact "added" surfaces the replaced count
        expect(desc.skippedCount).toBe(0);
    });

    test('falls back to the raw section name when no friendly label exists', () => {
        const desc = describeSectionSummary('futureSection', mergeSummary({ added: 1 }));
        expect(desc.label).toBe('futureSection');
    });

    test('returns null for missing/non-object summaries', () => {
        expect(describeSectionSummary('chronicle', null)).toBeNull();
        expect(describeSectionSummary('chronicle', undefined)).toBeNull();
    });
});

describe('summarizePreview', () => {
    function preview({ summary, identityPolicy, sameChat = true } = {}) {
        return {
            ok: true,
            sameChat,
            identityPolicy: identityPolicy || {
                identityKnown: true,
                sameChat: true,
                exactAllowed: true,
                perMessageAllowed: true,
                restrictions: [],
                warning: null,
            },
            summary: summary || {
                worldState: mergeSummary({ added: 1 }),
                chronicle: mergeSummary({ added: 2, skipped: [{ record: 's1', reason: 'dup' }] }),
                interiority: mergeSummary({
                    added: 1,
                    perMessage: { imported: 5, resolved: 5, sameChat: true, messageIds: ['mu-1'] },
                }),
            },
            previewToken: 'token-abc',
        };
    }

    function envelope(meta = {}) {
        return { _meta: { chatName: 'My Story', createdAt: '2026-08-08T12:00:00.000Z', messageCount: 42, identity: { chatId: 'c1', isUnknown: false }, ...meta } };
    }

    test('reports ok and carries meta + per-section rows in SECTION_ORDER', () => {
        const s = summarizePreview(preview(), envelope());
        expect(s.ok).toBe(true);
        expect(s.chatName).toBe('My Story');
        expect(s.messageCount).toBe(42);
        expect(s.sameChat).toBe(true);
        const names = s.sections.map(x => x.label);
        expect(names).toEqual([SECTION_LABELS.worldState, SECTION_LABELS.chronicle, SECTION_LABELS.interiority]);
    });

    test('surfaces interiority perMessage resolve counts', () => {
        const s = summarizePreview(preview(), envelope());
        const interiority = s.sections.find(x => x.label === SECTION_LABELS.interiority);
        expect(interiority.perMessage).toEqual({ imported: 5, resolved: 5, sameChat: true });
    });

    test('carries the identity-policy warning and restrictions', () => {
        const p = preview({
            identityPolicy: {
                identityKnown: false,
                sameChat: false,
                exactAllowed: false,
                perMessageAllowed: false,
                restrictions: ['perMessage skipped', 'exact/replace disabled'],
                warning: 'Unverified identity.',
            },
            sameChat: false,
        });
        const s = summarizePreview(p, envelope());
        expect(s.identityKnown).toBe(false);
        expect(s.exactAllowed).toBe(false);
        expect(s.warning).toBe('Unverified identity.');
        expect(s.restrictions).toEqual(['perMessage skipped', 'exact/replace disabled']);
    });

    test('returns ok:false for a rejected preview', () => {
        const s = summarizePreview({ ok: false, reason: 'invalid-backup' }, envelope());
        expect(s.ok).toBe(false);
        expect(s.reason).toBe('invalid-backup');
        expect(s.sections).toEqual([]);
    });
});

describe('buildRestoreModes', () => {
    test('defaults yield an empty modes object (planner applies its own fallbacks)', () => {
        expect(buildRestoreModes()).toEqual({});
    });

    test('"replace" is passed through explicitly so the plan is deterministic', () => {
        expect(buildRestoreModes({ worldState: 'replace', knowledgeCounters: 'replace' })).toEqual({
            worldState: 'replace',
            knowledgeCounters: 'replace',
        });
    });

    test('"keep" suppresses that section', () => {
        expect(buildRestoreModes({ worldState: 'keep', knowledgeCounters: 'keep' })).toEqual({
            worldState: 'keep',
            knowledgeCounters: 'keep',
        });
    });

    test('restoreSessionConfig only sets the flag when true', () => {
        expect(buildRestoreModes({ restoreSessionConfig: false })).toEqual({});
        expect(buildRestoreModes({ restoreSessionConfig: true })).toEqual({ restoreSessionConfig: true });
    });

    test('unknown mode values are dropped (never silently coerced)', () => {
        expect(buildRestoreModes({ worldState: 'nuke', knowledgeCounters: null })).toEqual({});
    });
});

describe('readRestoreControlValues', () => {
    function fakeRoot(values = {}) {
        const map = {
            '#mwt-bk-ws-mode': { value: values.worldState ?? '' },
            '#mwt-bk-counters-mode': { value: values.knowledgeCounters ?? '' },
            '#mwt-bk-session-config': { checked: !!values.restoreSessionConfig },
            '#mwt-bk-exact': { checked: !!values.exact },
        };
        return { querySelector: sel => map[sel] || null };
    }

    test('reads the control values into the plain-values shape', () => {
        const v = readRestoreControlValues(fakeRoot({
            worldState: 'keep', knowledgeCounters: 'replace', restoreSessionConfig: true, exact: true,
        }));
        expect(v).toEqual({
            worldState: 'keep',
            knowledgeCounters: 'replace',
            restoreSessionConfig: true,
            exact: true,
        });
    });

    test('missing controls fall back to the planner-policy default', () => {
        const v = readRestoreControlValues(fakeRoot());
        expect(v).toEqual({
            worldState: '',
            knowledgeCounters: '',
            restoreSessionConfig: false,
            exact: false,
        });
    });

    test('returns {} when no root is available (modal not in DOM)', () => {
        expect(readRestoreControlValues(null)).toEqual({});
    });
});

describe('SECTION_ORDER / SECTION_LABELS', () => {
    test('every ordered section has a label and the count matches the data map', () => {
        for (const name of SECTION_ORDER) {
            expect(SECTION_LABELS[name]).toBeTruthy();
        }
        // The seven backup sections from data.js SECTION_KEYS.
        expect(SECTION_ORDER).toHaveLength(7);
    });
});
