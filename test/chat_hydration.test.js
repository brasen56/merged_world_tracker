import { beforeEach, expect, test, vi } from 'vitest';

const { checker } = vi.hoisted(() => ({ checker: vi.fn() }));
vi.mock('../../../../../script.js', () => ({ isChatFullyHydrated: checker }));
import { isChatHydrated } from '../core/chat_hydration.js';

beforeEach(() => { checker.mockReset(); checker.mockReturnValue(true); });

test('host hydration status gates even a dense loaded range', async () => {
    checker.mockReturnValue(false);
    expect(await isChatHydrated([{ mes: 'Loaded' }])).toBe(false);
    checker.mockReturnValue(true);
    expect(await isChatHydrated([{ mes: 'Loaded' }])).toBe(true);
});

test('checker failures and sparse slots fail closed', async () => {
    checker.mockImplementation(() => { throw new Error('unavailable'); });
    expect(await isChatHydrated([])).toBe(false);
    checker.mockReturnValue(true);
    expect(await isChatHydrated(new Array(2))).toBe(false);
    expect(await isChatHydrated([undefined])).toBe(false);
});

test('concurrent callers both wait for the same host checker', async () => {
    checker.mockReturnValue(false);
    expect(await Promise.all([isChatHydrated([]), isChatHydrated([])])).toEqual([false, false]);
});