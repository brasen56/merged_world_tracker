/** @vitest-environment jsdom */
/**
 * test/interiority_injection_cap.test.js — M5-6 follow-up (docs/TODO.md §0,
 * 2026-09-27 review).
 *
 * The narrator block carries at most MAX_INJECTED_INTENTIONS active entries.
 * The first cap kept the first 20 in LEDGER order — the ledger is
 * append-only, so the newest intentions (and any marked urgent) were the ones
 * dropped — and it appended "…review the Interiority ledger" to the prompt,
 * an instruction for the user delivered to the narrator model instead.
 *
 * Contract now: keep the highest priority first, then the most recently
 * declared; print the kept entries in ledger order; report the omission to
 * the user (panel + diagnostics), never inside the prompt.
 */
import { beforeEach, describe, expect, test } from 'vitest';

import {
    MAX_INJECTED_INTENTIONS, formatLedgerForInjection, selectInjectedIntentions,
} from '../interiority/prompts.js';
import { _resetDiagnostics, getEvents } from '../core/diagnostics.js';
import { applyIntentionsInjection } from '../interiority/injection.js';
import { state as interiorityState } from '../interiority/data.js';
import { renderContent } from '../interiority/render.js';
import { getFakeMeta, resetCoreStubs } from './stubs/core.js';

const entry = (n, priority) => ({
    id: `i${n}`, npc: 'Avery', action: `action ${n}`, trigger: 'dawn', status: 'active',
    ...(priority ? { priority } : {}),
});

beforeEach(() => {
    resetCoreStubs();
    _resetDiagnostics();
});

describe('which intentions reach the narrator', () => {
    test('the cap is 20', () => {
        expect(MAX_INJECTED_INTENTIONS).toBe(20);
    });

    test('with equal priority the most recent are kept, not the oldest', () => {
        const ledger = Array.from({ length: 25 }, (_, n) => entry(n));
        const { kept, omitted } = selectInjectedIntentions(ledger);
        expect(omitted).toBe(5);
        expect(kept.map(e => e.id)).toEqual(ledger.slice(5).map(e => e.id));
    });

    test('an urgent intention survives even when it is the oldest', () => {
        const ledger = [entry(0, 'urgent'), ...Array.from({ length: 24 }, (_, n) => entry(n + 1))];
        const kept = selectInjectedIntentions(ledger).kept.map(e => e.id);
        expect(kept).toContain('i0');
        expect(kept).toHaveLength(20);
    });

    test('low-priority intentions are dropped before normal ones', () => {
        const ledger = [
            ...Array.from({ length: 20 }, (_, n) => entry(n)),
            ...Array.from({ length: 5 }, (_, n) => entry(n + 20, 'low')),
        ];
        const kept = selectInjectedIntentions(ledger).kept.map(e => e.id);
        expect(kept).toEqual(ledger.slice(0, 20).map(e => e.id));
    });

    test('dormant entries never count against the cap', () => {
        const ledger = [
            ...Array.from({ length: 20 }, (_, n) => entry(n)),
            { ...entry(99), status: 'dormant' },
        ];
        expect(selectInjectedIntentions(ledger)).toMatchObject({ omitted: 0 });
        expect(selectInjectedIntentions(ledger).kept).toHaveLength(20);
    });
});

describe('what the narrator sees', () => {
    test('kept entries print in ledger order with no omission notice', () => {
        const ledger = [entry(0, 'urgent'), ...Array.from({ length: 24 }, (_, n) => entry(n + 1))];
        const output = formatLedgerForInjection(ledger);
        const printed = [...output.matchAll(/action (\d+) →/g)].map(m => Number(m[1]));
        expect(printed).toEqual([...printed].sort((a, b) => a - b));
        expect(printed[0]).toBe(0);
        expect(output).not.toMatch(/omitted|review the|Interiority ledger/i);
    });

    test('an omission is reported to diagnostics, not the prompt', () => {
        getFakeMeta().mwt_interiority = { ledger: Array.from({ length: 23 }, (_, n) => entry(n)) };
        applyIntentionsInjection();
        const capped = getEvents().filter(ev => ev?.event === 'intentions_injection_capped');
        expect(capped).toHaveLength(1);
        expect(capped[0].detail).toMatchObject({ active: 23, injected: 20, omitted: 3 });
    });
});

describe('what the user sees', () => {
    function renderPanel(count) {
        getFakeMeta().mwt_interiority = { ledger: Array.from({ length: count }, (_, n) => entry(n)) };
        document.body.innerHTML = '<div id="content"></div>';
        interiorityState.contentEl = document.querySelector('#content');
        renderContent();
        return document.querySelector('.mwt-int-cap-note');
    }

    test('the Active Intentions section explains an omission over the cap', () => {
        const note = renderPanel(23);
        expect(note?.textContent).toMatch(/Only 20 of 23 active intentions reach the narrator/);
        interiorityState.contentEl = null;
    });

    test('no note under the cap', () => {
        expect(renderPanel(20)).toBeNull();
        interiorityState.contentEl = null;
    });
});
