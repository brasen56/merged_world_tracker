import { describe, expect, test } from 'vitest';
import { lintManualBody, previousManualVersion } from '../knowledge/manual_edit_guidance.js';

const HEADER = 'Mara | Human | harbourmaster';
const BLOCK = '<!-- mwt:relationships:start -->\nfriendly\n<!-- mwt:relationships:end -->';

describe('manual recovery selection', () => {
    test('absent or body-equivalent history has no previous version', () => {
        expect(previousManualVersion([], HEADER)).toBeNull();
        expect(previousManualVersion([{ content: `${HEADER}\n\n${BLOCK}`, ts: 1 }], HEADER)).toBeNull();
        expect(previousManualVersion([{ content: `${HEADER}\r\nTone: brisk`, ts: 1 }], `${HEADER}\nTone: brisk`)).toBeNull();
    });

    test('skips redundant and relationship-only records, selecting the newest differing body', () => {
        expect(previousManualVersion([
            { content: HEADER, ts: 4 },
            { content: `${HEADER}\n\n${BLOCK}`, ts: 3 },
            { content: `older\n\n${BLOCK}`, ts: 2 },
            { content: 'oldest', ts: 1 },
        ], HEADER)).toEqual({ body: 'older', ts: 2 });
    });
});

describe('manual advisory lint', () => {
    test.each(['', 'not a header', '- Mara | Human | clerk', `\n${HEADER}`])('warns on malformed first line: %j', body => {
        expect(lintManualBody(body).join(' ')).toContain('first line');
    });

    test.each(['', '- (no entries yet)', 'not an item', '-item', '- item\nKnowledge Ledger:'])('warns on empty or unparseable ledger: %j', ledger => {
        expect(lintManualBody(`${HEADER}\nKnowledge Ledger:\n${ledger}`).join(' ')).toContain('empty or cannot be parsed');
    });

    test('warns on interrupted ledger but tolerates blank lines between items', () => {
        expect(lintManualBody(`${HEADER}\nKnowledge Ledger:\n- fact\ninterruption\n- lost`).join(' ')).toContain('interrupted');
        expect(lintManualBody(`${HEADER}\nKnowledge Ledger:\n- fact\n\n- more`)).toEqual([]);
    });

    test('warns when all dossier labels disappear, not when optional fields are absent', () => {
        expect(lintManualBody(`[Dossier] ${HEADER}`).join(' ')).toContain('fields are missing');
        expect(lintManualBody(`[Dossier] ${HEADER}\nRole: Clerk`)).toEqual([]);
    });

    test.each(['', '\n[Dossier] ', ' [Dossier] '])('warns on missing or misplaced marker: %j', prefix => {
        expect(lintManualBody(`${prefix}${HEADER}\nRole: Clerk`).join(' ')).toContain('not at the very start');
    });

    test('paste threshold is relative to the newline-normalized baseline', () => {
        const baseline = `${HEADER}\nKnowledge Ledger:\n${'- fact via witness\n'.repeat(4000)}`;
        expect(baseline.length).toBeGreaterThan(50000);
        expect(lintManualBody(baseline, baseline.replaceAll('\n', '\r\n'))).toEqual([]);
        expect(lintManualBody(baseline + 'x'.repeat(49999), baseline).join(' ')).not.toContain('50,000');
        expect(lintManualBody(baseline + 'x'.repeat(50000), baseline).join(' ')).toContain('50,000');
    });
});