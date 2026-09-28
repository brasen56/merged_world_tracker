/** @vitest-environment jsdom */
import { beforeEach, describe, expect, test } from 'vitest';

import { getFakeMeta, resetCoreStubs } from './stubs/core.js';
import { estimateTokens } from '../core/index.js';
import {
    applyInjection, buildChronicleInjectionBody, buildChronicleInjectionText,
    getInjectionStats,
} from '../chronicle/injection.js';
import { formatLedgerForInjection } from '../interiority/prompts.js';
import { addLedgerEntry, getLedger, updateLedgerEntry } from '../interiority/data.js';
import { pauseStore, _setScopeKeyResolver, _resetPausedStores } from '../core/schema_status.js';

beforeEach(() => {
    resetCoreStubs();
    _resetPausedStores();
    _setScopeKeyResolver(() => 'chat:tier3-followup');
});

describe('Chronicle shared injection payload', () => {
    test('stats count the same labelled and headed payload registered for injection', () => {
        getFakeMeta().session_chronicle_data = {
            injectEnabled: true, injectMode: 'all',
            snapshots: [
                { id: 'a', text: 'First', worldDate: 'Day one', characters: ['Avery'], createdAt: '2026-01-01' },
                { id: 'b', text: 'Second', worldDate: 'Day two', characters: ['Morgan'], createdAt: '2026-01-02' },
            ],
        };
        const body = buildChronicleInjectionBody();
        expect(body).toContain('### Chronicle Entry 1 — Day one [Avery]');
        expect(body).toContain('### Chronicle Entry 2 — Day two [Morgan]');
        expect(buildChronicleInjectionText()).toContain(body);
        expect(getInjectionStats().tokenEstimate).toBe(estimateTokens(buildChronicleInjectionText()));
        expect(() => applyInjection()).not.toThrow();
    });
});

describe('Interiority refused writes and bounded injection', () => {
    test('a paused store cannot return a staged successful edit', () => {
        const entry = addLedgerEntry({ npc: 'Avery', action: 'leave', trigger: 'dawn' });
        pauseStore('interiority', { reasonCode: 'future-version', message: 'blocked' });
        expect(updateLedgerEntry(entry.id, { action: 'stay' })).toBeNull();
        expect(getLedger()[0].action).toBe('leave');
    });

    test('narrator sees only a bounded number of active intentions, the most recent kept', () => {
        // Selection by priority then recency, and the no-notice-in-prompt
        // rule, are pinned in test/interiority_injection_cap.test.js.
        const ledger = Array.from({ length: 25 }, (_, n) => ({
            npc: 'Avery', action: `action ${n}`, trigger: 'dawn', status: 'active',
        }));
        const output = formatLedgerForInjection(ledger);
        expect(output).toContain('action 24 →');
        expect(output).toContain('action 5 →');
        expect(output).not.toContain('action 4 →');
        expect(output).not.toMatch(/omitted/);
    });
});