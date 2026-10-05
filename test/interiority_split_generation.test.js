import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resetCoreStubs, setFakeChat, setFakeContextExtras, setFakeApi } from './stubs/core.js';
import { saveSettings, getLedger, getPerMessage, getMsgKeyForIndex, addLedgerEntry } from '../interiority/data.js';
import { triggerGenerate } from '../interiority/index.js';
import { runDormantPoll } from '../interiority/generation.js';
import { getEvidenceBoundary } from '../interiority/lifecycle.js';
import { getIntentionsCaptureSnapshot, _resetIntentionsCapture } from '../interiority/capture.js';

const THOUGHTS = { npcs: [{
    name: 'Mara',
    thought: { type: 'reaction', re: 'the sealed parcel', text: 'What is he hiding in that seal?' },
}] };
const PROPOSAL = { action: 'open the parcel privately', trigger: 'when alone in her room', horizon: 'immediate' };
const INTENTIONS = { npcs: [{ name: 'Mara', executed: [], dropped: [], new_intentions: [PROPOSAL] }] };

beforeEach(() => {
    resetCoreStubs();
    _resetIntentionsCapture();
    vi.stubGlobal('document', {
        dispatchEvent: vi.fn(), getElementById: () => null, querySelectorAll: () => [],
    });
    vi.stubGlobal('SillyTavern', { getContext: () => ({ getCurrentChatId: () => 'split-contract' }) });
    setFakeContextExtras({ name1: 'Player', name2: 'Mara' });
    setFakeChat([
        { name: 'Player', is_user: true, mes: 'Here is a parcel for you.', extra: {} },
        { name: 'Mara', mes: 'Mara accepts the sealed parcel and pockets it.', extra: {} },
    ]);
    saveSettings({
        apiUrl: 'https://example.test/v1', modelName: 'test',
        generateThoughts: true, generateIntentions: true, splitThoughts: true,
        captureIntentionsDiagnostics: true,
    });
});

afterEach(() => vi.unstubAllGlobals());

describe('split generation response contract', () => {
    test('a private proposal reaches the ledger while the separate thought is saved', async () => {
        setFakeApi(async ({ systemPrompt }) => JSON.stringify(
            systemPrompt.includes('NEW INTENTIONS') ? INTENTIONS : THOUGHTS,
        ));

        await triggerGenerate();

        expect(getLedger()).toEqual([expect.objectContaining({
            npc: 'Mara', action: PROPOSAL.action, trigger: PROPOSAL.trigger,
        })]);
        expect(getPerMessage(getMsgKeyForIndex(1)).reactions).toEqual([
            expect.objectContaining({ npc: 'Mara', thought: THOUGHTS.npcs[0].thought.text }),
        ]);
        expect(getEvidenceBoundary('Mara')).not.toBeNull();
    });

    test('valid JSON with the wrong root is retried instead of silently losing a proposal', async () => {
        let intentionCalls = 0;
        setFakeApi(async ({ systemPrompt }) => {
            if (!systemPrompt.includes('NEW INTENTIONS')) return JSON.stringify(THOUGHTS);
            intentionCalls += 1;
            return JSON.stringify(intentionCalls === 1 ? { intentions: INTENTIONS.npcs } : INTENTIONS);
        });

        await triggerGenerate();

        expect(intentionCalls).toBe(2);
        expect(getLedger()).toHaveLength(1);
        const capture = getIntentionsCaptureSnapshot().calls.find(call => call.kind === 'intentions');
        expect(capture.attempts).toHaveLength(2);
        expect(capture.attempts[0]).toMatchObject({ ok: false, error: expect.stringContaining('npcs') });
        expect(capture.parsed).toBe(true);
    });

    test('a valid empty proposal list stays empty without a retry', async () => {
        let intentionCalls = 0;
        setFakeApi(async ({ systemPrompt }) => {
            if (!systemPrompt.includes('NEW INTENTIONS')) return JSON.stringify(THOUGHTS);
            intentionCalls += 1;
            return JSON.stringify({ npcs: [{ name: 'Mara', executed: [], dropped: [], new_intentions: [] }] });
        });

        await triggerGenerate();

        expect(intentionCalls).toBe(1);
        expect(getLedger()).toHaveLength(0);
        expect(getPerMessage(getMsgKeyForIndex(1)).reactions).toHaveLength(1);
        expect(getEvidenceBoundary('Mara')).not.toBeNull();
    });

    test.each([null, [], {}, { npcs: {} }, { npcs: 'Mara' }])(
        'an invalid envelope %j fails independently while thoughts survive', async (response) => {
            let intentionCalls = 0;
            setFakeApi(async ({ systemPrompt }) => {
                if (!systemPrompt.includes('NEW INTENTIONS')) return JSON.stringify(THOUGHTS);
                intentionCalls += 1;
                return JSON.stringify(response);
            });

            await triggerGenerate();

            expect(intentionCalls).toBe(2);
            expect(getLedger()).toHaveLength(0);
            expect(getPerMessage(getMsgKeyForIndex(1)).reactions).toHaveLength(1);
            expect(getEvidenceBoundary('Mara')).toBeNull();
            const capture = getIntentionsCaptureSnapshot().calls.find(call => call.kind === 'intentions');
            expect(capture.parsed).toBe(false);
            expect(capture.attempts.every(attempt => attempt.ok === false)).toBe(true);
        },
    );

    test('the dormant poll validates its own intentions envelope and remains proposal-only', async () => {
        const scheduled = addLedgerEntry({
            npc: 'Mara', action: 'meet the courier', trigger: 'harvest festival',
            status: 'dormant', wakeHint: 'harvest festival',
        }, 'day 1', 0);
        let calls = 0;
        setFakeApi(async () => {
            calls += 1;
            return JSON.stringify(calls === 1
                ? { npcs: [] }
                : { intentions: [{ id: scheduled.id, wake: true }] });
        });

        expect(await runDormantPoll()).toEqual([scheduled.id]);
        expect(calls).toBe(2);
        expect(getLedger()[0].status).toBe('dormant');
    });
});
