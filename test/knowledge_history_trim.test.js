/** @vitest-environment jsdom */
/**
 * pushHistory at a genuinely full browser. jsdom enforces a real 5,000,000
 * character localStorage quota and throws a real QuotaExceededError, so these
 * tests fill storage instead of mocking the refusal.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { getFakeNotifications, resetCoreStubs } from './stubs/core.js';
import { _resetDiagnostics, getEvents } from '../core/diagnostics.js';
import { _resetHistoryTrimNotice, compactStoredHistories, getHistory, importHistory, pushHistory } from '../knowledge/lorebook.js';
import { HISTORY_BUDGET_CHARS, HISTORY_CAP } from '../knowledge/state.js';

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

/** Every history's size as the browser quota counts it. */
function historyChars() {
    return Object.keys(localStorage).filter(k => k.startsWith('kt_history_'))
        .reduce((n, k) => n + k.length + localStorage.getItem(k).length, 0);
}

const events = name => getEvents({ module: 'knowledge' }).filter(e => e.event === name);

beforeEach(() => {
    resetCoreStubs();
    getFakeNotifications().length = 0;
    localStorage.clear();
    _resetHistoryTrimNotice();
    _resetDiagnostics();
});

afterEach(() => vi.restoreAllMocks());

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

describe('Restore history cap and budget', () => {
    const sal = version => `Sal | Human | cook\n${version}`;

    test('a push keeps the newest versions up to the cap', () => {
        seed(1, Array.from({ length: HISTORY_CAP }, (_, i) => sal(i)));
        expect(pushHistory(1, sal('new'), BOOK)).toBe(true);
        const contents = getHistory(1, BOOK).map(item => item.content);
        expect(contents).toHaveLength(HISTORY_CAP);
        expect(contents[0]).toBe(sal('new'));
        expect(contents.at(-1)).toBe(sal(HISTORY_CAP - 2));
    });

    test('past the budget the oldest versions of the largest history go, without a toast', () => {
        seed(1, Array.from({ length: 10 }, (_, i) => big('Ezra', i)));
        seed(2, Array.from({ length: 6 }, (_, i) => big('Derek', i)));
        expect(historyChars()).toBeGreaterThan(HISTORY_BUDGET_CHARS);
        expect(pushHistory(3, 'Ellis | Lion | hire', BOOK)).toBe(true);
        expect(historyChars()).toBeLessThanOrEqual(HISTORY_BUDGET_CHARS);
        expect(getHistory(3, BOOK)).toHaveLength(1);
        expect(getHistory(2, BOOK)).toHaveLength(6);
        const ezra = getHistory(1, BOOK);
        expect(ezra.length).toBeLessThan(10);
        expect(ezra.map(item => item.content)).toEqual(Array.from({ length: ezra.length }, (_, i) => big('Ezra', i)));
        expect(getFakeNotifications()).toEqual([]);
        const [trimmed, ...rest] = events('history_budget_trimmed');
        expect(rest).toEqual([]);
        expect(trimmed.detail).toMatchObject({ dropped: 10 - ezra.length, versions: 10 - ezra.length, budget: HISTORY_BUDGET_CHARS });
    });

    test('under the budget a push reads only its own key once storage is measured', () => {
        seed(1, Array.from({ length: 10 }, (_, i) => big('Ezra', i)));
        pushHistory(2, sal(0), BOOK);
        const getItem = vi.spyOn(Storage.prototype, 'getItem');
        expect(pushHistory(2, sal(1), BOOK)).toBe(true);
        expect(new Set(getItem.mock.calls.map(([k]) => k))).toEqual(new Set([key(2)]));
    });

    test('the running estimate trims on the push that crosses the budget, then leaves room', () => {
        // 13 records of ~200K: ~2.6M, so the second Derek push crosses 3M.
        seed(1, Array.from({ length: 10 }, (_, i) => big('Ezra', i)));
        seed(2, Array.from({ length: 3 }, (_, i) => big('Derek', i)));
        pushHistory(3, sal(0), BOOK);
        expect(pushHistory(2, big('Derek', 'new'), BOOK)).toBe(true);
        expect(events('history_budget_trimmed')).toEqual([]);
        expect(pushHistory(2, big('Derek', 'newer'), BOOK)).toBe(true);
        expect(events('history_budget_trimmed')).toHaveLength(1);
        expect(historyChars()).toBeLessThanOrEqual(HISTORY_BUDGET_CHARS);
        expect(pushHistory(2, big('Derek', 'newest'), BOOK)).toBe(true);
        expect(events('history_budget_trimmed')).toHaveLength(1);
        expect(getHistory(2, BOOK).map(item => item.content).slice(0, 3))
            .toEqual([big('Derek', 'newest'), big('Derek', 'newer'), big('Derek', 'new')]);
    });

    test('over the budget with nothing left to trim, snapshots still store and storage is not re-read each time', () => {
        seed(1, [big('Ezra', 'new', 800_000), big('Ezra', 'old', 800_000)]);
        seed(2, [big('Derek', 'new', 800_000), big('Derek', 'old', 800_000)]);
        expect(pushHistory(3, sal(0), BOOK)).toBe(true);
        expect(getHistory(1, BOOK)).toHaveLength(2);
        expect(getHistory(2, BOOK)).toHaveLength(2);
        const getItem = vi.spyOn(Storage.prototype, 'getItem');
        expect(pushHistory(3, sal(1), BOOK)).toBe(true);
        expect(new Set(getItem.mock.calls.map(([k]) => k))).toEqual(new Set([key(3)]));
        expect(getHistory(3, BOOK)).toHaveLength(2);
    });

    test('the page-load pass brings histories down to the cap, repeats first, leaving others byte-identical', () => {
        const records = [sal(0), `${sal(0)}\n\n${block('friend')}`, `${sal(0)}\n\n${block('rival')}`,
            ...Array.from({ length: 47 }, (_, i) => sal(i + 1))];
        seed(1, records);
        seed(2, [sal('a'), sal('b')]);
        const short = localStorage.getItem(key(2));
        const corrupt = `not json ${'z'.repeat(100)}`;
        localStorage.setItem(key(9), corrupt);
        compactStoredHistories();
        expect(getHistory(1, BOOK).map(item => item.content))
            .toEqual([sal(0), ...Array.from({ length: HISTORY_CAP - 1 }, (_, i) => sal(i + 1))]);
        expect(localStorage.getItem(key(2))).toBe(short);
        expect(localStorage.getItem(key(9))).toBe(corrupt);
        expect(events('history_compacted')[0].detail).toEqual({ dropped: records.length - HISTORY_CAP });
        expect(getFakeNotifications()).toEqual([]);
    });

    test('the page-load pass also brings histories under the budget', () => {
        seed(1, Array.from({ length: 10 }, (_, i) => big('Ezra', i)));
        seed(2, Array.from({ length: 6 }, (_, i) => big('Derek', i)));
        compactStoredHistories();
        expect(historyChars()).toBeLessThanOrEqual(HISTORY_BUDGET_CHARS);
        expect(getHistory(2, BOOK)).toHaveLength(6);
        expect(getFakeNotifications()).toEqual([]);
    });

    test('imported history is validated and capped like a push', () => {
        const records = [{ ts: 99, content: sal('newest') }, 'garbage',
            ...Array.from({ length: 20 }, (_, i) => ({ ts: 50 - i, content: sal(i), msgIdx: 1 }))];
        expect(importHistory(4, records, BOOK)).toBe(true);
        const stored = JSON.parse(localStorage.getItem(key(4)));
        expect(stored).toHaveLength(HISTORY_CAP);
        expect(stored[0]).toEqual({ ts: 99, content: sal('newest') });
        expect(stored.every(item => typeof item.content === 'string')).toBe(true);
        expect(importHistory(5, ['garbage'], BOOK)).toBe(false);
        expect(localStorage.getItem(key(5))).toBeNull();
    });

    test('an import into a full browser makes room instead of being dropped', () => {
        seed(1, Array.from({ length: 10 }, (_, i) => big('Ezra', i)));
        fill();
        expect(importHistory(4, [{ ts: 1, content: sal(0) }], BOOK)).toBe(true);
        expect(getHistory(4, BOOK)).toEqual([{ ts: 1, content: sal(0) }]);
        expect(getHistory(1, BOOK).length).toBeLessThan(10);
    });
});
