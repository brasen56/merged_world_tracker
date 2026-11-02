/** @vitest-environment jsdom */
/**
 * pushHistory at a genuinely full browser. jsdom enforces a real 5,000,000
 * character localStorage quota and throws a real QuotaExceededError, so these
 * tests fill storage instead of mocking the refusal.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getFakeNotifications, resetCoreStubs } from './stubs/core.js';
import { _resetHistoryTrimNotice, getHistory, pushHistory } from '../knowledge/lorebook.js';

const QUOTA = 5_000_000;
const BOOK = 'Knowledge Tracker';
const FILLER = 'other_extension_data';
const key = uid => `kt_history_${BOOK}_${uid}`;
const block = text => `<!-- mwt:relationships:start -->\n${text}\n<!-- mwt:relationships:end -->`;
const big = (name, version, size = 200_000) => `${name} | Human | lead\n${version}${'x'.repeat(size)}`;

/** Stored newest-first, matching what pushHistory writes. */
function seed(uid, contents) {
    localStorage.setItem(key(uid), JSON.stringify(contents.map((content, i) => (
        { ts: contents.length - i, content, msgIdx: 1 }))));
}

/** Pads with data that is not ours, leaving `spare` characters free. */
function fill(spare = 10) {
    localStorage.removeItem(FILLER);
    const used = Object.keys(localStorage).reduce((n, k) => n + k.length + localStorage.getItem(k).length, 0);
    localStorage.setItem(FILLER, 'x'.repeat(QUOTA - used - FILLER.length - spare));
}

beforeEach(() => {
    resetCoreStubs();
    getFakeNotifications().length = 0;
    localStorage.clear();
    _resetHistoryTrimNotice();
});

describe('pushHistory when the browser is full', () => {
    test('with room to spare nothing is trimmed, even repeats', () => {
        seed(1, [`Sal | Human | cook\n\n${block('friend')}`, `Sal | Human | cook\n\n${block('rival')}`]);
        expect(pushHistory(1, 'Sal | Human | cook', BOOK)).toBe(true);
        expect(getHistory(1, BOOK)).toHaveLength(3);
        expect(getFakeNotifications()).toEqual([]);
    });

    test('a first snapshot gets in by shrinking the largest history, oldest first', () => {
        seed(1, Array.from({ length: 10 }, (_, i) => big('Ezra', i)));
        seed(2, ['Sal | Human | cook\nnew', 'Sal | Human | cook\nold']);
        fill();
        expect(pushHistory(3, 'Ellis | Lion | hire', BOOK)).toBe(true);
        expect(getHistory(3, BOOK).map(item => item.content)).toEqual(['Ellis | Lion | hire']);
        expect(getHistory(2, BOOK)).toHaveLength(2);
        const ezra = getHistory(1, BOOK);
        expect(ezra.length).toBeLessThan(10);
        expect(ezra.map(item => item.content)).toEqual(Array.from({ length: ezra.length }, (_, i) => big('Ezra', i)));
    });

    test('the pushing NPC can be the largest and keeps the new snapshot', () => {
        seed(1, Array.from({ length: 10 }, (_, i) => big('Ezra', i)));
        fill();
        expect(pushHistory(1, big('Ezra', 'new'), BOOK)).toBe(true);
        const ezra = getHistory(1, BOOK);
        expect(ezra[0].content).toBe(big('Ezra', 'new'));
        expect(ezra[1].content).toBe(big('Ezra', 0));
        expect(ezra.length).toBeLessThan(11);
    });

    test('repeats of a body go first, lose no version and need no warning', () => {
        const body = big('Tavis', 'same', 100_000);
        seed(1, [`${body}\n\n${block('friend')}`, `${body}\n\n${block('rival')}`, `${body}\n`, 'Tavis | Human | older']);
        fill();
        expect(pushHistory(2, 'Ellis | Lion | hire', BOOK)).toBe(true);
        expect(getHistory(1, BOOK).map(item => item.content))
            .toEqual([`${body}\n\n${block('friend')}`, 'Tavis | Human | older']);
        expect(getFakeNotifications()).toEqual([]);
    });

    test('every history keeps two versions, and an impossible snapshot is refused', () => {
        seed(1, [big('Ezra', 'new', 1_000_000), big('Ezra', 'old', 1_000_000)]);
        fill();
        expect(pushHistory(2, big('Huge', 'x', 3_000_000), BOOK)).toBe(false);
        expect(getHistory(1, BOOK)).toHaveLength(2);
        expect(localStorage.getItem(key(2))).toBeNull();
        expect(getFakeNotifications()).toEqual([]);
    });

    test('only readable kt_history keys are ever rewritten', () => {
        const corrupt = `not json ${'z'.repeat(1_000_000)}`;
        localStorage.setItem(key(9), corrupt);
        localStorage.setItem('kt_history_not_a_list', '{"a":1}');
        seed(1, Array.from({ length: 10 }, (_, i) => big('Ezra', i)));
        fill();
        const filler = localStorage.getItem(FILLER);
        expect(pushHistory(2, 'Ellis | Lion | hire', BOOK)).toBe(true);
        expect(localStorage.getItem(key(9))).toBe(corrupt);
        expect(localStorage.getItem('kt_history_not_a_list')).toBe('{"a":1}');
        expect(localStorage.getItem(FILLER)).toBe(filler);
    });

    test('a refusal that is not about space drops nothing', () => {
        seed(1, Array.from({ length: 5 }, (_, i) => big('Ezra', i)));
        vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
            throw new DOMException('denied', 'SecurityError');
        });
        expect(pushHistory(2, 'Ellis | Lion | hire', BOOK)).toBe(false);
        vi.restoreAllMocks();
        expect(getHistory(1, BOOK)).toHaveLength(5);
    });

    test('dropping real versions warns once a session, naming the backup route', () => {
        seed(1, Array.from({ length: 20 }, (_, i) => big('Ezra', i)));
        fill();
        expect(pushHistory(2, 'Ellis | Lion | hire', BOOK)).toBe(true);
        fill();
        expect(pushHistory(3, 'Duane | Human | courier', BOOK)).toBe(true);
        const [notice, ...rest] = getFakeNotifications();
        expect(rest).toEqual([]);
        expect(notice.level).toBe('warning');
        expect(notice.message).toContain('lorebook entries are not affected');
        expect(notice.message).toMatch(/export your lorebook/i);
    });
});
