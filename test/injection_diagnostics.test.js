/**
 * test/injection_diagnostics.test.js — Phase 2 tests for injected-payload
 * snapshots.
 *
 * The whole point of Phase 2 (design §I.4.4) is that the recorded snapshot is
 * the EXACT string handed to SillyTavern's setExtensionPrompt — a fresh rebuild
 * on panel open would lie (see the stale-arc bug noted at
 * story_planner/index.js:85). These tests therefore drive the REAL
 * core/injection.js against a fake SillyTavern context (the tier5 pattern) and
 * assert the snapshot matches what setExtensionPrompt received, field for
 * field. Store-level semantics live in the second describe block.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
    RING_CAPACITY,
    _resetDiagnostics,
    clearInjections,
    getAllInjectedSnapshots,
    getEvents,
    getInjectedSnapshot,
    record,
    recordInjection,
} from '../core/diagnostics.js';
import { applyExtensionPromptInjection } from '../core/injection.js';
// The stub is imported directly (the barrel alias only rewrites core/index.js
// imports), letting one test run the SAME input through the real module and
// the stub and assert they register identical payloads.
import {
    applyExtensionPromptInjection as stubApplyInjection,
    getFakePromptCalls,
    resetCoreStubs,
    setFakeContextExtras,
} from './stubs/core.js';

/**
 * Install a fake SillyTavern context whose setExtensionPrompt records every
 * call, mirroring the CORE-08 pattern in tier5_regression_net.test.js.
 * @returns {Array[]} the collected setExtensionPrompt argument tuples
 */
function fakeSetExtensionPrompt() {
    const calls = [];
    globalThis.SillyTavern = {
        getContext: () => ({ setExtensionPrompt: (...args) => calls.push(args) }),
    };
    return calls;
}

beforeEach(() => {
    _resetDiagnostics();
    // A leaked fake runtime from a previous test must not make the
    // "unavailable" test below silently pass against a stale install.
    delete globalThis.SillyTavern;
});

afterEach(() => {
    delete globalThis.SillyTavern;
});

// ─── applyExtensionPromptInjection records what it sent ──────────────────────

describe('applyExtensionPromptInjection records what it sent', () => {
    test('snapshot payload is exactly the string handed to setExtensionPrompt', () => {
        const calls = fakeSetExtensionPrompt();

        const ok = applyExtensionPromptInjection({
            key: 'mwt_test_injection',
            header: '[Test Header]',
            body: 'Line one\nLine two',
            enabled: true,
            globalDepth: 9,
            fallbackDepth: 4,
            globalRole: 'assistant',
            wrapperTag: 'mwt_wrapper',
        });

        expect(ok).toBe(true);
        expect(calls).toHaveLength(1);
        const snap = getInjectedSnapshot('mwt_test_injection');
        expect(snap).toBeDefined();
        // The core promise: the recorded payload IS the sent payload.
        expect(snap.payload).toBe(calls[0][1]);
        expect(snap.payload).toContain('[Test Header]\n\nLine one\nLine two');
        expect(snap.payload).toContain('<mwt_wrapper>');
        expect(snap.role).toBe(2);    // 'assistant' → 2, exactly as sent
        expect(snap.depth).toBe(9);   // globalDepth wins over fallbackDepth
        expect(snap.enabled).toBe(true);
        expect(typeof snap.at).toBe('number');
        expect(snap.key).toBe('mwt_test_injection');
    });

    test('a re-apply overwrites the snapshot instead of appending', () => {
        fakeSetExtensionPrompt();

        applyExtensionPromptInjection({ key: 'mwt_test_injection', body: 'first', enabled: true, fallbackDepth: 4 });
        applyExtensionPromptInjection({ key: 'mwt_test_injection', body: 'second', enabled: true, fallbackDepth: 4 });

        const all = getAllInjectedSnapshots();
        expect(Object.keys(all)).toEqual(['mwt_test_injection']);
        expect(getInjectedSnapshot('mwt_test_injection').payload).toContain('second');
    });

    test('disabled and empty-body applies record the cleared state faithfully', () => {
        const calls = fakeSetExtensionPrompt();

        const ok = applyExtensionPromptInjection({
            key: 'mwt_test_injection', body: '', enabled: false, fallbackDepth: 4, globalRole: 'user',
        });

        expect(ok).toBe(false);
        expect(calls[0]).toEqual(['mwt_test_injection', '', 1, 4, undefined, 1]);
        expect(getInjectedSnapshot('mwt_test_injection')).toMatchObject({
            key: 'mwt_test_injection',
            payload: '',
            role: 1,
            depth: 4,
            enabled: false,
        });
    });

    test('a non-finite globalDepth falls back to the module depth in the snapshot', () => {
        fakeSetExtensionPrompt();

        applyExtensionPromptInjection({
            key: 'mwt_test_injection', body: 'x', enabled: true, globalDepth: 'not-a-number', fallbackDepth: 7,
        });

        expect(getInjectedSnapshot('mwt_test_injection').depth).toBe(7);
    });

    test('keys are tracked independently', () => {
        fakeSetExtensionPrompt();

        applyExtensionPromptInjection({ key: 'mwt_a', body: 'A', enabled: true, fallbackDepth: 1 });
        applyExtensionPromptInjection({ key: 'mwt_b', body: 'B', enabled: true, fallbackDepth: 2 });

        const all = getAllInjectedSnapshots();
        expect(Object.keys(all).sort()).toEqual(['mwt_a', 'mwt_b']);
        expect(all.mwt_a.payload).toContain('A');
        expect(all.mwt_b.payload).toContain('B');
    });

    test('nothing is recorded when setExtensionPrompt is unavailable', () => {
        // No fake SillyTavern installed — getSetExtensionPrompt() resolves null.
        expect(applyExtensionPromptInjection({ key: 'mwt_test_injection', body: 'x', enabled: true, fallbackDepth: 4 })).toBe(false);
        expect(getInjectedSnapshot('mwt_test_injection')).toBeUndefined();
        expect(getAllInjectedSnapshots()).toEqual({});
        expect(getEvents({ module: 'injection' })).toHaveLength(0);
    });
});

// ─── Snapshot store semantics ─────────────────────────────────────────────────

describe('injection snapshot store', () => {
    test('recordInjection never throws on bad input and ignores missing keys', () => {
        expect(() => recordInjection()).not.toThrow();
        expect(() => recordInjection(null)).not.toThrow();
        expect(() => recordInjection({ payload: 'no key' })).not.toThrow();
        expect(getAllInjectedSnapshots()).toEqual({});
    });

    test('getters return copies that cannot mutate internal state', () => {
        recordInjection({ key: 'k', payload: 'p', role: 0, depth: 2, enabled: true });

        getInjectedSnapshot('k').payload = 'tampered';
        expect(getInjectedSnapshot('k').payload).toBe('p');

        const all = getAllInjectedSnapshots();
        all.k.payload = 'tampered-again';
        expect(getInjectedSnapshot('k').payload).toBe('p');
    });

    test('clearInjections wipes snapshots without touching events', () => {
        recordInjection({ key: 'k', payload: 'p', role: 0, depth: 2, enabled: true });
        expect(getEvents({ module: 'injection' })).toHaveLength(1);

        clearInjections();
        expect(getInjectedSnapshot('k')).toBeUndefined();
        expect(getAllInjectedSnapshots()).toEqual({});
        expect(getEvents({ module: 'injection' })).toHaveLength(1);
    });

    test('snapshots survive event-ring eviction (dedicated store, not the ring)', () => {
        recordInjection({ key: 'k', payload: 'the frozen string', role: 0, depth: 2, enabled: true });

        // Flood the ring past capacity so the injection_applied echo is evicted.
        for (let i = 0; i < RING_CAPACITY + 10; i++) {
            record({ level: 'debug', module: 'noise', event: `n${i}` });
        }

        expect(getEvents().length).toBeLessThanOrEqual(RING_CAPACITY);
        expect(getEvents({ module: 'injection' })).toHaveLength(0);
        expect(getInjectedSnapshot('k').payload).toBe('the frozen string');
    });

    test('the ring echo carries metadata but never the payload body', () => {
        recordInjection({ key: 'k', payload: 'SECRET-PAYLOAD-BODY', role: 0, depth: 2, enabled: true });

        const evt = getEvents({ module: 'injection' })[0];
        expect(evt.event).toBe('injection_applied');
        expect(evt.level).toBe('info');
        expect(evt.detail.key).toBe('k');
        expect(evt.detail.enabled).toBe(true);
        expect(evt.detail.chars).toBe('SECRET-PAYLOAD-BODY'.length);
        expect(evt.detail.payload).toBeUndefined();
        expect(JSON.stringify(evt)).not.toContain('SECRET-PAYLOAD-BODY');
    });
});

// ─── Stub parity (test/stubs/core.js) ────────────────────────────────────────
//
// Feature-level tests reach applyExtensionPromptInjection through the barrel,
// which the Vitest alias swaps for the stub. If the stub drifted from the real
// payload construction (no wrapper tags, no boundary escaping, non-finite
// depths accepted), those tests would assert snapshots production never
// registers. These tests pin the stub to the real module.

describe('core stub applyExtensionPromptInjection parity', () => {
    /** Argument tuples captured by the stub's fake setExtensionPrompt. */
    let stubCalls;

    beforeEach(() => {
        stubCalls = [];
        resetCoreStubs();
        setFakeContextExtras({
            setExtensionPrompt: (...args) => stubCalls.push(args),
        });
    });

    test('same input produces the same registration in the stub and the real module', () => {
        const input = {
            key: 'k',
            header: '[H]',
            body: 'has <raw> & text',   // '<' must be boundary-escaped by wrapInTag
            enabled: true,
            fallbackDepth: 4,
            globalDepth: 9,
            globalRole: 'assistant',
            wrapperTag: 'mwt_wrap',
        };

        // Real module, against a fake SillyTavern context (cleared afterwards).
        const realCalls = [];
        globalThis.SillyTavern = {
            getContext: () => ({ setExtensionPrompt: (...args) => realCalls.push(args) }),
        };
        applyExtensionPromptInjection(input);
        const realSnap = getInjectedSnapshot('k');
        resetCoreStubs();   // clears diagnostics + stub state before the stub run
        setFakeContextExtras({
            setExtensionPrompt: (...args) => stubCalls.push(args),
        });

        stubApplyInjection(input);
        const stubSnap = getInjectedSnapshot('k');

        // Byte-for-byte: wrapper applied, '<' escaped, '&' preserved — exactly
        // what the real module registered.
        expect(stubSnap.payload).toBe(realSnap.payload);
        expect(stubSnap.payload).toContain('<mwt_wrap>\n[H]\n\nhas &lt;raw> & text\n</mwt_wrap>');
        expect(stubSnap.role).toBe(realSnap.role);
        expect(stubSnap.depth).toBe(realSnap.depth);
        expect(stubSnap.enabled).toBe(realSnap.enabled);
        expect(stubCalls[0]).toEqual(realCalls[0]);
        expect(getFakePromptCalls()[0].payload).toBe(realSnap.payload);
    });

    test('useTags: false skips the wrapper, matching the real module', () => {
        const input = {
            key: 'k', header: '[H]', body: 'plain', enabled: true,
            fallbackDepth: 4, wrapperTag: 'mwt_wrap', useTags: false,
        };

        stubApplyInjection(input);
        expect(getInjectedSnapshot('k').payload).toBe('[H]\n\nplain');

        const realCalls = [];
        globalThis.SillyTavern = {
            getContext: () => ({ setExtensionPrompt: (...args) => realCalls.push(args) }),
        };
        applyExtensionPromptInjection(input);
        expect(getFakePromptCalls()[0].payload).toBe(realCalls[0][1]);
    });

    test('a non-finite globalDepth falls back to the module depth (finite-depth guard)', () => {
        stubApplyInjection({
            key: 'k', body: 'x', enabled: true, globalDepth: 'not-a-number', fallbackDepth: 7,
        });

        expect(getInjectedSnapshot('k').depth).toBe(7);
        expect(stubCalls[0][3]).toBe(7);   // same depth handed to setExtensionPrompt
        expect(getFakePromptCalls()[0].depth).toBe(7);
    });

    test('a disabled apply registers an empty payload with enabled: false', () => {
        const ok = stubApplyInjection({ key: 'k', body: 'ignored', enabled: false, fallbackDepth: 4 });

        expect(ok).toBe(false);
        expect(getInjectedSnapshot('k')).toMatchObject({ payload: '', enabled: false, depth: 4 });
        expect(stubCalls[0][1]).toBe('');
    });
});
