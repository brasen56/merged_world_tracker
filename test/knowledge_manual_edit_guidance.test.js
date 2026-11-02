import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

    test('whitespace the relationship strip tidies away is not a different body', () => {
        const withBlock = `${HEADER}\n\nTone: brisk\n\n${BLOCK}`;
        expect(previousManualVersion([{ content: `${HEADER}\n\nTone: brisk\n`, ts: 1 }], withBlock)).toBeNull();
        expect(previousManualVersion([{ content: `${HEADER}\n\n\n\nTone: brisk`, ts: 1 }], withBlock)).toBeNull();
    });

    test('skips bodies headed with another NPC, keeping own and headerless records', () => {
        const other = { content: 'Tobias | Dwarf | cook\nTone: gruff', ts: 3 };
        expect(previousManualVersion([other], HEADER, 'Mara')).toBeNull();
        expect(previousManualVersion([other, { content: `[Dossier] ${HEADER}\nRole: Clerk`, ts: 2 }], HEADER, 'Mara'))
            .toEqual({ body: `[Dossier] ${HEADER}\nRole: Clerk`, ts: 2 });
        expect(previousManualVersion([other, { content: 'free text', ts: 1 }], HEADER, 'Mara'))
            .toEqual({ body: 'free text', ts: 1 });
    });

    test('a changed header still matches the header the entry carries now', () => {
        const record = { content: 'Harbourmaster | Human | clerk\nTone: dry', ts: 1 };
        expect(previousManualVersion([record], 'Harbourmaster | Human | clerk\nTone: warm', 'Mara'))
            .toEqual({ body: record.content, ts: 1 });
    });
});

describe('manual edit stylesheet', () => {
    // The host's .menu_button sets display:flex, which beats the [hidden] attribute.
    test.each(['.kt-view-edit', '.kt-view-restore'])('%s[hidden] has its own display:none', selector => {
        const css = readFileSync(fileURLToPath(new URL('../knowledge/style.css', import.meta.url)), 'utf8');
        expect(css.split('\n').find(line => line.includes(`${selector}[hidden]`))).toContain('display: none');
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