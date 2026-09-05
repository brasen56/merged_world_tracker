/**
 * test/knowledge_auto_trigger.test.js — the Knowledge auto-cadence contract
 * (review findings 3 + 4).
 *
 *   1. Auto classification (TODO §1): every cadence-driven Knowledge call —
 *      continuous growth capture, the NPC auto-scan, and the relationship
 *      auto-extract — must carry `trigger: 'auto'` down to the transport.
 *      Trigger-less would classify them as manual FOREGROUND work that the
 *      optional "pause background jobs while generating" policy cannot hold.
 *   2. The continuous-capture multi-NPC loop must STOP on a coordinator
 *      cancellation instead of treating it as a per-NPC best-effort failure:
 *      continuing would submit fresh-epoch jobs for an orchestration run that
 *      began in the old scope.
 *   3. runContinuousCapture must refuse its writes when the chat changed
 *      during its own API await — the caller's outer check runs only after
 *      the full multi-NPC pass and cannot undo a write.
 *
 * The transports here are the core stub's fetchFn (setFakeApi): the request
 * object it receives is exactly what ktFetchFromApi hands over, so `trigger`
 * is observable at the seam the coordinator reads.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { resetCoreStubs, setFakeChat, setFakeApi, bumpEpoch, _resetEpoch } from './stubs/core.js';
import { _clearCacheForTests, _setCacheForTests } from '../knowledge/store.js';
import { saveSettings } from '../knowledge/settings.js';
import { runScan } from '../knowledge/lorebook.js';
import { runRelationshipExtract } from '../knowledge/relationships.js';
import { runContinuousCaptureAll, runContinuousCapture } from '../knowledge/growth.js';
import { getEvidenceFile, saveEvidenceMap, setCaptureWatermark, getCaptureWatermark } from '../knowledge/evidence.js';

// ─── Harness ─────────────────────────────────────────────────────────────────

let apiCalls;

beforeEach(() => {
    resetCoreStubs();
    _clearCacheForTests();
    _resetEpoch();
    apiCalls = [];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    saveSettings({ apiUrl: 'https://example.test', modelName: 'test-model' });
});

function seedRegistry(entries) {
    _setCacheForTests('Knowledge Tracker', { registry: entries });
}

/** Five Mara messages (00:01–00:05) above a 00:00 watermark, plus the two
 * trailing in-flight placeholders getStableHistoryEnd excludes. */
function makeDeltaChat() {
    const chat = [];
    for (let i = 1; i <= 5; i++) {
        chat.push({
            name: 'Mara',
            mes: i === 1 ? 'Mara steadies her breathing.' : `Mara paces the floor (${i}).`,
            send_date: `2026-01-01T00:0${i}:00.000Z`,
        });
    }
    chat.push({ is_system: true, mes: 'in-flight placeholder', send_date: '2026-01-01T00:05:00.000Z' });
    chat.push({ is_system: true, mes: 'in-flight placeholder', send_date: '2026-01-01T00:05:00.000Z' });
    return chat;
}

/** Enrol ONE major NPC in continuous capture (registry gate + evidence file +
 * a 00:00 watermark so the delta window qualifies). */
function enrolContinuous(name, uid) {
    seedRegistry({ [name]: { uid, type: 'major', keywords: [name] } });
    getEvidenceFile(name).enrolled = true;
    saveEvidenceMap();
    setCaptureWatermark(name, Date.parse('2026-01-01T00:00:00.000Z'));
}

function observationsPayload() {
    return JSON.stringify({
        observations: [{ category: 'trait', claim: 'She remains composed under pressure.', quote: 'Mara steadies her breathing.', msgIdx: 0 }],
    });
}

// ─── 1. Auto trigger threading (finding 4) ────────────────────────────────────

describe('Knowledge auto-cadence calls carry trigger:auto to the transport', () => {
    test('continuous growth capture (runContinuousCaptureAll) classifies as background work', async () => {
        enrolContinuous('Mara', 7);
        setFakeChat(makeDeltaChat());
        setFakeApi((req) => { apiCalls.push(req); return observationsPayload(); });

        const { attempted } = await runContinuousCaptureAll();

        expect(attempted).toBe(1);
        expect(apiCalls).toHaveLength(1);
        expect(apiCalls[0].trigger).toBe('auto');
    });

    test('the NPC scan threads an explicit trigger (and stays manual-foreground without one)', async () => {
        seedRegistry({});
        // Three messages: getRecentMessages excludes the two-message in-flight
        // tail, so at least the first one must remain eligible.
        setFakeChat([
            { name: 'User', mes: 'hello', is_user: true },
            { name: 'Mara', mes: 'hi', is_user: false },
            { name: 'Mara', mes: 'bye', is_user: false },
        ]);
        setFakeApi((req) => {
            apiCalls.push(req);
            return JSON.stringify({ new_minor: [], new_major: [], update_minor: [], update_major: [] });
        });

        await runScan({ trigger: 'auto' });
        expect(apiCalls[0].trigger).toBe('auto');

        await runScan();
        expect(apiCalls[1].trigger).toBe(null); // manual Scan button stays foreground
    });

    test('the relationship extract threads an explicit trigger', async () => {
        seedRegistry({ Mara: { uid: 7, type: 'major', keywords: ['Mara'] } });
        setFakeChat([
            { mes: 'An earlier scene.', name: 'Narrator', is_user: false },
            { mes: 'tail one', name: 'Narrator', is_user: false },
            { mes: 'tail two', name: 'Narrator', is_user: false },
        ]);
        // relationships.js asserts strict scope identity after the API call;
        // without a resolvable chat id every identity is "unknown" and the
        // guard fires before the trigger is observable at the transport.
        globalThis.SillyTavern = { getContext: () => ({ getCurrentChatId: () => 'chat-rel' }) };
        try {
            setFakeApi((req) => { apiCalls.push(req); return JSON.stringify({ edges: [], stances: [] }); });

            await runRelationshipExtract({ trigger: 'auto' });

            expect(apiCalls).toHaveLength(1);
            expect(apiCalls[0].trigger).toBe('auto');
        } finally {
            delete globalThis.SillyTavern;
        }
    });
});

// ─── 2. Continuous-capture loop stops on cancellation (finding 3) ─────────────

describe('runContinuousCaptureAll — cancellation stops the whole run', () => {
    function enrolTwo() {
        seedRegistry({
            Mara: { uid: 7, type: 'major', keywords: ['Mara'] },
            Nils: { uid: 8, type: 'major', keywords: ['Nils'] },
        });
        for (const name of ['Mara', 'Nils']) {
            getEvidenceFile(name).enrolled = true;
            saveEvidenceMap();
            setCaptureWatermark(name, Date.parse('2026-01-01T00:00:00.000Z'));
        }
    }

    test('a coordinator cancellation on NPC 1 rethrows and NPC 2 is never attempted', async () => {
        enrolTwo();
        setFakeChat(makeDeltaChat());
        const cancelled = new Error('Job cancelled (chat scope changed)');
        cancelled.name = 'JobCancelledError';
        cancelled._mwtCancelled = true;
        setFakeApi((req) => {
            apiCalls.push(req);
            throw cancelled;
        });

        // The loop used to catch it as a per-NPC best-effort failure and
        // CONTINUE — submitting fresh-epoch jobs for the old-scope run.
        await expect(runContinuousCaptureAll()).rejects.toMatchObject({ _mwtCancelled: true });
        expect(apiCalls).toHaveLength(1); // Nils was never attempted
    });

    test('a mid-run chat switch stops the loop before the next NPC', async () => {
        enrolTwo();
        setFakeChat(makeDeltaChat());
        setFakeApi((req) => {
            apiCalls.push(req);
            bumpEpoch(); // the chat switches during NPC 1's API call
            return observationsPayload();
        });

        const { attempted } = await runContinuousCaptureAll();

        // NPC 1 ran (its own pre-write guard refused the result — see below);
        // the loop then stopped instead of spending NPC 2 at the new epoch.
        expect(apiCalls).toHaveLength(1);
        expect(attempted).toBe(1);
    });
});

// ─── 3. Pre-write scope guard inside runContinuousCapture (finding 3) ─────────

describe('runContinuousCapture — pre-write scope guard', () => {
    test('a chat switch during the API await refuses every write', async () => {
        enrolContinuous('Mara', 7);
        setFakeChat(makeDeltaChat());
        setFakeApi((req) => {
            apiCalls.push(req);
            bumpEpoch(); // chat switches mid-call; the wire result still returns
            return observationsPayload();
        });

        const result = await runContinuousCapture('Mara');

        expect(apiCalls).toHaveLength(1); // the spend happened — that is unavoidable
        expect(result).toBe(null);       // …but nothing may be written with it
        // No observations appended…
        expect(getEvidenceFile('Mara', false).raw).toHaveLength(0);
        // …and the watermark NOT advanced (a stale watermark would silently
        // skip re-capturing these messages in the new chat).
        expect(getCaptureWatermark('Mara')).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    });
});
