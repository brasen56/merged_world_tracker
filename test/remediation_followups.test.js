/**
 * Remediation follow-ups — the gaps left open by the REMEDIATION_MAP pass.
 *
 * Three of these cover findings whose checkbox was ticked but whose behaviour
 * was still wrong (CHRONICLE-03's counter reset, the section-regen write
 * window, the editor debounce). Two cover findings that were fixed correctly
 * but shipped with no test at all, which is how the `scSetStatus` ReferenceError
 * on the strict-grounding path survived review (WORLD-STATE-04, INTERIORITY-01).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import {
    resetCoreStubs, setFakeChat, setFakeApi, getFakeStatusCalls,
} from './stubs/core.js';
import { _resetEpoch, bumpEpoch } from '../core/scope.js';

// ─── CHRONICLE-03 (part 2) ────────────────────────────────────────────────────

describe('CHRONICLE-03 — messages arriving during generation survive the reset', () => {
    beforeEach(async () => {
        resetCoreStubs();
        _resetEpoch();
        // core/scope.js reads globalThis.SillyTavern directly (not the stub
        // context), so the chat id has to be seeded here. Without it every
        // capture is `identity-unknown`, and two unknowns deliberately never
        // compare equal — so every guard below would discard for the wrong
        // reason and the tests would pass for a lie.
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-A' }) };
        globalThis.document = { dispatchEvent: vi.fn() };
        setFakeChat([
            { id: 'm0', name: 'User', is_user: true, mes: 'The first scene.' },
            { id: 'm1', name: 'Mara', mes: 'The second scene.' },
        ]);
        const { state } = await import('../chronicle/data.js');
        state.isGenerating = false;
        state.isMainGenerating = false;
        state.msgSinceSnapshot = 0;
    });

    test('the success path consumes only the messages the snapshot covers', async () => {
        const { state, saveSettings, getChronicleData } = await import('../chronicle/data.js');
        const { generateSnapshot } = await import('../chronicle/snapshots.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });

        // 8 messages were waiting when generation started.
        state.msgSinceSnapshot = 8;

        let release;
        setFakeApi(() => new Promise(resolve => { release = resolve; }));
        const pending = generateSnapshot();
        await Promise.resolve();

        // 3 more arrive mid-flight. They are past the window's toIndex, so this
        // snapshot does not cover them — they must carry over to the next one.
        state.msgSinceSnapshot += 3;

        release('## Summary\nA valid generated summary.\n\n## Time Anchor\nIn-world date and time at end of this period: 2026-01-01 10:00');
        await pending;

        expect(state.msgSinceSnapshot).toBe(3);
        expect(getChronicleData().msgSinceSnapshot).toBe(3);
    });

    test('a deletion during generation cannot drive the counter negative', async () => {
        const { state, saveSettings } = await import('../chronicle/data.js');
        const { generateSnapshot } = await import('../chronicle/snapshots.js');
        saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });

        state.msgSinceSnapshot = 5;
        let release;
        setFakeApi(() => new Promise(resolve => { release = resolve; }));
        const pending = generateSnapshot();
        await Promise.resolve();

        // "Delete above" during generation drops the counter below the captured
        // value. Subtracting blindly would produce a negative counter, which
        // then never reaches the auto-snapshot threshold again.
        state.msgSinceSnapshot = 1;

        release('## Summary\nA valid generated summary.\n\n## Time Anchor\nIn-world date and time at end of this period: 2026-01-01 10:00');
        await pending;

        expect(state.msgSinceSnapshot).toBe(0);
    });
});

// ─── WORLD-STATE-02 (section-regen write window) ──────────────────────────────

describe('WORLD-STATE-02 — section regen writes against the current document', () => {
    const BASE = [
        '## Current Scene',
        'Mara waits in the study.',
        '',
        '## Pending',
        'An unpaid debt.',
    ].join('\n');

    beforeEach(async () => {
        resetCoreStubs();
        _resetEpoch();
        // core/scope.js reads globalThis.SillyTavern directly (not the stub
        // context), so the chat id has to be seeded here. Without it every
        // capture is `identity-unknown`, and two unknowns deliberately never
        // compare equal — so every guard below would discard for the wrong
        // reason and the tests would pass for a lie.
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-A' }) };
        globalThis.document = { dispatchEvent: vi.fn() };
        const { state } = await import('../world_state/data.js');
        state.wstIsRefreshing = false;
        state.modal = null;
    });

    test('an edit to another section during the grounding retry is preserved', async () => {
        const { saveSettings } = await import('../world_state/settings.js');
        const { setWorldStateData, getWorldStateText } = await import('../world_state/data.js');
        const { regenerateSection } = await import('../world_state/sections.js');

        saveSettings({
            apiUrl: 'https://example.test',
            modelName: 'test-model',
            groundingEnabled: true,
            // Strict is what makes the gate REJECT and retry. Soft strips in
            // place and returns ok, so the retry branch — the await this test
            // exists to cross — would never run.
            groundingMode: 'strict',
        });
        setWorldStateData({ text: BASE });

        let call = 0;
        setFakeApi(async () => {
            call++;
            if (call === 1) {
                // Ungrounded bold name → trips the gate → forces the retry,
                // and it is that retry's await we are testing across.
                return '## Pending\n- **Phantom Stranger** owes a favour.';
            }
            // While the retry was in flight the user edited a DIFFERENT
            // section. That edit must survive this write.
            setWorldStateData({
                text: BASE.replace('Mara waits in the study.', 'Mara waits by the door. (user edit)'),
            });
            return '## Pending\n- An unpaid debt, now overdue.';
        });

        await regenerateSection('Pending', 2);

        const finalText = getWorldStateText();
        expect(finalText).toContain('Mara waits by the door. (user edit)');
        expect(finalText).toContain('now overdue');
        expect(finalText).not.toContain('waits in the study');
    });
});

// ─── WORLD-STATE-04 ───────────────────────────────────────────────────────────

describe('WORLD-STATE-04 — strict grounding fails closed', () => {
    const PRIOR = [
        '## Current Scene',
        'Mara waits in the study.',
        '',
        '## Pending',
        'An unpaid debt.',
    ].join('\n');

    const UNGROUNDED = [
        '## Current Scene',
        '- **Phantom Stranger** enters the room.',
        '',
        '## Pending',
        'An unpaid debt.',
        '',
        '## Active Threads',
        'The debt is still owed.',
    ].join('\n');

    beforeEach(async () => {
        resetCoreStubs();
        _resetEpoch();
        // core/scope.js reads globalThis.SillyTavern directly (not the stub
        // context), so the chat id has to be seeded here. Without it every
        // capture is `identity-unknown`, and two unknowns deliberately never
        // compare equal — so every guard below would discard for the wrong
        // reason and the tests would pass for a lie.
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-A' }) };
        globalThis.document = { dispatchEvent: vi.fn() };
        setFakeChat([{ id: 'm0', name: 'Mara', mes: 'Mara waits in the study.' }]);
        const { state } = await import('../world_state/data.js');
        state.wstIsRefreshing = false;
        state.modal = null;
    });

    test('strict mode discards an ungrounded refresh instead of downgrading to soft', async () => {
        const { saveSettings } = await import('../world_state/settings.js');
        const { setWorldStateData, getWorldStateText } = await import('../world_state/data.js');
        const { refreshWorldState } = await import('../world_state/refresh.js');

        saveSettings({
            apiUrl: 'https://example.test',
            modelName: 'test-model',
            groundingEnabled: true,
            groundingMode: 'strict',
            expiryEnabled: false,
        });
        setWorldStateData({ text: PRIOR });

        // The model produces the same ungrounded name on both the first attempt
        // and the retry — two honest chances, still ungrounded.
        setFakeApi(async () => UNGROUNDED);

        // Must return null, NOT throw: this path used to call the undefined
        // `scSetStatus`, which turned a clean discard into a ReferenceError
        // that the catch block re-threw at the caller.
        await expect(refreshWorldState()).resolves.toBeNull();

        // Nothing committed — the prior document is untouched.
        expect(getWorldStateText()).toBe(PRIOR);

        // And the discard is visible to the user rather than silent.
        const statuses = getFakeStatusCalls();
        expect(statuses.some(s => /strict mode/i.test(s.message))).toBe(true);
    });

    test('soft mode strips the ungrounded name and still commits', async () => {
        const { saveSettings } = await import('../world_state/settings.js');
        const { setWorldStateData, getWorldStateText } = await import('../world_state/data.js');
        const { refreshWorldState } = await import('../world_state/refresh.js');

        saveSettings({
            apiUrl: 'https://example.test',
            modelName: 'test-model',
            groundingEnabled: true,
            groundingMode: 'soft',
            expiryEnabled: false,
        });
        setWorldStateData({ text: PRIOR });
        setFakeApi(async () => UNGROUNDED);

        const result = await refreshWorldState();

        expect(result).not.toBeNull();
        expect(getWorldStateText()).not.toContain('Phantom Stranger');
        expect(getWorldStateText()).toContain('## Current Scene');
    });
});

// ─── WORLD-STATE-09 ───────────────────────────────────────────────────────────

describe('WORLD-STATE-09 — the editor debounce is scoped to its own chat', () => {
    beforeEach(async () => {
        resetCoreStubs();
        _resetEpoch();
        // core/scope.js reads globalThis.SillyTavern directly (not the stub
        // context), so the chat id has to be seeded here. Without it every
        // capture is `identity-unknown`, and two unknowns deliberately never
        // compare equal — so every guard below would discard for the wrong
        // reason and the tests would pass for a lie.
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-A' }) };
        vi.useFakeTimers();
        globalThis.document = { dispatchEvent: vi.fn(), getElementById: () => null };
        const { state } = await import('../world_state/data.js');
        state.editorPersistTimer = null;
        state.editSessionActive = false;
        state.modal = null;
    });

    function fakeModalWithEditor(value) {
        return {
            querySelector: (sel) => (sel === '#ws-editor' ? { value } : null),
        };
    }

    test('a pending edit is dropped when the chat changed under it', async () => {
        const { state, setWorldStateData, getWorldStateText } = await import('../world_state/data.js');
        const { scheduleEditorPersist } = await import('../world_state/render.js');

        setWorldStateData({ text: 'Chat A state.' });
        // The modal survives a chat switch and editor.value still holds the
        // OLD chat's text until renderModalContent() runs — which is exactly
        // the value that used to get written into the new chat.
        state.modal = fakeModalWithEditor('Chat A state, half-typed edit.');

        scheduleEditorPersist();
        bumpEpoch(); // the chat changed while the debounce was pending
        vi.advanceTimersByTime(2000);

        expect(getWorldStateText()).toBe('Chat A state.');
    });

    test('a pending edit still persists when the chat did not change', async () => {
        const { state, setWorldStateData, getWorldStateText } = await import('../world_state/data.js');
        const { scheduleEditorPersist } = await import('../world_state/render.js');

        setWorldStateData({ text: 'Chat A state.' });
        state.modal = fakeModalWithEditor('Chat A state, edited.');

        scheduleEditorPersist();
        vi.advanceTimersByTime(2000);

        expect(getWorldStateText()).toBe('Chat A state, edited.');
    });
});

// ─── INTERIORITY-01 ───────────────────────────────────────────────────────────

describe('INTERIORITY-01 — stale thought blocks are removed from the DOM', () => {
    /**
     * Minimal stand-in for the pieces of the message DOM this function touches:
     * `#chat` → `.mes[mesid="N"]` → `.mwt-int-msg-thoughts`.
     */
    function buildChatDom({ hasStaleBlock }) {
        const removed = [];
        const staleBlock = { remove: () => removed.push('stale') };
        const msgEl = {
            _appended: [],
            querySelector: (sel) => (sel === '.mwt-int-msg-thoughts' && hasStaleBlock ? staleBlock : null),
            appendChild: (node) => msgEl._appended.push(node),
        };
        const chatEl = { querySelector: () => msgEl };
        return { removed, msgEl, chatEl };
    }

    beforeEach(() => {
        resetCoreStubs();
        _resetEpoch();
        // core/scope.js reads globalThis.SillyTavern directly (not the stub
        // context), so the chat id has to be seeded here. Without it every
        // capture is `identity-unknown`, and two unknowns deliberately never
        // compare equal — so every guard below would discard for the wrong
        // reason and the tests would pass for a lie.
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-A' }) };
    });

    test('the old block is removed even when no new thought data exists', async () => {
        const { removed, msgEl, chatEl } = buildChatDom({ hasStaleBlock: true });
        globalThis.document = {
            getElementById: (id) => (id === 'chat' ? chatEl : null),
            createElement: () => ({ className: '', innerHTML: '', appendChild: () => {} }),
            dispatchEvent: vi.fn(),
        };

        const { renderThoughtBlockForMessage } = await import('../interiority/render.js');

        // No perMessage metadata for this index — the swipe/edit/empty-regen
        // case. The old code returned before touching the DOM, leaving the
        // previous timeline's private thoughts on screen.
        renderThoughtBlockForMessage(0);

        expect(removed).toEqual(['stale']);
        expect(msgEl._appended).toHaveLength(0);
    });

    test('cleanup is a no-op when there was no block to begin with', async () => {
        const { removed, msgEl, chatEl } = buildChatDom({ hasStaleBlock: false });
        globalThis.document = {
            getElementById: (id) => (id === 'chat' ? chatEl : null),
            createElement: () => ({ className: '', innerHTML: '', appendChild: () => {} }),
            dispatchEvent: vi.fn(),
        };

        const { renderThoughtBlockForMessage } = await import('../interiority/render.js');
        renderThoughtBlockForMessage(0);

        expect(removed).toEqual([]);
        expect(msgEl._appended).toHaveLength(0);
    });
});
